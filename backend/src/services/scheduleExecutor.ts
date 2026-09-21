import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { default as pool } from '../config/database.js';
import { StellarService } from './stellarService.js';
import { scheduleService } from './scheduleService.js';
import type { Schedule, ExecutionResult, PaymentRecipient } from '../types/schedule.js';
import { Operation, Asset, Memo, Keypair } from '@stellar/stellar-sdk';
import os from 'node:os';
import type { PoolClient } from 'pg';

export class ScheduleExecutor {
  private cronJob: ScheduledTask | null = null;
  private readonly podId: string;

  constructor() {
    this.podId = `${os.hostname()}-${process.pid}`;
  }

  /**
   * Initialize the cron job to run every minute
   * Sets up node-cron job with error handling and logging
   */
  initialize(): void {
    // Cron expression: run every minute
    this.cronJob = cron.schedule('* * * * *', async () => {
      try {
        console.log('[ScheduleExecutor] Running scheduled task check...');
        await this.processDueSchedules();
      } catch (error) {
        console.error('[ScheduleExecutor] Error in cron job execution:', error);
      }
    });

    console.log('[ScheduleExecutor] Cron job initialized - running every minute');
  }

  /**
   * Stop the cron job (for graceful shutdown)
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log('[ScheduleExecutor] Cron job stopped');
    }
  }

  /**
   * Claim due schedules atomically using FOR UPDATE SKIP LOCKED.
   * Each row is marked with the claiming pod's ID so concurrent pods
   * skip already-claimed rows instead of executing them twice.
   */
  async processDueSchedules(): Promise<void> {
    // Reclaim rows from crashed pods before attempting our own claim
    await this.releaseStaleClaims();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Claim due schedules atomically: SELECT … FOR UPDATE SKIP LOCKED
      // locks the rows this pod claims; other pods skip them.
      const claimQuery = `
        UPDATE schedules
        SET locked_by = $1, locked_at = NOW()
        WHERE id IN (
          SELECT id
          FROM schedules
          WHERE next_run_timestamp <= (NOW() AT TIME ZONE 'UTC')
            AND status = 'active'
            AND locked_by IS NULL
          ORDER BY next_run_timestamp ASC
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id,
          organization_id as "organizationId",
          user_id as "userId",
          frequency,
          time_of_day as "timeOfDay",
          start_date as "startDate",
          end_date as "endDate",
          payment_config as "paymentConfig",
          timezone,
          next_run_timestamp as "nextRunTimestamp",
          last_run_timestamp as "lastRunTimestamp",
          status,
          created_at as "createdAt",
          updated_at as "updatedAt"
      `;

      const result = await client.query(claimQuery, [this.podId]);
      await client.query('COMMIT');

      const claimedSchedules = result.rows;

      if (claimedSchedules.length > 0) {
        console.log(`[ScheduleExecutor] Claimed ${claimedSchedules.length} due schedule(s)`);
      }

      let successCount = 0;
      let failureCount = 0;

      for (const scheduleRow of claimedSchedules) {
        let executionResult: ExecutionResult;

        try {
          const schedule: Schedule = {
            ...scheduleRow,
            startDate: new Date(scheduleRow.startDate),
            endDate: scheduleRow.endDate ? new Date(scheduleRow.endDate) : undefined,
            nextRunTimestamp: new Date(scheduleRow.nextRunTimestamp),
            lastRunTimestamp: scheduleRow.lastRunTimestamp
              ? new Date(scheduleRow.lastRunTimestamp)
              : undefined,
            createdAt: new Date(scheduleRow.createdAt),
            updatedAt: new Date(scheduleRow.updatedAt),
          };

          console.log(`[ScheduleExecutor] Executing schedule ID ${schedule.id} (Scheduled for: ${schedule.nextRunTimestamp.toISOString()})`);
          executionResult = await this.executeSchedule(schedule);
        } catch (error) {
          executionResult = {
            success: false,
            error: {
              message: error instanceof Error ? error.message : 'System error in executor',
              details: error as any,
            },
          };
          console.error(
            `[ScheduleExecutor] Error executing schedule ID ${scheduleRow.id}:`,
            error
          );
        }

        try {
          // Commit execution history and schedule state before releasing the claim.
          // If commit fails, the claim stays in place for stale-claim recovery.
          await this.recordExecution(scheduleRow.id, executionResult, client);

          if (executionResult.success) {
            successCount++;
            console.log(
              `[ScheduleExecutor] Schedule ID ${scheduleRow.id} executed successfully. Hash: ${executionResult.transactionHash}`
            );
          } else {
            failureCount++;
            console.error(
              `[ScheduleExecutor] Schedule ID ${scheduleRow.id} failed:`,
              executionResult.error?.message
            );
          }
        } catch (recordError) {
          failureCount++;
          console.error(
            `[ScheduleExecutor] Failed to finalize schedule ID ${scheduleRow.id}; claim retained for recovery:`,
            recordError
          );
        }
      }

      if (claimedSchedules.length > 0) {
        console.log(
          `[ScheduleExecutor] Execution complete - Success: ${successCount}, Failed: ${failureCount}`
        );
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  /**
   * Release stale claims held by crashed pods (locked_at older than 5 minutes).
   * Called once per cron cycle before claiming new schedules.
   */
  private async releaseStaleClaims(): Promise<void> {
    try {
      const result = await pool.query(
        `UPDATE schedules
         SET locked_by = NULL, locked_at = NULL
         WHERE locked_by IS NOT NULL
           AND locked_at < NOW() - INTERVAL '5 minutes'`
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[ScheduleExecutor] Released ${result.rowCount} stale claim(s)`);
      }
    } catch (error) {
      console.error('[ScheduleExecutor] Failed to release stale claims:', error);
    }
  }

  /**
   * Execute a single schedule by building and submitting a Stellar transaction
   * @param schedule - The schedule to execute
   * @returns ExecutionResult with success status and transaction hash or error
   */
  async executeSchedule(schedule: Schedule): Promise<ExecutionResult> {
    try {
      // Extract payment configuration
      const paymentConfig = schedule.paymentConfig;

      if (!paymentConfig || !paymentConfig.recipients || paymentConfig.recipients.length === 0) {
        throw new Error('Invalid payment configuration: no recipients found');
      }

      // Get source keypair from environment
      // In production, this should be securely managed (e.g., KMS, vault)
      const sourceSecret = process.env.STELLAR_SOURCE_SECRET;
      if (!sourceSecret) {
        throw new Error('STELLAR_SOURCE_SECRET environment variable not set');
      }

      const sourceKeypair = Keypair.fromSecret(sourceSecret);

      // Build Stellar operations from recipients
      const operations = paymentConfig.recipients.map((recipient: PaymentRecipient) => {
        // Parse asset - handle native XLM and custom assets
        let asset: Asset;
        if (recipient.assetCode === 'XLM' || recipient.assetCode === 'native') {
          asset = Asset.native();
        } else {
          // For custom assets, we need an issuer public key
          // This should be configured per asset in production
          const issuerPublicKey = process.env.STELLAR_ASSET_ISSUER;
          if (!issuerPublicKey) {
            throw new Error(`Asset issuer not configured for ${recipient.assetCode}`);
          }
          asset = new Asset(recipient.assetCode, issuerPublicKey);
        }

        return Operation.payment({
          destination: recipient.walletAddress,
          asset,
          amount: recipient.amount,
        });
      });

      // Build transaction using StellarService
      const txOptions: { fee?: string; timeout?: number; memo?: Memo } = {
        timeout: 30,
      };
      if (paymentConfig.memo) {
        txOptions.memo = Memo.text(paymentConfig.memo);
      }

      const builder = await StellarService.buildTransaction(
        sourceKeypair.publicKey(),
        operations,
        txOptions
      );

      const transaction = builder.build();

      // Sign transaction
      const signedTransaction = StellarService.signTransaction(transaction, sourceKeypair);

      // Submit transaction
      const result = await StellarService.submitTransaction(signedTransaction);

      return {
        success: result.success,
        transactionHash: result.hash,
      };
    } catch (error) {
      // Parse Stellar error for better error messages
      const parsedError = StellarService.parseError(error);

      return {
        success: false,
        error: {
          message: parsedError.message,
          details: {
            type: parsedError.type,
            code: parsedError.code,
            resultXdr: parsedError.resultXdr,
          },
        },
      };
    }
  }

  /**
   * Record execution in execution_history table and update schedule state
   * @param scheduleId - The schedule ID
   * @param result - The execution result
   */
  async recordExecution(
    scheduleId: number,
    result: ExecutionResult,
    client: PoolClient
  ): Promise<void> {
    try {
      await client.query('BEGIN');

      const status = result.success ? 'success' : 'failed';
      const insertQuery = `
        INSERT INTO execution_history (
          schedule_id,
          executed_at,
          status,
          transaction_hash,
          transaction_result,
          error_message,
          error_details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `;

      const insertValues = [
        scheduleId,
        new Date(),
        status,
        result.transactionHash || null,
        result.success ? JSON.stringify({ hash: result.transactionHash }) : null,
        result.error?.message || null,
        result.error?.details ? JSON.stringify(result.error.details) : null,
      ];

      await client.query(insertQuery, insertValues);

      // Use the claim-owning connection so history and schedule-state mutation
      // commit together without opening a nested transaction.
      await scheduleService.updateAfterExecution(scheduleId, result, client);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // The only unlock happens after execution state has committed, on the same
    // physical connection, and only while this executor still owns the claim.
    const releaseResult = await client.query(
      `UPDATE schedules
       SET locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND locked_by = $2
       RETURNING id`,
      [scheduleId, this.podId]
    );

    if (releaseResult.rowCount !== 1) {
      throw new Error(
        `Schedule ${scheduleId} lock is no longer owned by executor ${this.podId}`
      );
    }
  }
}

// Export singleton instance
export const scheduleExecutor = new ScheduleExecutor();

import { DateTime } from 'luxon';
import { default as pool } from '../config/database.js';
import type { PoolClient } from 'pg';
import type {
  Schedule,
  ScheduleFrequency,
  CreateScheduleRequest,
  ScheduleFilters,
  ExecutionResult,
} from '../types/schedule.js';

export class ScheduleService {
  /**
   * Calculate the next run timestamp for a schedule based on frequency and timezone
   * @param frequency - Schedule frequency ('once', 'weekly', 'biweekly', 'monthly')
   * @param timeOfDay - Time of day in HH:MM format
   * @param startDate - Start date for the schedule
   * @param timezone - Timezone for the schedule (e.g., 'America/New_York')
   * @param lastRun - Optional last run timestamp for recurring schedules
   * @returns Date object representing the next execution time (in UTC)
   */
  calculateNextRun(
    frequency: ScheduleFrequency,
    timeOfDay: string,
    startDate: Date,
    timezone: string,
    lastRun?: Date,
  ): Date {
    const [hours, minutes] = timeOfDay.split(':').map(Number);

    // Initial reference point in the specified timezone
    let referenceDateTime: DateTime;

    if (frequency === 'once') {
      referenceDateTime = DateTime.fromJSDate(startDate, { zone: timezone }).set({
        hour: hours,
        minute: minutes,
        second: 0,
        millisecond: 0,
      });
      return referenceDateTime.toJSDate();
    }

    // For recurring schedules, use lastRun if provided, otherwise use startDate
    if (lastRun) {
      referenceDateTime = DateTime.fromJSDate(lastRun, { zone: timezone });
    } else {
      referenceDateTime = DateTime.fromJSDate(startDate, { zone: timezone }).set({
        hour: hours,
        minute: minutes,
        second: 0,
        millisecond: 0,
      });

      // If we are calculating for the first time and the derived time is in the past,
      // it means we should probably calculate the *next* occurrence.
      // But usually, createSchedule will set the first run to the user's intent.
    }

    let nextRun: DateTime = referenceDateTime;

    // Calculate next occurrence based on frequency
    switch (frequency) {
      case 'weekly':
        nextRun = referenceDateTime.plus({ weeks: 1 });
        break;

      case 'biweekly':
        nextRun = referenceDateTime.plus({ weeks: 2 });
        break;

      case 'monthly':
        nextRun = referenceDateTime.plus({ months: 1 });
        break;

      default:
        throw new Error(`Unsupported frequency: ${frequency}`);
    }

    // Ensure the time of day is preserved in the target timezone
    nextRun = nextRun.set({
      hour: hours,
      minute: minutes,
      second: 0,
      millisecond: 0,
    });

    return nextRun.toJSDate();
  }

  async createSchedule(
    organizationId: number,
    userId: number,
    scheduleData: CreateScheduleRequest,
  ): Promise<Schedule> {
    // Validate schedule data
    this.validateScheduleData(scheduleData);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Parse dates
      const startDate = new Date(scheduleData.startDate);
      const endDate = scheduleData.endDate ? new Date(scheduleData.endDate) : null;

      // Calculate initial next_run_timestamp
      const nextRunTimestamp = this.calculateNextRun(
        scheduleData.frequency,
        scheduleData.timeOfDay,
        startDate,
        scheduleData.timezone,
      );

      // Insert schedule into database
      const query = `
        INSERT INTO schedules (
          organization_id,
          user_id,
          frequency,
          time_of_day,
          start_date,
          end_date,
          payment_config,
          timezone,
          next_run_timestamp,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

      const values = [
        organizationId,
        userId,
        scheduleData.frequency,
        scheduleData.timeOfDay,
        startDate,
        endDate,
        JSON.stringify(scheduleData.paymentConfig),
        scheduleData.timezone,
        nextRunTimestamp,
        'active',
      ];

      const result = await client.query(query, values);
      await client.query('COMMIT');

      const schedule = result.rows[0];

      // Parse dates and JSON from database
      return {
        ...schedule,
        startDate: new Date(schedule.startDate),
        endDate: schedule.endDate ? new Date(schedule.endDate) : undefined,
        nextRunTimestamp: new Date(schedule.nextRunTimestamp),
        lastRunTimestamp: schedule.lastRunTimestamp
          ? new Date(schedule.lastRunTimestamp)
          : undefined,
        createdAt: new Date(schedule.createdAt),
        updatedAt: new Date(schedule.updatedAt),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate schedule data against business rules
   * @param scheduleData - Schedule data to validate
   * @throws Error if validation fails
   */
  private validateScheduleData(scheduleData: CreateScheduleRequest): void {
    // Validate frequency
    if (!['once', 'weekly', 'biweekly', 'monthly'].includes(scheduleData.frequency)) {
      throw new Error(`Invalid frequency: ${scheduleData.frequency}`);
    }

    // Validate timeOfDay format (HH:MM)
    const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timeRegex.test(scheduleData.timeOfDay)) {
      throw new Error(`Invalid time format: ${scheduleData.timeOfDay}. Expected HH:MM format.`);
    }

    // Validate startDate is not in the past
    const startDate = new Date(scheduleData.startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (startDate < today) {
      throw new Error('Start date cannot be in the past');
    }

    // Validate endDate is after startDate (if provided)
    if (scheduleData.endDate) {
      const endDate = new Date(scheduleData.endDate);
      if (endDate <= startDate) {
        throw new Error('End date must be after start date');
      }
    }

    // Validate payment config
    if (!scheduleData.paymentConfig || !scheduleData.paymentConfig.recipients) {
      throw new Error('Payment configuration is required');
    }

    // Validate timezone
    if (!scheduleData.timezone || scheduleData.timezone.trim() === '') {
      throw new Error('Timezone is required');
    }

    try {
      DateTime.local().setZone(scheduleData.timezone);
      if (!DateTime.local().setZone(scheduleData.timezone).isValid) {
        throw new Error('Invalid timezone');
      }
    } catch (e) {
      throw new Error(`Invalid timezone: ${scheduleData.timezone}`);
    }

    if (scheduleData.paymentConfig.recipients.length === 0) {
      throw new Error('At least one recipient is required');
    }

    // Validate each recipient
    scheduleData.paymentConfig.recipients.forEach((recipient, index) => {
      if (!recipient.walletAddress || recipient.walletAddress.trim() === '') {
        throw new Error(`Recipient ${index + 1}: Wallet address is required`);
      }

      if (!recipient.amount || parseFloat(recipient.amount) <= 0) {
        throw new Error(`Recipient ${index + 1}: Amount must be greater than 0`);
      }

      if (!recipient.assetCode || recipient.assetCode.trim() === '') {
        throw new Error(`Recipient ${index + 1}: Asset code is required`);
      }
    });

    // Validate memo length if provided
    if (scheduleData.paymentConfig.memo && scheduleData.paymentConfig.memo.length > 28) {
      throw new Error('Memo cannot exceed 28 characters');
    }
  }

  async getActiveSchedules(
    organizationId: number,
    filters?: ScheduleFilters,
  ): Promise<Schedule[]> {
    const client = await pool.connect();
    try {
      // Default filter values
      const status = filters?.status || 'active';
      const page = filters?.page || 1;
      const limit = filters?.limit || 50;
      const offset = (page - 1) * limit;

      // Build query with filters
      const query = `
        SELECT 
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
        FROM schedules
        WHERE organization_id = $1 AND status = $2
        ORDER BY next_run_timestamp ASC
        LIMIT $3 OFFSET $4
      `;

      const values = [organizationId, status, limit, offset];
      const result = await client.query(query, values);

      // Parse dates and JSON from database
      return result.rows.map((row: any) => ({
        ...row,
        startDate: new Date(row.startDate),
        endDate: row.endDate ? new Date(row.endDate) : undefined,
        nextRunTimestamp: new Date(row.nextRunTimestamp),
        lastRunTimestamp: row.lastRunTimestamp
          ? new Date(row.lastRunTimestamp)
          : undefined,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    } finally {
      client.release();
    }
  }

  async cancelSchedule(
    scheduleId: number,
    organizationId: number,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      // Query the schedule by ID
      const selectQuery = `
        SELECT id, organization_id as "organizationId", status
        FROM schedules
        WHERE id = $1
      `;

      const selectResult = await client.query(selectQuery, [scheduleId]);

      // Check if schedule exists
      if (selectResult.rows.length === 0) {
        const error = new Error('Schedule not found') as any;
        error.statusCode = 404;
        throw error;
      }

      const schedule = selectResult.rows[0];

      // Verify schedule belongs to the organization
      if (schedule.organizationId !== organizationId) {
        const error = new Error('Access denied: Schedule belongs to a different organization') as any;
        error.statusCode = 403;
        throw error;
      }

      // Update schedule status to 'cancelled'
      const updateQuery = `
        UPDATE schedules
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `;

      await client.query(updateQuery, [scheduleId]);
    } finally {
      client.release();
    }
  }

  async updateAfterExecution(
    scheduleId: number,
    executionResult: ExecutionResult,
    client?: PoolClient,
  ): Promise<void> {
    const ownsClient = !client;
    const dbClient = client ?? (await pool.connect());

    try {
      if (ownsClient) {
        await dbClient.query('BEGIN');
      }

      const selectQuery = `
        SELECT
          id,
          frequency,
          time_of_day as "timeOfDay",
          start_date as "startDate",
          timezone,
          last_run_timestamp as "lastRunTimestamp"
        FROM schedules
        WHERE id = $1
      `;

      const selectResult = await dbClient.query(selectQuery, [scheduleId]);

      if (selectResult.rows.length === 0) {
        throw new Error(`Schedule with ID ${scheduleId} not found`);
      }

      const schedule = selectResult.rows[0];
      const executionTime = new Date();

      let newStatus: string;
      let nextRunTimestamp: Date | null = null;

      if (!executionResult.success) {
        newStatus = 'failed';
      } else if (schedule.frequency === 'once') {
        newStatus = 'completed';
      } else {
        newStatus = 'active';
        nextRunTimestamp = this.calculateNextRun(
          schedule.frequency,
          schedule.timeOfDay,
          new Date(schedule.startDate),
          schedule.timezone,
          executionTime,
        );
      }

      const updateQuery = `
        UPDATE schedules
        SET
          last_run_timestamp = $1,
          status = $2,
          next_run_timestamp = COALESCE($3, next_run_timestamp),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
      `;

      await dbClient.query(updateQuery, [
        executionTime,
        newStatus,
        nextRunTimestamp,
        scheduleId,
      ]);

      if (ownsClient) {
        await dbClient.query('COMMIT');
      }
    } catch (error) {
      if (ownsClient) {
        await dbClient.query('ROLLBACK');
      }
      throw error;
    } finally {
      if (ownsClient) {
        dbClient.release();
      }
    }
  }
}

export const scheduleService = new ScheduleService();

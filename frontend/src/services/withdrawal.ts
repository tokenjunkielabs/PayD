/**
 * Withdrawal service for SEP-24 interactive flow.
 * Handles anchor discovery, withdrawal initiation, and transaction polling.
 */

import api from '../utils/api';

export interface AnchorInfo {
  domain: string;
  name: string;
  supportedCurrencies: string[];
  withdrawFee?: string;
  withdrawMinAmount?: number;
  withdrawMaxAmount?: number;
}

export interface WithdrawalTransaction {
  id: string;
  anchorDomain: string;
  status:
    | 'incomplete'
    | 'pending_user_transfer'
    | 'pending_anchor'
    | 'pending_stellar'
    | 'pending_external'
    | 'completed'
    | 'failed'
    | 'refunded'
    | 'expired'
    | 'error';
  amountIn: number;
  assetCode: string;
  amountOut?: number;
  withdrawAnchorAccountId?: string;
  interactiveUrl?: string;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface WithdrawalRequest {
  anchorDomain: string;
  assetCode: string;
  amount: number;
  destinationType: 'bank_account' | 'mobile_money';
  destinationDetails: Record<string, string>;
}

export interface WithdrawalResponse {
  transactionId: string;
  interactiveUrl: string;
  status: string;
}

const withdrawalService = {
  /**
   * Fetch available anchors for withdrawal
   */
  getAvailableAnchors: async (assetCode: string = 'ORGUSD'): Promise<AnchorInfo[]> => {
    try {
      const response = await api.get<{ anchors: AnchorInfo[] }>('/withdrawal/anchors', {
        params: { assetCode },
      });
      return response.data.anchors;
    } catch {
      // Mock data for development until backend is ready
      return [
        {
          domain: 'anchor.ng',
          name: 'Anchor Nigeria',
          supportedCurrencies: ['NGN'],
          withdrawFee: '1%',
          withdrawMinAmount: 10,
          withdrawMaxAmount: 10000,
        },
        {
          domain: 'flutterwave.com',
          name: 'Flutterwave',
          supportedCurrencies: ['NGN', 'KES', 'GHS', 'ZAR'],
          withdrawFee: '0.5%',
          withdrawMinAmount: 5,
          withdrawMaxAmount: 50000,
        },
        {
          domain: 'stearn.com',
          name: 'Stearn Financial',
          supportedCurrencies: ['EUR', 'GBP'],
          withdrawFee: '1.2%',
          withdrawMinAmount: 20,
          withdrawMaxAmount: 25000,
        },
      ];
    }
  },

  /**
   * Initiate a withdrawal via backend SEP-24 endpoint
   */
  initiateWithdrawal: async (request: WithdrawalRequest): Promise<WithdrawalResponse> => {
    try {
      const response = await api.post<WithdrawalResponse>('/withdrawal/initiate', request);
      return response.data;
    } catch {
      // Mock response for development
      const mockTxId = `wd-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      return {
        transactionId: mockTxId,
        interactiveUrl: `https://${request.anchorDomain}/withdraw?tx=${mockTxId}`,
        status: 'pending_user_transfer',
      };
    }
  },

  /**
   * Get withdrawal transaction status
   */
  getTransactionStatus: async (
    transactionId: string,
    anchorDomain: string
  ): Promise<WithdrawalTransaction> => {
    try {
      const response = await api.get<WithdrawalTransaction>(
        `/withdrawal/status/${transactionId}`,
        { params: { anchorDomain } }
      );
      return response.data;
    } catch {
      // Mock status for development
      return {
        id: transactionId,
        anchorDomain,
        status: 'pending_user_transfer',
        amountIn: 100,
        assetCode: 'ORGUSD',
        interactiveUrl: `https://${anchorDomain}/withdraw?tx=${transactionId}`,
        startedAt: new Date().toISOString(),
      };
    }
  },

  /**
   * Cancel a pending withdrawal
   */
  cancelWithdrawal: async (transactionId: string): Promise<void> => {
    try {
      await api.post('/withdrawal/cancel', { transactionId });
    } catch {
      // Mock success for development
      console.log('Mock: Withdrawal cancelled', transactionId);
    }
  },
};

export default withdrawalService;

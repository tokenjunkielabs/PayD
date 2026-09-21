import api from '../utils/api';

export interface ForecastLiquidity {
  status: 'green' | 'yellow' | 'red';
  availableBalance: number;
  requiredNext2Runs: number;
  shortfallNext2Runs: number;
  assetCode: string;
  assetIssuer: string;
  distributionAccount: string;
}

export interface ForecastRun {
  runTimestamp: string;
  scheduleId: number;
  grossAmount: number;
  taxAmount: number;
  benefitsAmount: number;
  totalLiability: number;
  assetCode: string;
  assetIssuer: string;
}

export interface ForecastMonthlyPoint {
  month: string;
  projectedTotalLiability: number;
  actualTotalCost?: number;
}

export interface ForecastResponse {
  organizationId: number;
  monthsForward: number;
  nextRuns: ForecastRun[];
  liquidity: ForecastLiquidity;
  fxRisk?: {
    baseCurrency: string;
    quoteCurrency: string;
    dailyVolatility: number | null;
    points: Array<{ rateDate: string; rate: number }>;
  };
  monthly: ForecastMonthlyPoint[];
}

export interface LiquiditySettings {
  distributionAccount: string;
  assetIssuer: string;
  assetCode?: string;
  benefitsRatePct?: number;
  yellowBufferPct?: number;
  alertEmails?: string[];
}

export const getForecast = async (monthsForward: number = 6): Promise<ForecastResponse> => {
  const { data } = await api.get<{ success: boolean; data: ForecastResponse }>('/v1/forecast', {
    params: { monthsForward },
  });
  return data.data;
};

export const getLiquiditySettings = async (): Promise<LiquiditySettings | null> => {
  const { data } = await api.get<{ success: boolean; data: LiquiditySettings | null }>(
    '/v1/forecast/settings'
  );
  return data.data;
};

export const updateLiquiditySettings = async (
  input: LiquiditySettings
): Promise<LiquiditySettings> => {
  const { data } = await api.put<{ success: boolean; data: LiquiditySettings }>(
    '/v1/forecast/settings',
    input
  );
  return data.data;
};

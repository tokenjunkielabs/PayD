import api from '../utils/api';

export interface DraftPayslipLine {
  source: 'deduction_rule' | 'tax_rule';
  source_id: number;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
  amount: number;
  destination_wallet_address: string | null;
  destination_kind: 'treasury' | 'provider';
}

export interface DraftPayslip {
  organization_id: number;
  employee_id: number;
  currency: string;
  gross_amount: number;
  lines: DraftPayslipLine[];
  total_deductions: number;
  net_amount: number;
}

export const getMyDeductionsDraftPayslip = async (): Promise<DraftPayslip> => {
  const { data } = await api.get<{ success: boolean; data: DraftPayslip }>(
    '/v1/benefits/me/deductions'
  );

  return data.data;
};

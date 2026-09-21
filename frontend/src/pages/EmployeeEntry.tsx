import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Icon, Button, Card, Input, Select, Alert } from '@stellar/design-system';
import { EmployeeList } from '../components/EmployeeList';
import { AutosaveIndicator } from '../components/AutosaveIndicator';
import { WalletQRCode } from '../components/WalletQRCode';
import { useAutosave } from '../hooks/useAutosave';
import { generateWallet } from '../services/stellar';
import { useTranslation } from 'react-i18next';
import { useNotification } from '../hooks/useNotification';

import api from '../utils/api';

interface EmployeeFormState {
  fullName: string;
  walletAddress: string;
  role: string;
  currency: string;
  email: string; // Added email
}

interface EmployeeItem {
  id: string;
  name: string;
  email: string;
  imageUrl?: string;
  position: string;
  wallet?: string;
  status?: 'Active' | 'Inactive';
}

const initialFormState: EmployeeFormState = {
  fullName: '',
  walletAddress: '',
  role: 'contractor',
  currency: 'USDC',
  email: '',
};

interface BackendEmployee {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  position?: string;
  job_title?: string;
  wallet_address: string;
  status: string;
}

export default function EmployeeEntry() {
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState<EmployeeFormState>(initialFormState);
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{
    message: string;
    secretKey?: string;
    walletAddress?: string;
    employeeName?: string;
  } | null>(null);

  const { notifySuccess } = useNotification();
  const { saving, lastSaved, loadSavedData } = useAutosave<EmployeeFormState>(
    'employee-entry-draft',
    formData
  );
  const { t } = useTranslation();

  const fetchEmployees = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get<{ data: BackendEmployee[] }>('/employees');
      const employeeRows = Array.isArray(response.data?.data) ? response.data.data : [];
      const mapped: EmployeeItem[] = employeeRows.map((emp: BackendEmployee) => ({
        id: String(emp.id),
        name: `${emp.first_name} ${emp.last_name}`,
        email: emp.email,
        position: emp.position ?? emp.job_title ?? 'Employee',
        wallet: emp.wallet_address,
        status: emp.status === 'active' ? ('Active' as const) : ('Inactive' as const),
      }));
      setEmployees(mapped);
    } catch (err) {
      console.error('Failed to fetch employees:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEmployees();
  }, [fetchEmployees]);

  useEffect(() => {
    const saved = loadSavedData();
    if (saved) {
      setFormData(saved);
    }
  }, [loadSavedData]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev: EmployeeFormState) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (name: string, value: string) => {
    setFormData((prev: EmployeeFormState) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    let generatedWallet: { publicKey: string; secretKey: string } | undefined;
    if (!formData.walletAddress) {
      generatedWallet = generateWallet();
    }

    const walletAddress = generatedWallet ? generatedWallet.publicKey : formData.walletAddress;

    // Split name into first and last
    const nameParts = formData.fullName.trim().split(' ');
    const firstName = nameParts[0] || 'Unknown';
    const lastName = nameParts.slice(1).join(' ') || 'Employee';

    const payload = {
      first_name: firstName,
      last_name: lastName,
      email: formData.email,
      wallet_address: walletAddress,
      position: formData.role, // Mapping role to position for now as per minimal demo
      base_salary: 0, // Default for now
      base_currency: formData.currency,
      status: 'active',
    };

    try {
      await api.post('/employees', payload);

      notifySuccess(
        `${formData.fullName} added successfully!`,
        generatedWallet ? 'A new Stellar wallet was generated for this employee.' : undefined
      );

      setNotification({
        message: `Employee ${formData.fullName} added successfully! ${
          generatedWallet ? 'A wallet was created for them.' : ''
        }`,
        secretKey: generatedWallet?.secretKey,
        walletAddress,
        employeeName: formData.fullName,
      });

      // Reset form and refresh list
      setFormData(initialFormState);
      void fetchEmployees();
    } catch (error) {
      console.error('Failed to add employee:', error);
    }
  };

  if (isAdding) {
    return (
      <div
        style={{
          maxWidth: notification?.walletAddress ? '800px' : '600px',
          margin: '2rem auto',
          padding: '0 1rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}
        >
          <div
            className="cursor-pointer"
            style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}
          >
            <button
              onClick={() => setIsAdding(false)}
              className="text-muted cursor-pointer hover:text-text transition-colors"
              title="Back to Directory"
            >
              <Icon.ArrowLeft />
            </button>
            <h1
              style={{
                fontWeight: 'bold',
                fontSize: '1.5rem',
                margin: 0,
              }}
            >
              Add New Employee
            </h1>
          </div>
          <AutosaveIndicator saving={saving} lastSaved={lastSaved} />
        </div>

        {notification && notification.walletAddress && (
          <div style={{ marginBottom: '1.5rem' }}>
            <WalletQRCode
              walletAddress={notification.walletAddress}
              secretKey={notification.secretKey}
              employeeName={notification.employeeName}
            />
            {notification.secretKey && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '1rem',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  color: 'var(--accent2)',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  fontSize: '0.875rem',
                }}
              >
                <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
                  [SIMULATED EMAIL NOTIFICATION TO EMPLOYEE]
                </strong>
                Hello {formData.fullName}, your employer has added you to the payroll.
                <br />
                A default Stellar wallet has been created for you to receive claimable balances.
                <br />
                <b style={{ display: 'block', marginTop: '0.5rem' }}>Your Secret Key:</b>{' '}
                <code style={{ wordBreak: 'break-all' }}>{notification.secretKey}</code>
                <br />
                <i style={{ display: 'block', marginTop: '0.5rem' }}>
                  Please save this secret key securely to claim your future salary.
                </i>
              </div>
            )}
          </div>
        )}

        {notification && !notification.walletAddress && (
          <div style={{ marginBottom: '1.5rem' }}>
            <Alert variant="success" title="Success" placement="inline">
              {notification.message}
            </Alert>
          </div>
        )}

        <Card>
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
          >
            <Input
              id="fullName"
              fieldSize="md"
              label="Full Name"
              name="fullName"
              value={formData.fullName}
              onChange={handleChange}
              placeholder="Jane Smith"
              required
            />
            <Input
              id="email"
              fieldSize="md"
              label="Email Address"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="jane.smith@example.com"
              required
            />
            <Input
              id="walletAddress"
              fieldSize="md"
              label="Stellar Wallet Address (Optional)"
              note="If no wallet is provided, a claimable balance will be created using a new wallet generated for them."
              name="walletAddress"
              value={formData.walletAddress}
              onChange={handleChange}
              placeholder="Leave blank to generate a wallet"
            />
            <Select
              id="role"
              fieldSize="md"
              label="Role"
              value={formData.role}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                handleSelectChange('role', e.target.value)
              }
            >
              <option value="contractor">Contractor</option>
              <option value="full-time">Full Time</option>
              <option value="part-time">Part Time</option>
            </Select>
            <Select
              id="currency"
              fieldSize="md"
              label="Preferred Currency"
              value={formData.currency}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                handleSelectChange('currency', e.target.value)
              }
            >
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
              <option value="EURC">EURC</option>
            </Select>
            <Button type="submit" variant="primary" size="md">
              Add Employee
            </Button>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-start p-12 max-w-6xl mx-auto w-full">
      <div className="w-full mb-12 flex items-end justify-between border-b border-hi pb-8">
        <div>
          <h1 className="text-4xl font-black mb-2 tracking-tight">
            {t('employees.title', { highlight: '' }).replace('{{highlight}}', '')}
            <span className="text-accent"> {t('employees.titleHighlight')}</span>
          </h1>
          <p className="text-muted font-mono text-sm tracking-wider uppercase">
            {t('employees.subtitle')}
          </p>
        </div>
        <button
          id="tour-add-employee"
          onClick={() => setIsAdding(true)}
          className="px-5 py-2.5 bg-accent text-bg font-bold rounded-lg hover:bg-accent/90 transition-all flex items-center gap-2 text-sm shadow-lg shadow-accent/10"
        >
          <Icon.Plus size="sm" />
          {t('employees.addEmployee')}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center p-12">
          <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <EmployeeList
          employees={employees}
          onEmployeeClick={(employee: EmployeeItem) => console.log('Clicked:', employee.name)}
          onAddEmployee={(employee: EmployeeItem) => console.log('Added:', employee)}
        />
      )}
    </div>
  );
}

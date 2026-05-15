import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TenantForm } from './TenantForm';
import * as tenantUpdateModule from '@/queries/tenantUpdate';
import type { TenantMeDto } from '@/queries/tenantMe';

const baseTenant: TenantMeDto = {
  id: 't-1',
  businessName: 'Officina Rossi',
  vatNumber: '01234567890',
  email: 'info@rossi.test',
  phone: '+39 02 1234567',
  addressLine: 'Via Verdi 1',
  city: 'Milano',
  province: 'MI',
  postalCode: '20100',
  status: 'active',
  plan: 'pilot',
  billingStatus: 'ok',
  createdAt: '2026-05-15T00:00:00Z',
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('TenantForm', () => {
  let mockMutate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockMutate = vi.fn().mockResolvedValue(baseTenant);
    vi.spyOn(tenantUpdateModule, 'useTenantUpdate').mockReturnValue({
      mutateAsync: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof tenantUpdateModule.useTenantUpdate>);
  });

  it('renders P. IVA as read-only display', () => {
    render(wrap(<TenantForm tenant={baseTenant} />));
    expect(screen.getByText('01234567890')).toBeInTheDocument();
  });

  it('renders defaultValues from tenant prop', () => {
    render(wrap(<TenantForm tenant={baseTenant} />));
    expect(screen.getByLabelText('Ragione sociale')).toHaveValue('Officina Rossi');
    expect(screen.getByLabelText('Provincia')).toHaveValue('MI');
    expect(screen.getByLabelText('CAP')).toHaveValue('20100');
  });

  it('submits diff only for changed fields', async () => {
    render(wrap(<TenantForm tenant={baseTenant} />));
    fireEvent.change(screen.getByLabelText('Indirizzo'), {
      target: { value: 'Via Roma 99' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(mockMutate).toHaveBeenCalledWith({ addressLine: 'Via Roma 99' });
  });

  it('rejects postalCode with 4 digits', async () => {
    render(wrap(<TenantForm tenant={baseTenant} />));
    fireEvent.change(screen.getByLabelText('CAP'), { target: { value: '2010' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('CAP: 5 cifre')).toBeInTheDocument();
    });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('rejects malformed email', async () => {
    render(wrap(<TenantForm tenant={baseTenant} />));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Email non valida')).toBeInTheDocument();
    });
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

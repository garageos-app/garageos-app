import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CustomerDetail } from './CustomerDetail';
import { ApiError } from '@/lib/api-client';
import type { CustomerDetail as CustomerDetailDto } from '@/queries/types';

const { apiFetchMock, navigateMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const FIXTURE: CustomerDetailDto = {
  id: CUSTOMER_ID,
  email: 'mario@example.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+39 333 1234567',
  taxCode: 'RSSMRA80A01H501Z',
  isBusiness: false,
  businessName: null,
  vatNumber: null,
  addressLine: 'Via Roma 1',
  city: 'Roma',
  province: 'RM',
  postalCode: '00100',
  status: 'active',
  createdAt: '2026-01-15T10:30:00.000Z',
  tenantRelation: {
    tenantNotes: 'Cliente VIP',
    interventionCount: 3,
    firstInterventionAt: '2025-01-15T10:00:00.000Z',
    lastInterventionAt: '2026-04-30T09:00:00.000Z',
  },
  vehicles: [{ id: 'v1', plate: 'AB123CD', make: 'Fiat', model: 'Panda', year: 2018 }],
};

function renderRoute(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/customers/${CUSTOMER_ID}`]}>
        <Routes>
          <Route path="/customers/:id" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  navigateMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetail (view mode)', () => {
  it('renders all sections from DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(FIXTURE);
    renderRoute(<CustomerDetail />);
    await waitFor(() => screen.getByRole('heading', { name: 'Mario Rossi' }));
    expect(screen.getByText('mario@example.it', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getAllByText('Mario').length).toBeGreaterThan(0);
    expect(screen.getByText('RSSMRA80A01H501Z')).toBeInTheDocument();
    expect(screen.getByText(/Via Roma 1/)).toBeInTheDocument();
    expect(screen.getByText('Cliente VIP')).toBeInTheDocument();
    expect(screen.getByText(/AB123CD/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Modifica/i })).toBeInTheDocument();
  });

  it('renders B2B header (businessName + B2B badge) when isBusiness=true', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ...FIXTURE,
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: '12345678901',
    });
    renderRoute(<CustomerDetail />);
    expect(await screen.findByRole('heading', { name: 'Rossi SRL' })).toBeInTheDocument();
    expect(screen.getByText('B2B')).toBeInTheDocument();
    expect(screen.getByText('12345678901')).toBeInTheDocument();
  });

  it('renders empty vehicles state', async () => {
    apiFetchMock.mockResolvedValueOnce({ ...FIXTURE, vehicles: [] });
    renderRoute(<CustomerDetail />);
    expect(await screen.findByText(/Nessun veicolo associato/i)).toBeInTheDocument();
  });

  it('shows loading skeleton while query pending', () => {
    apiFetchMock.mockImplementationOnce(() => new Promise(() => {})); // pending forever
    renderRoute(<CustomerDetail />);
    expect(screen.getByTestId('customer-detail-skeleton')).toBeInTheDocument();
  });

  it('redirects to / on 404', async () => {
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('customer.not_found', 404, 'Cliente non trovato'),
    );
    renderRoute(<CustomerDetail />);
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Cliente non trovato'));
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows error alert with refetch button on non-404 errors', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('server.error', 500, 'Boom'));
    renderRoute(<CustomerDetail />);
    expect(await screen.findByRole('button', { name: /Riprova/i })).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('email is rendered with "non modificabile" badge', async () => {
    apiFetchMock.mockResolvedValueOnce(FIXTURE);
    renderRoute(<CustomerDetail />);
    await waitFor(() => screen.getByRole('heading', { name: 'Mario Rossi' }));
    expect(screen.getByText(/non modificabile/i)).toBeInTheDocument();
  });
});

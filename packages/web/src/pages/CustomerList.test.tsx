import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CustomerList } from './CustomerList';
import type { CustomerListResponse } from '@/queries/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<CustomerList />, { wrapper: Wrapper });
}

const onePage: CustomerListResponse = {
  data: [
    {
      id: 'c1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    },
    {
      id: 'c2',
      firstName: 'Anna',
      lastName: 'Bianchi',
      phone: null,
      isBusiness: false,
      businessName: null,
      vehicleCount: 0,
      lastInterventionAt: null,
    },
  ],
  meta: { has_more: false },
};

describe('CustomerList', () => {
  beforeEach(() => apiFetchMock.mockReset());
  afterEach(() => vi.clearAllTimers());

  it('renders customer rows with name, phone, vehicle count, last intervention', async () => {
    apiFetchMock.mockResolvedValueOnce(onePage);
    renderPage();

    expect(await screen.findByText('Rossi Mario')).toBeInTheDocument();
    expect(screen.getByText('Bianchi Anna')).toBeInTheDocument();
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument();
    // Last intervention null shows "Nessuno".
    expect(screen.getByText('Nessuno')).toBeInTheDocument();
  });

  it('shows the empty state when no customers match', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: [], meta: { has_more: false } });
    renderPage();
    expect(await screen.findByText(/nessun cliente/i)).toBeInTheDocument();
  });

  it('shows an error alert with retry on failure', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument();
  });

  it('passes the typed query to the API (debounced)', async () => {
    apiFetchMock.mockResolvedValue(onePage);
    renderPage();
    await screen.findByText('Rossi Mario');

    const input = screen.getByPlaceholderText(/cerca per nome/i);
    await userEvent.type(input, 'ross');

    await waitFor(
      () => expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?q=ross&limit=20'),
      {
        timeout: 2000,
      },
    );
  });

  it('shows "Carica altre" when there is a next page', async () => {
    apiFetchMock.mockResolvedValueOnce({ ...onePage, meta: { has_more: true, cursor: 'CUR1' } });
    renderPage();
    expect(await screen.findByRole('button', { name: /carica altre/i })).toBeInTheDocument();
  });
});

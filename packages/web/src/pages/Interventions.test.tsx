import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { Interventions } from './Interventions';
import type { InterventionsListResponse } from '@/queries/interventionsList';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

// Filter-bar data sources are exercised in their own tests; stub them here.
vi.mock('@/queries/interventionTypes', () => ({
  useInterventionTypes: () => ({ data: { data: [] }, isPending: false }),
}));
vi.mock('@/queries/users-admin', () => ({
  useUsers: () => ({ data: { users: [] }, isPending: false }),
}));
vi.mock('@/auth/useHasRole', () => ({
  useHasRole: () => false,
}));

const ONE_ITEM: InterventionsListResponse = {
  items: [
    {
      id: 'i-1',
      interventionDate: '2026-07-01',
      odometerKm: 12000,
      status: 'active',
      type: { id: 't1', nameIt: 'Intervento Meccanico' },
      vehicle: { id: 'v-1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      operator: { id: 'u-1', name: 'Mario Rossi' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

function renderPage(initialEntry = '/interventions') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<Interventions />, { wrapper: Wrapper });
}

describe('Interventions page', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('renders rows from the response', async () => {
    apiFetchMock.mockResolvedValue(ONE_ITEM);
    renderPage();
    await waitFor(() => expect(screen.getByText('AB123CD')).toBeInTheDocument());
    expect(apiFetchMock.mock.calls[0]![0] as string).toContain('/v1/interventions?');
  });

  it('shows the empty state when there are no interventions', async () => {
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    renderPage();
    await waitFor(() => expect(screen.getByText(/nessun intervento trovato/i)).toBeInTheDocument());
  });

  it('drives the query from the URL query string', async () => {
    apiFetchMock.mockResolvedValue(ONE_ITEM);
    renderPage('/interventions?status=cancelled&page=2');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const url = apiFetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('status=cancelled');
    expect(url).toContain('page=2');
  });
});

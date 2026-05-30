import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useInterventionsRecent } from './interventionsRecent';
import type { InterventionsRecentResponse, RecentIntervention } from './interventionsRecent';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const ITEM: RecentIntervention = {
  id: 'i1',
  createdAt: '2026-05-23T10:00:00.000Z',
  status: 'active',
  summary: 'Tagliando',
  vehicle: { id: 'v1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  operator: { id: 'u1', name: 'Giuseppe Rossi' },
};

describe('useInterventionsRecent', () => {
  it('fires the query with the default limit=10', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/recent?limit=10');
  });

  it('passes a custom limit through to the URL', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(25), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/recent?limit=25');
  });

  it('unwraps and returns res.items', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [ITEM] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([ITEM]);
  });
});

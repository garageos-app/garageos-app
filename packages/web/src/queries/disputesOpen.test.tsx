import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useDisputesOpen } from './disputesOpen';
import type { DisputesOpenResponse } from './disputesOpen';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

const filterRef = { current: { selectedLocationId: null as string | null } };
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: DisputesOpenResponse = {
  pendingResponse: { count: 0, items: [] },
  inProgress: { count: 0, items: [] },
};

describe('useDisputesOpen', () => {
  it('fetches without location_id when no sede is selected', async () => {
    filterRef.current = { selectedLocationId: null };
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDisputesOpen(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/disputes/open');
  });

  it('appends location_id and keys the query by the selected sede', async () => {
    filterRef.current = { selectedLocationId: 'loc-b' };
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDisputesOpen(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/disputes/open?location_id=loc-b');
    filterRef.current = { selectedLocationId: null };
  });
});

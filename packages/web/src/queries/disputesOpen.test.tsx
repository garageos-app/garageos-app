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

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: DisputesOpenResponse = {
  pendingResponse: { count: 0, items: [] },
  inProgress: { count: 0, items: [] },
};

describe('useDisputesOpen', () => {
  it('fetches /v1/disputes/open', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDisputesOpen(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/disputes/open');
  });
});

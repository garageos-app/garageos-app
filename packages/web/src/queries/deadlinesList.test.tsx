import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useDeadlinesList } from './deadlinesList';
import type { DeadlinesListResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: DeadlinesListResponse = { deadlines: [], nextCursor: null };

describe('useDeadlinesList', () => {
  it('fires the query and includes status=open by default', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDeadlinesList({}), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/deadlines?status=open&limit=50');
  });

  it('passes intervention_type_id when provided', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const typeId = '11111111-1111-4111-8111-111111111111';
    const { result } = renderHook(() => useDeadlinesList({ interventionTypeId: typeId }), {
      wrapper: wrap,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/v1/deadlines?status=open&intervention_type_id=${typeId}&limit=50`,
    );
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useInterventionRevisions } from './interventionRevisions';
import { ApiError } from '@/lib/api-client';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useInterventionRevisions', () => {
  it('fetches /v1/interventions/:id/revisions and returns DTO on success', async () => {
    const dto = {
      data: [
        {
          id: 'rev-111',
          revised_at: '2026-05-10T10:00:00.000Z',
          reason: 'Typo fix',
          changes: { description: { before: 'old', after: 'new' } },
          user: { id: 'user-1', first_name: 'Mario', last_name: 'Rossi' },
        },
      ],
      meta: { has_more: false },
    };
    apiFetchMock.mockResolvedValueOnce(dto);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useInterventionRevisions('11111111-1111-1111-1111-111111111111'),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(dto);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/v1/interventions/11111111-1111-1111-1111-111111111111/revisions',
    );
  });

  it('does NOT fire when id is undefined (enabled gating)', async () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useInterventionRevisions(undefined), { wrapper: Wrapper });

    // give react-query a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('exposes ApiError 404 in result.error on backend 404', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('NOT_FOUND', 404, 'not found'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useInterventionRevisions('22222222-2222-2222-2222-222222222222'),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(404);
  });
});

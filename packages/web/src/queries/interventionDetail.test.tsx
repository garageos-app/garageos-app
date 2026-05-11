import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  useInterventionDetail,
  useCancelIntervention,
  useAttachmentViewUrl,
} from './interventionDetail';
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

describe('useInterventionDetail', () => {
  it('fetches /v1/interventions/:id and returns DTO on success', async () => {
    const dto = {
      id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
    };
    apiFetchMock.mockResolvedValueOnce(dto);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useInterventionDetail('11111111-1111-1111-1111-111111111111'),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(dto);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/v1/interventions/11111111-1111-1111-1111-111111111111',
    );
  });

  it('does NOT fire when id is undefined (enabled gating)', async () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useInterventionDetail(undefined), { wrapper: Wrapper });

    // give react-query a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('exposes ApiError 404 in result.error on backend 404', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('NOT_FOUND', 404, 'not found'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useInterventionDetail('22222222-2222-2222-2222-222222222222'),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(404);
  });
});

describe('useCancelIntervention', () => {
  it('POSTs to /:id/cancel with {reason} and resolves on success', async () => {
    apiFetchMock.mockResolvedValueOnce({
      intervention: { id: '33333333-3333-3333-3333-333333333333', status: 'cancelled' },
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useCancelIntervention('33333333-3333-3333-3333-333333333333'),
      { wrapper: Wrapper },
    );

    const reason = 'A'.repeat(25);
    await act(async () => {
      await result.current.mutateAsync({ reason });
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/v1/interventions/33333333-3333-3333-3333-333333333333/cancel',
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  });

  it('invalidates the 4 expected query keys on success', async () => {
    apiFetchMock.mockResolvedValueOnce({
      intervention: { id: '33333333-3333-3333-3333-333333333333', status: 'cancelled' },
    });

    const { Wrapper, qc } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const id = '33333333-3333-3333-3333-333333333333';
    const { result } = renderHook(() => useCancelIntervention(id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ reason: 'A'.repeat(25) });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['intervention-detail', id] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['intervention-disputes', id] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['intervention-revisions', id] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle-timeline'] });
  });
});

describe('useAttachmentViewUrl', () => {
  it('GETs /v1/attachments/:id/view-url and returns {url, expires_at}', async () => {
    apiFetchMock.mockResolvedValueOnce({
      url: 'https://s3/x',
      expires_at: '2026-05-11T12:00:00.000Z',
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAttachmentViewUrl(), { wrapper: Wrapper });

    let out: { url: string; expires_at: string } | undefined;
    await act(async () => {
      out = await result.current.mutateAsync('44444444-4444-4444-4444-444444444444');
    });

    expect(out?.url).toBe('https://s3/x');
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/v1/attachments/44444444-4444-4444-4444-444444444444/view-url',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useInterventionDisputes, useRespondToDispute } from './interventionDisputes';
import type { InterventionDispute, InterventionDisputesResponse } from './types';
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

const sampleOpenDispute: InterventionDispute = {
  id: 'd1',
  reasonCategory: 'not_performed',
  customerDescription: 'Il lavoro non è stato eseguito.',
  status: 'open',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2026-04-01T10:00:00.000Z',
  resolvedAt: null,
};

describe('useInterventionDisputes', () => {
  it('fetches /v1/interventions/:id/disputes and exposes the array', async () => {
    apiFetchMock.mockClear();
    const sample: InterventionDisputesResponse = { disputes: [sampleOpenDispute] };
    apiFetchMock.mockResolvedValueOnce(sample);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useInterventionDisputes('int-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/int-1/disputes');
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].id).toBe('d1');
  });

  it('does not fire when enabled=false', () => {
    apiFetchMock.mockClear();
    const { Wrapper } = makeWrapper();
    renderHook(() => useInterventionDisputes('int-1', { enabled: false }), { wrapper: Wrapper });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('surfaces 404 errors as ApiError', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('intervention.not_found', 404, 'Intervento non trovato'),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useInterventionDisputes('int-missing'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('intervention.not_found');
  });
});

describe('useRespondToDispute', () => {
  it('POSTs the body and invalidates 2 query keys on success', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      disputes: [
        {
          ...sampleOpenDispute,
          status: 'responded',
          tenantResponse: 'OK',
          tenantResponseAt: '2026-05-10T09:00:00.000Z',
        },
      ],
      interventionStatus: 'active',
    });

    const { Wrapper, qc } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRespondToDispute('int-1', 'veh-9'), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        disputeId: 'd1',
        tenantResponse: 'Risposta tecnica articolata di almeno 20 caratteri.',
      });
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/int-1/dispute-response', {
      method: 'POST',
      body: JSON.stringify({
        disputeId: 'd1',
        tenantResponse: 'Risposta tecnica articolata di almeno 20 caratteri.',
      }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['intervention-disputes', 'int-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle-timeline', 'veh-9'] });
  });

  it('does not invalidate on mutation error', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('intervention.dispute.response.no_active_dispute', 409, 'Non più aperta'),
    );
    const { Wrapper, qc } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRespondToDispute('int-1', 'veh-9'), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ disputeId: 'd1', tenantResponse: 'x'.repeat(20) }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

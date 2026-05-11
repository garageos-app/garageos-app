import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useUpdateIntervention } from './updateIntervention';
import { ApiError } from '@/lib/api-client';

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe('useUpdateIntervention', () => {
  it('happy path: PATCHes the endpoint and invalidates the timeline query', async () => {
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' } });
    const { qc, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await result.current.mutateAsync({
      id: 'i-1',
      body: { description: 'updated' },
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/v1/interventions/i-1', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'updated' }),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['vehicle-timeline', 'v-1'],
    });
  });

  it('propagates 400 revision_reason_required to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.revision_reason_required', 400, 'reason required'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { description: 'updated' } }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'intervention.modification.revision_reason_required',
    });
  });

  it('propagates 422 disputed error to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.disputed', 422, 'disputed'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 422, code: 'intervention.modification.disputed' });
  });

  it('propagates 422 cancelled error to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.cancelled', 422, 'cancelled'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 422, code: 'intervention.modification.cancelled' });
  });

  it('propagates 403/404/5xx errors', async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError('not_found', 404, 'not found'));
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { description: 'x' } }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useDeadlinesUpcoming } from './deadlinesUpcoming';
import type { DeadlinesListResponse, TenantDeadline } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function makeDeadline(overrides: Partial<TenantDeadline> = {}): TenantDeadline {
  return {
    id: overrides.id ?? 'd1',
    vehicleId: 'v1',
    interventionTypeId: 't1',
    dueDate: overrides.dueDate ?? null,
    dueOdometerKm: null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: 'v1',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: null,
    },
    interventionType: { id: 't1', code: 'maint', nameIt: 'Manutenzione' },
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useDeadlinesUpcoming', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('filters deadlines outside the [today, +daysAhead] window', async () => {
    const today = new Date();
    const inWindow = new Date(today);
    inWindow.setDate(today.getDate() + 3);
    const outOfWindow = new Date(today);
    outOfWindow.setDate(today.getDate() + 30);

    const response: DeadlinesListResponse = {
      deadlines: [
        makeDeadline({ id: 'in', dueDate: inWindow.toISOString().slice(0, 10) }),
        makeDeadline({ id: 'out', dueDate: outOfWindow.toISOString().slice(0, 10) }),
      ],
      nextCursor: null,
    };
    apiFetchMock.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.map((d) => d.id)).toEqual(['in']);
  });

  it('excludes deadlines with null dueDate', async () => {
    apiFetchMock.mockResolvedValueOnce({
      deadlines: [makeDeadline({ id: 'null', dueDate: null })],
      nextCursor: null,
    } satisfies DeadlinesListResponse);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('orders results by dueDate ASC (server may not guarantee for partial filter)', async () => {
    const today = new Date();
    const day2 = new Date(today);
    day2.setDate(today.getDate() + 2);
    const day5 = new Date(today);
    day5.setDate(today.getDate() + 5);

    apiFetchMock.mockResolvedValueOnce({
      deadlines: [
        makeDeadline({ id: 'd5', dueDate: day5.toISOString().slice(0, 10) }),
        makeDeadline({ id: 'd2', dueDate: day2.toISOString().slice(0, 10) }),
      ],
      nextCursor: null,
    } satisfies DeadlinesListResponse);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.map((d) => d.id)).toEqual(['d2', 'd5']);
  });

  it('includes deadlines exactly at today (lower bound) and today+daysAhead (upper bound)', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(today.getDate() + 7);

    const fmt = (d: Date) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    apiFetchMock.mockResolvedValueOnce({
      deadlines: [
        makeDeadline({ id: 'lower', dueDate: fmt(today) }),
        makeDeadline({ id: 'upper', dueDate: fmt(horizon) }),
      ],
      nextCursor: null,
    } satisfies DeadlinesListResponse);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.map((d) => d.id).sort()).toEqual(['lower', 'upper']);
  });

  it('calls /v1/deadlines with status=open and limit=50', async () => {
    apiFetchMock.mockResolvedValueOnce({ deadlines: [], nextCursor: null });
    renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/v1/deadlines');
    expect(url).toContain('status=open');
    expect(url).toContain('limit=50');
  });
});

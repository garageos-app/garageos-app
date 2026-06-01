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

const filterRef = { current: { selectedLocationId: null as string | null } };
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
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

  // The API serializes Prisma DateTime as a full ISO timestamp
  // (`"YYYY-MM-DDT00:00:00.000Z"`), not a date-only string. These fixtures
  // mirror the real API output. A prior version of this hook used
  // `dueDate.split('-')` directly and silently produced `NaN` on real
  // payloads, filtering all deadlines out — caught only by operator smoke
  // (PR #126/#127). Always test against ISO timestamps here.
  function isoMidnight(d: Date): string {
    // Use local date components: Prisma serializes `DATE` columns as
    // `"YYYY-MM-DDT00:00:00.000Z"` where the YYYY-MM-DD reflects the stored
    // date with no timezone offset (DATE has no time/tz). Mirror that here
    // so a date created locally still produces the correct YYYY-MM-DD prefix.
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
  }

  it('filters deadlines outside the [today, +daysAhead] window', async () => {
    const today = new Date();
    const inWindow = new Date(today);
    inWindow.setDate(today.getDate() + 3);
    const outOfWindow = new Date(today);
    outOfWindow.setDate(today.getDate() + 30);

    const response: DeadlinesListResponse = {
      deadlines: [
        makeDeadline({ id: 'in', dueDate: isoMidnight(inWindow) }),
        makeDeadline({ id: 'out', dueDate: isoMidnight(outOfWindow) }),
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
        makeDeadline({ id: 'd5', dueDate: isoMidnight(day5) }),
        makeDeadline({ id: 'd2', dueDate: isoMidnight(day2) }),
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

    apiFetchMock.mockResolvedValueOnce({
      deadlines: [
        makeDeadline({ id: 'lower', dueDate: isoMidnight(today) }),
        makeDeadline({ id: 'upper', dueDate: isoMidnight(horizon) }),
      ],
      nextCursor: null,
    } satisfies DeadlinesListResponse);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.map((d) => d.id).sort()).toEqual(['lower', 'upper']);
  });

  it('parses ISO timestamp dueDate as returned by the real API', async () => {
    // Verbatim shape of the API response observed in prod (PR #127 root cause).
    const today = new Date();
    const inWindow = new Date(today);
    inWindow.setDate(today.getDate() + 5);
    const isoString = isoMidnight(inWindow);
    expect(isoString).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    apiFetchMock.mockResolvedValueOnce({
      deadlines: [makeDeadline({ id: 'iso-fixture', dueDate: isoString })],
      nextCursor: null,
    } satisfies DeadlinesListResponse);

    const { result } = renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.map((d) => d.id)).toEqual(['iso-fixture']);
  });

  it('calls /v1/deadlines with status=open and limit=50', async () => {
    apiFetchMock.mockResolvedValueOnce({ deadlines: [], nextCursor: null });
    renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/v1/deadlines');
    expect(url).toContain('status=open');
    expect(url).toContain('limit=50');
    expect(url).not.toContain('location_id');
  });

  it('appends location_id when a sede is selected', async () => {
    filterRef.current = { selectedLocationId: 'loc-b' };
    apiFetchMock.mockResolvedValueOnce({ deadlines: [], nextCursor: null });
    renderHook(() => useDeadlinesUpcoming(7), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('location_id=loc-b');
    filterRef.current = { selectedLocationId: null };
  });
});

import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import type { DeadlinesListResponse, TenantDeadline } from './types';

/**
 * Top-N upcoming open deadlines for the calling tenant, restricted to the
 * window [today, today + daysAhead]. Endpoint `/v1/deadlines` does not
 * accept date filters (see packages/api/src/routes/v1/deadlines-list-tenant.ts),
 * so the window filter and ordering are applied client-side after fetching
 * a single page of up to 50 open deadlines.
 *
 * Deadlines with `dueDate === null` are excluded (no due date = not in the
 * 7-day window by definition).
 */
export function useDeadlinesUpcoming(daysAhead: number) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['deadlines-upcoming', daysAhead] as const,
    queryFn: async (): Promise<TenantDeadline[]> => {
      const params = new URLSearchParams();
      params.set('status', 'open');
      params.set('limit', '50');
      const res = await apiFetch<DeadlinesListResponse>(`/v1/deadlines?${params.toString()}`);

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const horizon = new Date(today);
      horizon.setDate(today.getDate() + daysAhead);

      return res.deadlines
        .filter((d) => {
          if (!d.dueDate) return false;
          const due = new Date(d.dueDate);
          return due >= today && due <= horizon;
        })
        .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0));
    },
    staleTime: 60_000,
  });
}

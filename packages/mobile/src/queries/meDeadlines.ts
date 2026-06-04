// useMeDeadlines — TanStack Query hook for GET /v1/me/deadlines.
// Returns the open+overdue deadlines across the customer's owned vehicles
// (server default filter), urgency-ordered by the endpoint. Projects the
// wrapper down to MeDeadline[] via select(); nextCursor is dropped pending
// infinite-scroll work. Mirrors src/queries/meVehicles.ts.
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { MeDeadline, MeDeadlinesResponse } from '@/lib/types/deadline';

export function useMeDeadlines() {
  const api = useApiClient();
  return useQuery<MeDeadlinesResponse, Error, MeDeadline[]>({
    queryKey: ['me', 'deadlines'],
    queryFn: () => api.fetch<MeDeadlinesResponse>('/v1/me/deadlines'),
    select: (r) => r.deadlines,
  });
}

// Client-side per-vehicle filter. /v1/me/deadlines has no vehicleId query
// param; at B2C scale fetching the full open+overdue set and filtering here
// reuses the shared ['me','deadlines'] cache (F-CLI-106 vehicle-detail tab).
export function deadlinesForVehicle(
  deadlines: MeDeadline[] | undefined,
  vehicleId: string,
): MeDeadline[] {
  return deadlines?.filter((d) => d.vehicleId === vehicleId) ?? [];
}

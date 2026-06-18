import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { TimelineOfficineResponse, TimelineResponse } from './types';

// `tenantIds` filters shop interventions to the selected officine. Empty ⇒
// no filter (all officine). The selection is part of the query key so a
// filter change refetches from page 1 (server-side filter, correct pagination).
export function useVehicleTimeline(id: string | undefined, tenantIds: string[] = []) {
  const apiFetch = useApiFetch();
  // Stable, order-independent key segment for the selected officine.
  const tenantKey = [...tenantIds].sort().join(',');
  return useInfiniteQuery({
    queryKey: ['vehicle-timeline', id, tenantKey] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      if (tenantKey) search.set('tenant_ids', tenantKey);
      return apiFetch<TimelineResponse>(`/v1/vehicles/${id}/timeline?${search.toString()}`);
    },
    enabled: !!id,
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.cursor ?? undefined,
    staleTime: 5 * 60 * 1000,
  });
}

// Distinct officine present in the vehicle's shop history — feeds the filter
// dropdown and the per-officina color assignment.
export function useTimelineOfficine(id: string | undefined) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['vehicle-timeline-officine', id] as const,
    queryFn: () => apiFetch<TimelineOfficineResponse>(`/v1/vehicles/${id}/timeline/officine`),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}

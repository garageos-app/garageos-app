import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { TimelineResponse } from './types';

export function useVehicleTimeline(id: string | undefined) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['vehicle-timeline', id] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<TimelineResponse>(`/v1/vehicles/${id}/timeline?${search.toString()}`);
    },
    enabled: !!id,
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.cursor ?? undefined,
    staleTime: 5 * 60 * 1000,
  });
}

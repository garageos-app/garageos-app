import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import { useLocationFilter } from '@/location-filter/useLocationFilter';

import type { DeadlinesListResponse } from './types';

interface DeadlinesFilters {
  interventionTypeId?: string;
}

export function useDeadlinesList(filters: DeadlinesFilters) {
  const apiFetch = useApiFetch();
  const { selectedLocationId } = useLocationFilter();
  return useInfiniteQuery({
    queryKey: ['deadlines-list-tenant', filters, selectedLocationId] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('status', 'open');
      if (filters.interventionTypeId) {
        search.set('intervention_type_id', filters.interventionTypeId);
      }
      search.set('limit', '50');
      if (selectedLocationId) search.set('location_id', selectedLocationId);
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<DeadlinesListResponse>(`/v1/deadlines?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}

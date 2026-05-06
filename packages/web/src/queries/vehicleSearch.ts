import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { SearchType } from '@/lib/search-input';
import type { VehicleSearchResponse } from './types';

export function useVehicleSearch(params: { q: string; t: SearchType | null }) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['vehicle-search', params.t, params.q] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (params.t) search.set(params.t, params.q);
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<VehicleSearchResponse>(`/v1/vehicles/search?${search.toString()}`);
    },
    enabled: !!params.q && !!params.t,
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.cursor ?? undefined,
    staleTime: 30_000,
  });
}

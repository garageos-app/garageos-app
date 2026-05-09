import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import type { SearchType } from '@/lib/search-input';

import type { VehicleSearchResponse } from './types';

// Discriminated union: either a free-text search by selector type
// (vin/plate/garage_code) OR a customer-id lookup. The customer branch
// reaches /v1/vehicles/search?customer=<uuid> (PR #76) and inherits
// the same pagination contract.

export type VehicleSearchParams =
  | { kind: 'query'; q: string; t: SearchType | null }
  | { kind: 'customer'; customerId: string };

export function useVehicleSearch(params: VehicleSearchParams) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['vehicle-search', params] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (params.kind === 'customer') {
        search.set('customer', params.customerId);
      } else if (params.t) {
        search.set(params.t, params.q);
      }
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<VehicleSearchResponse>(`/v1/vehicles/search?${search.toString()}`);
    },
    enabled:
      params.kind === 'customer'
        ? !!params.customerId
        : !!params.q && !!params.t && params.t !== 'customer',
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.cursor ?? undefined,
    staleTime: 30_000,
  });
}

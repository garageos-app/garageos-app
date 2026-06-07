import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { CustomerListResponse } from './types';

// F-OFF-202 customer list. Tenant-scoped GET /v1/customers; optional name
// search via q (the caller passes an already-debounced value). Cursor
// pagination via meta.cursor (id-only opaque cursor).
export function useCustomersList(q: string) {
  const apiFetch = useApiFetch();
  const trimmed = q.trim();
  return useInfiniteQuery({
    queryKey: ['customers', 'list', trimmed] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (trimmed) search.set('q', trimmed);
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<CustomerListResponse>(`/v1/customers?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => (last.meta.has_more ? last.meta.cursor : undefined),
    staleTime: 60_000,
  });
}

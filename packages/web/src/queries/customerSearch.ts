import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { CustomerSearchResponse } from './types';

// E2 customer autocomplete officina (Persona Giuseppe demo).
// Consumes /v1/customers/search (PR #77) — tenant-scoped, ILIKE
// substring on firstName/lastName/businessName.
//
// `enabled` mirrors the backend's q >= 2 char requirement so we never
// fire a guaranteed-400 request just to prefill the dropdown.

export function useCustomerSearch(q: string) {
  const apiFetch = useApiFetch();
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['customer-search', trimmed] as const,
    queryFn: () => {
      const search = new URLSearchParams({ q: trimmed, limit: '20' });
      return apiFetch<CustomerSearchResponse>(`/v1/customers/search?${search.toString()}`);
    },
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { CustomerDetail, CustomerDetailUpdate } from './types';

export function useCustomerDetail(id: string) {
  const apiFetch = useApiFetch();
  return useQuery<CustomerDetail, ApiError>({
    queryKey: ['customer-detail', id] as const,
    queryFn: () => apiFetch<CustomerDetail>(`/v1/customers/${id}`),
    enabled: Boolean(id),
  });
}

// PATCH success invalidates 3 caches: the detail itself, plus two
// surfaces that show customer first/last name (search autocomplete,
// vehicle-search by-customer branch).
export function useUpdateCustomer(id: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<CustomerDetail, ApiError, CustomerDetailUpdate>({
    mutationFn: (body) =>
      apiFetch<CustomerDetail>(`/v1/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-detail', id] });
      qc.invalidateQueries({ queryKey: ['customer-search'] });
      qc.invalidateQueries({ queryKey: ['vehicle-search'] });
    },
  });
}

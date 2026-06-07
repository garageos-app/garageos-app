import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';

import type { CustomerCreateBody, CustomerCreateResponse } from './types';

// F-OFF-201 standalone create. Invalidates the customer list so the new
// (or newly-linked) customer appears. Navigation + toast live in the dialog,
// which needs the returned `created` flag and id.
export function useCreateCustomer() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<CustomerCreateResponse, ApiError, CustomerCreateBody>({
    mutationFn: (body) =>
      apiFetch<CustomerCreateResponse>('/v1/customers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers', 'list'] });
    },
  });
}

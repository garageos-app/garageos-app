import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError, useApiFetch } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import type { TenantMeDto } from './tenantMe';

export interface TenantUpdateBody {
  businessName?: string;
  addressLine?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string;
}

export function useTenantUpdate() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<TenantMeDto, ApiError, TenantUpdateBody>({
    mutationFn: (body) =>
      apiFetch<TenantMeDto>('/v1/tenants/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants-me'] });
      toast.success('Modifiche salvate');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

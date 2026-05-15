import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

export interface TenantMeDto {
  id: string;
  businessName: string;
  vatNumber: string | null;
  email: string;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  status: string;
  plan: string;
  billingStatus: string;
  createdAt: string;
}

export function useTenantMe(options: { enabled?: boolean } = {}) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['tenants-me'],
    queryFn: () => apiFetch<TenantMeDto>('/v1/tenants/me'),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

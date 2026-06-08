import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { ShopInterventionDetail } from '@/lib/types/intervention';

export function useMeShopInterventionDetail(id: string) {
  const api = useApiClient();
  return useQuery<ShopInterventionDetail, Error>({
    queryKey: ['me', 'intervention', id],
    queryFn: () => api.fetch<ShopInterventionDetail>(`/v1/me/interventions/${id}`),
    enabled: id.length > 0,
  });
}

// useMePrivateInterventionDetail — GET /v1/me/private-interventions/:id (F-CLI-202/204).
// Authoritative source used to prefill the edit form. Mirrors meVehicles.ts detail hook.
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { PrivateInterventionDetail } from '@/lib/types/private-intervention';

export function useMePrivateInterventionDetail(id: string) {
  const api = useApiClient();
  return useQuery<PrivateInterventionDetail, Error>({
    queryKey: ['me', 'private-intervention', id],
    queryFn: () => api.fetch<PrivateInterventionDetail>(`/v1/me/private-interventions/${id}`),
    enabled: id.length > 0,
  });
}

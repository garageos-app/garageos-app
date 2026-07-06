// useMeInterventionTypes — GET /v1/me/intervention-types (PR-1 catalog for
// private interventions). Projects the { data } wrapper to the array, mirroring
// meVehicles.ts. Long staleTime: the global catalog is admin-managed and rarely
// changes (parity with web useInterventionTypes).
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  MeInterventionType,
  MeInterventionTypesResponse,
} from '@/lib/types/private-intervention';

export function useMeInterventionTypes() {
  const api = useApiClient();
  return useQuery<MeInterventionTypesResponse, Error, MeInterventionType[]>({
    queryKey: ['me', 'intervention-types'],
    queryFn: () => api.fetch<MeInterventionTypesResponse>('/v1/me/intervention-types'),
    select: (r) => r.data,
    staleTime: 30 * 60 * 1000,
  });
}

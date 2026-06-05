// useMe — GET /v1/me (customer self-profile). useUpdateMeProfile — PATCH
// /v1/me/profile, invalidating the profile query so the Profilo tab repaints.
// Mirrors meVehicles.ts / createPrivateIntervention.ts. F-CLI-004 PR2.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { MeProfile, UpdateMeProfileBody } from '@/lib/types/profile';

export function useMe() {
  const api = useApiClient();
  return useQuery<MeProfile, Error>({
    queryKey: ['me', 'profile'],
    queryFn: () => api.fetch<MeProfile>('/v1/me'),
  });
}

export function useUpdateMeProfile() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<MeProfile, Error, UpdateMeProfileBody>({
    mutationFn: (body) => api.fetch<MeProfile>('/v1/me/profile', { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'profile'] });
    },
  });
}

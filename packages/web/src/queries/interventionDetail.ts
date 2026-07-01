import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { CancelInterventionRequest, InterventionDetail } from './types';

export function useInterventionDetail(id: string | undefined) {
  const apiFetch = useApiFetch();
  return useQuery<InterventionDetail, ApiError>({
    queryKey: ['intervention-detail', id] as const,
    queryFn: () => apiFetch<InterventionDetail>(`/v1/interventions/${id}`),
    enabled: typeof id === 'string' && id.length > 0,
  });
}

// POST success invalidates 4 caches: the intervention detail itself,
// its disputes (BR-127 status flip), its revisions log, and the
// vehicle timeline (so the cancelled badge appears immediately).
export function useCancelIntervention(id: string | undefined) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, CancelInterventionRequest>({
    mutationFn: (payload) =>
      apiFetch(`/v1/interventions/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['intervention-detail', id] });
      qc.invalidateQueries({ queryKey: ['intervention-disputes', id] });
      qc.invalidateQueries({ queryKey: ['intervention-revisions', id] });
      qc.invalidateQueries({ queryKey: ['vehicle-timeline'] });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type {
  DisputeResponseRequest,
  DisputeResponseResult,
  InterventionDispute,
  InterventionDisputesResponse,
} from './types';

// Lazy via `enabled` so the GET fires only when the dispute Dialog is
// opened by the operator. Returns the unwrapped disputes array directly
// (the API wrapper { disputes } stays internal to queryFn).
export function useInterventionDisputes(interventionId: string, options?: { enabled?: boolean }) {
  const apiFetch = useApiFetch();
  return useQuery<InterventionDispute[], ApiError>({
    queryKey: ['intervention-disputes', interventionId] as const,
    queryFn: async () => {
      const res = await apiFetch<InterventionDisputesResponse>(
        `/v1/interventions/${interventionId}/disputes`,
      );
      return res.disputes;
    },
    enabled: Boolean(interventionId) && (options?.enabled ?? true),
  });
}

// On success invalidates 2 caches: the dispute list itself (so the
// Dialog re-renders with the new responded card) and the vehicle
// timeline (so the badge "Disputa" disappears once BR-127 status flip
// happens — backend sets intervention.status='active' when no open
// dispute remains, and the timeline DTO derives is_disputed from that).
export function useRespondToDispute(interventionId: string, vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<DisputeResponseResult, ApiError, DisputeResponseRequest>({
    mutationFn: (body) =>
      apiFetch<DisputeResponseResult>(`/v1/interventions/${interventionId}/dispute-response`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['intervention-disputes', interventionId] });
      qc.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
    },
  });
}

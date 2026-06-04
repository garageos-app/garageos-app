// Update + delete mutations for private interventions (F-CLI-204).
// Both invalidate the vehicle timeline so the Storico tab reflects the change;
// update also invalidates the detail cache used to prefill the edit form.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  CreatePrivateInterventionBody,
  PrivateInterventionDetail,
} from '@/lib/types/private-intervention';

export function useUpdatePrivateIntervention(id: string, vehicleId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<PrivateInterventionDetail, Error, CreatePrivateInterventionBody>({
    mutationFn: (body) =>
      api.fetch<PrivateInterventionDetail>(`/v1/me/private-interventions/${id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'timeline'] });
      void qc.invalidateQueries({ queryKey: ['me', 'private-intervention', id] });
    },
  });
}

export function useDeletePrivateIntervention(id: string, vehicleId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => api.fetch<void>(`/v1/me/private-interventions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'timeline'] });
    },
  });
}

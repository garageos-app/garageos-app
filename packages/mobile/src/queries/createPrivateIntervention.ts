// useCreatePrivateIntervention — first mobile mutation (F-CLI-203).
// POSTs a private intervention and invalidates the vehicle timeline so the
// new entry appears in the Storico tab. Mirrors the api-client usage in
// src/queries/meVehicles.ts; the timeline key matches meVehicleTimeline.ts.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  CreatePrivateInterventionBody,
  PrivateInterventionDetail,
} from '@/lib/types/private-intervention';

export function useCreatePrivateIntervention(vehicleId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<PrivateInterventionDetail, Error, CreatePrivateInterventionBody>({
    mutationFn: (body) =>
      api.fetch<PrivateInterventionDetail>(`/v1/me/vehicles/${vehicleId}/private-interventions`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'timeline'] });
    },
  });
}

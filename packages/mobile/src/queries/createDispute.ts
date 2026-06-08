// POSTs a customer dispute (F-CLI-206) and invalidates both the intervention
// detail and the vehicle timeline so the CONTESTATO badge appears.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { CreateDisputeBody } from '@/lib/types/intervention';

type CreateDisputeResponse = {
  dispute: { id: string };
  interventionStatus: string;
};

export function useCreateDispute(interventionId: string, vehicleId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<CreateDisputeResponse, Error, CreateDisputeBody>({
    mutationFn: (body) =>
      api.fetch<CreateDisputeResponse>(`/v1/interventions/${interventionId}/dispute`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'intervention', interventionId] });
      void qc.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'timeline'] });
    },
  });
}

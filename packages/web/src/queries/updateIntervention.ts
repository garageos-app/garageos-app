import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { EditInterventionPayload } from '@/lib/validators/editIntervention';

interface UpdateInterventionVariables {
  id: string;
  body: EditInterventionPayload;
}

// PATCH /v1/interventions/:id (F-OFF-304). On success, invalidates the
// vehicle-timeline query so the row re-renders with updated values.
// All error codes (400 revision_reason_required, 422 disputed/cancelled,
// 403/404, 5xx) bubble unchanged to the dialog, which maps them to
// inline errors or Sonner toasts.
export function useUpdateIntervention(vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, UpdateInterventionVariables>({
    mutationFn: ({ id, body }) =>
      apiFetch<unknown>(`/v1/interventions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
    },
  });
}

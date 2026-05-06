import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { CreateInterventionPayload } from '@/lib/validators/intervention';
import type { CreateInterventionResponse } from './types';

export function useCreateIntervention(vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation<CreateInterventionResponse, ApiError, CreateInterventionPayload>({
    mutationFn: (payload) =>
      apiFetch<CreateInterventionResponse>(`/v1/vehicles/${vehicleId}/interventions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
      qc.invalidateQueries({ queryKey: ['vehicle-detail', vehicleId] });
      toast.success('Intervento registrato');
      navigate(`/vehicles/${vehicleId}`);
    },
  });
}

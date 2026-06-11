// useCreatePendingVehicle — customer pre-registration of a vehicle awaiting
// workshop certification (F-CLI-104). Mirrors claimVehicle.ts. Invalidates the
// vehicles list (['me','vehicles'], the queryKey in meVehicles.ts) so the new
// pending vehicle appears when the user returns to the list.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  CreatePendingVehicleRequest,
  CreatePendingVehicleResponse,
} from '@/lib/types/vehicle';

export function useCreatePendingVehicle() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<CreatePendingVehicleResponse, Error, CreatePendingVehicleRequest>({
    mutationFn: (body) =>
      api.fetch<CreatePendingVehicleResponse>('/v1/me/vehicles/pending', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'vehicles'] });
    },
  });
}

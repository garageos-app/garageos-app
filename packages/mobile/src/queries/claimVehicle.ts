// useClaimVehicle — attaches a certified vehicle to the customer by garage code
// (F-CLI-101). Mirrors createPrivateIntervention.ts. Invalidates the vehicles
// list (['me','vehicles'], the queryKey in meVehicles.ts) so the newly claimed
// vehicle appears when the user returns to the list.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { ClaimVehicleResponse } from '@/lib/types/vehicle';

export function useClaimVehicle() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<ClaimVehicleResponse, Error, { garageCode: string }>({
    mutationFn: (body) =>
      api.fetch<ClaimVehicleResponse>('/v1/me/vehicles/claim', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'vehicles'] });
    },
  });
}

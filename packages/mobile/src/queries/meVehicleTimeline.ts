// meVehicleTimeline — TanStack Query hook for /v1/vehicles/:id/timeline.
// Query key is ['vehicle', id, 'timeline'] (NOT scoped under 'me') because the
// timeline endpoint lives on /v1/vehicles/:id/timeline and is served via the
// dualPoolContext (any pool with vehicle access), not /v1/me/.
// See plan 2026-05-14-mobile-b2c-scaffold §Task 8.5.

import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { TimelineResponse } from '@/lib/types/vehicle';

export function useMeVehicleTimeline(vehicleId: string) {
  const api = useApiClient();
  return useQuery<TimelineResponse, Error>({
    queryKey: ['vehicle', vehicleId, 'timeline'],
    queryFn: () => api.fetch<TimelineResponse>(`/v1/vehicles/${vehicleId}/timeline?type=all`),
    enabled: vehicleId.length > 0,
  });
}

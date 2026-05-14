// meVehicles — TanStack Query hooks for /v1/me/vehicles list + detail.
// useMeVehiclesList projects the wrapper response down to MeVehicleSummary[]
// via select(); meta/cursor are dropped pending pagination work.
// useMeVehicleDetail short-circuits with enabled:false when id is empty so
// callers (e.g. expo-router screens) can mount before the param resolves.
// See plan 2026-05-14-mobile-b2c-scaffold §Task 8.4.

import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  MeVehicleDetail,
  MeVehiclesListResponse,
  MeVehicleSummary,
} from '@/lib/types/vehicle';

export function useMeVehiclesList() {
  const api = useApiClient();
  return useQuery<MeVehiclesListResponse, Error, MeVehicleSummary[]>({
    queryKey: ['me', 'vehicles'],
    queryFn: () => api.fetch<MeVehiclesListResponse>('/v1/me/vehicles'),
    select: (r) => r.data,
  });
}

export function useMeVehicleDetail(id: string) {
  const api = useApiClient();
  return useQuery<MeVehicleDetail, Error>({
    queryKey: ['me', 'vehicle', id],
    queryFn: () => api.fetch<MeVehicleDetail>(`/v1/me/vehicles/${id}`),
    enabled: id.length > 0,
  });
}

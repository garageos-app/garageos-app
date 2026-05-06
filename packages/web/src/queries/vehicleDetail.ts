import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { VehicleDetailResponse } from './types';

export function useVehicleDetail(id: string | undefined) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['vehicle-detail', id] as const,
    queryFn: () => apiFetch<VehicleDetailResponse>(`/v1/vehicles/${id}`),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}

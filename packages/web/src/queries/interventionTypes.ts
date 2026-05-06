import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { InterventionTypesResponse } from './types';

export function useInterventionTypes() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['intervention-types'] as const,
    queryFn: () => apiFetch<InterventionTypesResponse>('/v1/intervention-types'),
    staleTime: 30 * 60 * 1000,
  });
}

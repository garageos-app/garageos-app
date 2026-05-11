import { useQuery } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { InterventionRevisionsResponse } from './types';

export function useInterventionRevisions(id: string | undefined) {
  const apiFetch = useApiFetch();
  return useQuery<InterventionRevisionsResponse, ApiError>({
    queryKey: ['intervention-revisions', id] as const,
    queryFn: () => apiFetch<InterventionRevisionsResponse>(`/v1/interventions/${id}/revisions`),
    enabled: typeof id === 'string' && id.length > 0,
  });
}

import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

export interface RecentIntervention {
  id: string;
  createdAt: string;
  status: 'active' | 'disputed';
  summary: string;
  vehicle: {
    id: string;
    plate: string;
    make: string;
    model: string;
  };
  operator: {
    id: string;
    name: string;
  };
}

export interface InterventionsRecentResponse {
  items: RecentIntervention[];
}

export function useInterventionsRecent(limit = 10) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['interventions-recent', limit] as const,
    queryFn: async (): Promise<RecentIntervention[]> => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      const res = await apiFetch<InterventionsRecentResponse>(
        `/v1/interventions/recent?${params.toString()}`,
      );
      return res.items;
    },
    staleTime: 60_000,
  });
}

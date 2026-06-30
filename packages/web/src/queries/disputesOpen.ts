import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

export type DisputeReasonCategory = 'not_performed' | 'wrong_data' | 'not_authorized' | 'other';

export interface PendingDispute {
  id: string;
  interventionId: string;
  vehicleTarga: string;
  customerName: string;
  createdAt: string;
  reasonCategory: DisputeReasonCategory;
}

export interface InProgressDispute extends PendingDispute {
  status: 'responded' | 'escalated';
}

export interface DisputesOpenResponse {
  pendingResponse: {
    count: number;
    items: PendingDispute[];
  };
  inProgress: {
    count: number;
    items: InProgressDispute[];
  };
}

export function useDisputesOpen() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['disputes-open'] as const,
    queryFn: async (): Promise<DisputesOpenResponse> => {
      return apiFetch<DisputesOpenResponse>('/v1/disputes/open');
    },
    staleTime: 60_000,
  });
}

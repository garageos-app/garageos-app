import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import { useLocationFilter } from '@/location-filter/useLocationFilter';

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
  const { selectedLocationId } = useLocationFilter();
  return useQuery({
    queryKey: ['disputes-open', selectedLocationId] as const,
    queryFn: async (): Promise<DisputesOpenResponse> => {
      const url = selectedLocationId
        ? `/v1/disputes/open?location_id=${selectedLocationId}`
        : '/v1/disputes/open';
      return apiFetch<DisputesOpenResponse>(url);
    },
    staleTime: 60_000,
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';

// F-OFF-110 — officina-mediated vehicle ownership transfer mutation.
// POST /v1/vehicles/:id/ownership-transfer (see BR-049).

export type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

export type OwnershipTransferRecipient =
  | { kind: 'existing'; customerId: string }
  | {
      kind: 'new';
      firstName: string;
      lastName: string;
      email: string;
      phone?: string | null;
      codiceFiscale?: string | null;
      isBusiness?: boolean;
      businessName?: string | null;
      vatNumber?: string | null;
    };

export interface OwnershipTransferPayload {
  recipient: OwnershipTransferRecipient;
  reason: TransferReason;
  notes?: string | null;
}

export interface OwnershipTransferResponse {
  vehicle: {
    id: string;
    garageCode: string | null;
    plate: string;
    [k: string]: unknown;
  };
  ownership: { id: string; customerId: string; startedAt: string };
  transfer: {
    id: string;
    status: 'completed';
    completedAt: string;
    reason: TransferReason;
    notes: string | null;
  };
}

export function useOwnershipTransfer(vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<OwnershipTransferResponse, ApiError, OwnershipTransferPayload>({
    mutationFn: (payload) =>
      apiFetch<OwnershipTransferResponse>(`/v1/vehicles/${vehicleId}/ownership-transfer`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle-detail', vehicleId] });
      void qc.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
      void qc.invalidateQueries({ queryKey: ['customer-search'] });
    },
  });
}

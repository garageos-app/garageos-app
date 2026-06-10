// Transfer hooks — F-CLI-401→403 customer ownership transfer (consumes
// /v1/me/transfers* from PR1-PR4). Mirrors me.ts / notificationPreferences.ts.
//
// Wire shapes (me-transfers.ts): POST /me/transfers returns the BARE TransferDto
// (201); list returns {data}; detail/accept/confirm/reject/preview return
// {transfer}. Invalidations per spec §PR5: initiate/reject → ['transfers'](+id);
// confirm → ['transfers'](+id) + ['me','vehicles'] (the REAL meVehicles.ts key —
// ownership moves on confirm, BR-043, so the vehicle leaves the seller's list);
// accept → none (ownership does not move on accept).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { Transfer, TransferResponse, TransfersListResponse } from '@/lib/types/transfer';

export function useTransfers() {
  const api = useApiClient();
  return useQuery<TransfersListResponse, Error, Transfer[]>({
    queryKey: ['transfers'],
    queryFn: () => api.fetch<TransfersListResponse>('/v1/me/transfers'),
    select: (r) => r.data,
  });
}

export function useTransfer(id: string) {
  const api = useApiClient();
  return useQuery<TransferResponse, Error, Transfer>({
    queryKey: ['transfers', id],
    queryFn: () => api.fetch<TransferResponse>(`/v1/me/transfers/${id}`),
    select: (r) => r.transfer,
    enabled: id.length > 0,
  });
}

export function useInitiateTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, { vehicleId: string }>({
    mutationFn: ({ vehicleId }) =>
      api.fetch<Transfer>('/v1/me/transfers', {
        method: 'POST',
        body: { vehicleId, method: 'physical_code' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
    },
  });
}

// A GET modeled as a mutation: the preview runs on the "Verifica" tap, not on
// mount or while typing (spec §Dati), and its lifecycle (pending/error) drives
// the button state exactly like a write would.
export function useTransferPreview() {
  const api = useApiClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (code) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${code}/preview`);
      return r.transfer;
    },
  });
}

export function useAcceptTransfer() {
  const api = useApiClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (code) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${code}/accept`, {
        method: 'POST',
      });
      return r.transfer;
    },
  });
}

export function useConfirmTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (id) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${id}/confirm`, {
        method: 'POST',
      });
      return r.transfer;
    },
    onSuccess: (_t, id) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfers', id] });
      void qc.invalidateQueries({ queryKey: ['me', 'vehicles'] });
    },
  });
}

export function useRejectTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, { id: string; reason?: string }>({
    mutationFn: async ({ id, reason }) => {
      // Always send a JSON body: the api-client only sets Content-Type when a
      // body is present, and the route parses `request.body ?? {}`.
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${id}/reject`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
      return r.transfer;
    },
    onSuccess: (_t, { id }) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfers', id] });
    },
  });
}

import type { Transfer, TransferStatus } from '@/lib/types/transfer';
import { formatDate } from '@/lib/format';

// BR-043 lifecycle states (Italian, user-facing, seller perspective).
export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  pending_recipient: 'In attesa del nuovo proprietario',
  pending_seller_confirmation: 'In attesa della tua conferma',
  pending_validation: 'In verifica',
  completed: 'Completato',
  rejected: 'Rifiutato',
  expired: 'Scaduto',
};

// Mirror of ACTIVE_TRANSFER_STATUSES in api routes/v1/me-transfers.ts (BR-047:
// at most one active transfer per vehicle).
const ACTIVE_STATUSES: readonly TransferStatus[] = [
  'pending_recipient',
  'pending_seller_confirmation',
  'pending_validation',
];

export function isTransferActive(status: TransferStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export type TransferStatusTone = 'pending' | 'done' | 'closed';

// Badge styling bucket: pending → warning colors, done → muted/primary,
// closed (rejected/expired) → danger colors.
export function transferStatusTone(status: TransferStatus): TransferStatusTone {
  if (isTransferActive(status)) return 'pending';
  return status === 'completed' ? 'done' : 'closed';
}

// Message handed to Share.share by the seller (spec §PR5: zero new deps).
export function transferShareMessage(t: Transfer): string {
  const label = `${t.vehicle.make} ${t.vehicle.model} (${t.vehicle.plate})`;
  return (
    `Codice GarageOS per il passaggio di proprietà di ${label}: ${t.transferCode ?? ''}. ` +
    `Apri l'app GarageOS, tocca "Hai ricevuto un codice?" e inseriscilo entro il ${formatDate(t.expiresAt)}.`
  );
}

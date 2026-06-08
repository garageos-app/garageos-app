import type { DisputeReasonCategory, DisputeStatus } from '@/lib/types/intervention';

// BR-123 reason categories (Italian, user-facing).
export const REASON_CATEGORY_LABELS: Record<DisputeReasonCategory, string> = {
  not_performed: "L'intervento non è mai stato effettuato",
  wrong_data: 'I dati riportati sono errati (km, data, pezzi)',
  not_authorized: 'Non ho autorizzato questo intervento',
  other: 'Altro',
};

export const REASON_CATEGORY_ORDER: DisputeReasonCategory[] = [
  'not_performed',
  'wrong_data',
  'not_authorized',
  'other',
];

// BR-125 lifecycle states (Italian, user-facing).
export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Aperta',
  responded: 'Risposta ricevuta',
  resolved_by_cancellation: 'Risolta (intervento annullato)',
  escalated: 'In gestione GarageOS',
  closed_by_admin: 'Chiusa',
};

// A dispute is "active" (blocks a new one, BR-122) while open or responded.
export function isDisputeActive(status: DisputeStatus): boolean {
  return status === 'open' || status === 'responded';
}

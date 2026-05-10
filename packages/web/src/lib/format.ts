import type { DisputeReasonCategory, DisputeStatus } from '@/queries/types';

const dateFmt = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const numberFmt = new Intl.NumberFormat('it-IT');
const currencyFmt = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'EUR',
});

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return dateFmt.format(new Date(iso));
}

export function formatKm(km: number | null): string {
  if (km == null) return '—';
  return `${numberFmt.format(km)} km`;
}

export function formatCurrency(cents: number | null): string {
  if (cents == null) return '—';
  return currencyFmt.format(cents / 100);
}

export function fallback(s: string | null | undefined): string {
  return s ?? '—';
}

export function disputeReasonLabel(reason: DisputeReasonCategory): string {
  switch (reason) {
    case 'not_performed':
      return 'Lavoro non svolto';
    case 'wrong_data':
      return 'Dati errati';
    case 'not_authorized':
      return 'Lavoro non autorizzato';
    case 'other':
      return 'Altro';
  }
}

export function disputeStatusLabel(status: DisputeStatus): string {
  switch (status) {
    case 'open':
      return 'Aperta';
    case 'responded':
      return 'Risposta inviata';
    case 'resolved_by_cancellation':
      return 'Chiusa per cancellazione intervento';
    case 'escalated':
      return 'Escalation in corso';
    case 'closed_by_admin':
      return "Chiusa dall'amministrazione";
  }
}

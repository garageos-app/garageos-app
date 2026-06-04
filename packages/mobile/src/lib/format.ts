export function formatDate(input: string | null | undefined): string {
  if (!input) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return '—';
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

export function formatKm(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const formatted = value.toLocaleString('it-IT');
  return `${formatted} km`;
}

export function formatTimeAgo(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return 'oggi';
  if (diffDays === 1) return 'ieri';
  if (diffDays < 7) return `${diffDays} giorni fa`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} settimane fa`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} mesi fa`;
  return `${Math.floor(diffDays / 365)} anni fa`;
}

export type DueSeverity = 'overdue' | 'soon' | 'normal' | 'none';

// Future-facing counterpart of formatTimeAgo: turns a deadline dueDate + status
// into a short Italian urgency label + a severity bucket that DeadlineRow maps
// to colors. status 'overdue' always wins; a null dueDate (km-only deadline,
// BR-100) has no date urgency. Date math mirrors formatTimeAgo: parse YYYY-MM-DD
// at UTC midnight and diff against today at UTC midnight.
export function formatDueUrgency(
  dueDate: string | null | undefined,
  status: string,
): { label: string; severity: DueSeverity } {
  if (status === 'overdue') return { label: 'Scaduta', severity: 'overdue' };
  if (!dueDate) return { label: '—', severity: 'none' };
  const date = new Date(`${dueDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return { label: '—', severity: 'none' };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffDays = Math.floor((date.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { label: 'Scaduta', severity: 'overdue' };
  if (diffDays === 0) return { label: 'Oggi', severity: 'soon' };
  if (diffDays === 1) return { label: 'Domani', severity: 'soon' };
  if (diffDays <= 7) return { label: `Tra ${diffDays} giorni`, severity: 'soon' };
  if (diffDays <= 30) {
    const weeks = Math.floor(diffDays / 7);
    return {
      label: weeks === 1 ? 'Tra 1 settimana' : `Tra ${weeks} settimane`,
      severity: 'normal',
    };
  }
  return { label: formatDate(dueDate), severity: 'normal' };
}

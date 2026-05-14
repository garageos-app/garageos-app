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

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

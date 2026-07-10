import type { PDFFont } from 'pdf-lib';

// Shared PDF formatting helpers. Formatting is manual (no Intl/ICU) to stay
// independent of the Lambda runtime locale — the ONE exception is `todayInRome`,
// which needs a timezone conversion and uses Intl with an explicit timeZone (see
// its comment). Used by the vehicle-history renderer (F-CLI-501), which also
// backs the single-intervention export (F-OFF-309) since 2026-07-10.

// U+00B7 MIDDLE DOT — valid WinAnsi (0xB7). Field separator.
export const DOT = '·';
// U+00D7 MULTIPLICATION SIGN — valid WinAnsi (0xD7). Quantity marker.
export const TIMES = '×';

// dd/MM/yyyy from an ISO yyyy-MM-dd string — manual, no ICU dependency.
export function formatDateIt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// GarageOS serves Italian workshops only — PDF "documento generato il" dates are
// wall-clock Italy dates, not UTC.
const APP_TIME_ZONE = 'Europe/Rome';

// Today's date as `YYYY-MM-DD` in the app's wall-clock zone (Europe/Rome).
// `new Date().toISOString().slice(0,10)` returns the UTC date, which rolls over
// an hour or two early relative to Italian local time — near local midnight it
// prints the previous day on the document. Intl with an EXPLICIT timeZone and
// the `en-CA` locale (which formats as `YYYY-MM-DD`) is deterministic and
// independent of the runtime's default locale/timezone — this is the only place
// where ICU is used, and only because it is the correct tool for a timezone
// conversion (contrast the locale-independent manual formatters above).
export function todayInRome(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Thousands separator with a dot (it-IT) — manual, no toLocaleString.
export function formatKm(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Greedy word-wrap to a max width in points. Splits on '\n' first, then filters
// empty tokens per line to avoid a spurious trailing '' entry. Intentional
// blank lines (empty rawLine after trimming) are preserved as-is.
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
  }
  return out;
}

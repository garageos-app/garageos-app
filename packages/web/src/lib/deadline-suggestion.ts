import type { InterventionType } from '@/queries/types';
import { formatKm } from '@/lib/format';

export interface DeadlineSuggestion {
  typeName: string;
  months: number | null;
  km: number | null;
}

/**
 * F-OFF-308: derive the deadline suggestion for a selected intervention type.
 * Returns null unless the type opts into suggestions (suggestsDeadline) AND
 * carries at least one default (months or km). A suggestion with both defaults
 * null is intentionally suppressed — enabling it would create a no-op deadline
 * the API discards (BR-100).
 */
export function deriveDeadlineSuggestion(
  type: InterventionType | null | undefined,
): DeadlineSuggestion | null {
  if (!type || !type.suggestsDeadline) return null;
  if (type.defaultDeadlineMonths == null && type.defaultDeadlineKm == null) return null;
  return {
    typeName: type.nameIt,
    months: type.defaultDeadlineMonths,
    km: type.defaultDeadlineKm,
  };
}

/**
 * Human-readable Italian suggestion line, e.g.
 * "Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi."
 * Callers gate on deriveDeadlineSuggestion, which guarantees at least one of
 * km/months is present, so at least one part is always produced.
 */
export function formatDeadlineSuggestion(s: DeadlineSuggestion): string {
  const parts: string[] = [];
  if (s.km != null) parts.push(formatKm(s.km));
  if (s.months != null) parts.push(`${s.months} ${s.months === 1 ? 'mese' : 'mesi'}`);
  return `Suggerito per «${s.typeName}»: prossima scadenza tra ${parts.join(' o ')}.`;
}

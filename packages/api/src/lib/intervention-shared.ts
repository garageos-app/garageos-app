// BR-062 wiki window helper. Single source of truth for the predicate
// that decides whether an intervention is in the "free edits" wiki window
// or the audit-locked state. Mirrors the now-removed local copy in
// vehicles-timeline.ts (PR #84). Both consumers (vehicles-timeline route
// DTO mapper and interventions-detail route DTO mapper) call this with
// a single page-scoped `now` snapshot so all rows on the same response
// report a consistent value.

export const WIKI_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isWikiWindowOpen(
  wikiLockedAt: Date | null,
  firstSeenByCustomerAt: Date | null,
  createdAt: Date,
  now: Date,
): boolean {
  if (wikiLockedAt !== null) return false;
  if (firstSeenByCustomerAt !== null) return false;
  return now.getTime() - createdAt.getTime() < WIKI_WINDOW_MS;
}

// BR-071 parts_replaced JSON normalization. Canonical shape from
// PartReplacedSchema in @garageos/database. Defensive normalization
// protects callers from hand-edited rows or schema drift. Shared
// across any route that returns a full intervention DTO (detail,
// future B2C mobile detail, revision diff, print export).
export interface PartReplaced {
  name: string;
  code: string | null;
  quantity: number;
  notes: string | null;
}

export function normalizePartsReplaced(value: unknown): PartReplaced[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === 'string' ? o.name : '',
      code: typeof o.code === 'string' ? o.code : null,
      quantity: typeof o.quantity === 'number' ? o.quantity : 1,
      notes: typeof o.notes === 'string' ? o.notes : null,
    };
  });
}

// Today at UTC midnight. Shared anchor for future-date guards on
// intervention_date (officina POST, customer-side POST/PATCH). YYYY-MM-DD
// strings parse to UTC midnight; comparing at the same anchor avoids
// timezone false positives around midnight regardless of runtime TZ.
export function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

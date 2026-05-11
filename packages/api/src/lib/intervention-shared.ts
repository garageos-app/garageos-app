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

// BR-065 parts_replaced JSON normalization. The column is a free-form
// Json without a Prisma type. Defensive normalization protects callers
// from hand-edited rows or schema drift. Shared across any route that
// returns a full intervention DTO (detail, future B2C mobile detail,
// revision diff, print export).
export interface PartReplaced {
  brand: string | null;
  code: string | null;
  description: string;
  quantity: number;
}

export function normalizePartsReplaced(value: unknown): PartReplaced[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      brand: typeof o.brand === 'string' ? o.brand : null,
      code: typeof o.code === 'string' ? o.code : null,
      description: typeof o.description === 'string' ? o.description : '',
      quantity: typeof o.quantity === 'number' ? o.quantity : 1,
    };
  });
}

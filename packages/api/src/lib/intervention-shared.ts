// BR-062 wiki window helper. Single source of truth for the predicate
// that decides whether an intervention is in the "free edits" wiki window
// or the audit-locked state. Mirrors the now-removed local copy in
// vehicles-timeline.ts (PR #84). Both consumers (vehicles-timeline route
// DTO mapper and interventions-detail route DTO mapper) call this with
// a single page-scoped `now` snapshot so all rows on the same response
// report a consistent value.

import type { PrismaClient } from '@garageos/database';

import { businessError } from './business-error.js';

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

// Future-date guard. Validates that an `intervention_date` string
// (YYYY-MM-DD) is not after today (UTC-midnight anchor). Used by both
// officina and customer-side intervention endpoints. Caller supplies
// the error code + message — officina uses BR-069-specific copy,
// customer-side uses `private_intervention.date_future`. Returns the
// parsed UTC Date on success so callers don't re-parse.
export function assertNotFutureInterventionDate(
  dateStr: string,
  errorCode: string,
  errorMsg: string,
): Date {
  const dateUtc = new Date(`${dateStr}T00:00:00.000Z`);
  if (dateUtc.getTime() > todayUtcMidnight().getTime()) {
    throw businessError(errorCode, 422, errorMsg);
  }
  return dateUtc;
}

// FK existence check for intervention_types. RLS on intervention_types
// is permissive (migration 20260427120000) — system-wide AND tenant-
// custom rows are visible. Caller is responsible for the null/undefined
// guard on id. Used by both POST and PATCH private intervention
// endpoints. FK Restrict prevents a dangling reference post-creation.
export async function assertInterventionTypeExists(tx: PrismaClient, id: string): Promise<void> {
  const t = await tx.interventionType.findFirst({
    where: { id },
    select: { id: true },
  });
  if (!t) {
    throw businessError('VALIDATION_ERROR', 422, 'Tipo intervento non valido.');
  }
}

// BR-303 serializer. Turns the frozen (interventionId, checklistItemId)
// snapshot rows into the wire shape `{ label }`. Pure function — no DB
// access — so both the create route (Task 3) and the future detail/edit
// routes (Task 4/5) can reuse it on whatever selection rows they already
// have in hand. Sort is sortOrderSnapshot asc with nulls last (an item
// whose snapshot predates BR-303's sort_order column, or was manually
// null-ed), then labelSnapshot asc as the tiebreaker/fallback.
export function serializeChecklistItems(
  selections: { labelSnapshot: string; sortOrderSnapshot: number | null }[],
): { label: string }[] {
  return [...selections]
    .sort((a, b) => {
      if (a.sortOrderSnapshot === null && b.sortOrderSnapshot === null) {
        return a.labelSnapshot.localeCompare(b.labelSnapshot, 'it');
      }
      if (a.sortOrderSnapshot === null) return 1;
      if (b.sortOrderSnapshot === null) return -1;
      if (a.sortOrderSnapshot !== b.sortOrderSnapshot) {
        return a.sortOrderSnapshot - b.sortOrderSnapshot;
      }
      return a.labelSnapshot.localeCompare(b.labelSnapshot, 'it');
    })
    .map((s) => ({ label: s.labelSnapshot }));
}

// BR-300/301/302 shared validator. Both the create route (Task 3) and the
// PATCH edit route (Task 4, which replaces the full selection set — see
// BR-308 comment on UpdateInterventionSchema) call this before writing any
// intervention_checklist_selections row, so the cardinality/ownership/
// visibility rules stay centralized instead of duplicated per route.
export async function validateChecklistSelection(
  tx: PrismaClient,
  args: { tenantId: string; interventionTypeId: string; checklistItemIds: string[] },
): Promise<{ id: string; nameIt: string; sortOrder: number }[]> {
  const { tenantId, interventionTypeId, checklistItemIds } = args;

  // Dedup ids up front: the same id sent twice must resolve to a single
  // selection row, not a unique constraint violation on
  // (intervention_id, checklist_item_id) at insert time.
  const ids = [...new Set(checklistItemIds)];

  // BR-300: at least one checklist item selection is mandatory.
  if (ids.length === 0) {
    throw businessError(
      'intervention.creation.checklist_required',
      400,
      'Seleziona almeno una voce checklist.',
    );
  }

  const INVALID_SELECTION_DETAIL =
    'Una o più voci checklist non sono valide per questo tipo di intervento o non sono disponibili.';

  // BR-302: a tenant that opted out of the whole intervention type
  // (tenant_intervention_type_exclusions) cannot register checklist items
  // scoped to it either — checked up front so the failure is uniform
  // regardless of which item ids were submitted.
  const typeExcluded = await tx.tenantInterventionTypeExclusion.findFirst({
    where: { tenantId, interventionTypeId },
    select: { tenantId: true },
  });
  if (typeExcluded) {
    throw businessError(
      'intervention.creation.checklist_item_invalid',
      422,
      INVALID_SELECTION_DETAIL,
    );
  }

  // BR-301: every selected id must belong to the chosen intervention type.
  // BR-302: and must be active. A single findMany covers both — any id
  // that fails either condition is simply absent from `found`.
  const found = await tx.interventionChecklistItem.findMany({
    where: { id: { in: ids }, interventionTypeId, active: true },
    select: { id: true, nameIt: true, sortOrder: true },
  });
  if (found.length !== ids.length) {
    throw businessError(
      'intervention.creation.checklist_item_invalid',
      422,
      INVALID_SELECTION_DETAIL,
    );
  }

  // BR-302: an item can be globally active yet excluded for this specific
  // tenant (tenant_checklist_item_exclusions) — reject the whole batch if
  // any selected id is on that list.
  const exclusions = await tx.tenantChecklistItemExclusion.findMany({
    where: { tenantId, checklistItemId: { in: ids } },
    select: { checklistItemId: true },
  });
  if (exclusions.length > 0) {
    throw businessError(
      'intervention.creation.checklist_item_invalid',
      422,
      INVALID_SELECTION_DETAIL,
    );
  }

  return found;
}

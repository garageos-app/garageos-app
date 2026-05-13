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

// Public DTO shape for an attachment exposed on the wire. Snake_case
// because the API contract is snake_case; the s3 key is intentionally
// dropped (clients call /v1/attachments/:id/view-url to get signed URLs).
export type PrivateInterventionAttachmentDto = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

// Reads processed, non-deleted attachments for a private intervention
// and maps them to the public DTO. Used by detail GET and PATCH
// handlers — single source of truth for the select + serializer so
// drift here breaks both endpoints simultaneously (desired failure mode).
export async function fetchPrivateInterventionAttachments(
  tx: PrismaClient,
  privateInterventionId: string,
): Promise<PrivateInterventionAttachmentDto[]> {
  const rows = await tx.attachment.findMany({
    where: {
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      processed: true,
      deletedAt: null,
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    file_name: r.fileName,
    mime_type: r.mimeType,
    size_bytes: r.sizeBytes,
    created_at: r.createdAt.toISOString(),
  }));
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

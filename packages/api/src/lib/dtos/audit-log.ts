// DTO module for the platform-admin audit-log viewer.
//
// Cursor design: keyset pagination ordered by (createdAt DESC, id DESC).
// The cursor carries millisecond precision via `toISOString()` — Postgres
// `timestamptz` stores up to microseconds, but Prisma returns a JS Date
// (millisecond precision), so no precision is lost in the round-trip.
// Task 2 must query: createdAt < cursor.createdAt OR
//   (createdAt = cursor.createdAt AND id < cursor.id).

import type { Prisma } from '@garageos/database';

// ─── Prisma SELECT ────────────────────────────────────────────────────────────

export const AUDIT_LOG_SELECT = {
  id: true,
  tenantId: true,
  actorType: true,
  actorId: true,
  action: true,
  entityType: true,
  entityId: true,
  ipAddress: true,
  metadata: true,
  createdAt: true,
} as const satisfies Prisma.AuditLogSelect;

export type AuditLogRow = Prisma.AuditLogGetPayload<{
  select: typeof AUDIT_LOG_SELECT;
}>;

// ─── Wire types ───────────────────────────────────────────────────────────────

export interface AuditLogItem {
  id: string;
  createdAt: string; // ISO-8601
  /** null = platform-level event (no tenant); set = tenant event (businessName
   *  may be null if the tenant was hard-deleted and is no longer in the DB). */
  tenant: { id: string; businessName: string | null } | null;
  actorType: 'user' | 'customer' | 'system' | 'admin';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  ipAddress: string | null;
  /** Passed through as-is from the Prisma Json column (already a JS value). */
  metadata: unknown;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  nextCursor: string | null;
}

// ─── Cursor codec ─────────────────────────────────────────────────────────────

export interface AuditCursor {
  /** ISO-8601 timestamp matching the last row's createdAt. */
  createdAt: string;
  /** UUID of the last row. */
  id: string;
}

/**
 * Encodes a cursor from the last row of a page.
 * Produces a base64url-safe opaque token safe for use in query strings.
 */
export function encodeAuditCursor(row: { createdAt: Date; id: string }): string {
  const payload = JSON.stringify({ c: row.createdAt.toISOString(), i: row.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor token produced by `encodeAuditCursor`.
 * Returns null on ANY malformed input — never throws.
 * Validates: valid base64url, valid JSON, `c` is a non-empty string that
 * parses as a date, `i` is a non-empty string.
 */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse returns any
    const parsed: any = JSON.parse(json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.c !== 'string' ||
      typeof parsed.i !== 'string' ||
      Number.isNaN(Date.parse(parsed.c as string))
    ) {
      return null;
    }
    return { createdAt: parsed.c as string, id: parsed.i as string };
  } catch {
    return null;
  }
}

// ─── Serializer ───────────────────────────────────────────────────────────────

/**
 * Maps a raw Prisma AuditLog row to the wire-format `AuditLogItem`.
 *
 * Tenant resolution (three-way):
 *  1. `tenantId === null`  → platform event   → `tenant: null`
 *  2. `tenantId` in map   → known tenant      → `tenant: { id, businessName }`
 *  3. `tenantId` not in map → hard-deleted    → `tenant: { id, businessName: null }`
 *
 * @param row - Raw DB row selected with AUDIT_LOG_SELECT.
 * @param tenantNameById - Map of tenantId → businessName pre-fetched by caller.
 *   Values may be null if the tenant exists but has no businessName set.
 */
export function serializeAuditLogItem(
  row: AuditLogRow,
  tenantNameById: Map<string, string | null>,
): AuditLogItem {
  let tenant: AuditLogItem['tenant'];
  if (row.tenantId === null) {
    tenant = null;
  } else if (tenantNameById.has(row.tenantId)) {
    tenant = {
      id: row.tenantId,
      businessName: tenantNameById.get(row.tenantId) ?? null,
    };
  } else {
    // tenantId is set but not in the map — tenant was hard-deleted
    tenant = { id: row.tenantId, businessName: null };
  }

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    tenant,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    ipAddress: row.ipAddress,
    metadata: row.metadata,
  };
}

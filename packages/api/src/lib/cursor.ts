// Cursor helpers for id-based pagination. Shared by /v1/vehicles/search,
// /v1/customers/search, /v1/me/vehicles (simple id cursor) and
// /v1/interventions/:id/revisions, /v1/vehicles/:id/timeline
// (compound `{ field, id }` cursor — field is the timestamp/date used for
// the primary ORDER BY, id is the tie-breaker). Base64url-encoded JSON
// is opaque enough to discourage clients from constructing cursors by
// hand while remaining easy to debug in logs.

import { Buffer } from 'node:buffer';

// --- Simple id-only cursor ---

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}

// --- Compound `{ <field>, id }` cursor ---
//
// Encodes a pair (timestamp/date string, uuid) with the field name chosen
// by the caller so different endpoints can keep their distinctive keys
// (e.g. `ra` for revised_at, `d` for interventionDate) while sharing this
// helper. The caller asserts the field name on both sides; mismatches
// (e.g. encoding with `ra`, decoding with `d`) return `undefined` so a
// malformed/foreign cursor never produces silent garbage.

export function encodeCompoundCursor<F extends string>(
  field: F,
  value: string,
  id: string,
): string {
  return Buffer.from(JSON.stringify({ [field]: value, id }), 'utf8').toString('base64url');
}

export function decodeCompoundCursor<F extends string>(
  field: F,
  cursor: string | undefined,
): ({ [K in F]: string } & { id: string }) | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const value = obj[field];
    const id = obj.id;
    if (typeof value === 'string' && typeof id === 'string') {
      return { [field]: value, id } as { [K in F]: string } & { id: string };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

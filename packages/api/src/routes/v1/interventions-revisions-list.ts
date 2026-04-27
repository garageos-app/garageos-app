import { Buffer } from 'node:buffer';

import { z } from 'zod';

// GET /v1/interventions/:id/revisions — APPENDICE_A §3.6 (F-OFF-304
// lato lettura). Visibilità Any User: officina cross-tenant
// (BR-150), cliente owner-only (mirror timeline §2.5). Cliente vede
// `changes` con `internalNotes` strippato (BR-065); revisioni
// `internalNotes`-only droppate dalla response.
//
// `intervention_revisions` non ha RLS — la privacy boundary è 100%
// application-layer (ownership pre-check su vehicle_ownerships).
// Defense-in-depth via RLS è registrata come tech debt low-priority.

export const revisionsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

interface RevisionCursor {
  ra: string;
  id: string;
}

export function encodeCursor(c: RevisionCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): RevisionCursor | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      ra?: string;
      id?: string;
    };
    if (typeof obj.ra !== 'string') return undefined;
    if (typeof obj.id !== 'string') return undefined;
    if (Number.isNaN(new Date(obj.ra).getTime())) return undefined;
    return { ra: obj.ra, id: obj.id };
  } catch {
    return undefined;
  }
}

import type { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { decodeDateCompoundCursor, encodeCompoundCursor } from '../../lib/cursor.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';

// GET /v1/interventions/:id/revisions — APPENDICE_A §3.6 (F-OFF-304
// lato lettura). Visibilità Any User: officina cross-tenant
// (BR-150), cliente owner-only (mirror timeline §2.5).
//
// Reserved-field redaction (BR-153 / BR-151): the customer AND any
// non-owning officina see `changes` with `internalNotes` stripped
// (revisioni `internalNotes`-only droppate) and the operator identity
// hidden (response carries `tenant` instead of `user`). Only the owning
// tenant sees the full audit trail with mechanic identity. This mirrors
// the cross-tenant redaction on the detail endpoint (§2.12) — without it
// the revision history would re-leak the internal notes the detail DTO
// redacts.
//
// `intervention_revisions` ha RLS dal migration 0004:
// SELECT cross-tenant permissive (BR-150 audit chain), INSERT
// append-only enforced via EXISTS join al parent. La privacy del
// cliente resta application-layer (ownership pre-check su
// vehicle_ownerships) perche RLS non e pool-aware.

export const revisionsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// BR-065 — internalNotes is workshop-only. Strip it from the JSON
// `changes` for the customer view, and drop the entire revision row
// when stripping leaves no other fields. Defensive against malformed
// `changes` (non-object) — the PATCH path always writes an object,
// but a hand-edited row should not crash the response.
export function filterRevisionsForCustomer<R extends { changes: unknown }>(rows: R[]): R[] {
  return rows.flatMap((row) => {
    if (!isPlainObject(row.changes)) return [];
    const stripped = { ...row.changes };
    delete stripped.internalNotes;
    if (Object.keys(stripped).length === 0) return [];
    return [{ ...row, changes: stripped }];
  });
}

const revisionSelect = {
  id: true,
  revisedAt: true,
  reason: true,
  changes: true,
  user: { select: { id: true, firstName: true, lastName: true } },
  intervention: {
    select: {
      tenant: { select: { businessName: true } },
      location: { select: { city: true } },
    },
  },
} as const;

type RevisionRow = Prisma.InterventionRevisionGetPayload<{ select: typeof revisionSelect }>;

const interventionRevisionsListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id/revisions',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request) => {
      const { id: interventionId } = idParamSchema.parse(request.params);
      const { limit, cursor: cursorRaw } = revisionsListQuerySchema.parse(request.query);
      // `ra` is a full ISO timestamp; decodeDateCompoundCursor guards
      // against hand-crafted cursors with non-date payloads (returns
      // undefined → page 1 fallback) so we never feed Invalid Date into
      // the Prisma `where` clause below.
      const cursor = decodeDateCompoundCursor('ra', cursorRaw, 'timestamp');

      const isOfficine = request.authPool === 'officine';
      const isClienti = request.authPool === 'clienti';

      // Officina: pool-bound user role. Migration 0004 ha splittato users
      // SELECT/WRITE -> il join cross-tenant a users.firstName/lastName
      // funziona ora senza `role: 'admin'` short-lived (mirror del
      // pattern timeline §2.5). Cliente: customerId-scoped; il
      // privacy boundary resta l'ownership pre-check sotto.
      const ctx = isOfficine
        ? { tenantId: request.tenantId!, role: 'user' as const }
        : { customerId: request.customerId!, role: 'user' as const };

      return app.withContext(ctx, async (tx) => {
        // 1. Intervention existence — 404 P2025 cross-pool consistente.
        // tenantId drives the owner-vs-redacted decision for officine.
        const intervention = await tx.intervention.findUniqueOrThrow({
          where: { id: interventionId },
          select: { id: true, vehicleId: true, tenantId: true },
        });

        // 2. Cliente: ownership attiva sul vehicle (mirror timeline 403).
        if (isClienti) {
          const ownership = await tx.vehicleOwnership.findFirst({
            where: {
              vehicleId: intervention.vehicleId,
              customerId: request.customerId!,
              endedAt: null,
            },
            select: { id: true },
          });
          if (!ownership) {
            throw businessError(
              'intervention.revisions.not_owner',
              403,
              'Solo il proprietario attivo può consultare lo storico modifiche.',
            );
          }
        }

        // 3. Fetch limit+1 con cursor predicate (revisedAt DESC, id DESC).
        const where: Prisma.InterventionRevisionWhereInput = {
          interventionId,
          ...(cursor
            ? {
                OR: [
                  { revisedAt: { lt: new Date(cursor.ra) } },
                  { revisedAt: new Date(cursor.ra), id: { lt: cursor.id } },
                ],
              }
            : {}),
        };

        const rows: RevisionRow[] = await tx.interventionRevision.findMany({
          where,
          select: revisionSelect,
          orderBy: [{ revisedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const fetched = hasMore ? rows.slice(0, limit) : rows;

        // 4. Cursor codifica la posizione DB (lastFetched), NON la
        // lastFiltered. Il cliente cliccando "next" non salta righe
        // perché il sort è stabile su (revisedAt, id).
        const lastFetched = fetched.at(-1);
        const cursorOut =
          hasMore && lastFetched
            ? encodeCompoundCursor('ra', lastFetched.revisedAt.toISOString(), lastFetched.id)
            : undefined;

        // 5. Redaction + map response shape. The full audit trail (with
        // `user` identity and unredacted `changes`) goes ONLY to the owning
        // tenant. Customers and cross-tenant officine get internalNotes
        // stripped (BR-153) and the `tenant` shape instead of `user`
        // (BR-151 operator identity hidden).
        const isOwnerOfficine = isOfficine && intervention.tenantId === request.tenantId;
        const visible = isOwnerOfficine ? fetched : filterRevisionsForCustomer(fetched);

        const data = visible.map((row) => {
          const base = {
            id: row.id,
            revised_at: row.revisedAt.toISOString(),
            reason: row.reason,
            changes: row.changes,
          };
          if (isOwnerOfficine) {
            return {
              ...base,
              user: {
                id: row.user.id,
                first_name: row.user.firstName,
                last_name: row.user.lastName,
              },
            };
          }
          return {
            ...base,
            tenant: {
              business_name: row.intervention.tenant.businessName,
              location_city: row.intervention.location.city,
            },
          };
        });

        return {
          data,
          meta: {
            has_more: hasMore,
            ...(cursorOut ? { cursor: cursorOut } : {}),
          },
        };
      });
    },
  );
};

export default interventionRevisionsListRoutes;

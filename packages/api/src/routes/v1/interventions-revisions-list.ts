import type { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { decodeDateCompoundCursor, encodeCompoundCursor } from '../../lib/cursor.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';

// GET /v1/interventions/:id/revisions — APPENDICE_A §3.6 (F-OFF-304
// lato lettura).
//
// Officina: own-only. An app-layer pre-check —
// `findFirst({ id, tenantId })` — is the real security frontier here
// (RLS on `intervention_revisions` remains permissive cross-tenant, see
// below — never rely on RLS alone). A foreign-tenant (or non-existent)
// intervention is indistinguishable and returns 404
// (`intervention.not_found`); the owning tenant always sees the full,
// unredacted audit trail with mechanic identity.
//
// Cliente: unchanged. Existence check via `findUniqueOrThrow({ id })`
// (P2025 → 404 via the error handler) followed by the active-ownership
// pre-check on `vehicle_ownerships` (403
// `intervention.revisions.not_owner`, mirror timeline §2.5). The
// reserved `internalNotes` field is stripped from `changes` (BR-065;
// revisions whose only change was `internalNotes` are dropped
// entirely), and the response carries a `tenant` shape instead of
// `user` (operator identity not exposed to customers).
//
// NOTE (2026-07-09): BR-150 / BR-153 (shared cross-tenant logbook with
// redaction for non-owning officine) are being deprecated — the shared
// logbook is now customer-facing only, not shop-facing. This endpoint no
// longer implements cross-tenant officina reads or officina-side
// redaction.
//
// `intervention_revisions` ha RLS dal migration 0004:
// SELECT cross-tenant permissive (legacy BR-150 audit chain), INSERT
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

      // Officina: pool-bound user role. Migration 0004 ha splittato users
      // SELECT/WRITE -> il join cross-tenant a users.firstName/lastName
      // funziona ora senza `role: 'admin'` short-lived (mirror del
      // pattern timeline §2.5). Cliente: customerId-scoped; il
      // privacy boundary resta l'ownership pre-check sotto.
      const ctx = isOfficine
        ? { tenantId: request.tenantId!, role: 'user' as const }
        : { customerId: request.customerId!, role: 'user' as const };

      return app.withContext(ctx, async (tx) => {
        // 1. Existence + authorization, branched by pool.
        if (isOfficine) {
          // Officina: own-only app-layer pre-check. A foreign-tenant (or
          // non-existent) intervention is indistinguishable and 404s —
          // see the header comment above for the BR-150/BR-153
          // deprecation this replaces.
          const owned = await tx.intervention.findFirst({
            where: { id: interventionId, tenantId: request.tenantId! },
            select: { id: true },
          });
          if (!owned) {
            throw businessError('intervention.not_found', 404, 'Intervento non trovato.');
          }
        } else {
          // Cliente: existence check (P2025 → 404 via the error handler)
          // followed by the active-ownership pre-check on the vehicle
          // (mirror timeline 403). Unchanged from before this task.
          const intervention = await tx.intervention.findUniqueOrThrow({
            where: { id: interventionId },
            select: { id: true, vehicleId: true },
          });

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

        // 5. Redaction + map response shape. Officina always reaches this
        // point as the owner (a foreign tenant already 404s in step 1
        // above), so it always gets the full, unredacted audit trail
        // with `user` identity. Cliente always gets internalNotes
        // stripped (BR-065) and the `tenant` shape instead of `user`
        // (operator identity not exposed to customers) — unchanged.
        const showFullTrail = isOfficine;
        const visible = showFullTrail ? fetched : filterRevisionsForCustomer(fetched);

        const data = visible.map((row) => {
          const base = {
            id: row.id,
            revised_at: row.revisedAt.toISOString(),
            reason: row.reason,
            changes: row.changes,
          };
          if (showFullTrail) {
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

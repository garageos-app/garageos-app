import { CreateDisputeSchema } from '@garageos/database';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// POST /v1/interventions/:id/dispute — F-CLI-206 / F-OFF-602 customer
// side. The authenticated customer contests an officina intervention on
// a vehicle they currently own. BR-120 (only current owner), BR-122
// (one active dispute per (intervention, customer)), BR-124 (Zod
// 20..2000 chars in the shared CreateDisputeSchema), BR-127
// (intervention.status flips to `disputed` while at least one
// open/responded dispute exists), BR-128 (disputes are immutable: we
// never DELETE — closed states resolve via separate transitions).
//
// RLS escape hatch: the transaction runs with `role: 'admin'` SOLELY
// for the BR-127 UPDATE flip on `interventions.status` — customer-pool
// sessions don't satisfy the tenant-scoped `interventions_update`
// USING/WITH CHECK clause. The SELECT side no longer requires admin
// (migration 0003 made interventions cross-tenant readable), but the
// UPDATE is the tightest possible exception. The privacy boundary is
// enforced application-side:
//   - BR-120: vehicle_ownerships lookup with the JWT-bound customerId
//             happens BEFORE any insert, so a non-owner cannot create
//             rows on someone else's intervention.
//   - The dispute row always carries the authenticated customerId.
//   - The only field written on `interventions` is `status`, which is
//     exactly the field BR-127 mandates.
// Future work (project_tech_debt.md): replace this admin elevation
// with a customer-side WRITE policy that allows UPDATE only when an
// open/responded `intervention_disputes` row exists for the current
// customer — optional column-level guard via BEFORE UPDATE trigger.

const idParamSchema = z.object({
  id: z.uuid(),
});

// Mirrors the businessError factory in vehicles.ts / interventions.ts.
// Dot-separated names round-trip verbatim through the shared error
// handler as the Problem+JSON `code` field.
function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}

const interventionDisputeRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/interventions/:id/dispute',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request, reply) => {
      const { id: interventionId } = idParamSchema.parse(request.params);
      const body = CreateDisputeSchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'admin' }, async (tx) => {
        // P2025 → 404 by the shared error handler. The lookup does not
        // pre-filter by tenant or by ownership — those are checked
        // explicitly below (RLS would otherwise hide the row and the
        // 404 would be ambiguous; the explicit BR-120 check returns
        // a clearer 403 with the dedicated code).
        const intervention = await tx.intervention.findUniqueOrThrow({
          where: { id: interventionId },
          select: { id: true, vehicleId: true, status: true },
        });

        // BR-130 implication: a cancelled intervention cannot be the
        // subject of a NEW dispute. Existing disputes that were already
        // flipped to `resolved_by_cancellation` by the cancel handler
        // are out of scope here.
        if (intervention.status === 'cancelled') {
          throw businessError(
            'intervention.dispute.intervention_cancelled',
            422,
            'Non puoi contestare un intervento già annullato.',
          );
        }

        // BR-120 + BR-040: exactly one active ownership row per
        // vehicle. Past owners (endedAt IS NOT NULL) cannot dispute
        // because their right is "frozen" at transfer time.
        const ownership = await tx.vehicleOwnership.findFirst({
          where: {
            vehicleId: intervention.vehicleId,
            customerId,
            endedAt: null,
          },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'intervention.dispute.not_owner',
            403,
            'Solo il proprietario attuale del veicolo può contestare un intervento.',
          );
        }

        // BR-122: at most one ACTIVE dispute per (intervention,
        // customer). `open` and `responded` count as active; closed
        // states (`resolved_by_cancellation`, `escalated`,
        // `closed_by_admin`) do NOT block — the customer can re-open
        // if new elements emerge.
        const existing = await tx.interventionDispute.findFirst({
          where: {
            interventionId,
            customerId,
            status: { in: ['open', 'responded'] },
          },
          select: { id: true },
        });
        if (existing) {
          throw businessError(
            'intervention.dispute.already_exists',
            409,
            'Hai già una contestazione aperta per questo intervento.',
          );
        }

        // status defaults to 'open' via the Prisma schema default.
        // tenantResponse* and resolvedAt stay null — the officina-side
        // F-OFF-602 handler (future PR) will fill them.
        const dispute = await tx.interventionDispute.create({
          data: {
            interventionId,
            customerId,
            reasonCategory: body.reasonCategory,
            customerDescription: body.description,
          },
          select: {
            id: true,
            interventionId: true,
            customerId: true,
            reasonCategory: true,
            customerDescription: true,
            status: true,
            createdAt: true,
          },
        });

        // BR-127: the parent intervention is marked `disputed` whenever
        // at least one open/responded dispute exists on it. The flip is
        // idempotent — skip the UPDATE when the row is already
        // `disputed` (e.g. another customer disputed it earlier and
        // their row is still active).
        if (intervention.status !== 'disputed') {
          await tx.intervention.update({
            where: { id: interventionId },
            data: { status: 'disputed' },
          });
        }

        // TODO(F-OFF-602): notify the tenant via push + email. Push
        // tokens infra (BR-251 / push_tokens table) and the SES
        // transactional email path are pending; tracked in
        // project_tech_debt.md so the wiring lands when the supporting
        // services ship.

        reply.code(201);
        return {
          dispute,
          interventionStatus: 'disputed' as const,
        };
      });
    },
  );
};

export default interventionDisputeRoutes;

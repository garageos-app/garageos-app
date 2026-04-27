import { CancelInterventionSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/interventions/:id/cancel — F-OFF-307. Logical cancellation
// of an officina intervention. BR-066 (super_admin only, reason >= 20
// chars, irreversible). BR-130 (cancellation flips all active disputes
// on this intervention to `resolved_by_cancellation`). BR-154 (audit
// log entry with action='cancel'). RLS interventions_update enforces
// tenant ownership; cross-tenant write falls out as P2025 → 404 via
// the shared error handler (RLS-as-404).
//
// Single TX on officina pool, no role:'admin' escape hatch. The
// intervention_disputes_access policy (single USING(...) covering all
// commands) admits officina-pool UPDATE when the parent intervention
// belongs to the current tenant — checked transitively via the
// `intervention.tenantId = current_tenant_id()` clause.

const interventionCancelRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/interventions/:id/cancel',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = CancelInterventionSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, role: true, locationId: true },
        });

        // Cross-tenant masked by interventions_update RLS (USING +
        // WITH CHECK both require tenant_id = current_tenant_id()),
        // so P2025 → 404 covers both unknown id and other-tenant id.
        const existing = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: { tenantId: true, status: true, vehicleId: true },
        });

        const now = new Date();

        await tx.intervention.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledReason: body.reason,
            cancelledByUserId: user.id,
            cancelledAt: now,
          },
        });

        await recordVehicleAccess({
          tx,
          vehicleId: existing.vehicleId,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'cancel',
          ipAddress: request.ip,
          log: request.log,
        });

        const reloaded = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            locationId: true,
            userId: true,
            vehicleId: true,
            interventionTypeId: true,
            interventionDate: true,
            odometerKm: true,
            title: true,
            description: true,
            partsReplaced: true,
            internalNotes: true,
            status: true,
            cancelledReason: true,
            cancelledByUserId: true,
            cancelledAt: true,
            kmAnomaly: true,
            firstSeenByCustomerAt: true,
            wikiLockedAt: true,
            createdAt: true,
            updatedAt: true,
            interventionType: {
              select: { id: true, code: true, nameIt: true },
            },
          },
        });

        return { intervention: reloaded, resolvedDisputes: [] as const };
      });
    },
  );
};

export default interventionCancelRoutes;

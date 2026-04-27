import { Prisma, UpdateInterventionSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/interventions/:id (F-OFF-304). RLS interventions_write
// enforces tenant ownership; cross-tenant write falls out as P2025 →
// 404 via the shared error handler (RLS-as-404). BR-062 wiki-window
// vs post-lock behavior is computed from
// (now - createdAt, firstSeenByCustomerAt, wikiLockedAt).
// BR-064 — post-lock revision row + reason; BR-065 — 5 editable
// fields; BR-128/BR-130 — disputed/cancelled blocked.

const EDITABLE_KEYS = [
  'interventionTypeId',
  'title',
  'description',
  'partsReplaced',
  'internalNotes',
] as const;

const interventionUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/interventions/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = UpdateInterventionSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });

        const existing = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            tenantId: true,
            status: true,
            vehicleId: true,
            createdAt: true,
            wikiLockedAt: true,
            firstSeenByCustomerAt: true,
            interventionTypeId: true,
            title: true,
            description: true,
            partsReplaced: true,
            internalNotes: true,
          },
        });

        // Build the partial update payload. Override flags / reason are
        // never persisted — only the 5 BR-065 editable fields land on
        // the row.
        const data: Record<string, unknown> = {};
        for (const k of EDITABLE_KEYS) {
          const value = (body as Record<string, unknown>)[k];
          if (value !== undefined) {
            data[k] = value as unknown;
          }
        }

        if (data.partsReplaced !== undefined) {
          data.partsReplaced = data.partsReplaced as Prisma.InputJsonValue;
        }

        await tx.intervention.update({ where: { id }, data });

        await recordVehicleAccess({
          tx,
          vehicleId: existing.vehicleId,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'update',
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

        return { intervention: reloaded, revision: null };
      });
    },
  );

  // Suppress unused-import warning for businessError until Task 6 wires
  // it in for status guards. Remove this when Task 6 imports it.
  void businessError;
};

export default interventionUpdateRoutes;

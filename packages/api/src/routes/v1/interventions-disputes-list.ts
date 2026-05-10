import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id/disputes — F-OFF-602 read companion to
// dispute-response (PR #28). Lists all disputes (any status) for an
// intervention so the officina UI can display the full thread before
// the operator writes a response.
//
// Visibility: tutti i ruoli officina possono leggere; il POST response
// resta gated a [super_admin, mechanic] in interventions-dispute-response.ts.
//
// Tenant scoping: post-PR #22 the interventions table has a permissive
// SELECT RLS (cross-tenant readable to support shared timelines).
// Therefore we must enforce tenant isolation explicitly via `findFirst`
// with `where: { id, tenantId }` — `findUniqueOrThrow` would succeed
// for cross-tenant ids and leak existence. See
// `feedback_rls_split_changes_endpoint_semantics.md`.

const interventionDisputesListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id/disputes',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const intervention = await tx.intervention.findFirst({
          where: { id, tenantId },
          select: { id: true },
        });
        if (!intervention) {
          throw businessError(
            'intervention.not_found',
            404,
            'Intervento non trovato o non accessibile da questa officina.',
          );
        }

        const disputes = await tx.interventionDispute.findMany({
          where: { interventionId: id },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            reasonCategory: true,
            customerDescription: true,
            status: true,
            tenantResponse: true,
            tenantResponseAt: true,
            createdAt: true,
            resolvedAt: true,
            tenantResponseUser: {
              select: { firstName: true, lastName: true },
            },
          },
        });

        return { disputes };
      });
    },
  );
};

export default interventionDisputesListRoutes;

import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id/disputes — F-OFF-602 read companion to
// dispute-response (PR #28). Lists all disputes (any status) for an
// intervention so the officina UI can display the full thread before
// the operator writes a response. Mirror del pattern customers-detail
// (RLS-as-404 via findUniqueOrThrow + tenant context).
//
// Visibility: tutti i ruoli officina possono leggere; il POST response
// resta gated a [super_admin, mechanic] in interventions-dispute-response.ts.
//
// RLS: la policy intervention_isolation (RLS) filtra cross-tenant
// automaticamente. Cross-tenant intervention id → P2025 → 404.

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
        // RLS-as-404: cross-tenant intervention id throws P2025 →
        // mapped to NOT_FOUND by error-handler. Inline catch keeps the
        // domain code consistent with the cancel route (BR-127 family).
        try {
          await tx.intervention.findUniqueOrThrow({
            where: { id },
            select: { id: true },
          });
        } catch {
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

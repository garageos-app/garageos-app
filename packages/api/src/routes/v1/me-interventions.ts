// GET /v1/me/interventions/:id — F-CLI-206 customer view of a single shop
// intervention plus the caller's dispute thread on it (BR-128). The
// customer reaches this from the vehicle timeline; it powers the "Contesta"
// action and shows the officina's response.
//
// Auth chain: requireAuth -> requireClientiPool -> clientiContext.
//
// RLS: interventions SELECT is permissive (cross-tenant readable, migration
// 0003); intervention_disputes USING permits customer_id =
// current_customer_id(). role:'user' is therefore sufficient — no admin
// elevation needed. The privacy boundary is the application-side ownership
// gate below (the true frontier, never RLS alone — see feedback
// rls_only_endpoint_leaks_in_prod / PR #154): a non-owner gets a 404 with
// no existence leak.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { projectShopInterventionDetail } from '../../lib/customer-intervention-detail.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';
import { clientiContext } from '../../middleware/clienti-context.js';

const idParamSchema = z.object({ id: z.uuid() });

const meInterventionsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/v1/me/interventions/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' as const }, async (tx) => {
        const intervention = await tx.intervention.findFirst({
          where: { id },
          select: {
            id: true,
            vehicleId: true,
            interventionDate: true,
            odometerKm: true,
            title: true,
            description: true,
            partsReplaced: true,
            status: true,
            interventionType: { select: { code: true, nameIt: true } },
            tenant: { select: { businessName: true } },
            location: { select: { city: true } },
            // Deadlines this intervention generated (BR-067 source link).
            // Cancelled ones are noise; the customer already sees these shop
            // deadlines via /v1/me/deadlines, so no extra visibility gate is
            // needed beyond the BR-120 ownership frontier below.
            sourceDeadlines: {
              where: { status: { not: 'cancelled' } },
              orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
              select: {
                id: true,
                dueDate: true,
                dueOdometerKm: true,
                description: true,
                status: true,
                interventionType: { select: { code: true, nameIt: true } },
              },
            },
          },
        });
        if (!intervention) {
          throw businessError('me.intervention.not_found', 404, 'Intervento non trovato.');
        }

        // BR-120 frontier: only the current owner may read the detail.
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId: intervention.vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'me.intervention.not_found',
            404,
            'Intervento non trovato o non più di tua proprietà.',
          );
        }

        const [disputes, attachmentsCount] = await Promise.all([
          tx.interventionDispute.findMany({
            where: { interventionId: id, customerId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              reasonCategory: true,
              customerDescription: true,
              status: true,
              createdAt: true,
              tenantResponse: true,
              tenantResponseAt: true,
              resolvedAt: true,
            },
          }),
          tx.attachment.count({
            where: {
              ownerType: 'intervention',
              ownerId: id,
              processed: true,
              deletedAt: null,
            },
          }),
        ]);

        return projectShopInterventionDetail(intervention, disputes, attachmentsCount);
      });
    },
  );
};

export default meInterventionsRoutes;

import type { FastifyPluginAsync } from 'fastify';

import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET /v1/me/intervention-types — customer-facing global intervention-type
// catalog for private interventions. Same source rows as the officina
// GET /v1/intervention-types (global catalog, tenant_id IS NULL, active),
// but WITHOUT per-tenant exclusions (BR-304): customers are not tenant-
// scoped, so they always see the full global catalog. BR-305: a type is
// offered only if it has >=1 active checklist item (so the mobile form can
// satisfy BR-300). RLS on intervention_types is permissive (SELECT USING
// true), so the customer tx can read it.
const meInterventionTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/intervention-types',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const types = await tx.interventionType.findMany({
          where: { tenantId: null, active: true },
          orderBy: [{ nameIt: 'asc' }],
          select: {
            id: true,
            code: true,
            nameIt: true,
            icon: true,
            checklistItems: {
              where: { active: true },
              orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }],
              select: { id: true, code: true, nameIt: true, sortOrder: true },
            },
          },
        });

        const data = types
          .filter((t) => t.checklistItems.length >= 1) // BR-305
          .map((t) => ({
            id: t.id,
            code: t.code,
            name_it: t.nameIt,
            icon: t.icon,
            checklist_items: t.checklistItems.map((i) => ({
              id: i.id,
              code: i.code,
              name_it: i.nameIt,
              sort_order: i.sortOrder,
            })),
          }));

        return { data };
      });
    },
  );
};

export default meInterventionTypesRoutes;

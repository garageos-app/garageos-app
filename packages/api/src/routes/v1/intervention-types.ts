import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const interventionTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/intervention-types',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const tenantId = request.tenantId!;
      return app.withContext({ tenantId }, async (tx) => {
        // RLS on intervention_types is permissive (SELECT USING true) so the
        // cross-tenant intervention timeline can resolve foreign-tenant type
        // names. The catalog endpoint must therefore scope at the application
        // layer to system-wide rows + the caller's own custom rows.
        const rows = await tx.interventionType.findMany({
          where: {
            OR: [{ tenantId: null }, { tenantId }],
          },
          orderBy: [{ nameIt: 'asc' }],
          select: {
            id: true,
            code: true,
            nameIt: true,
            description: true,
            icon: true,
            suggestsDeadline: true,
            defaultDeadlineMonths: true,
            defaultDeadlineKm: true,
            tenantId: true,
          },
        });
        return {
          data: rows.map(({ tenantId: rowTenantId, ...rest }) => ({
            ...rest,
            custom: rowTenantId !== null,
          })),
        };
      });
    },
  );
};

export default interventionTypesRoutes;

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
        const rows = await tx.interventionType.findMany({
          orderBy: [{ category: 'asc' }, { nameIt: 'asc' }],
          select: {
            id: true,
            code: true,
            nameIt: true,
            description: true,
            icon: true,
            category: true,
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

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../../lib/dtos/user-admin.js';

// GET /v1/users — F-OFF-004 admin list.
// Returns all users (active + inactive, including soft-deleted) of the
// caller's tenant. Soft-deleted are returned so the UI can show them
// as "Disattivati" — operators sometimes need to reactivate. Filter
// client-side.
export const usersListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/users',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request) => {
      const tenantId = request.tenantId!;
      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.user.findMany({
          where: { tenantId },
          select: USER_ADMIN_SELECT,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
        return { users: rows.map(serializeUserAdmin) };
      });
    },
  );
};

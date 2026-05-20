// GET /v1/tenants/me/locations — F-OFF-004 list of active locations for the
// caller's tenant. Used by the InviteUserDialog to populate the location
// Select so a super_admin can assign a mechanic to a location.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
//
// RLS note: locations SELECT policy is permissive (USING true — migration
// 0003). Tenant filtering is enforced application-side per the project pattern
// documented in feedback_rls_intervention_types_permissive_read.md.

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';

export const tenantsLocationsListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/tenants/me/locations',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request) => {
      const tenantId = request.tenantId!;

      // Tenant-scoped filter enforced application-side (SELECT RLS is permissive).
      const rows = await app.withContext({ tenantId }, (tx) =>
        tx.location.findMany({
          where: { tenantId, status: 'active', deletedAt: null },
          select: { id: true, name: true, city: true, isPrimary: true },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        }),
      );

      return { locations: rows };
    },
  );
};

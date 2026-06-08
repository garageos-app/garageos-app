import type { FastifyPluginAsync } from 'fastify';

import { serializeTenantMe, TENANT_ME_SELECT_WITH_SETTINGS } from '../../lib/dtos/tenant-me.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/tenants/me — APPENDICE_A §3.2, F-OFF-007 "Info tenant corrente".
//
// Select list is the public tenant profile. Intentionally excluded:
// - settings (JSON bag that may contain internal flags / PII)
// - logoUrl (will need a signed URL layer if it becomes customer-
//   visible — not in scope for PR 7)
// - taxCode (sometimes present for sole proprietors; handle with
//   the PII layer when it arrives)
// - deletedAt / updatedAt (internal lifecycle)
//
// Same RLS contract as /v1/users/me: app.withContext({ tenantId })
// activates the policies on the tenants table. findUniqueOrThrow by id
// would in theory return any tenant if RLS were off; withContext is
// what actually stops cross-tenant reads.
const tenantRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/tenants/me',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const tenantId = request.tenantId!;

      const row = await app.withContext({ tenantId }, (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: TENANT_ME_SELECT_WITH_SETTINGS,
        }),
      );
      return serializeTenantMe(row);
    },
  );
};

export default tenantRoutes;

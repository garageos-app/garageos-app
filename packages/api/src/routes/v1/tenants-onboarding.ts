import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/tenants/me/onboarding/complete — F-OFF-002 onboarding wizard.
// Marks the tenant's guided onboarding as completed by writing
// settings.onboardingCompletedAt. Super Admin only. The flag is read back
// via GET /v1/tenants/me (serializeTenantMe) to drive the web redirect gate.
// Idempotent: re-calling overwrites the timestamp. No body.
const tenantsOnboardingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/me/onboarding/complete',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;

      await app.withContext({ tenantId }, async (tx) => {
        const current = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { settings: true },
        });
        const settings =
          current.settings &&
          typeof current.settings === 'object' &&
          !Array.isArray(current.settings)
            ? (current.settings as Record<string, unknown>)
            : {};
        await tx.tenant.update({
          where: { id: tenantId },
          data: { settings: { ...settings, onboardingCompletedAt: new Date().toISOString() } },
        });
      });

      return reply.code(204).send();
    },
  );
};

export default tenantsOnboardingRoutes;

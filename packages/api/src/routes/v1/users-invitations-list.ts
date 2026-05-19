// GET /v1/users/invitations — F-OFF-004 Super Admin list of pending invitations.
//
// Returns only non-accepted, non-expired internal_user invitations for the
// caller's tenant, ordered by createdAt desc.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: read-only, tenantId-scoped (no writes, no role: 'admin' needed).

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { INVITATION_ADMIN_SELECT, serializeInvitationAdmin } from '../../lib/dtos/invitation.js';

export const usersInvitationsListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/users/invitations',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request) => {
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.invitation.findMany({
          where: {
            tenantId,
            invitationType: 'internal_user',
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: INVITATION_ADMIN_SELECT,
          orderBy: { createdAt: 'desc' },
        });

        return {
          invitations: rows.map((r) => serializeInvitationAdmin(r)),
        };
      });
    },
  );
};

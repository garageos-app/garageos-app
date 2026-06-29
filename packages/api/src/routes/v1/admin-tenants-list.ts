// GET /v1/admin/tenants — Slice 2 platform-admin endpoint to list all tenants.
//
// Returns all non-deleted tenants in descending creation order, each with an
// inline owner summary derived from the most-recent internal_user/super_admin
// invitation. The invitation lookup is a single query (no N+1) — results are
// grouped in memory by tenantId (first in the desc list = most recent).
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No rate-limit (read).

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import {
  INVITATION_OWNER_SELECT,
  TENANT_ADMIN_LIST_SELECT,
  serializeTenantAdminListItem,
  type InvitationOwnerRow,
  type TenantAdminListItem,
} from '../../lib/dtos/tenant-admin.js';

export const adminTenantsListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/tenants',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (_request, reply) => {
      // Snapshot `now` once per request so all owner-status derivations in
      // this response use the same reference point (avoids drift between items).
      const now = new Date();

      const tenants = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Step 1: fetch all non-deleted tenants ordered newest-first.
        const tenantRows = await tx.tenant.findMany({
          where: { deletedAt: null },
          select: TENANT_ADMIN_LIST_SELECT,
          orderBy: { createdAt: 'desc' },
        });

        if (tenantRows.length === 0) {
          return [] as TenantAdminListItem[];
        }

        // Step 2: single invitation query for all tenant IDs (no N+1).
        // Filter: internal_user invitations with role super_admin only.
        // Ordered desc so the first hit per tenantId is the most recent.
        const tenantIds = tenantRows.map((t) => t.id);
        const invitations = await tx.invitation.findMany({
          where: {
            tenantId: { in: tenantIds },
            invitationType: 'internal_user',
            role: 'super_admin',
          },
          select: INVITATION_OWNER_SELECT,
          orderBy: { createdAt: 'desc' },
        });

        // Step 3: build tenantId → most-recent invitation map in memory.
        // Since results are desc, the first entry per tenantId is the newest.
        const ownerMap = new Map<string, InvitationOwnerRow>();
        for (const inv of invitations) {
          if (!ownerMap.has(inv.tenantId)) {
            ownerMap.set(inv.tenantId, inv);
          }
        }

        // Step 4: serialize each tenant with its owner summary.
        return tenantRows.map(
          (row): TenantAdminListItem =>
            serializeTenantAdminListItem(row, ownerMap.get(row.id) ?? null, now),
        );
      });

      return reply.code(200).send({ tenants });
    },
  );
};

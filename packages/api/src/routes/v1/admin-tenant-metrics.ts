// GET /v1/admin/tenants/:id/metrics — Slice 4 per-tenant metrics for the admin
// console TenantDetail page. On-demand counts under admin RLS context (no
// migration). Separate from admin-tenant-detail so the page loads it lazily and
// the detail payload stays stable.
//
// Anti-enum: invalid UUID and unknown UUID both → tenant.not_found 404.
// "non eliminati" everywhere: users deletedAt null, interventions status<>cancelled,
// customers via non-deleted relation. Auth: requireAuth → requirePlatformAdminsPool.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import type { TenantMetrics } from '../../lib/dtos/tenant-metrics.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const adminTenantMetricsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/tenants/:id/metrics',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const metrics = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Existence check (anti-enum 404) before computing anything.
        const existing = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) throw businessError('tenant.not_found', 404, 'Officina non trovata.');

        const [
          interventionsTotal,
          interventionsLast30d,
          lastIntervention,
          usersTotal,
          vehiclesTotal,
          customersTotal,
          openDeadlines,
          pendingInvitations,
        ] = await Promise.all([
          tx.intervention.count({ where: { tenantId: id, status: { not: 'cancelled' } } }),
          tx.intervention.count({
            where: { tenantId: id, status: { not: 'cancelled' }, createdAt: { gte: since30d } },
          }),
          tx.intervention.findFirst({
            where: { tenantId: id, status: { not: 'cancelled' } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          tx.user.count({ where: { tenantId: id, deletedAt: null } }),
          tx.vehicle.count({
            where: { OR: [{ createdByTenantId: id }, { certifiedByTenantId: id }] },
          }),
          tx.customerTenantRelation.count({ where: { tenantId: id, customerDeleted: false } }),
          tx.deadline.count({ where: { tenantId: id, status: { in: ['open', 'overdue'] } } }),
          tx.invitation.count({
            where: {
              tenantId: id,
              invitationType: 'internal_user',
              acceptedAt: null,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);

        return {
          interventions: {
            total: interventionsTotal,
            last30d: interventionsLast30d,
            lastAt: lastIntervention ? lastIntervention.createdAt.toISOString() : null,
          },
          usersTotal,
          vehiclesTotal,
          customersTotal,
          openDeadlines,
          pendingInvitations,
        } satisfies TenantMetrics;
      });

      return reply.code(200).send(metrics);
    },
  );
};

// GET /v1/admin/metrics — Slice 4 platform-admin aggregate metrics.
//
// On-demand counts across all tenants under admin RLS context (no migration:
// every table read already grants `is_admin_role()` SELECT). The interventions
// trend is a single generate_series LEFT JOIN so empty weeks are zero-filled in
// SQL (8 buckets: current ISO week + 7 prior), avoiding JS/timezone date math.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No tenant context.

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import type { PlatformMetrics, WeeklyTrendPoint } from '../../lib/dtos/platform-metrics.js';

export const adminMetricsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/metrics',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (_request, reply) => {
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const metrics = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // non eliminati: users/customers via deletedAt null,
        // interventions via status != cancelled (no deletedAt column).
        const [
          tenantsTotal,
          tenantsActive,
          tenantsSuspended,
          usersTotal,
          interventionsTotal,
          interventionsLast30d,
          vehiclesTotal,
          customersTotal,
          trendRows,
        ] = await Promise.all([
          tx.tenant.count({ where: { deletedAt: null } }),
          tx.tenant.count({ where: { deletedAt: null, status: 'active' } }),
          tx.tenant.count({ where: { deletedAt: null, status: 'suspended' } }),
          tx.user.count({ where: { deletedAt: null } }),
          tx.intervention.count({ where: { status: { not: 'cancelled' } } }),
          tx.intervention.count({
            where: { status: { not: 'cancelled' }, createdAt: { gte: since30d } },
          }),
          tx.vehicle.count(),
          tx.customer.count({ where: { deletedAt: null } }),
          tx.$queryRaw<Array<{ week: string; count: number }>>`
            SELECT to_char(series.week_start, 'YYYY-MM-DD') AS week,
                   COALESCE(c.count, 0)::int AS count
            FROM generate_series(
              date_trunc('week', now()) - interval '7 weeks',
              date_trunc('week', now()),
              interval '1 week'
            ) AS series(week_start)
            LEFT JOIN (
              SELECT date_trunc('week', created_at) AS wk, count(*) AS count
              FROM interventions
              WHERE created_at >= date_trunc('week', now()) - interval '7 weeks'
                AND status <> 'cancelled'
              GROUP BY 1
            ) c ON c.wk = series.week_start
            ORDER BY series.week_start
          `,
        ]);

        const trend: WeeklyTrendPoint[] = trendRows.map((r) => ({
          week: r.week,
          count: Number(r.count),
        }));

        return {
          tenants: {
            total: tenantsTotal,
            active: tenantsActive,
            suspended: tenantsSuspended,
          },
          usersTotal,
          interventions: { total: interventionsTotal, last30d: interventionsLast30d },
          vehiclesTotal,
          customersTotal,
          trend,
        } satisfies PlatformMetrics;
      });

      return reply.code(200).send(metrics);
    },
  );
};

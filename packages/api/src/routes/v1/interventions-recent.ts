import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/recent — F-OFF-501 PR2 (HomeDashboard
// "Ultimi interventi" card). Returns the tenant's most recent active
// or disputed interventions ordered by createdAt DESC. No pagination
// (top-N). RLS topology: interventions SELECT is permissive cross-
// tenant (migration 0003 split SELECT/WRITE) — enforce tenant
// isolation explicitly via findMany {where: {tenantId}}. Same pattern
// as interventions-disputes-list.ts. See
// feedback_rls_split_changes_endpoint_semantics.md.
//
// operator.name composed server-side with defensive fallback "Operatore"
// when the user relation is null or when both firstName and lastName are
// null. Both branches are currently dead code at runtime (users.first_name
// + last_name are NOT NULL in the schema, and intervention.user_id FK is
// onDelete: Restrict) — kept as scaffolding for future schema changes
// (e.g. soft-anonymization). Pattern mirrors interventions-detail.ts:138.

export const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const SUMMARY_MAX = 100;
const OPERATOR_FALLBACK = 'Operatore';

function deriveSummary(title: string | null, description: string): string {
  if (title && title.length > 0) return title;
  const firstLine = description.split('\n')[0] ?? '';
  return firstLine.slice(0, SUMMARY_MAX);
}

function deriveOperatorName(
  user: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!user) return OPERATOR_FALLBACK;
  const composed = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return composed.length > 0 ? composed : OPERATOR_FALLBACK;
}

const interventionRecentRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/recent',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const { limit } = recentQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const rows = await tx.intervention.findMany({
          where: {
            tenantId,
            status: { in: ['active', 'disputed'] },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            id: true,
            createdAt: true,
            status: true,
            title: true,
            description: true,
            userId: true,
            vehicle: {
              select: { id: true, plate: true, make: true, model: true },
            },
            user: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        });

        return {
          items: rows.map((row) => ({
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            status: row.status,
            summary: deriveSummary(row.title, row.description),
            vehicle: {
              id: row.vehicle.id,
              plate: row.vehicle.plate,
              make: row.vehicle.make,
              model: row.vehicle.model,
            },
            operator: {
              id: row.user?.id ?? row.userId,
              name: deriveOperatorName(row.user),
            },
          })),
        };
      });
    },
  );
};

export default interventionRecentRoutes;

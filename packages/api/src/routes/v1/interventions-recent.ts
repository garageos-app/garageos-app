import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

// GET /v1/interventions/recent — F-OFF-501 PR2 (HomeDashboard
// "Ultimi interventi" card). Returns the tenant's most recent active
// or disputed interventions ordered by createdAt DESC. No pagination
// (top-N). RLS topology: interventions SELECT is permissive cross-
// tenant (migration 0003 split SELECT/WRITE) — enforce tenant
// isolation explicitly via findMany {where: {tenantId}}. Same pattern
// as interventions-disputes-list.ts. See
// feedback_rls_split_changes_endpoint_semantics.md.

export const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const interventionRecentRoutes: FastifyPluginAsync = async () => {
  // Handler implemented in Task 3.
};

export default interventionRecentRoutes;

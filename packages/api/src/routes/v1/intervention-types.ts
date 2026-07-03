import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const interventionTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/intervention-types',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const tenantId = request.tenantId!;
      return app.withContext({ tenantId }, async (tx) => {
        // RLS on intervention_types is permissive (SELECT USING true) so the
        // cross-tenant intervention timeline can resolve foreign-tenant type
        // names. Since the PR-4 redesign the catalog is fully global
        // (tenant_id IS NULL) — tenants can no longer own custom rows — so
        // the app-layer `where` below (scoped to global rows) is the actual
        // filtering boundary, not a cross-tenant convenience narrowing.
        //
        // BR-304: opt-out visibility model — a type/checklist item is
        // visible to a tenant unless an explicit exclusion row exists in
        // tenant_intervention_type_exclusions / tenant_checklist_item_exclusions
        // (managed by the platform admin via
        // /v1/admin/tenants/:tenantId/catalog-visibility).
        const types = await tx.interventionType.findMany({
          where: { tenantId: null, active: true },
          orderBy: [{ nameIt: 'asc' }],
          select: {
            id: true,
            code: true,
            nameIt: true,
            description: true,
            icon: true,
            suggestsDeadline: true,
            defaultDeadlineMonths: true,
            defaultDeadlineKm: true,
            checklistItems: {
              where: { active: true },
              orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }],
              select: { id: true, code: true, nameIt: true, sortOrder: true },
            },
          },
        });

        // Sequential awaits, not Promise.all: withContext runs on a single
        // interactive $transaction connection, and concurrent queries on
        // the same tx trigger the pg "client.query() … already executing"
        // warning (see vehicles-timeline.ts / vehicles.ts for the same
        // lesson learned in this codebase).
        const excludedTypes = await tx.tenantInterventionTypeExclusion.findMany({
          where: { tenantId },
          select: { interventionTypeId: true },
        });
        const excludedItems = await tx.tenantChecklistItemExclusion.findMany({
          where: { tenantId },
          select: { checklistItemId: true },
        });
        const excludedTypeIds = new Set(excludedTypes.map((e) => e.interventionTypeId));
        const excludedItemIds = new Set(excludedItems.map((e) => e.checklistItemId));

        const data = types
          .filter((type) => !excludedTypeIds.has(type.id))
          .map((type) => ({
            ...type,
            // Retained for wire shape retro-compat — tenant-owned custom
            // types no longer exist post-redesign, so this is always false.
            custom: false,
            checklistItems: type.checklistItems.filter((item) => !excludedItemIds.has(item.id)),
          }))
          // BR-305: a type is offered to the officina only if it retains
          // >=1 visible checklist item after exclusions are applied —
          // otherwise the intervention-create form could not satisfy
          // BR-300 (checklist required), so the type is omitted entirely.
          .filter((type) => type.checklistItems.length >= 1);

        return { data };
      });
    },
  );
};

export default interventionTypesRoutes;

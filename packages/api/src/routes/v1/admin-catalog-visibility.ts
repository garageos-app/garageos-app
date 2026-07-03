// GET /v1/admin/tenants/:tenantId/catalog-visibility — read a tenant's
//     effective catalog visibility (global catalog + per-tenant exclusions).
// PUT /v1/admin/tenants/:tenantId/catalog-visibility — atomically replace a
//     tenant's exclusion set.
//
// BR-304 (opt-out): every GLOBAL intervention type / checklist item is
// visible to every tenant unless an explicit exclusion row exists in
// tenant_intervention_type_exclusions / tenant_checklist_item_exclusions.
// There is no per-tenant opt-in — `visible = !excluded`.
//
// BR-306: catalogo scrivibile solo dal platform admin. Governance of the
// exclusion tables mirrors the global catalog CRUD in
// admin-intervention-types.ts / admin-checklist-items.ts: requireAuth →
// requirePlatformAdminsPool, no tenantContext middleware (platform admins
// are not tenant users), all DB access through
// app.withContext({ role: 'admin' }) so the *_excl_write RLS policies
// (FOR ALL USING(is_admin_role())) pass.
//
// PUT replaces the tenant's exclusion set atomically: deleteMany + createMany
// in the same transaction as the existence/invalid_ref checks and the audit
// row, so a mid-write failure rolls back the whole exclusion set rather than
// leaving a partial replace.
//
// :tenantId anti-enum pattern (mirrors admin-tenant-detail.ts): an invalid
// UUID and an unknown UUID both surface as
// admin.catalog_visibility.tenant_not_found to avoid leaking existence info.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  PutVisibilityBody,
  serializeCatalogVisibility,
} from '../../lib/dtos/catalog-visibility.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const ParamsSchema = z.object({ tenantId: z.string().uuid() });

export const adminCatalogVisibilityRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/tenants/:tenantId/catalog-visibility ────────────────────────
  app.get(
    '/v1/admin/tenants/:tenantId/catalog-visibility',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → same 404 as unknown UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.catalog_visibility.tenant_not_found',
          404,
          'Officina non trovata.',
        );
      }
      const { tenantId } = parsedParams.data;

      const { types, excludedTypeIds, excludedItemIds } = await app.withContext(
        { role: 'admin' as const },
        async (tx) => {
          const tenant = await tx.tenant.findFirst({
            where: { id: tenantId, deletedAt: null },
            select: { id: true },
          });
          if (!tenant) {
            throw businessError(
              'admin.catalog_visibility.tenant_not_found',
              404,
              'Officina non trovata.',
            );
          }

          const activeTypes = await tx.interventionType.findMany({
            where: { tenantId: null, active: true },
            select: {
              id: true,
              code: true,
              nameIt: true,
              checklistItems: {
                where: { active: true },
                select: { id: true, code: true, nameIt: true, sortOrder: true },
                orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }],
              },
            },
            orderBy: { nameIt: 'asc' },
          });

          const typeExclusions = await tx.tenantInterventionTypeExclusion.findMany({
            where: { tenantId },
            select: { interventionTypeId: true },
          });
          const itemExclusions = await tx.tenantChecklistItemExclusion.findMany({
            where: { tenantId },
            select: { checklistItemId: true },
          });

          return {
            types: activeTypes,
            excludedTypeIds: new Set(typeExclusions.map((e) => e.interventionTypeId)),
            excludedItemIds: new Set(itemExclusions.map((e) => e.checklistItemId)),
          };
        },
      );

      return reply.code(200).send({
        data: { types: serializeCatalogVisibility(types, excludedTypeIds, excludedItemIds) },
      });
    },
  );

  // ── PUT /v1/admin/tenants/:tenantId/catalog-visibility ────────────────────────
  app.put(
    '/v1/admin/tenants/:tenantId/catalog-visibility',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → same 404 as unknown UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.catalog_visibility.tenant_not_found',
          404,
          'Officina non trovata.',
        );
      }
      const { tenantId } = parsedParams.data;

      const parsed = PutVisibilityBody.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const uniqueTypeIds = [...new Set(parsed.data.excludedTypeIds)];
      const uniqueItemIds = [...new Set(parsed.data.excludedItemIds)];

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const tenant = await tx.tenant.findFirst({
          where: { id: tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!tenant) {
          throw businessError(
            'admin.catalog_visibility.tenant_not_found',
            404,
            'Officina non trovata.',
          );
        }

        // invalid_ref: every excluded id must reference an existing GLOBAL
        // type / checklist item under a global type.
        if (uniqueTypeIds.length > 0) {
          const count = await tx.interventionType.count({
            where: { id: { in: uniqueTypeIds }, tenantId: null },
          });
          if (count !== uniqueTypeIds.length) {
            throw businessError(
              'admin.catalog_visibility.invalid_ref',
              422,
              'Riferimento a tipo o voce inesistente.',
            );
          }
        }
        if (uniqueItemIds.length > 0) {
          const count = await tx.interventionChecklistItem.count({
            where: { id: { in: uniqueItemIds }, interventionType: { tenantId: null } },
          });
          if (count !== uniqueItemIds.length) {
            throw businessError(
              'admin.catalog_visibility.invalid_ref',
              422,
              'Riferimento a tipo o voce inesistente.',
            );
          }
        }

        // Atomic replace: wipe the tenant's current exclusion set and
        // re-insert the requested one, in the same transaction.
        await tx.tenantInterventionTypeExclusion.deleteMany({ where: { tenantId } });
        if (uniqueTypeIds.length > 0) {
          await tx.tenantInterventionTypeExclusion.createMany({
            data: uniqueTypeIds.map((interventionTypeId) => ({ tenantId, interventionTypeId })),
          });
        }

        await tx.tenantChecklistItemExclusion.deleteMany({ where: { tenantId } });
        if (uniqueItemIds.length > 0) {
          await tx.tenantChecklistItemExclusion.createMany({
            data: uniqueItemIds.map((checklistItemId) => ({ tenantId, checklistItemId })),
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'system',
            actorId: null,
            action: 'catalog_visibility_updated',
            entityType: 'tenant',
            entityId: tenantId,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
              excludedTypes: uniqueTypeIds.length,
              excludedItems: uniqueItemIds.length,
            },
            ipAddress: request.ip,
          },
        });
      });

      return reply
        .code(200)
        .send({ excludedTypeIds: uniqueTypeIds, excludedItemIds: uniqueItemIds });
    },
  );
};

export default adminCatalogVisibilityRoutes;

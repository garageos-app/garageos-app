import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@garageos/database';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { interventionsListQuerySchema } from './interventions-list.schema.js';

// GET /v1/interventions — "Registro Interventi" list endpoint, PR-1
// (task 2 of 4). Paginated, filterable, sortable list of the tenant's
// interventions for the officina web app. Query-param parsing (incl.
// the checklistItemIds-requires-exactly-one-typeId guard) lives in
// interventions-list.schema.ts (task 1) — the route only builds the
// Prisma where/orderBy/select from the already-validated shape.
//
// RLS topology: interventions SELECT is permissive cross-tenant
// (migration 0003 split SELECT/WRITE) — enforce tenant isolation
// explicitly via {where: {tenantId}} on both count and findMany. Same
// pattern as interventions-recent.ts. See
// feedback_rls_split_changes_endpoint_semantics.md.
//
// operator.name composed server-side with defensive fallback
// "Operatore" — mirrors interventions-recent.ts's deriveOperatorName.

const OPERATOR_FALLBACK = 'Operatore';

function deriveOperatorName(
  user: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!user) return OPERATOR_FALLBACK;
  const composed = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return composed.length > 0 ? composed : OPERATOR_FALLBACK;
}

const interventionsListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const parsed = interventionsListQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      const where: Prisma.InterventionWhereInput = {
        tenantId,
        status: { in: parsed.status },
      };

      if (parsed.q) {
        where.vehicle = {
          OR: [
            { plate: { contains: parsed.q, mode: 'insensitive' } },
            { make: { contains: parsed.q, mode: 'insensitive' } },
            { model: { contains: parsed.q, mode: 'insensitive' } },
          ],
        };
      }

      if (parsed.typeId?.length) {
        where.interventionTypeId = { in: parsed.typeId };
      }

      if (parsed.operatorId?.length) {
        where.userId = { in: parsed.operatorId };
      }

      if (parsed.checklistItemIds?.length) {
        // AND-of-`some` = "has all" of the requested checklist items,
        // per the spec (checklistItemIds requires exactly one typeId,
        // enforced upstream by the Zod refine).
        where.AND = parsed.checklistItemIds.map((id) => ({
          checklistSelections: { some: { checklistItemId: id } },
        }));
      }

      if (parsed.dateFrom || parsed.dateTo) {
        where.interventionDate = {
          ...(parsed.dateFrom ? { gte: new Date(`${parsed.dateFrom}T00:00:00.000Z`) } : {}),
          ...(parsed.dateTo ? { lte: new Date(`${parsed.dateTo}T00:00:00.000Z`) } : {}),
        };
      }

      const order = parsed.order;
      const orderBy: Prisma.InterventionOrderByWithRelationInput[] = (() => {
        switch (parsed.sort) {
          case 'status':
            return [{ status: order }, { id: 'desc' }];
          case 'type':
            return [{ interventionType: { nameIt: order } }, { id: 'desc' }];
          case 'operator':
            return [{ user: { lastName: order } }, { user: { firstName: order } }, { id: 'desc' }];
          case 'km':
            return [{ odometerKm: order }, { id: 'desc' }];
          case 'date':
          default:
            return [{ interventionDate: order }, { id: 'desc' }];
        }
      })();

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        // Single interactive withContext connection — count then
        // findMany must run sequentially, NOT via Promise.all.
        const total = await tx.intervention.count({ where });
        const rows = await tx.intervention.findMany({
          where,
          orderBy,
          skip: (parsed.page - 1) * parsed.pageSize,
          take: parsed.pageSize,
          select: {
            id: true,
            interventionDate: true,
            odometerKm: true,
            status: true,
            userId: true,
            interventionType: {
              select: { id: true, nameIt: true },
            },
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
            interventionDate: row.interventionDate.toISOString().slice(0, 10),
            odometerKm: row.odometerKm,
            status: row.status,
            type: { id: row.interventionType.id, nameIt: row.interventionType.nameIt },
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
          total,
          page: parsed.page,
          pageSize: parsed.pageSize,
        };
      });
    },
  );
};

export default interventionsListRoutes;

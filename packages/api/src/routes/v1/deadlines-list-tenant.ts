import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/deadlines — F-OFF-402.
//
// Officina-side aggregate read of all deadlines for the calling
// tenant. RLS deadlines_tenant_isolation guarantees tenant scoping.
// Customer PII gated by BR-151 via resolvePiiVisibility +
// maskCustomer (mirror vehicles/search PR #76 pattern).
//
// Note: 'overdue' status is in the enum but no cron updates it today.
// The filter accepts it for forward-compat; frontend derives
// effectiveStatus from (dueDate < today && status === 'open').

const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).default('open'),
  intervention_type_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const deadlinesListTenantRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/deadlines',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { status, intervention_type_id, limit, cursor } = querySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.deadline.findMany({
          where: {
            status,
            ...(intervention_type_id ? { interventionTypeId: intervention_type_id } : {}),
          },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            vehicleId: true,
            interventionTypeId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            isRecurring: true,
            status: true,
            interventionType: { select: { id: true, code: true, nameIt: true } },
            vehicle: {
              select: {
                id: true,
                plate: true,
                make: true,
                model: true,
                ownerships: {
                  where: { endedAt: null },
                  take: 1,
                  select: {
                    customer: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        phone: true,
                        isBusiness: true,
                        businessName: true,
                        vatNumber: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;

        // BR-151 PII visibility per row's customer (if any active ownership).
        const customerIds = items
          .flatMap((d) => d.vehicle.ownerships.map((o) => o.customer?.id))
          .filter((id): id is string => Boolean(id));
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const data = items.map((d) => {
          const ownership = d.vehicle.ownerships[0] ?? null;
          const cust = ownership?.customer ?? null;
          return {
            id: d.id,
            vehicleId: d.vehicleId,
            interventionTypeId: d.interventionTypeId,
            dueDate: d.dueDate,
            dueOdometerKm: d.dueOdometerKm,
            description: d.description,
            isRecurring: d.isRecurring,
            status: d.status,
            interventionType: d.interventionType,
            vehicle: {
              id: d.vehicle.id,
              plate: d.vehicle.plate,
              make: d.vehicle.make,
              model: d.vehicle.model,
              currentOwnership: cust
                ? { customer: maskCustomer(cust, visibleSet.has(cust.id)) }
                : null,
            },
          };
        });

        const nextCursor = hasMore ? items[items.length - 1]!.id : null;
        return reply.send({ deadlines: data, nextCursor });
      });
    },
  );
};

export default deadlinesListTenantRoutes;

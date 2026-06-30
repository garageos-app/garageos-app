import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';

// GET /v1/vehicles/:vehicleId/deadlines — F-OFF-401 read endpoint.
//
// Dual-pool list:
//   - Officina (tenantContext): RLS deadlines_tenant_isolation scopes
//     visible deadlines to caller tenant. Cross-tenant deadlines are
//     filtered out, so an officina querying a vehicle owned by another
//     tenant gets an empty page (consistent with POST /deadlines BR-150
//     semantics — vehicles are globally readable, deadlines are not).
//   - Customer (clientiContext): RLS deadlines_customer_select admits
//     deadlines on vehicles the customer owns (active vehicle_ownerships
//     row). We add an explicit ownership pre-check to surface a flat
//     404 when the customer does not own the vehicle, instead of leaking
//     existence via an empty list.
//
// vehicles_read is permissive USING(true) (BR-150), so the officina
// "vehicle existence" 404 here covers only "vehicle id does not exist
// at all", not "vehicle exists in another tenant". Mirrors the POST
// handler in deadlines-create.ts.
//
// Cursor pagination:
//   - orderBy: dueDate ASC NULLS LAST, then id ASC for stable tie-break.
//   - Implementation: take(limit + 1), peek hasMore, slice, return
//     nextCursor = last visible row's id (consumed by Prisma cursor on
//     the next page request, with skip: 1).

const paramSchema = z.object({ vehicleId: z.uuid() });
const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const deadlinesListVehicleRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/:vehicleId/deadlines',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request, reply) => {
      const { vehicleId } = paramSchema.parse(request.params);
      const { status, limit, cursor } = querySchema.parse(request.query);

      // dualPoolContext sets either tenantId (officine) or customerId
      // (clienti) via the underlying pool-specific context middleware.
      const ctx = request.tenantId
        ? { tenantId: request.tenantId }
        : { customerId: request.customerId! };

      return app.withContext(ctx, async (tx) => {
        if (request.customerId) {
          // Customer-pool: explicit active-ownership precondition.
          // deadlines_customer_select RLS only admits deadlines on
          // owned vehicles, so an empty list is observable for a
          // non-owner. To avoid leaking that the vehicle exists in
          // some tenant, we collapse "no ownership" into a 404.
          const ownership = await tx.vehicleOwnership.findFirst({
            where: { vehicleId, customerId: request.customerId, endedAt: null },
            select: { id: true },
          });
          if (!ownership) {
            throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
          }
        } else {
          // Officina-pool: vehicles_read USING(true) (BR-150) makes any
          // existing vehicle visible. We only 404 when the id truly
          // does not exist; cross-tenant returns empty deadlines
          // because deadlines_tenant_isolation filters at the query
          // layer (no leak — caller already knew the id).
          const vehicle = await tx.vehicle.findUnique({
            where: { id: vehicleId },
            select: { id: true },
          });
          if (!vehicle) {
            throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
          }
        }

        const rows = await tx.deadline.findMany({
          where: {
            vehicleId,
            ...(status ? { status } : {}),
          },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            tenantId: true,
            vehicleId: true,
            interventionTypeId: true,
            sourceInterventionId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            isRecurring: true,
            recurringMonths: true,
            recurringKm: true,
            status: true,
            completedByInterventionId: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true,
            interventionType: { select: { id: true, code: true, nameIt: true } },
          },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? items[items.length - 1]!.id : null;

        return reply.send({ deadlines: items, nextCursor });
      });
    },
  );
};

export default deadlinesListVehicleRoutes;

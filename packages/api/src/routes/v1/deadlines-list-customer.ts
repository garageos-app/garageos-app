import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET /v1/me/deadlines — F-CLI-301.
//
// Customer-pool read of all deadlines on vehicles the authenticated
// customer currently owns (active ownership, BR-040: ended_at IS NULL).
// RLS policy `deadlines_customer_select` (migration 20260508130000)
// admits exactly those rows when the calling customer matches an
// active vehicle_ownerships row, so no application-side join is needed
// for isolation — we just rely on the policy and let `withContext`
// set `app.current_customer_id`.
//
// Default status filter: when the caller does not pass `?status=`, we
// return only `open|overdue` (the active surfaces a B2C app cares
// about). Explicit `?status=` overrides — the customer can still ask
// for completed/cancelled history if the UI exposes it.
//
// Cursor pagination matches the officine list endpoint
// (deadlines-list-vehicle.ts): orderBy dueDate ASC NULLS LAST then id
// ASC for tie-break, take(limit + 1) peek-ahead, return nextCursor =
// last visible row id (Prisma cursor on next request, with skip: 1).
//
// Response includes nested `vehicle` (id, plate, make, model) and
// `interventionType` (id, code, nameIt) for direct B2C app rendering
// without follow-up requests. Vehicle.plate (not licensePlate) per
// schema.prisma — see Task 8 hotfix lesson.

const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const deadlinesListCustomerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/deadlines',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request, reply) => {
      const { status, limit, cursor } = querySchema.parse(request.query);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // Default filter: open + overdue. The B2C UI treats these as the
        // "actionable" set; completed/cancelled are history and only
        // surface when explicitly asked for via ?status=.
        const statusFilter = status
          ? { status }
          : { status: { in: ['open', 'overdue'] as ('open' | 'overdue')[] } };

        const rows = await tx.deadline.findMany({
          where: { ...statusFilter },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
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
            vehicle: {
              select: {
                id: true,
                plate: true,
                make: true,
                model: true,
              },
            },
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

export default deadlinesListCustomerRoutes;

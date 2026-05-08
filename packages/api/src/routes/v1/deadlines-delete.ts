import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { cancelPendingReminders } from '../../lib/deadlines/scheduling.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// DELETE /v1/deadlines/:id — F-OFF-401 soft-delete endpoint.
//
// Tenant-scoped soft delete:
//   1. cancelPendingReminders → for each pending DeadlineNotification
//      issue a DeleteSchedule + flip deliveryStatus='cancelled'. Sent
//      rows are preserved untouched (audit append-only invariant).
//   2. flip deadline.status='cancelled'.
//
// 204 — success (no body).
// 204 — idempotent on already-cancelled (no AWS calls, no DB churn).
// 409 deadline.delete.completed — completed deadlines preserve audit
//      and cannot be retroactively erased. Operators correct mistakes
//      via the complete-with-undo workflow within the BR window, not
//      via DELETE on a completed row.
// 404 — RLS-as-404 via P2025. deadlines_tenant_isolation scopes
//      SELECT/UPDATE to the caller tenant; cross-tenant ids and
//      unknown ids both surface as findUniqueOrThrow → P2025 → 404
//      through the shared error handler.

const paramSchema = z.object({ id: z.uuid() });

const deadlinesDeleteRoutes: FastifyPluginAsync = async (app) => {
  app.delete(
    '/v1/deadlines/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id } = paramSchema.parse(request.params);
      const tenantId = request.tenantId!;

      await app.withContext({ tenantId }, async (tx) => {
        // RLS-as-404: deadlines_tenant_isolation scopes both SELECT and
        // UPDATE to the caller tenant. A row owned by a different tenant
        // (or a non-existent id) raises P2025 → 404 via error-handler.
        const existing = await tx.deadline.findUniqueOrThrow({
          where: { id },
          select: { id: true, status: true },
        });

        if (existing.status === 'completed') {
          throw businessError(
            'deadline.delete.completed',
            409,
            'Una scadenza completata non può essere cancellata.',
          );
        }

        if (existing.status === 'cancelled') {
          // Idempotent — already cancelled. No AWS work, no DB churn.
          return;
        }

        // Status is 'open' or 'overdue' — both are deletable.
        await cancelPendingReminders({ tx, deadlineId: id, reason: 'deadline deleted' });
        await tx.deadline.update({ where: { id }, data: { status: 'cancelled' } });
      });

      return reply.code(204).send();
    },
  );
};

export default deadlinesDeleteRoutes;

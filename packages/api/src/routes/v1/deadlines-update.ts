import { UpdateDeadlineSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { replaceReminders } from '../../lib/deadlines/scheduling.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/deadlines/:id — F-OFF-401 update endpoint.
//
// Officina updates a tenant-scoped deadline. Two distinct write paths:
//
//   1. dueDate change → cancel the pending DeadlineNotification rows +
//      DeleteSchedule for each, then re-insert a fresh set anchored at
//      the new dueDate via createReminders. This goes through
//      replaceReminders, which preserves already-`sent` rows untouched
//      (audit-preserving append-only invariant) and emits
//      X-GarageOS-Warning: scheduler_partial when at least one
//      CreateSchedule call fails.
//
//   2. Non-date update → DB-only mutation. Zero AWS Scheduler calls,
//      zero DeadlineNotification mutations. Cadence / description /
//      odometer / isRecurring move on the row but the existing
//      reminders point at the same dueDate so they remain valid.
//
// 409 — `deadline.update.not_open` when status != 'open' (BR-100..BR-109:
// completed and cancelled deadlines are immutable; correcting an error
// means logging a new row, not re-opening the existing one).
//
// 404 — RLS-as-404 via P2025. deadlines_tenant_isolation scopes the
// SELECT/UPDATE to the caller tenant, so cross-tenant ids surface as
// findUniqueOrThrow → P2025 → 404 NOT_FOUND through the shared error
// handler. Same path covers truly unknown ids.

const paramSchema = z.object({ id: z.uuid() });

const deadlinesUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/deadlines/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id } = paramSchema.parse(request.params);
      const body = UpdateDeadlineSchema.parse(request.body);
      const tenantId = request.tenantId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // RLS-as-404: deadlines_tenant_isolation scopes both SELECT and
        // UPDATE to the caller tenant. A row owned by a different tenant
        // (or a non-existent id) raises P2025 → 404 via error-handler.
        const existing = await tx.deadline.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            status: true,
            dueDate: true,
          },
        });

        if (existing.status !== 'open') {
          // BR-100..BR-109: completed / cancelled / overdue deadlines
          // are read-only. Mutation requires creating a new deadline,
          // not flipping the status field.
          throw businessError(
            'deadline.update.not_open',
            409,
            `Impossibile modificare una scadenza in stato ${existing.status}.`,
          );
        }

        // Detect a real dueDate change — same-day PATCH must not fan out
        // to AWS Scheduler. Compare ms timestamps to bypass instance
        // identity. Existing dueDate is nullable in the schema; treat
        // null as "change" since any non-null body value differs from it.
        const dateChanging =
          body.dueDate != null && body.dueDate.getTime() !== (existing.dueDate?.getTime() ?? -1);

        // Build the partial update payload. We include each key only
        // when present in the body so a missing key on the wire does
        // NOT clobber the existing column to null. Nullable keys in the
        // schema accept `null` to clear the value; that is preserved.
        const data: Record<string, unknown> = {};
        if (body.dueDate !== undefined) data.dueDate = body.dueDate;
        if (body.dueOdometerKm !== undefined) data.dueOdometerKm = body.dueOdometerKm;
        if (body.description !== undefined) data.description = body.description;
        if (body.isRecurring !== undefined) data.isRecurring = body.isRecurring;
        if (body.recurringMonths !== undefined) data.recurringMonths = body.recurringMonths;
        if (body.recurringKm !== undefined) data.recurringKm = body.recurringKm;

        await tx.deadline.update({ where: { id }, data });

        // dueDate change → cancel + recreate reminder set. Past T-30/T-7
        // are filtered inside createReminders so a near-future re-target
        // still produces the correct subset (e.g. only T-0 if the new
        // date is < 7 days away).
        let partial = false;
        if (dateChanging && body.dueDate) {
          const r = await replaceReminders({
            tx,
            deadlineId: id,
            newDueDate: body.dueDate,
          });
          partial = r.partial;
        }

        // Re-fetch the row with the public response shape, plus the
        // current notification set (which may have been replaced above).
        const refreshed = await tx.deadline.findUniqueOrThrow({
          where: { id },
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
          },
        });
        const notifications = await tx.deadlineNotification.findMany({
          where: { deadlineId: id },
          orderBy: { scheduledFor: 'asc' },
          select: {
            id: true,
            scheduledFor: true,
            reminderType: true,
            deliveryStatus: true,
            sentAt: true,
            eventbridgeScheduleArn: true,
          },
        });
        return { deadline: refreshed, notifications, partial };
      });

      if (result.partial) {
        reply.header('X-GarageOS-Warning', 'scheduler_partial');
      }

      return reply.send({
        ...result.deadline,
        notifications: result.notifications,
      });
    },
  );
};

export default deadlinesUpdateRoutes;

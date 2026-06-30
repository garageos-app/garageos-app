import { CompleteDeadlineSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { createNextRecurringDeadline } from '../../lib/deadlines/recurrence.js';
import { cancelPendingReminders } from '../../lib/deadlines/scheduling.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/deadlines/:id/complete — F-OFF-405.
//
// Officina marks an open deadline as completed. The closing intervention
// is optionally linked via `completedByInterventionId` (BR-100..BR-109).
//
// Three side effects, in order:
//   1. cancelPendingReminders → for each pending DeadlineNotification
//      issue a DeleteSchedule + flip deliveryStatus='cancelled'. Sent
//      rows are preserved untouched (audit append-only invariant).
//   2. flip deadline.status='completed' + completedAt=now +
//      completedByInterventionId.
//   3. If isRecurring=true && recurringMonths > 0, auto-create the next
//      cycle via createNextRecurringDeadline (anniversary semantic:
//      newDueDate = oldDueDate + recurringMonths). The new row carries
//      sourceInterventionId = body.completedByInterventionId (chain of
//      provenance). Up to 3 reminders are scheduled for the new cycle;
//      past anniversary instants are silently skipped by createReminders.
//
// recurringKm-only recurrence (recurringMonths=null) is intentionally
// skipped — BR-103 specifies reminders are date-driven.
//
// Response shape: { completed, next } where `next` is null for non-
// recurring deadlines or when the recurrence guard is not satisfied.
//
// 409 deadline.complete.not_open — when status != 'open' (BR-100..
// BR-109: only open deadlines transition to completed; an already-
// completed or cancelled deadline is immutable).
// 422 deadline.complete.intervention_invalid — when the supplied
// completedByInterventionId belongs to a different vehicle or a
// different tenant (cross-tenant detection works because Intervention
// has its own RLS scope, but we double-check tenantId belt-and-braces).
// 404 — RLS-as-404. deadlines_tenant_isolation scopes SELECT/UPDATE to
// the caller tenant; cross-tenant deadlines and unknown ids both surface
// as findUniqueOrThrow → P2025 → 404 NOT_FOUND.

const paramSchema = z.object({ id: z.uuid() });

const deadlinesCompleteRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/deadlines/:id/complete',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id } = paramSchema.parse(request.params);
      const body = CompleteDeadlineSchema.parse(request.body ?? {});
      const tenantId = request.tenantId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // RLS-as-404: deadlines_tenant_isolation scopes SELECT/UPDATE to
        // the caller tenant. Cross-tenant or unknown ids raise P2025
        // → 404 via the shared error handler.
        const existing = await tx.deadline.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            vehicleId: true,
            interventionTypeId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            isRecurring: true,
            recurringMonths: true,
            recurringKm: true,
            status: true,
          },
        });

        if (existing.status !== 'open') {
          // BR-100..BR-109: completed / cancelled deadlines are
          // read-only. Re-completing or completing-after-cancel requires
          // a new deadline, not flipping the status field.
          throw businessError(
            'deadline.complete.not_open',
            409,
            `Impossibile completare una scadenza in stato ${existing.status}.`,
          );
        }

        // Validate the optional completedByInterventionId: it must point
        // to an intervention in the same tenant AND on the same vehicle
        // as the deadline. Cross-vehicle / cross-tenant rejected 422.
        if (body.completedByInterventionId) {
          const ix = await tx.intervention.findUnique({
            where: { id: body.completedByInterventionId },
            select: { id: true, vehicleId: true, tenantId: true },
          });
          if (!ix || ix.tenantId !== tenantId || ix.vehicleId !== existing.vehicleId) {
            throw businessError(
              'deadline.complete.intervention_invalid',
              422,
              'completedByInterventionId non valido per questo veicolo.',
            );
          }
        }

        const completedAt = new Date();
        await cancelPendingReminders({ tx, deadlineId: id, reason: 'deadline completed' });
        await tx.deadline.update({
          where: { id },
          data: {
            status: 'completed',
            completedAt,
            completedByInterventionId: body.completedByInterventionId ?? null,
          },
        });

        // Auto-create next recurring cycle when both isRecurring and a
        // positive recurringMonths cadence are set. dueDate is required
        // for anniversary arithmetic — narrow nullability before the call.
        let next: Record<string, unknown> | null = null;
        if (
          existing.isRecurring &&
          existing.recurringMonths != null &&
          existing.recurringMonths > 0 &&
          existing.dueDate
        ) {
          next = await createNextRecurringDeadline({
            tx,
            completed: {
              id: existing.id,
              tenantId: existing.tenantId,
              vehicleId: existing.vehicleId,
              interventionTypeId: existing.interventionTypeId,
              dueDate: existing.dueDate,
              dueOdometerKm: existing.dueOdometerKm,
              description: existing.description,
              isRecurring: existing.isRecurring,
              recurringMonths: existing.recurringMonths,
              recurringKm: existing.recurringKm,
              completedByInterventionId: body.completedByInterventionId ?? null,
            },
          });
        }

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

        return { completed: refreshed, next };
      });

      return reply.code(200).send(result);
    },
  );
};

export default deadlinesCompleteRoutes;

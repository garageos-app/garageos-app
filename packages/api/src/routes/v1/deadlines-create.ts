import { CreateDeadlineSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { createReminders } from '../../lib/deadlines/scheduling.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/vehicles/:vehicleId/deadlines — F-OFF-401. Officina creates
// a deadline on a vehicle and triggers the H3 EventBridge Scheduler
// integration: up to 3 reminder notifications (T-30, T-7, T-0 days,
// each anchored at 08:00 Europe/Rome) are scheduled via createReminders.
//
// BR-100..BR-109 — deadline lifecycle. dueDate is validated forward-only
// at the Zod layer (BR-103: reminders are forward-looking; retroactive
// logging belongs in POST /interventions).
//
// RLS-as-404 — vehicles_select RLS scopes to current_tenant_id() so
// cross-tenant lookups produce P2025 → 404 via the shared error handler.
//
// intervention_types SELECT was made permissive in PR #60 (cross-tenant
// timeline support). This route filters app-side: we accept system rows
// (tenant_id IS NULL) OR rows belonging to the current tenant; anything
// else is rejected with 422 deadline.intervention_type.not_found.
// See feedback_rls_intervention_types_permissive_read.md.
//
// sourceInterventionId is optional but, when present, must belong to
// THIS vehicle and the current tenant. Cross-vehicle / cross-tenant
// values are rejected 422.
//
// Scheduler failure is a compensating action: the deadline row commits
// regardless, but each failed CreateSchedule call flips the matching
// notification row to deliveryStatus=failed. When ANY row failed, the
// response carries header X-GarageOS-Warning: scheduler_partial.

const paramSchema = z.object({ vehicleId: z.uuid() });

const deadlinesCreateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:vehicleId/deadlines',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { vehicleId } = paramSchema.parse(request.params);
      const body = CreateDeadlineSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // (cognitoSub, tenantId) lookup post-0004 — see users.ts header
        // for the cross-tenant defense-in-depth rationale.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true, role: true, locationId: true },
        });

        // Vehicle existence enforced by RLS — P2025 → 404 covers both
        // unknown id and other-tenant id (RLS-as-404). Vehicle has no
        // tenantId / locationId columns in the schema (tenant ownership
        // is via createdByTenantId / certifiedByTenantId; visibility is
        // via vehicle_ownerships); this lookup is purely an existence
        // gate that piggybacks on the vehicles_select RLS scope.
        await tx.vehicle.findUniqueOrThrow({
          where: { id: vehicleId },
          select: { id: true },
        });

        // Deadline.locationId is NOT NULL in the schema. Mirrors the
        // pattern in routes/v1/interventions.ts: location is inferred
        // from the authenticated user. Super-admin accounts without a
        // primary location must be associated to one before creating
        // deadlines.
        if (!user.locationId) {
          throw businessError(
            'deadline.creation.user_no_location',
            422,
            "L'utente autenticato non è associato a una location. Imposta una location prima di creare scadenze.",
          );
        }

        // intervention_types is permissive read post-PR #60. Filter app-
        // side: accept system rows (tenantId IS NULL) OR our own.
        const itype = await tx.interventionType.findUnique({
          where: { id: body.interventionTypeId },
          select: { id: true, tenantId: true },
        });
        if (!itype || (itype.tenantId !== null && itype.tenantId !== tenantId)) {
          throw businessError(
            'deadline.intervention_type.not_found',
            422,
            'Tipo intervento non trovato per questo tenant.',
          );
        }

        if (body.sourceInterventionId) {
          const src = await tx.intervention.findUnique({
            where: { id: body.sourceInterventionId },
            select: { id: true, vehicleId: true, tenantId: true },
          });
          if (!src || src.tenantId !== tenantId || src.vehicleId !== vehicleId) {
            throw businessError(
              'deadline.source_intervention.invalid',
              422,
              'sourceInterventionId non valido per questo veicolo.',
            );
          }
        }

        // BR-100..BR-109 — deadline create.
        const deadline = await tx.deadline.create({
          data: {
            tenantId,
            locationId: user.locationId,
            vehicleId,
            interventionTypeId: itype.id,
            sourceInterventionId: body.sourceInterventionId ?? null,
            dueDate: body.dueDate,
            dueOdometerKm: body.dueOdometerKm ?? null,
            description: body.description ?? null,
            isRecurring: body.isRecurring,
            recurringMonths: body.recurringMonths ?? null,
            recurringKm: body.recurringKm ?? null,
            status: 'open',
          },
          select: {
            id: true,
            tenantId: true,
            locationId: true,
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

        // BR-102: schedule the 3 reminders (or fewer if some are already
        // in the past). createReminders does the past-date filter +
        // compensating-action handling internally.
        const remindersResult = await createReminders({
          tx,
          deadlineId: deadline.id,
          dueDate: body.dueDate,
        });

        // Re-fetch notifications with the fields the client cares about.
        // The eventbridgeScheduleArn is stamped post-INSERT inside
        // createReminders, so we need a fresh read here.
        const notifications = await tx.deadlineNotification.findMany({
          where: { deadlineId: deadline.id },
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

        return { deadline, notifications, partial: remindersResult.partial };
      });

      if (result.partial) {
        reply.header('X-GarageOS-Warning', 'scheduler_partial');
      }

      return reply.code(201).send({
        ...result.deadline,
        notifications: result.notifications,
      });
    },
  );
};

export default deadlinesCreateRoutes;

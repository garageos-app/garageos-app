import type { FastifyBaseLogger } from 'fastify';

import type { PrismaClient } from '@garageos/database';

import { dispatchNotification } from '../notifications/dispatcher.js';
import { resolveCurrentOwner } from '../notifications/recipient-resolver.js';
import type { DeadlineReminderType } from '../notifications/types.js';

// AppLike is a structural subset of FastifyInstance — only the two
// members consumed by processSchedulerInvocation. Using a local
// interface (not importing FastifyInstance directly) keeps this lib
// free of any server bootstrapping dependency and makes unit tests
// trivially fakeable without fastify scaffolding.
//
// withContext ctx shape mirrors the signature declared in
// packages/api/src/plugins/database.ts — { role: 'admin' } is the
// cross-tenant escape hatch required because scheduler invocations
// carry no JWT. See feedback_withcontext_empty_blocks_rls_writes.md:
// an empty ctx object {} would silently deny RLS-protected writes.
export interface AppLike {
  withContext: <T>(
    ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
  log: FastifyBaseLogger;
}

export interface SchedulerInvocationDetail {
  deadlineNotificationId: string;
  reminderType: DeadlineReminderType;
}

export type SchedulerInvocationStatus =
  | 'sent'
  | 'skipped_already_processed'
  | 'skipped_deadline_cancelled'
  | 'skipped_no_owner'
  | 'skipped_preferences'
  | 'failed';

export interface SchedulerInvocationResult {
  status: SchedulerInvocationStatus;
  error?: string;
}

// processSchedulerInvocation — the 6-branch handler invoked by
// withSchedulerGuard (Task 9) when EventBridge Scheduler fires a
// deadline reminder.
//
// Idempotency contract: every branch gates on the current
// deliveryStatus of the notification row. Scheduler retries on
// `failed` rows can retry indefinitely; all other statuses short-
// circuit immediately (skipped_already_processed) so duplicate
// invocations are harmless.
//
// Cross-tenant: uses { role: 'admin' } so the RLS context permits
// writes across all tenants without a JWT. See
// feedback_withcontext_empty_blocks_rls_writes.md for why {} alone
// would silently fail.
export async function processSchedulerInvocation(input: {
  app: AppLike;
  detail: SchedulerInvocationDetail;
}): Promise<SchedulerInvocationResult> {
  const { app, detail } = input;

  // See BR-XXX: all DB access runs under the admin role context so
  // RLS cross-tenant reads/writes succeed without a tenant-scoped JWT.
  return app.withContext({ role: 'admin' }, async (tx) => {
    const row = await tx.deadlineNotification.findUnique({
      where: { id: detail.deadlineNotificationId },
      select: {
        id: true,
        deadlineId: true,
        deliveryStatus: true,
        reminderType: true,
        scheduledFor: true,
        deadline: {
          select: {
            id: true,
            status: true,
            tenantId: true,
            vehicleId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            interventionType: { select: { nameIt: true } },
            vehicle: { select: { id: true, plate: true } },
          },
        },
      },
    });

    // Branch 1a: row was deleted between schedule creation and fire.
    // Treat as already-processed — no update needed (no row to update).
    if (!row) {
      app.log.warn({ scheduler: { detail, result: 'row_missing' } });
      return { status: 'skipped_already_processed' as const };
    }

    // Branch 1b: row exists but was already processed (Scheduler
    // retry after a prior success/cancellation). Short-circuit without
    // touching the row to preserve audit integrity.
    if (row.deliveryStatus !== 'pending') {
      return { status: 'skipped_already_processed' as const };
    }

    const deadline = row.deadline;

    // Branch 2: parent deadline was deleted or completed between
    // schedule creation and invocation. Mark notification cancelled
    // so it doesn't retry.
    if (deadline.status !== 'open') {
      await tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'cancelled', failureReason: `deadline ${deadline.status}` },
      });
      return { status: 'skipped_deadline_cancelled' as const };
    }

    // Branch 3: no active customer ownership on the vehicle (BR-040).
    // Mark failed (not cancelled) so a manual retry is possible if
    // ownership is reassigned later — though in practice the Scheduler
    // won't re-fire after this unless the row is manually reset.
    const recipient = await resolveCurrentOwner(tx, deadline.vehicleId);
    if (!recipient) {
      await tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'failed', failureReason: 'no_current_owner' },
      });
      return { status: 'skipped_no_owner' as const };
    }

    const dueDateIso = deadline.dueDate ? deadline.dueDate.toISOString().slice(0, 10) : '';

    // dispatchNotification NEVER throws (see contract in dispatcher.ts).
    // Branch 4 (pref-off), 5 (sent), and 6 (failed) are determined by
    // the returned DispatchResult.
    const dispatchResult = await dispatchNotification({
      event: {
        type: 'deadline.reminder',
        deadlineId: deadline.id,
        reminderType: detail.reminderType,
        dueDate: dueDateIso,
        dueOdometerKm: deadline.dueOdometerKm,
        vehicleId: deadline.vehicle.id,
        vehicleLicensePlate: deadline.vehicle.plate,
        interventionTypeName: deadline.interventionType.nameIt,
        description: deadline.description,
      },
      recipient,
      logger: app.log,
    });

    // Branch 4: customer disabled deadline reminders. Mark cancelled
    // (not failed) — retrying would produce the same outcome.
    if (dispatchResult.skipped === 'pref-off') {
      await tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'cancelled', failureReason: 'preference_disabled' },
      });
      return { status: 'skipped_preferences' as const };
    }

    // Branch 5: email sent successfully.
    if (dispatchResult.sent) {
      await tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'sent', sentAt: new Date() },
      });
      return { status: 'sent' as const };
    }

    // Branch 6: dispatch failed (SES error, network timeout, etc.).
    // Mark the row failed but DO NOT suppress the error signal — the
    // caller (withSchedulerGuard, Task 9) will return a non-2xx status
    // so EventBridge Scheduler retries the invocation automatically.
    const errorMessage = dispatchResult.error ?? 'unknown';
    await tx.deadlineNotification.update({
      where: { id: row.id },
      data: { deliveryStatus: 'failed', failureReason: errorMessage },
    });
    return { status: 'failed' as const, error: errorMessage };
  });
}

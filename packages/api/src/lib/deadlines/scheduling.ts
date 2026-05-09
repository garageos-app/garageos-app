import type { PrismaClient } from '@garageos/database';

import { createReminderSchedule, deleteReminderSchedule } from '../scheduler-client.js';
import {
  computeReminderSchedule,
  buildPendingSchedules,
  type DeadlineReminderType,
} from './compute-reminders.js';

// PrismaTxLike is a structural subset of PrismaClient (and its $transaction callback
// argument) — only the deadlineNotification delegate is required. Using Pick here
// works because PrismaClient is a class whose delegates are readonly properties; the
// structural match is sufficient for both the real client and the fake tx in tests.
type PrismaTxLike = Pick<PrismaClient, 'deadlineNotification'>;

// ─── createReminders ─────────────────────────────────────────────────────────

export interface CreateRemindersInput {
  tx: PrismaTxLike;
  deadlineId: string;
  dueDate: Date;
  /** Reference instant for filtering past schedules. Defaults to `new Date()`. */
  now?: Date;
}

export interface CreateRemindersResult {
  created: Array<{
    id: string;
    reminderType: DeadlineReminderType;
    scheduledFor: Date;
    deliveryStatus: 'pending' | 'failed';
  }>;
  /** true when at least one row failed to register with EventBridge Scheduler. */
  partial: boolean;
}

/**
 * For a given deadline, INSERT up to 3 DeadlineNotification rows (one per
 * reminder type) and register each with EventBridge Scheduler.
 *
 * Past reminder instants (T-30, T-7, T-0 already elapsed) are silently
 * skipped — no DB row is created for them. See BR-103.
 *
 * AWS Scheduler failure for a single row is a compensating action: that row's
 * `deliveryStatus` is flipped to `failed` (the DB row persists for auditability)
 * and `result.partial` is set to `true`. The rest of the rows continue
 * unaffected. The Prisma transaction is NOT rolled back.
 *
 * Schedule name convention: `deadline-{deadlineNotificationId}`.
 */
export async function createReminders(input: CreateRemindersInput): Promise<CreateRemindersResult> {
  const now = input.now ?? new Date();
  const set = computeReminderSchedule(input.dueDate);
  const pending = buildPendingSchedules(set, now);

  const created: CreateRemindersResult['created'] = [];
  let partial = false;

  for (const item of pending) {
    // INSERT first so we have the DB-generated UUID for the schedule name.
    const row = await input.tx.deadlineNotification.create({
      data: {
        deadlineId: input.deadlineId,
        scheduledFor: item.scheduledFor,
        reminderType: item.reminderType,
        deliveryStatus: 'pending',
      },
      select: { id: true, reminderType: true, scheduledFor: true, deliveryStatus: true },
    });

    try {
      // Schedule name is deterministic from the notification id — used for
      // idempotent DeleteSchedule calls in cancelPendingReminders.
      const arn = await createReminderSchedule({
        scheduleName: `deadline-${row.id}`,
        scheduledFor: item.scheduledFor,
        payload: { deadlineNotificationId: row.id, reminderType: item.reminderType },
      });
      // Stamp the ARN for observability (logs, admin queries). Not used for
      // deletion — we always reconstruct the schedule name from the row id.
      await input.tx.deadlineNotification.update({
        where: { id: row.id },
        data: { eventbridgeScheduleArn: arn },
      });
      created.push({
        id: row.id,
        reminderType: row.reminderType as DeadlineReminderType,
        scheduledFor: row.scheduledFor,
        deliveryStatus: 'pending',
      });
    } catch (err) {
      // Compensating action: mark only THIS row failed. Other rows are unaffected.
      partial = true;
      const failureReason = err instanceof Error ? err.message : String(err);
      await input.tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'failed', failureReason },
      });
      created.push({
        id: row.id,
        reminderType: row.reminderType as DeadlineReminderType,
        scheduledFor: row.scheduledFor,
        deliveryStatus: 'failed',
      });
    }
  }

  return { created, partial };
}

// ─── cancelPendingReminders ───────────────────────────────────────────────────

export interface CancelPendingRemindersInput {
  tx: PrismaTxLike;
  deadlineId: string;
  /** Human-readable reason stored in `failureReason` for auditability. */
  reason: string;
}

/**
 * Cancel all pending or stranded-failed reminders for a deadline.
 *
 * For each pending row:
 *   1. DeleteSchedule via `deadline-{id}` (idempotent — swallows ResourceNotFoundException).
 *   2. Flip `deliveryStatus` to `cancelled`, storing `reason` in `failureReason`.
 *
 * For each failed row WITH an active EventBridge schedule (e.g. SES error
 * mid-fire left the schedule untouched):
 *   1. DeleteSchedule via `deadline-{id}` (idempotent).
 *   2. Nullify `eventbridgeScheduleArn` only — preserve `deliveryStatus='failed'`
 *      and the original `failureReason` for audit history. Nullifying the ARN
 *      ensures re-entry skips this row (predicate filters `eventbridgeScheduleArn IS NOT NULL`).
 *
 * `sent` rows are never touched (audit-preserving append-only invariant).
 * Already-`cancelled` rows are excluded by the OR predicate. Failed rows
 * without an active ARN (already cleaned up) are also excluded.
 */
export async function cancelPendingReminders(input: CancelPendingRemindersInput): Promise<void> {
  const rows = await input.tx.deadlineNotification.findMany({
    where: {
      deadlineId: input.deadlineId,
      OR: [
        { deliveryStatus: 'pending' },
        { deliveryStatus: 'failed', eventbridgeScheduleArn: { not: null } },
      ],
    },
    select: { id: true, deliveryStatus: true, eventbridgeScheduleArn: true },
  });

  for (const row of rows) {
    // Use deterministic name pattern — not the stored ARN — because
    // DeleteSchedule accepts Name + GroupName, not ARN.
    await deleteReminderSchedule(`deadline-${row.id}`);
    if (row.deliveryStatus === 'pending') {
      await input.tx.deadlineNotification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'cancelled', failureReason: input.reason },
      });
    } else {
      // Audit-preserving: keep deliveryStatus='failed' + failureReason,
      // nullify ARN only.
      await input.tx.deadlineNotification.update({
        where: { id: row.id },
        data: { eventbridgeScheduleArn: null },
      });
    }
  }
}

// ─── replaceReminders ─────────────────────────────────────────────────────────

export interface ReplaceRemindersInput {
  tx: PrismaTxLike;
  deadlineId: string;
  newDueDate: Date;
  /** Reference instant for filtering past schedules. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Replace all pending reminders for a deadline with a new set derived from
 * `newDueDate`. Used when PATCH changes the `dueDate` of an existing deadline.
 *
 * Equivalent to `cancelPendingReminders` (reason: 'deadline rescheduled')
 * followed by `createReminders` for the new date.
 *
 * Sent rows are preserved untouched.
 */
export async function replaceReminders(
  input: ReplaceRemindersInput,
): Promise<CreateRemindersResult> {
  await cancelPendingReminders({
    tx: input.tx,
    deadlineId: input.deadlineId,
    reason: 'deadline rescheduled',
  });
  return createReminders({
    tx: input.tx,
    deadlineId: input.deadlineId,
    dueDate: input.newDueDate,
    ...(input.now !== undefined && { now: input.now }),
  });
}

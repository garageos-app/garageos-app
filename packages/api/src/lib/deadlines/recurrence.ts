import type { PrismaClient } from '@garageos/database';

import { createReminders } from './scheduling.js';

// PrismaTxLike is a structural subset of PrismaClient (and its $transaction callback
// argument) — only the deadline and deadlineNotification delegates are required.
// Using Pick here works because PrismaClient is a class whose delegates are readonly
// properties; the structural match is sufficient for both the real client and fake tx in tests.
type PrismaTxLike = Pick<PrismaClient, 'deadline' | 'deadlineNotification'>;

export interface CompletedDeadlineSnapshot {
  id: string;
  tenantId: string;
  locationId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: Date;
  dueOdometerKm: number | null;
  description: string | null;
  isRecurring: boolean;
  recurringMonths: number | null;
  recurringKm: number | null;
  completedByInterventionId: string | null;
}

export interface CreateNextRecurringInput {
  tx: PrismaTxLike;
  completed: CompletedDeadlineSnapshot;
  /** Reference instant for filtering past reminder schedules. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Anniversary-semantic month addition.
 *
 * JS `setUTCMonth(month + N)` overflows month-end: Jan 31 + 1mo lands on
 * March 3 because February never has 31 days. When the UTC day shifts after
 * the addition, we've overflowed — snap back with `setUTCDate(0)` to reach
 * the last day of the intended target month.
 *
 * Examples:
 *  - 2026-12-31 + 12mo → 2027-12-31 (no overflow)
 *  - 2027-01-31 + 1mo  → 2027-02-28 (overflow snap)
 */
function addCalendarMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + months);
  if (next.getUTCDate() !== day) {
    // Overflow occurred — go back to last day of the intended target month.
    next.setUTCDate(0);
  }
  return next;
}

/**
 * Auto-create the next recurring deadline cycle when a recurring deadline is completed.
 *
 * Anniversary semantic: new dueDate = oldDueDate + recurringMonths (NOT completedAt +
 * recurringMonths) so the calendar cadence is preserved across late completions.
 *
 * recurringKm-only recurrence (recurringMonths = null) is intentionally skipped —
 * BR-103 specifies that reminders are date-driven only.
 *
 * If the newly computed dueDate is in the past (late completion + short cadence),
 * the Deadline row is still created — createReminders will silently skip schedules
 * for past reminder instants, consistent with PATCH past-date behavior.
 *
 * sourceInterventionId chains provenance: the intervention that closed cycle N
 * becomes the source of cycle N+1. See §2.7 of the H3 design spec.
 *
 * Returns null when recurrence should not be auto-created (isRecurring=false or
 * recurringMonths is null/0).
 */
export async function createNextRecurringDeadline(
  input: CreateNextRecurringInput,
): Promise<Record<string, unknown> | null> {
  const { tx, completed, now } = input;

  // See BR-103: date-driven only. Skip recurringKm-only deadlines.
  if (!completed.isRecurring) return null;
  if (completed.recurringMonths == null || completed.recurringMonths <= 0) return null;

  const newDueDate = addCalendarMonths(completed.dueDate, completed.recurringMonths);

  // Advance the odometer target only when both old target and increment are present.
  const newDueOdometerKm =
    completed.dueOdometerKm != null && completed.recurringKm != null
      ? completed.dueOdometerKm + completed.recurringKm
      : null;

  const created = await tx.deadline.create({
    data: {
      tenantId: completed.tenantId,
      locationId: completed.locationId,
      vehicleId: completed.vehicleId,
      interventionTypeId: completed.interventionTypeId,
      // Chain provenance: intervention that completed cycle N is the source of cycle N+1.
      sourceInterventionId: completed.completedByInterventionId,
      dueDate: newDueDate,
      dueOdometerKm: newDueOdometerKm,
      description: completed.description,
      isRecurring: true,
      recurringMonths: completed.recurringMonths,
      recurringKm: completed.recurringKm,
      status: 'open',
      // Reset completion fields — this is a fresh cycle.
      completedByInterventionId: null,
      completedAt: null,
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

  // Schedule up to 3 reminders (T-30d, T-7d, T-0d). Past instants are skipped
  // client-side by createReminders — no extra guard needed here.
  await createReminders({
    tx,
    deadlineId: created.id,
    dueDate: newDueDate,
    // Use exactOptionalPropertyTypes-friendly conditional spread (same pattern as
    // replaceReminders in scheduling.ts).
    ...(now !== undefined && { now }),
  });

  return created;
}

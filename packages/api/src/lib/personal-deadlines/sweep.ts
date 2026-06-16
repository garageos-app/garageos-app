import type { FastifyBaseLogger } from 'fastify';

import type { PrismaClient } from '@garageos/database';

import { romeTodayDateOnly } from '../deadlines/compute-reminders.js';
import { dispatchNotification } from '../notifications/dispatcher.js';
import type { CustomerForNotification, DispatchResult } from '../notifications/types.js';

// AppLike is a structural subset of FastifyInstance — only the two members
// the sweep consumes. Kept local (not importing FastifyInstance directly) so
// this lib has no server-bootstrapping dependency and is trivially fakeable
// in unit tests. Mirrors the AppLike rationale in
// lib/transfers/expire-transfers.ts and lib/deadlines/scheduler-invocation.ts.
//
// withContext ctx shape mirrors plugins/database.ts. { role: 'admin' } is the
// cross-tenant escape hatch required because the EventBridge cron invocation
// carries no JWT. See feedback_withcontext_empty_blocks_rls_writes.md: an
// empty ctx object {} would silently deny RLS-protected writes.
export interface AppLike {
  withContext: <T>(
    ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
  log: FastifyBaseLogger;
}

export interface PersonalDeadlineSweepResult {
  overdueFlipped: number;
  staleCancelled: number;
  channelsOffCancelled: number;
  sent: number;
  failed: number;
}

// A pending reminder is "stale" once its scheduled day is this many days in
// the past. Such rows are reaped (delivery_status -> cancelled) instead of
// firing a now-irrelevant reminder: the in-app overdue badge is the backstop
// once the parent deadline has flipped to overdue.
const STALE_DAYS = 3;

// One Rome calendar day in milliseconds. @db.Date columns are UTC-midnight
// anchored (see romeTodayDateOnly), so day arithmetic on them is exact.
const DAY_MS = 86_400_000;

type SweepOutcome =
  | { status: 'sent' }
  | { status: 'failed'; reason: string }
  | { status: 'cancelled'; reason: string };

// resolveSweepOutcome — pure interpreter of a DispatchResult into the row's
// terminal delivery state. dispatchNotification dispatches email and push
// independently (BR-250) and NEVER throws (contract in dispatcher.ts), so the
// outcome is derived purely from the returned struct:
//   - any channel delivered            -> sent
//   - nothing delivered but an error   -> failed (transient: SES/network)
//   - nothing delivered, no error      -> cancelled (pref-off/channel-off/
//                                          no-token: retrying is a no-op)
// Kept pure (no I/O) so it can be unit-tested with a full matrix.
export function resolveSweepOutcome(result: DispatchResult): SweepOutcome {
  const emailSent = result.sent === true;
  const pushSent = (result.push?.sent ?? 0) > 0;
  if (emailSent || pushSent) return { status: 'sent' };

  const error = result.error ?? result.push?.error;
  if (error) return { status: 'failed', reason: error };

  return { status: 'cancelled', reason: 'not_delivered' };
}

// processPersonalDeadlineSweep — the daily cron handler (F-CLI-306 PR2).
//
// Runs entirely inside ONE admin-context transaction (the EventBridge cron
// carries no JWT — see feedback_withcontext_empty_blocks_rls_writes.md). The
// order is deliberate:
//   1. BR-298 overdue flip FIRST: open deadlines past due become overdue, so
//      step 4's `personalDeadline.status === 'open'` filter excludes them.
//   2. Stale-cancel leftover pending reminders (independent of parent status).
//   3. Fetch + deliver the still-due reminders on still-open deadlines.
//
// Idempotency: every delivery gates on delivery_status === 'pending' (step 4
// where-clause). A daily re-run does NOT re-process sent/failed/cancelled
// rows. A transient failure therefore strands a single reminder on `failed`
// (accepted: the in-app overdue badge is the backstop; matches the stale-
// recovery design rather than indefinite retry).
//
// BR-292: per-deadline notify flags are AND-ed with the customer's global
// preference. The pre-gate short-circuits when BOTH flags are off; otherwise
// the flags are passed to dispatchNotification as the channel mask (the
// dispatcher AND-s each with the global pref).
// BR-295: reminder timing is already baked into scheduled_for at creation
// time — this sweep only fires rows whose scheduled day has arrived.
//
// Lets DB errors propagate (no try/catch around the tx) so the Lambda returns
// non-2xx and EventBridge retries the whole sweep.
export async function processPersonalDeadlineSweep(input: {
  app: AppLike;
}): Promise<PersonalDeadlineSweepResult> {
  const { app } = input;

  return app.withContext({ role: 'admin' }, async (tx) => {
    const todayRome = romeTodayDateOnly();
    const staleCutoff = new Date(todayRome.getTime() - STALE_DAYS * DAY_MS);

    // Step 1 — BR-298: flip open deadlines whose due date has passed to
    // overdue. Done FIRST so step 4 (status === 'open') excludes them.
    const overdue = await tx.personalDeadline.updateMany({
      where: { status: 'open', dueDate: { lt: todayRome } },
      data: { status: 'overdue' },
    });

    // Step 2 — reap stale pending reminders (scheduled more than STALE_DAYS
    // ago and never delivered). Independent of the parent deadline's status:
    // this also sweeps leftovers on deadlines that just flipped to overdue.
    const stale = await tx.personalDeadlineReminder.updateMany({
      where: {
        deliveryStatus: 'pending',
        scheduledFor: { lt: staleCutoff },
      },
      data: { deliveryStatus: 'cancelled', failureReason: 'stale' },
    });

    // Step 3 — fetch the due reminders to deliver: pending, scheduled day has
    // arrived (<= today), and the parent deadline is still open (the BR-298
    // flip above already excluded overdue parents). The recipient IS the
    // owning customer — no ownership resolution needed for personal deadlines.
    const due = await tx.personalDeadlineReminder.findMany({
      where: {
        deliveryStatus: 'pending',
        scheduledFor: { lte: todayRome },
        personalDeadline: { status: 'open' },
      },
      select: {
        id: true,
        kind: true,
        personalDeadline: {
          select: {
            id: true,
            dueDate: true,
            category: true,
            customLabel: true,
            notifyEmail: true,
            notifyPush: true,
            vehicle: { select: { plate: true, make: true, model: true } },
            customer: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                isBusiness: true,
                businessName: true,
                notificationPreferences: true,
                status: true,
              },
            },
          },
        },
      },
    });

    let channelsOffCancelled = 0;
    let sent = 0;
    let failed = 0;

    // Step 4 — deliver sequentially. NEVER Promise.all over a Prisma tx (the
    // pg adapter warns and statements can interleave on one connection).
    for (const reminder of due) {
      const deadline = reminder.personalDeadline;

      // BR-292 pre-gate: when BOTH channels are off there is nothing to AND
      // with the global pref — cancel without dispatching.
      if (!deadline.notifyEmail && !deadline.notifyPush) {
        await tx.personalDeadlineReminder.update({
          where: { id: reminder.id },
          data: { deliveryStatus: 'cancelled', failureReason: 'channels_off' },
        });
        channelsOffCancelled++;
        continue;
      }

      const dueDate = deadline.dueDate;
      const daysUntilDue = Math.round((dueDate.getTime() - todayRome.getTime()) / DAY_MS);
      const dueDateIso = dueDate.toISOString().slice(0, 10);
      const vehicleMakeModel = `${deadline.vehicle.make} ${deadline.vehicle.model}`;

      // The select above returns exactly the CustomerForNotification shape.
      const recipient = deadline.customer as CustomerForNotification;

      const result = await dispatchNotification({
        event: {
          type: 'personal_deadline.reminder',
          personalDeadlineId: deadline.id,
          category: deadline.category,
          customLabel: deadline.customLabel,
          dueDate: dueDateIso,
          vehiclePlate: deadline.vehicle.plate,
          vehicleMakeModel,
          kind: reminder.kind,
          daysUntilDue,
        },
        recipient,
        logger: app.log,
        tx,
        // BR-292: per-deadline mask, AND-ed with the global pref by the dispatcher.
        channels: { email: deadline.notifyEmail, push: deadline.notifyPush },
      });

      const outcome = resolveSweepOutcome(result);
      if (outcome.status === 'sent') {
        await tx.personalDeadlineReminder.update({
          where: { id: reminder.id },
          data: { deliveryStatus: 'sent', sentAt: new Date() },
        });
        sent++;
      } else if (outcome.status === 'failed') {
        await tx.personalDeadlineReminder.update({
          where: { id: reminder.id },
          data: { deliveryStatus: 'failed', failureReason: outcome.reason },
        });
        failed++;
      } else {
        // Nothing delivered, no error (pref-off / channel-off / no-token):
        // cancel — a retry would yield the same no-op. Counted under
        // channelsOffCancelled (the "suppressed, not failed" bucket).
        await tx.personalDeadlineReminder.update({
          where: { id: reminder.id },
          data: { deliveryStatus: 'cancelled', failureReason: outcome.reason },
        });
        channelsOffCancelled++;
      }
    }

    const result: PersonalDeadlineSweepResult = {
      overdueFlipped: overdue.count,
      staleCancelled: stale.count,
      channelsOffCancelled,
      sent,
      failed,
    };
    app.log.info({ personalDeadlineSweep: result });
    return result;
  });
}

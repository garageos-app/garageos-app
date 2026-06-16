import type { FastifyBaseLogger } from 'fastify';

import type { PersonalDeadlineCategory, PrismaClient } from '@garageos/database';

import { romeTodayDateOnly } from '../deadlines/compute-reminders.js';
import { dispatchNotification } from '../notifications/dispatcher.js';
import { isNotifiableRecipient } from '../notifications/recipient-resolver.js';
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

// A due reminder row in the shape the Step 3 findMany select returns. Named so
// the per-row processor (processDueReminder) has a precise input type.
type DueReminderRow = {
  id: string;
  kind: 'lead' | 'tail';
  personalDeadline: {
    id: string;
    dueDate: Date;
    category: PersonalDeadlineCategory;
    customLabel: string | null;
    notifyEmail: boolean;
    notifyPush: boolean;
    vehicle: { plate: string; make: string; model: string };
    customer: CustomerForNotification;
  };
};

// The terminal effect of processing a single due reminder, used to accumulate
// the sweep counters in the handler's outer scope.
type ProcessOutcome = 'sent' | 'failed' | 'channelsOffCancelled';

// processDueReminder — handle ONE due reminder inside its OWN short admin
// transaction. Returns the counter bucket the row landed in.
//
// Per-row tx — a reminder is re-dispatched on retry only if its OWN tx fails
// after dispatch (minimal unavoidable at-least-once window); rows already
// committed are not re-sent. This mirrors lib/deadlines/scheduler-invocation.ts,
// which already uses one tx per reminder (it just processes one per invocation).
// The previous single-tx structure held one transaction open across all N
// network sends (connection-hold / idle-in-transaction risk) and, worse, a DB
// error mid-loop rolled back the status writes of already-dispatched rows,
// re-sending those emails/pushes on the EventBridge retry.
async function processDueReminder(
  app: AppLike,
  reminder: DueReminderRow,
  todayRome: Date,
): Promise<ProcessOutcome> {
  const deadline = reminder.personalDeadline;

  // BR-292 pre-gate: when BOTH channels are off there is nothing to AND with
  // the global pref — cancel without dispatching. No network I/O, so this is a
  // pure DB write inside its own tx.
  if (!deadline.notifyEmail && !deadline.notifyPush) {
    await app.withContext({ role: 'admin' }, (tx) =>
      tx.personalDeadlineReminder.update({
        where: { id: reminder.id },
        data: { deliveryStatus: 'cancelled', failureReason: 'channels_off' },
      }),
    );
    return 'channelsOffCancelled';
  }

  const dueDate = deadline.dueDate;
  const daysUntilDue = Math.round((dueDate.getTime() - todayRome.getTime()) / DAY_MS);
  const dueDateIso = dueDate.toISOString().slice(0, 10);
  const vehicleMakeModel = `${deadline.vehicle.make} ${deadline.vehicle.model}`;
  const recipient = deadline.customer;

  // BR-158: never notify a deleted/anonymized customer (status='deleted' or a
  // deleted-<hash>@garageos.it placeholder email). Mirrors the guard the
  // notification recipient-resolver applies; the sweep loads the customer
  // directly, so it must apply the same check before dispatching. No network
  // I/O — cancel in its own admin tx, same pre-gate shape as channels_off.
  if (!isNotifiableRecipient(recipient)) {
    await app.withContext({ role: 'admin' }, (tx) =>
      tx.personalDeadlineReminder.update({
        where: { id: reminder.id },
        data: { deliveryStatus: 'cancelled', failureReason: 'recipient_deleted' },
      }),
    );
    return 'channelsOffCancelled';
  }

  // One short tx per row: dispatch (email + push network I/O) then the single
  // status write. A throw here loses ONLY this row's status write — rows
  // already committed in prior per-row txs are untouched.
  // CAS-on-pending re-read: re-checking deliveryStatus inside this tx closes
  // the cross-feature transfer race (a concurrent ownership-transfer cancel,
  // BR-297, may have flipped this row between the Step-3 fetch and now).
  return app.withContext({ role: 'admin' }, async (tx) => {
    const fresh = await tx.personalDeadlineReminder.findUnique({
      where: { id: reminder.id },
      select: { deliveryStatus: true },
    });
    // A concurrent writer (e.g. ownership-transfer cancel, BR-297) may have
    // cancelled this row after the Step-3 fetch — do not resurrect it to 'sent'.
    if (fresh?.deliveryStatus !== 'pending') return 'channelsOffCancelled';

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
      return 'sent';
    }
    if (outcome.status === 'failed') {
      await tx.personalDeadlineReminder.update({
        where: { id: reminder.id },
        data: { deliveryStatus: 'failed', failureReason: outcome.reason },
      });
      return 'failed';
    }
    // Nothing delivered, no error (pref-off / channel-off / no-token): cancel —
    // a retry would yield the same no-op. Counted under channelsOffCancelled
    // (the "suppressed, not failed" bucket).
    await tx.personalDeadlineReminder.update({
      where: { id: reminder.id },
      data: { deliveryStatus: 'cancelled', failureReason: outcome.reason },
    });
    return 'channelsOffCancelled';
  });
}

// processPersonalDeadlineSweep — the daily cron handler (F-CLI-306 PR2).
//
// Each unit of work runs in its OWN short admin-context transaction (the
// EventBridge cron carries no JWT — see
// feedback_withcontext_empty_blocks_rls_writes.md). Per-row tx — a reminder is
// re-dispatched on retry only if its OWN tx fails after dispatch (minimal
// unavoidable at-least-once window); rows already committed are not re-sent.
// This mirrors lib/deadlines/scheduler-invocation.ts (one tx per reminder).
// A single tx spanning all N network sends would hold a connection open across
// every send and, on a mid-loop DB error, roll back the status writes of
// already-dispatched rows (duplicate delivery on the EventBridge retry).
//
// The order is deliberate:
//   1. BR-298 overdue flip FIRST (own tx): open deadlines past due become
//      overdue, so step 3's `personalDeadline.status === 'open'` filter
//      excludes them.
//   2. Stale-cancel leftover pending reminders (own tx, independent of parent).
//   3. Fetch the still-due reminders (own read tx), then deliver each in its
//      own per-row tx via processDueReminder.
//
// Idempotency: every delivery gates on delivery_status === 'pending' (step 3
// where-clause). A daily re-run does NOT re-process sent/failed/cancelled
// rows. A transient failure therefore strands a single reminder on `failed`
// (accepted: the in-app overdue badge is the backstop; matches the stale-
// recovery design rather than indefinite retry). The fetched rows are read
// once; re-reading inside each per-row tx is not required — the pending gate
// already makes a same-day re-run idempotent, and there is a single daily
// schedule (no concurrent sweep).
//
// BR-292: per-deadline notify flags are AND-ed with the customer's global
// preference. The pre-gate short-circuits when BOTH flags are off; otherwise
// the flags are passed to dispatchNotification as the channel mask (the
// dispatcher AND-s each with the global pref).
// BR-295: reminder timing is already baked into scheduled_for at creation
// time — this sweep only fires rows whose scheduled day has arrived.
//
// Lets DB errors propagate (no try/catch) so the Lambda returns non-2xx and
// EventBridge retries the sweep.
export async function processPersonalDeadlineSweep(input: {
  app: AppLike;
}): Promise<PersonalDeadlineSweepResult> {
  const { app } = input;

  const todayRome = romeTodayDateOnly();
  const staleCutoff = new Date(todayRome.getTime() - STALE_DAYS * DAY_MS);

  // Step 1 — BR-298: flip open deadlines whose due date has passed to overdue.
  // Done FIRST so step 3 (status === 'open') excludes them. Own short tx.
  const overdue = await app.withContext({ role: 'admin' }, (tx) =>
    tx.personalDeadline.updateMany({
      where: { status: 'open', dueDate: { lt: todayRome } },
      data: { status: 'overdue' },
    }),
  );

  // Step 2 — reap stale pending reminders (scheduled more than STALE_DAYS ago
  // and never delivered). Independent of the parent deadline's status: this
  // also sweeps leftovers on deadlines that just flipped to overdue. Own tx.
  const stale = await app.withContext({ role: 'admin' }, (tx) =>
    tx.personalDeadlineReminder.updateMany({
      where: {
        deliveryStatus: 'pending',
        scheduledFor: { lt: staleCutoff },
      },
      data: { deliveryStatus: 'cancelled', failureReason: 'stale' },
    }),
  );

  // Step 3 — fetch the due reminders to deliver: pending, scheduled day has
  // arrived (<= today), and the parent deadline is still open (the BR-298 flip
  // above already excluded overdue parents). The recipient IS the owning
  // customer — no ownership resolution needed for personal deadlines. Own read
  // tx; the rows are then processed in their own per-row txs below.
  const due = (await app.withContext({ role: 'admin' }, (tx) =>
    tx.personalDeadlineReminder.findMany({
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
    }),
  )) as unknown as DueReminderRow[];

  let channelsOffCancelled = 0;
  let sent = 0;
  let failed = 0;

  // Step 4 — deliver SEQUENTIALLY, each row in its own per-row tx. NEVER
  // Promise.all (the pg adapter warns and statements can interleave on one
  // connection). DB errors propagate: a throw on row N loses only row N's
  // status write, not rows 1..N-1 (their per-row tx already committed).
  for (const reminder of due) {
    const bucket = await processDueReminder(app, reminder, todayRome);
    if (bucket === 'sent') sent++;
    else if (bucket === 'failed') failed++;
    else channelsOffCancelled++;
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
}

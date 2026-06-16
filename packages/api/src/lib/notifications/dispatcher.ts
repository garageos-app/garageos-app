import type { PrismaClient } from '@garageos/database';
import type { FastifyBaseLogger } from 'fastify';

import { sendEmail } from './email-channel.js';
import { preferenceKeyForEvent } from './event-preference-key.js';
import { isEmailEnabled } from './preferences.js';
import { dispatchPush, type AdminRunner } from './push-channel.js';
import {
  renderDeadlineReminderHtml,
  renderDeadlineReminderSubject,
  renderDeadlineReminderText,
} from './templates/deadline-reminder.js';
import {
  CANCELLATION_EMAIL_SUBJECT,
  renderCancellationEmailHtml,
  renderCancellationEmailText,
} from './templates/intervention-cancelled.js';
import {
  CREATED_EMAIL_SUBJECT,
  renderCreatedEmailHtml,
  renderCreatedEmailText,
} from './templates/intervention-created.js';
import {
  REVISION_EMAIL_SUBJECT,
  renderRevisionEmailHtml,
  renderRevisionEmailText,
} from './templates/intervention-revised.js';
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from './templates/ownership-transferred.js';
import {
  renderPersonalDeadlineReminderHtml,
  renderPersonalDeadlineReminderSubject,
  renderPersonalDeadlineReminderText,
} from './templates/personal-deadline-reminder.js';
import type {
  CustomerForNotification,
  DispatchResult,
  NotificationEvent,
  PushDispatchResult,
} from './types.js';

// Structural subset of FastifyInstance (and scheduler AppLike): just the
// withContext decorator the dispatcher needs to open an admin context for push
// when the caller is NOT already inside one.
interface DispatcherAppLike {
  withContext: <T>(
    ctx: { role?: 'admin' | 'user'; tenantId?: string; customerId?: string },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
}

interface DispatchInput {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
  // Push context. Routes pass `app` (post-commit, no open tx) → the push
  // channel opens its own admin context. The scheduler passes `tx` (its open
  // admin tx) to reuse it. When neither is provided, push is skipped entirely
  // (back-compat for email-only callers and unit tests).
  app?: DispatcherAppLike;
  tx?: PrismaClient;
  // Per-event channel mask AND-ed with the customer's global preference
  // (BR-292). Absent => both channels enabled (every existing caller). The
  // personal-deadline sweep passes the deadline's notifyEmail/notifyPush flags.
  channels?: { email: boolean; push: boolean };
}

type EmailOutcome = Pick<DispatchResult, 'sent' | 'skipped' | 'error'>;

// CONTRACT: dispatchNotification NEVER throws. All errors are captured into the
// returned DispatchResult and logged. Email and push are dispatched
// independently (BR-250): one being off/failing never suppresses the other.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const { event, recipient, logger, app, tx } = input;
  const prefKey = preferenceKeyForEvent(event);

  const email = await dispatchEmail({
    event,
    recipient,
    logger,
    prefKey,
    ...(input.channels !== undefined && { channels: input.channels }),
  });

  // Push runs only when a DB context is available.
  const run: AdminRunner | null = tx
    ? (fn) => fn(tx)
    : app
      ? (fn) => app.withContext({ role: 'admin' }, fn)
      : null;

  let push: PushDispatchResult | undefined;
  if (run) {
    try {
      push = await dispatchPush({
        event,
        recipient,
        run,
        logger,
        ...(input.channels !== undefined && { channels: input.channels }),
      });
    } catch (err) {
      // dispatchPush is best-effort and should not throw, but the contract is
      // enforced here too so a push failure never breaks the email result.
      const error = err instanceof Error ? err.message : String(err);
      logger.error({
        push: { event: event.type, recipientId: recipient.id, result: 'error', error },
      });
      push = { attempted: 0, sent: 0, deactivated: 0, appInstalledCleared: false, error };
    }
  }

  return push ? { ...email, push } : email;
}

async function dispatchEmail(args: {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
  prefKey: ReturnType<typeof preferenceKeyForEvent>;
  channels?: { email: boolean; push: boolean };
}): Promise<EmailOutcome> {
  const { event, recipient, logger, prefKey } = args;

  // BR-292: per-event channel mask AND-ed with the customer's global preference.
  // Absent channels => email enabled (every existing caller unaffected).
  if (args.channels && !args.channels.email) {
    logger.info({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'skipped',
        reason: 'channel-off',
      },
    });
    return { sent: false, skipped: 'channel-off' };
  }

  if (!isEmailEnabled(recipient, prefKey)) {
    logger.info({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'skipped',
        reason: 'pref-off',
      },
    });
    return { sent: false, skipped: 'pref-off' };
  }

  let subject: string;
  let html: string;
  let text: string;

  switch (event.type) {
    case 'intervention.created':
      subject = CREATED_EMAIL_SUBJECT;
      html = renderCreatedEmailHtml({
        recipient,
        intervention: event.intervention,
        interventionTypeName: event.interventionTypeName,
        vehicle: event.vehicle,
        tenant: event.tenant,
      });
      text = renderCreatedEmailText({
        recipient,
        intervention: event.intervention,
        interventionTypeName: event.interventionTypeName,
        vehicle: event.vehicle,
        tenant: event.tenant,
      });
      break;
    case 'intervention.revised':
      subject = REVISION_EMAIL_SUBJECT;
      html = renderRevisionEmailHtml({
        recipient,
        intervention: event.intervention,
        revision: event.revision,
        tenant: event.tenant,
      });
      text = renderRevisionEmailText({
        recipient,
        intervention: event.intervention,
        revision: event.revision,
        tenant: event.tenant,
      });
      break;
    case 'intervention.cancelled':
      subject = CANCELLATION_EMAIL_SUBJECT;
      html = renderCancellationEmailHtml({
        recipient,
        intervention: event.intervention,
        tenant: event.tenant,
      });
      text = renderCancellationEmailText({
        recipient,
        intervention: event.intervention,
        tenant: event.tenant,
      });
      break;
    case 'deadline.reminder':
      subject = renderDeadlineReminderSubject(event);
      html = renderDeadlineReminderHtml({ recipient, event });
      text = renderDeadlineReminderText({ recipient, event });
      break;
    case 'ownership.transferred':
      subject = OWNERSHIP_TRANSFERRED_SUBJECT;
      html = renderOwnershipTransferredHtml({
        recipient,
        vehicle: event.vehicle,
        tenant: event.tenant,
        transferReason: event.transferReason,
        transferredAt: event.transferredAt,
      });
      text = renderOwnershipTransferredText({
        recipient,
        vehicle: event.vehicle,
        tenant: event.tenant,
        transferReason: event.transferReason,
        transferredAt: event.transferredAt,
      });
      break;
    case 'personal_deadline.reminder':
      subject = renderPersonalDeadlineReminderSubject(event);
      html = renderPersonalDeadlineReminderHtml({ recipient, event });
      text = renderPersonalDeadlineReminderText({ recipient, event });
      break;
  }

  try {
    await sendEmail({ toAddress: recipient.email, subject, html, text });
    logger.info({
      notification: { event: event.type, recipientId: recipient.id, result: 'sent' },
    });
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'error',
        error: errorMessage,
      },
    });
    return { sent: false, error: errorMessage };
  }
}

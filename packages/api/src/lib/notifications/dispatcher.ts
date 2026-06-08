import type { FastifyBaseLogger } from 'fastify';

import { sendEmail } from './email-channel.js';
import { preferenceKeyForEvent } from './event-preference-key.js';
import { isEmailEnabled } from './preferences.js';
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
  REVISION_EMAIL_SUBJECT,
  renderRevisionEmailHtml,
  renderRevisionEmailText,
} from './templates/intervention-revised.js';
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from './templates/ownership-transferred.js';
import type { CustomerForNotification, DispatchResult, NotificationEvent } from './types.js';

interface DispatchInput {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
}

// Single entry point for all H1/H3 notifications. Channel-agnostic shape:
// H2 will extend this to fan out to push + email; the handler call site
// stays unchanged.
//
// CONTRACT: dispatchNotification NEVER throws. All errors are captured
// into the returned DispatchResult and logged. Callers (handlers) rely
// on this guarantee — no outer try/catch needed at the call site.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const { event, recipient, logger } = input;

  const prefKey = preferenceKeyForEvent(event);
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
  }

  try {
    await sendEmail({ toAddress: recipient.email, subject, html, text });
    logger.info({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'sent',
      },
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

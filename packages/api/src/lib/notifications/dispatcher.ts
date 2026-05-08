import type { FastifyBaseLogger } from 'fastify';

import { sendEmail } from './email-channel.js';
import { isEmailEnabled } from './preferences.js';
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
import type { CustomerForNotification, DispatchResult, NotificationEvent } from './types.js';

interface DispatchInput {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
}

// Single entry point for all H1 notifications. Channel-agnostic shape:
// H2 will extend this to fan out to push + email; the handler call site
// stays unchanged.
//
// CONTRACT: dispatchNotification NEVER throws. All errors are captured
// into the returned DispatchResult and logged. Callers (handlers) rely
// on this guarantee — no outer try/catch needed at the call site.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const { event, recipient, logger } = input;

  if (!isEmailEnabled(recipient, 'intervention_updates')) {
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

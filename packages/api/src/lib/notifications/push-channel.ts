import type { PrismaClient } from '@garageos/database';
import type { FastifyBaseLogger } from 'fastify';

import { preferenceKeyForEvent } from './event-preference-key.js';
import { isValidExpoPushToken, sendExpoPushChunks, type ExpoPushMessage } from './expo-client.js';
import { isPushEnabled } from './preferences.js';
import { renderPushPayload } from './push-templates.js';
import type { CustomerForNotification, NotificationEvent, PushDispatchResult } from './types.js';

// Loose tx — only the delegates the push channel reads/writes.
type PushTxLike = Pick<PrismaClient, 'pushToken' | 'customer'>;

// Runs a unit of push-token DB work under an admin RLS context. The scheduler
// passes its existing admin tx; routes pass an opener backed by
// app.withContext({role:'admin'}). Keeps the Expo HTTP call inside whatever
// context the caller already established (same boundary as the email send).
export type AdminRunner = <T>(fn: (tx: PushTxLike) => Promise<T>) => Promise<T>;

// Expo ticket-time errors that mean "this token is dead" (BR-254). Receipt-
// polling (the async second phase) is deferred to a dedicated PR.
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials']);

// Best-effort push delivery. NEVER throws — every failure is captured into the
// returned PushDispatchResult. Email and push are independent (BR-250).
export async function dispatchPush(input: {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  run: AdminRunner;
  logger: FastifyBaseLogger;
}): Promise<PushDispatchResult> {
  const { event, recipient, run, logger } = input;
  const key = preferenceKeyForEvent(event);

  if (!isPushEnabled(recipient, key)) {
    return {
      attempted: 0,
      sent: 0,
      skipped: 'pref-off',
      deactivated: 0,
      appInstalledCleared: false,
    };
  }

  return run(async (tx) => {
    const tokens = await tx.pushToken.findMany({
      where: { customerId: recipient.id, active: true },
      select: { id: true, expoPushToken: true },
    });
    const valid = tokens.filter((t) => isValidExpoPushToken(t.expoPushToken));
    if (valid.length === 0) {
      return {
        attempted: 0,
        sent: 0,
        skipped: 'no-token' as const,
        deactivated: 0,
        appInstalledCleared: false,
      };
    }

    const payload = renderPushPayload(event);
    const messages: ExpoPushMessage[] = valid.map((t) => ({
      to: t.expoPushToken,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: 'default',
    }));

    let tickets;
    try {
      tickets = await sendExpoPushChunks(messages);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({
        push: { event: event.type, recipientId: recipient.id, result: 'error', error },
      });
      return {
        attempted: valid.length,
        sent: 0,
        deactivated: 0,
        appInstalledCleared: false,
        error,
      };
    }

    // tickets[i] aligns with valid[i] (sendExpoPushChunks preserves order).
    let sent = 0;
    const deadTokenIds: string[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'ok') {
        sent += 1;
      } else if (ticket.details?.error && DEAD_TOKEN_ERRORS.has(ticket.details.error)) {
        deadTokenIds.push(valid[i]!.id);
      }
    });

    let appInstalledCleared = false;
    if (deadTokenIds.length > 0) {
      await tx.pushToken.updateMany({
        where: { id: { in: deadTokenIds } },
        data: { active: false },
      });
      const remaining = await tx.pushToken.count({
        where: { customerId: recipient.id, active: true },
      });
      if (remaining === 0) {
        await tx.customer.update({
          where: { id: recipient.id },
          data: { appInstalled: false },
        });
        appInstalledCleared = true;
      }
    }

    logger.info({
      push: {
        event: event.type,
        recipientId: recipient.id,
        result: 'sent',
        attempted: valid.length,
        sent,
        deactivated: deadTokenIds.length,
        appInstalledCleared,
      },
    });
    return { attempted: valid.length, sent, deactivated: deadTokenIds.length, appInstalledCleared };
  });
}

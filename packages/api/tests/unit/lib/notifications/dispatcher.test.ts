import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { dispatchNotification } from '../../../../src/lib/notifications/dispatcher.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../src/lib/notifications/types.js';
import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const sesMock = mockClient(SESv2Client);

const baseRecipient: CustomerForNotification = {
  id: 'cust-1',
  email: 'mario@test.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  notificationPreferences: { email: { intervention_updates: true } },
  status: 'active',
};

const revisedEvent: NotificationEvent = {
  type: 'intervention.revised',
  intervention: {
    id: 'int-1',
    vehicleId: 'veh-1',
    title: 'Tagliando',
    description: 'olio',
    cancelledReason: null,
  },
  revision: {
    id: 'rev-1',
    revisedAt: new Date('2026-05-08T10:00:00Z'),
    reason: 'Correzione km',
    changes: {},
  },
  tenant: { id: 'ten-1', businessName: 'Officina Mario S.r.l.' },
};

const cancelledEvent: NotificationEvent = {
  type: 'intervention.cancelled',
  intervention: {
    id: 'int-1',
    vehicleId: 'veh-1',
    title: 'Tagliando',
    description: 'olio',
    cancelledReason: 'errore VIN',
  },
  tenant: { id: 'ten-1', businessName: 'Officina Mario S.r.l.' },
};

const fakeLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => fakeLogger,
  level: 'info',
  silent: vi.fn(),
} as unknown as Parameters<typeof dispatchNotification>[0]['logger'];

describe('dispatchNotification', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    vi.clearAllMocks();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('routes intervention.revised to revision template + sends email', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm1' });
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(result.sent).toBe(true);
    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const subject = (
      calls[0]!.args[0]!.input as { Content?: { Simple?: { Subject?: { Data?: string } } } }
    ).Content?.Simple?.Subject?.Data;
    expect(subject).toMatch(/modificat/i);
  });

  it('routes intervention.cancelled to cancellation template', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm2' });
    const result = await dispatchNotification({
      event: cancelledEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(result.sent).toBe(true);
    const calls = sesMock.commandCalls(SendEmailCommand);
    const subject = (
      calls[0]!.args[0]!.input as { Content?: { Simple?: { Subject?: { Data?: string } } } }
    ).Content?.Simple?.Subject?.Data;
    expect(subject).toMatch(/annullat/i);
  });

  it('returns skipped:pref-off when intervention_updates is false', async () => {
    const recipient = {
      ...baseRecipient,
      notificationPreferences: { email: { intervention_updates: false } },
    };
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient,
      logger: fakeLogger,
    });
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('pref-off');
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('NEVER throws — SES error captured into result.error', async () => {
    sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/Throttling/);
  });

  it('NEVER throws — env var missing captured into result.error', async () => {
    delete process.env.SES_FROM_ADDRESS;
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/SES env vars missing/);
  });

  it('logs success with notification.result=sent', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm3' });
    await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({ result: 'sent', event: 'intervention.revised' }),
      }),
    );
  });
});

describe('dispatchNotification — ownership.transferred', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    vi.clearAllMocks();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const recipient: CustomerForNotification = {
    id: 'c-cedente',
    email: 'cedente@test.it',
    firstName: 'Luca',
    lastName: 'Verdi',
    isBusiness: false,
    businessName: null,
    notificationPreferences: {},
    status: 'active',
  };
  const event: NotificationEvent = {
    type: 'ownership.transferred',
    vehicle: { id: 'veh-1', plate: 'AB123CD' },
    tenant: { id: 't-1', businessName: 'Officina Bianchi' },
    transferReason: 'purchase',
    transferredAt: '2026-05-22T10:30:00.000Z',
  };

  it('sends the email when the ownership_transfer preference is on (default)', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm-transfer-1' });
    const result = await dispatchNotification({ event, recipient, logger: fakeLogger });
    expect(result.sent).toBe(true);
    const calls = sesMock.commandCalls(SendEmailCommand);
    const subject = (
      calls[0]!.args[0]!.input as { Content?: { Simple?: { Subject?: { Data?: string } } } }
    ).Content?.Simple?.Subject?.Data;
    expect(subject).toBe('La proprietà del tuo veicolo è stata trasferita');
  });

  it('skips when the customer disabled ownership_transfer emails', async () => {
    const optedOut: CustomerForNotification = {
      ...recipient,
      notificationPreferences: { email: { ownership_transfer: false } },
    };
    const result = await dispatchNotification({ event, recipient: optedOut, logger: fakeLogger });
    expect(result).toEqual({ sent: false, skipped: 'pref-off' });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

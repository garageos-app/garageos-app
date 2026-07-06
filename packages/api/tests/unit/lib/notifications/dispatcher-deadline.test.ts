// Tests for the deadline.reminder arm of dispatchNotification and the
// per-event preference key logic introduced in H3. Also includes a
// regression guard for H1 intervention events to ensure the
// preferenceKeyForEvent refactor did not break existing behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../src/lib/notifications/types.js';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const sesMock = mockClient(SESv2Client);

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
} as unknown as Parameters<
  (typeof import('../../../../src/lib/notifications/dispatcher.js'))['dispatchNotification']
>[0]['logger'];

const makeRecipient = (prefs: Record<string, boolean> = {}): CustomerForNotification => ({
  id: 'cust-1',
  email: 'mario@test.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  status: 'active',
  notificationPreferences: { email: prefs },
});

const deadlineEvent: NotificationEvent = {
  type: 'deadline.reminder',
  deadlineId: '11111111-1111-1111-1111-111111111111',
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  vehicleId: '22222222-2222-2222-2222-222222222222',
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: 'Revisione obbligatoria 4 anni',
  dueOdometerKm: null,
};

const cancelledEvent: NotificationEvent = {
  type: 'intervention.cancelled',
  intervention: {
    id: 'int-1',
    vehicleId: 'veh-1',
    description: 'olio',
    cancelledReason: 'errore VIN',
  },
  tenant: { id: 'ten-1', businessName: 'Officina Mario S.r.l.' },
};

describe('dispatchNotification — deadline.reminder arm', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    vi.clearAllMocks();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    process.env.WEB_APP_BASE_URL = 'https://app.garageos.aifollyadvisor.com';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('sends email when deadline_reminder preference is enabled', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-1' });
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({ deadline_reminder: true }),
      logger: fakeLogger,
    });
    expect(result).toEqual({ sent: true });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it('uses t_minus_30 subject in the sent email', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-2' });
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({ deadline_reminder: true }),
      logger: fakeLogger,
    });
    const calls = sesMock.commandCalls(SendEmailCommand);
    const subject = (
      calls[0]!.args[0]!.input as { Content?: { Simple?: { Subject?: { Data?: string } } } }
    ).Content?.Simple?.Subject?.Data;
    expect(subject).toBe('Promemoria: scadenza Revisione fra 30 giorni — AB123CD');
  });

  it('skips with pref-off when deadline_reminder=false', async () => {
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({ deadline_reminder: false }),
      logger: fakeLogger,
    });
    expect(result).toEqual({ sent: false, skipped: 'pref-off' });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('sends email when deadline_reminder preference is absent (fallback to DEFAULT=true per BR-226)', async () => {
    // When the stored prefs object lacks the key, isEmailEnabled falls back to
    // DEFAULT_NOTIFICATION_PREFERENCES which defaults deadline_reminder=true.
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-fallback' });
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({}),
      logger: fakeLogger,
    });
    expect(result).toEqual({ sent: true });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it('logs pref-off skip with event type', async () => {
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({ deadline_reminder: false }),
      logger: fakeLogger,
    });
    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          event: 'deadline.reminder',
          result: 'skipped',
          reason: 'pref-off',
        }),
      }),
    );
  });

  it('NEVER throws on SES error — captured into result.error', async () => {
    sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: deadlineEvent,
      recipient: makeRecipient({ deadline_reminder: true }),
      logger: fakeLogger,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/Throttling/);
  });
});

describe('dispatchNotification — per-event preference key regression (H1)', () => {
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

  it('still checks intervention_updates for intervention.cancelled (regression)', async () => {
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: cancelledEvent,
      recipient: makeRecipient({ intervention_updates: false }),
      logger: fakeLogger,
    });
    expect(result).toEqual({ sent: false, skipped: 'pref-off' });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('deadline_reminder=true does NOT unlock intervention events (isolation)', async () => {
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    // recipient has deadline_reminder=true but intervention_updates=false
    const result = await dispatchNotification({
      event: cancelledEvent,
      recipient: makeRecipient({ deadline_reminder: true, intervention_updates: false }),
      logger: fakeLogger,
    });
    expect(result).toEqual({ sent: false, skipped: 'pref-off' });
  });
});

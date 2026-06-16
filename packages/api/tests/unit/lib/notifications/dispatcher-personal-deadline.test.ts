// Tests for the personal_deadline.reminder arm of dispatchNotification and the
// BR-292 channel-mask gating (channels.email / channels.push).
//
// NOTE: The email-sent path for personal_deadline.reminder events depends on
// preferenceKeyForEvent mapping that event to 'personal_deadline_reminder'.
// That mapping is added in Task 4 (event-preference-key.ts). Tests that verify
// "email sent" for personal_deadline.reminder events are deferred to Task 4's
// test file. This file covers:
//  - The channel-off early-return for both channels (BR-292), which is checked
//    BEFORE the pref lookup and is self-contained in Task 3 code.
//  - The push template / email template subject wiring for personal_deadline.reminder
//    (verified indirectly via channel-off skipping the pref check on email).
//  - Regression: intervention.created with absent channels still dispatches both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import type { PrismaClient } from '@garageos/database';
import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../src/lib/notifications/types.js';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const sesMock = mockClient(SESv2Client);

// Mock the push channel so we don't need a real DB in unit tests.
const dispatchPushMock = vi.fn();
vi.mock('../../../../src/lib/notifications/push-channel.js', () => ({
  dispatchPush: (args: unknown) => dispatchPushMock(args),
}));

// Fake app: withContext just runs the callback with a dummy tx — push is mocked.
function fakeApp() {
  return {
    withContext: <T>(_ctx: unknown, fn: (tx: PrismaClient) => Promise<T>) => fn({} as PrismaClient),
  };
}

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

// Minimal recipient with prefs on by default.
const makeRecipient = (emailPrefs: Record<string, boolean> = {}): CustomerForNotification => ({
  id: 'cust-pd-1',
  email: 'lucia@test.it',
  firstName: 'Lucia',
  lastName: 'Bianchi',
  isBusiness: false,
  businessName: null,
  status: 'active',
  notificationPreferences: { email: emailPrefs },
});

const personalDeadlineEvent: NotificationEvent = {
  type: 'personal_deadline.reminder',
  personalDeadlineId: 'pd-00000000-0000-0000-0000-000000000001',
  category: 'insurance',
  customLabel: null,
  dueDate: '2026-08-01',
  vehiclePlate: 'GG123ZZ',
  vehicleMakeModel: 'Fiat Panda',
  kind: 'lead',
  daysUntilDue: 15,
};

// intervention.created event for regression test — no channels field.
const createdEvent: NotificationEvent = {
  type: 'intervention.created',
  intervention: {
    id: 'int-reg',
    vehicleId: 'veh-reg',
    title: 'Tagliando',
    description: null,
    cancelledReason: null,
  },
  interventionTypeName: 'Tagliando',
  vehicle: { id: 'veh-reg', plate: 'AA000BB', make: 'Fiat', model: 'Punto' },
  tenant: { id: 'ten-reg', businessName: 'Officina Regressione' },
};

describe('dispatchNotification — BR-292 channel-mask gating', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    vi.clearAllMocks();
    dispatchPushMock.mockReset();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    process.env.WEB_APP_BASE_URL = 'https://app.garageos.aifollyadvisor.com';
    delete process.env.EMAIL_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // Test 2: channels.email=false → email skipped 'channel-off', push mock receives the mask.
  // The channel-off guard fires BEFORE the pref lookup, so this works even before Task 4.
  it('skips email with channel-off when channels.email=false (BR-292)', async () => {
    dispatchPushMock.mockResolvedValue({
      attempted: 1,
      sent: 1,
      deactivated: 0,
      appInstalledCleared: false,
    });

    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: personalDeadlineEvent,
      recipient: makeRecipient({ personal_deadline_reminder: true }),
      logger: fakeLogger,
      app: fakeApp(),
      channels: { email: false, push: true },
    });

    // channel-off is returned before the pref check — must be 'channel-off' not 'pref-off'.
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('channel-off');
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    // Push mock was called and received the full channel mask.
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    const pushArg = dispatchPushMock.mock.calls[0]![0] as { channels?: unknown };
    expect(pushArg).toMatchObject({ channels: { email: false, push: true } });
    // Push was not masked off → result.push reflects the mock's response.
    expect(result.push?.sent).toBe(1);
  });

  // Test 3: channels.push=false → email path runs normally, push mock receives mask.
  // The push channel (mocked here) is responsible for applying its own channel-off guard.
  // We verify the mask is correctly forwarded to dispatchPush.
  it('forwards channels.push=false to dispatchPush so it can apply channel-off (BR-292)', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-pd-3' });
    // Simulate push-channel.ts returning channel-off (what it will return post Task 3).
    dispatchPushMock.mockResolvedValue({
      attempted: 0,
      sent: 0,
      skipped: 'channel-off',
      deactivated: 0,
      appInstalledCleared: false,
    });

    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    // Use intervention.created (pref key is wired) to isolate the channel-mask forwarding.
    const result = await dispatchNotification({
      event: createdEvent,
      recipient: makeRecipient({ intervention_updates: true }),
      logger: fakeLogger,
      app: fakeApp(),
      channels: { email: true, push: false },
    });

    expect(result.sent).toBe(true);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    // Push mock received the channels mask with push=false.
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    const pushArg = dispatchPushMock.mock.calls[0]![0] as { channels?: unknown };
    expect(pushArg).toMatchObject({ channels: { email: true, push: false } });
    // The mocked push-channel returned channel-off, which flows through.
    expect(result.push?.skipped).toBe('channel-off');
  });

  // Test 4: global pref false + channels.email=true → pref-off wins (uses intervention.created
  // because its pref key is wired in event-preference-key.ts — the pref-wins behaviour
  // is the same for all events and does not depend on which event type is used).
  it('skips email with pref-off when global pref false, even if channels.email=true (BR-292)', async () => {
    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: createdEvent,
      recipient: makeRecipient({ intervention_updates: false }),
      logger: fakeLogger,
      channels: { email: true, push: true },
    });

    // channel-off guard does NOT fire (channels.email=true).
    // pref-off guard DOES fire (intervention_updates=false).
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('pref-off');
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  // Test 5: regression — intervention.created with no channels dispatches both channels.
  it('regression: intervention.created with no channels dispatches email and push (back-compat)', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-reg' });
    dispatchPushMock.mockResolvedValue({
      attempted: 1,
      sent: 1,
      deactivated: 0,
      appInstalledCleared: false,
    });

    const { dispatchNotification } =
      await import('../../../../src/lib/notifications/dispatcher.js');
    const result = await dispatchNotification({
      event: createdEvent,
      recipient: makeRecipient({ intervention_updates: true }),
      logger: fakeLogger,
      app: fakeApp(),
      // No channels field — both enabled by default (existing callers unaffected).
    });

    expect(result.sent).toBe(true);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    const pushArg = dispatchPushMock.mock.calls[0]![0] as { channels?: unknown };
    // channels should be absent (not passed) for existing callers — back-compat.
    expect(pushArg).not.toHaveProperty('channels');
    expect(result.push?.sent).toBe(1);
  });
});

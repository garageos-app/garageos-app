import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createPushToken,
  getCustomerAppInstalled,
  getPushTokens,
  resetDb,
  setCustomerAppInstalled,
} from './helpers.js';

// Mock the Expo seam so no real HTTP leaves the test. The push channel imports
// from expo-client.js; here we control the tickets it sees.
const sendMock = vi.fn();
vi.mock('../../src/lib/notifications/expo-client.js', () => ({
  sendExpoPushChunks: (msgs: unknown[]) => sendMock(msgs),
  isValidExpoPushToken: (t: string) => t.startsWith('ExpoPushToken['),
}));

import { dispatchNotification } from '../../src/lib/notifications/dispatcher.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../src/lib/notifications/types.js';

const event: NotificationEvent = {
  type: 'deadline.reminder',
  deadlineId: randomUUID(),
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  dueOdometerKm: null,
  vehicleId: randomUUID(),
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: null,
};

describe('Push delivery (F-CLI-302 PR2, BR-254)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    sendMock.mockReset();
    // Email path needs SES env to exist; guard so it fails fast and harmlessly
    // (push is the SUT, and dispatchNotification never throws).
    process.env.SES_FROM_ADDRESS ??= 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET ??= 'test-config-set';
  });

  function recipient(customerId: string): CustomerForNotification {
    return {
      id: customerId,
      email: 'a@b.it',
      firstName: 'A',
      lastName: 'B',
      isBusiness: false,
      businessName: null,
      status: 'active',
      notificationPreferences: {},
    };
  }

  it('reads active tokens under admin context and reports them sent', async () => {
    const { customerId } = await createCustomer({});
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[live-1]', deviceName: 'A' });
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[live-2]', deviceName: 'B' });
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
    ]);

    const result = await dispatchNotification({
      event,
      recipient: recipient(customerId),
      logger: app.log,
      app,
    });

    expect(result.push).toMatchObject({ attempted: 2, sent: 2, deactivated: 0 });
    const rows = await getPushTokens(customerId);
    expect(rows.every((r) => r.active)).toBe(true);
  });

  it('BR-254: persists active=false for a DeviceNotRegistered token, keeps the other', async () => {
    const { customerId } = await createCustomer({});
    await setCustomerAppInstalled(customerId, true);
    const live = await createPushToken({
      customerId,
      expoPushToken: 'ExpoPushToken[ok]',
      deviceName: 'A',
    });
    const dead = await createPushToken({
      customerId,
      expoPushToken: 'ExpoPushToken[dead]',
      deviceName: 'B',
    });
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);

    const result = await dispatchNotification({
      event,
      recipient: recipient(customerId),
      logger: app.log,
      app,
    });

    expect(result.push).toMatchObject({ attempted: 2, sent: 1, deactivated: 1 });
    const rows = await getPushTokens(customerId);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.active]));
    expect(byId[live.id]).toBe(true);
    expect(byId[dead.id]).toBe(false);
    expect(await getCustomerAppInstalled(customerId)).toBe(true); // one token still alive
  });

  it('BR-254: clears app_installed when the last active token dies', async () => {
    const { customerId } = await createCustomer({});
    await setCustomerAppInstalled(customerId, true);
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[only]', deviceName: 'A' });
    sendMock.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);

    await dispatchNotification({ event, recipient: recipient(customerId), logger: app.log, app });

    const rows = await getPushTokens(customerId);
    expect(rows.every((r) => !r.active)).toBe(true);
    expect(await getCustomerAppInstalled(customerId)).toBe(false);
  });
});

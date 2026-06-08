import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import { dispatchPush, type AdminRunner } from '../../../../src/lib/notifications/push-channel.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../src/lib/notifications/types.js';

const sendMock = vi.fn();
vi.mock('../../../../src/lib/notifications/expo-client.js', () => ({
  sendExpoPushChunks: (msgs: unknown) => sendMock(msgs),
  isValidExpoPushToken: (t: string) => t.startsWith('ExpoPushToken['),
}));

const fakeLogger = {
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof dispatchPush>[0]['logger'];

const event: NotificationEvent = {
  type: 'deadline.reminder',
  deadlineId: 'd',
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  dueOdometerKm: null,
  vehicleId: 'v',
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: null,
};

function recipient(prefs: object = {}): CustomerForNotification {
  return {
    id: 'cust-1',
    email: 'a@b.it',
    firstName: 'A',
    lastName: 'B',
    isBusiness: false,
    businessName: null,
    status: 'active',
    notificationPreferences: prefs as CustomerForNotification['notificationPreferences'],
  };
}

// Fake tx exposing only pushToken + customer delegates the channel touches.
function makeTx(tokens: Array<{ id: string; expoPushToken: string }>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const count = vi.fn();
  const customerUpdate = vi.fn().mockResolvedValue({});
  const tx = {
    pushToken: {
      findMany: vi.fn().mockResolvedValue(tokens),
      updateMany,
      count,
    },
    customer: { update: customerUpdate },
  };
  const run: AdminRunner = (fn) => fn(tx as unknown as PrismaClient);
  return { tx, run, updateMany, count, customerUpdate };
}

beforeEach(() => {
  sendMock.mockReset();
  vi.clearAllMocks();
});

describe('dispatchPush', () => {
  it('skips with pref-off when the push preference is disabled', async () => {
    const { run } = makeTx([{ id: 'p1', expoPushToken: 'ExpoPushToken[a]' }]);
    const res = await dispatchPush({
      event,
      recipient: recipient({ push: { deadline_reminder: false } }),
      run,
      logger: fakeLogger,
    });
    expect(res).toEqual({
      attempted: 0,
      sent: 0,
      skipped: 'pref-off',
      deactivated: 0,
      appInstalledCleared: false,
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips with no-token when the customer has no active tokens', async () => {
    const { run } = makeTx([]);
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res.skipped).toBe('no-token');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends to all valid tokens and counts oks', async () => {
    const { run } = makeTx([
      { id: 'p1', expoPushToken: 'ExpoPushToken[a]' },
      { id: 'p2', expoPushToken: 'ExpoPushToken[b]' },
    ]);
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
    ]);
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res).toMatchObject({
      attempted: 2,
      sent: 2,
      deactivated: 0,
      appInstalledCleared: false,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('BR-254: deactivates a DeviceNotRegistered token, keeps the other', async () => {
    const { run, updateMany, count, customerUpdate } = makeTx([
      { id: 'p1', expoPushToken: 'ExpoPushToken[a]' },
      { id: 'p2', expoPushToken: 'ExpoPushToken[b]' },
    ]);
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    count.mockResolvedValue(1); // one token still active afterwards
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p2'] } },
      data: { active: false },
    });
    expect(customerUpdate).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      attempted: 2,
      sent: 1,
      deactivated: 1,
      appInstalledCleared: false,
    });
  });

  it('BR-254: clears app_installed when the last active token dies', async () => {
    const { run, count, customerUpdate } = makeTx([
      { id: 'p1', expoPushToken: 'ExpoPushToken[a]' },
    ]);
    sendMock.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    count.mockResolvedValue(0); // no active tokens left
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(customerUpdate).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      data: { appInstalled: false },
    });
    expect(res).toMatchObject({ deactivated: 1, appInstalledCleared: true });
  });

  it('captures a send failure into result.error without throwing', async () => {
    const { run, updateMany } = makeTx([{ id: 'p1', expoPushToken: 'ExpoPushToken[a]' }]);
    sendMock.mockRejectedValue(new Error('Expo down'));
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res).toMatchObject({ attempted: 1, sent: 0, deactivated: 0, error: 'Expo down' });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import * as dispatcherMod from '../../../../src/lib/notifications/dispatcher.js';
import type { AppLike } from '../../../../src/lib/personal-deadlines/sweep.js';
import {
  processPersonalDeadlineSweep,
  resolveSweepOutcome,
} from '../../../../src/lib/personal-deadlines/sweep.js';
import type { PushDispatchResult } from '../../../../src/lib/notifications/types.js';

vi.mock('../../../../src/lib/notifications/dispatcher.js', () => ({
  dispatchNotification: vi.fn(),
}));

// FakePrisma exposes only the delegates the sweep consumes. Double-cast via
// unknown satisfies the compiler while keeping test code readable (same
// pattern as scheduler-invocation.test.ts).
interface FakePrisma {
  personalDeadline: {
    updateMany: ReturnType<typeof vi.fn>;
  };
  personalDeadlineReminder: {
    updateMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function asPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

function makeFakeApp(fake: FakePrisma): AppLike {
  return {
    withContext: vi
      .fn()
      .mockImplementation(
        async (
          _ctx: { role?: 'admin' | 'user'; tenantId?: string },
          fn: (tx: PrismaClient) => Promise<unknown>,
        ) => fn(asPrisma(fake)),
      ),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as AppLike['log'],
  };
}

function makePrisma(overrides?: {
  pdUpdateMany?: ReturnType<typeof vi.fn>;
  pdrUpdateMany?: ReturnType<typeof vi.fn>;
  pdrFindMany?: ReturnType<typeof vi.fn>;
  pdrUpdate?: ReturnType<typeof vi.fn>;
}): FakePrisma {
  return {
    personalDeadline: {
      updateMany: overrides?.pdUpdateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
    },
    personalDeadlineReminder: {
      updateMany: overrides?.pdrUpdateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
      findMany: overrides?.pdrFindMany ?? vi.fn().mockResolvedValue([]),
      update: overrides?.pdrUpdate ?? vi.fn().mockResolvedValue({}),
    },
  };
}

// A due reminder row in the shape the sweep's findMany select returns.
function dueReminder(opts: {
  id?: string;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  dueDate?: Date;
}) {
  return {
    id: opts.id ?? 'r1',
    kind: 'lead' as const,
    personalDeadline: {
      id: 'pd1',
      dueDate: opts.dueDate ?? new Date('2026-06-16T00:00:00.000Z'),
      category: 'insurance' as const,
      customLabel: null,
      notifyEmail: opts.notifyEmail ?? true,
      notifyPush: opts.notifyPush ?? true,
      vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      customer: {
        id: 'cust1',
        email: 'owner@example.it',
        firstName: 'Owner',
        lastName: 'Test',
        isBusiness: false,
        businessName: null,
        notificationPreferences: {},
        status: 'active',
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(dispatcherMod.dispatchNotification).mockReset();
});

describe('processPersonalDeadlineSweep', () => {
  it('BR-298: flips open deadlines past due to overdue and counts them', async () => {
    const pdUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const fake = makePrisma({ pdUpdateMany });
    const app = makeFakeApp(fake);

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.overdueFlipped).toBe(2);
    const call = pdUpdateMany.mock.calls[0]![0];
    expect(call.where.status).toBe('open');
    expect(call.where.dueDate.lt).toBeInstanceOf(Date);
    expect(call.data).toEqual({ status: 'overdue' });
  });

  it('stale-cancels pending reminders older than the stale cutoff', async () => {
    const pdrUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const fake = makePrisma({ pdrUpdateMany });
    const app = makeFakeApp(fake);

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.staleCancelled).toBe(1);
    const call = pdrUpdateMany.mock.calls[0]![0];
    expect(call.where.deliveryStatus).toBe('pending');
    // Cutoff is STALE_DAYS (3) before today's Rome midnight; a reminder
    // scheduled 5 days ago is < cutoff, one scheduled today is not.
    const cutoff = call.where.scheduledFor.lt as Date;
    const today = new Date();
    const fiveDaysAgo = new Date(today.getTime() - 5 * 86_400_000);
    expect(fiveDaysAgo.getTime()).toBeLessThan(cutoff.getTime());
    expect(today.getTime()).toBeGreaterThan(cutoff.getTime());
    expect(call.data).toEqual({ deliveryStatus: 'cancelled', failureReason: 'stale' });
  });

  it('delivery happy path: both channels on -> dispatch with mask, row sent', async () => {
    const pdrUpdate = vi.fn().mockResolvedValue({});
    const fake = makePrisma({
      pdrFindMany: vi.fn().mockResolvedValue([dueReminder({ id: 'r1' })]),
      pdrUpdate,
    });
    const app = makeFakeApp(fake);
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({ sent: true });

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.sent).toBe(1);
    const dispatchArg = vi.mocked(dispatcherMod.dispatchNotification).mock.calls[0]![0];
    expect(dispatchArg.event).toMatchObject({
      type: 'personal_deadline.reminder',
      personalDeadlineId: 'pd1',
      vehiclePlate: 'AB123CD',
      vehicleMakeModel: 'Fiat Panda',
      kind: 'lead',
    });
    expect(dispatchArg.channels).toEqual({ email: true, push: true });
    expect(pdrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ deliveryStatus: 'sent' }),
      }),
    );
  });

  it('channels_off pre-gate: both flags off -> cancelled, dispatch NOT called', async () => {
    const pdrUpdate = vi.fn().mockResolvedValue({});
    const fake = makePrisma({
      pdrFindMany: vi
        .fn()
        .mockResolvedValue([dueReminder({ id: 'r1', notifyEmail: false, notifyPush: false })]),
      pdrUpdate,
    });
    const app = makeFakeApp(fake);

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.channelsOffCancelled).toBe(1);
    expect(dispatcherMod.dispatchNotification).not.toHaveBeenCalled();
    expect(pdrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: { deliveryStatus: 'cancelled', failureReason: 'channels_off' },
      }),
    );
  });

  it('single channel: notifyPush false -> mask.push false; email sent -> row sent', async () => {
    const pdrUpdate = vi.fn().mockResolvedValue({});
    const fake = makePrisma({
      pdrFindMany: vi.fn().mockResolvedValue([dueReminder({ id: 'r1', notifyPush: false })]),
      pdrUpdate,
    });
    const app = makeFakeApp(fake);
    // push skipped (channel-off), email sent.
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({
      sent: true,
      push: {
        attempted: 0,
        sent: 0,
        skipped: 'channel-off',
        deactivated: 0,
        appInstalledCleared: false,
      },
    });

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.sent).toBe(1);
    const dispatchArg = vi.mocked(dispatcherMod.dispatchNotification).mock.calls[0]![0];
    expect(dispatchArg.channels).toEqual({ email: true, push: false });
  });

  it('failure: dispatch returns error -> row failed with reason, failed counter', async () => {
    const pdrUpdate = vi.fn().mockResolvedValue({});
    const fake = makePrisma({
      pdrFindMany: vi.fn().mockResolvedValue([dueReminder({ id: 'r1' })]),
      pdrUpdate,
    });
    const app = makeFakeApp(fake);
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({
      sent: false,
      error: 'SES boom',
    });

    const result = await processPersonalDeadlineSweep({ app });

    expect(result.failed).toBe(1);
    expect(pdrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: { deliveryStatus: 'failed', failureReason: 'SES boom' },
      }),
    );
  });

  it('idempotency gate: findMany filters pending + parent open + due', async () => {
    const pdrFindMany = vi.fn().mockResolvedValue([]);
    const fake = makePrisma({ pdrFindMany });
    const app = makeFakeApp(fake);

    await processPersonalDeadlineSweep({ app });

    const where = pdrFindMany.mock.calls[0]![0].where;
    expect(where.deliveryStatus).toBe('pending');
    expect(where.personalDeadline).toEqual({ status: 'open' });
    expect(where.scheduledFor.lte).toBeInstanceOf(Date);
  });

  it('uses withContext({role: admin}) for cross-tenant access', async () => {
    const fake = makePrisma();
    const app = makeFakeApp(fake);
    await processPersonalDeadlineSweep({ app });
    const withContextMock = app.withContext as unknown as ReturnType<typeof vi.fn>;
    expect(withContextMock).toHaveBeenCalledWith({ role: 'admin' }, expect.any(Function));
  });
});

describe('resolveSweepOutcome', () => {
  const push = (sent: number, error?: string): PushDispatchResult => ({
    attempted: sent,
    sent,
    deactivated: 0,
    appInstalledCleared: false,
    ...(error !== undefined && { error }),
  });

  it('email sent -> sent', () => {
    expect(resolveSweepOutcome({ sent: true })).toEqual({ status: 'sent' });
  });

  it('push sent (email off) -> sent', () => {
    expect(resolveSweepOutcome({ sent: false, push: push(1) })).toEqual({ status: 'sent' });
  });

  it('both sent -> sent', () => {
    expect(resolveSweepOutcome({ sent: true, push: push(2) })).toEqual({ status: 'sent' });
  });

  it('nothing sent + email error -> failed with that error', () => {
    expect(resolveSweepOutcome({ sent: false, error: 'SES throttle' })).toEqual({
      status: 'failed',
      reason: 'SES throttle',
    });
  });

  it('nothing sent + push error (no email error) -> failed with push error', () => {
    expect(resolveSweepOutcome({ sent: false, push: push(0, 'expo down') })).toEqual({
      status: 'failed',
      reason: 'expo down',
    });
  });

  it('nothing sent, no error (pref-off / no-token) -> cancelled not_delivered', () => {
    expect(resolveSweepOutcome({ sent: false, skipped: 'pref-off' })).toEqual({
      status: 'cancelled',
      reason: 'not_delivered',
    });
  });

  it('nothing sent, both channels skipped, no error -> cancelled', () => {
    expect(
      resolveSweepOutcome({
        sent: false,
        skipped: 'channel-off',
        push: {
          attempted: 0,
          sent: 0,
          skipped: 'no-token',
          deactivated: 0,
          appInstalledCleared: false,
        },
      }),
    ).toEqual({ status: 'cancelled', reason: 'not_delivered' });
  });
});

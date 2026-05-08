import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import * as schedulerClient from '../../../../src/lib/scheduler-client.js';
import {
  createReminders,
  cancelPendingReminders,
  replaceReminders,
} from '../../../../src/lib/deadlines/scheduling.js';

vi.mock('../../../../src/lib/scheduler-client.js', () => ({
  createReminderSchedule: vi.fn(),
  deleteReminderSchedule: vi.fn(),
}));

const FUTURE_DATE = new Date('2027-12-31T00:00:00Z');

interface FakeTx {
  deadlineNotification: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

// Cast helper: FakeTx is structurally compatible with the Pick<PrismaClient, ...>
// the orchestration functions accept, but the Prisma delegate types are too wide
// to express inline. Double-cast via unknown satisfies the compiler while keeping
// the test code readable.
function asTx(fake: FakeTx): PrismaClient {
  return fake as unknown as PrismaClient;
}

let counter = 0;
function makeTx(overrides: Partial<FakeTx['deadlineNotification']> = {}): FakeTx {
  return {
    deadlineNotification: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        counter += 1;
        return { ...data, id: `gen-${counter}`, createdAt: new Date() };
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      ...overrides,
    },
  };
}

beforeEach(() => {
  counter = 0;
  vi.mocked(schedulerClient.createReminderSchedule).mockReset();
  vi.mocked(schedulerClient.deleteReminderSchedule).mockReset();
});

describe('createReminders', () => {
  it('inserts 3 pending rows + creates 3 schedules for a future dueDate', async () => {
    const tx = makeTx();
    vi.mocked(schedulerClient.createReminderSchedule).mockResolvedValue(
      'arn:aws:scheduler:eu:1:schedule/test/n',
    );
    const result = await createReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      dueDate: FUTURE_DATE,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    expect(tx.deadlineNotification.create).toHaveBeenCalledTimes(3);
    expect(schedulerClient.createReminderSchedule).toHaveBeenCalledTimes(3);
    expect(result.created).toHaveLength(3);
    expect(result.partial).toBe(false);
  });

  it('skips T-30 / T-7 / T-0 that are in the past', async () => {
    const tx = makeTx();
    vi.mocked(schedulerClient.createReminderSchedule).mockResolvedValue('arn');
    // dueIn10Days = 2026-05-18. now = 2026-05-08T12:00:00Z.
    // T-30 = 2026-04-18 08:00 Rome → past (skipped).
    // T-7  = 2026-05-11 08:00 Rome (CEST = UTC+2) → 2026-05-11T06:00Z → 42h in the future (scheduled).
    // T-0  = 2026-05-18 08:00 Rome (CEST) → 2026-05-18T06:00Z → future (scheduled).
    // Expected: 2 rows inserted (T-7 + T-0), not 1.
    const dueIn10Days = new Date('2026-05-18T00:00:00Z');
    await createReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      dueDate: dueIn10Days,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    expect(tx.deadlineNotification.create).toHaveBeenCalledTimes(2);
    expect(schedulerClient.createReminderSchedule).toHaveBeenCalledTimes(2);
  });

  it('marks the row as failed if scheduler.CreateSchedule throws (compensating action)', async () => {
    const tx = makeTx();
    vi.mocked(schedulerClient.createReminderSchedule)
      .mockResolvedValueOnce('arn-1')
      .mockRejectedValueOnce(new Error('aws unavailable'))
      .mockResolvedValueOnce('arn-3');
    const result = await createReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      dueDate: FUTURE_DATE,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    expect(result.partial).toBe(true);
    expect(tx.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: 'failed',
          failureReason: 'aws unavailable',
        }),
      }),
    );
  });

  it('stamps eventbridgeScheduleArn on created notification rows after CreateSchedule succeeds', async () => {
    const tx = makeTx();
    vi.mocked(schedulerClient.createReminderSchedule).mockResolvedValue(
      'arn:aws:scheduler:eu:1:schedule/test/the-arn',
    );
    await createReminders({ tx: asTx(tx), deadlineId: 'd1', dueDate: FUTURE_DATE });
    expect(tx.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventbridgeScheduleArn: 'arn:aws:scheduler:eu:1:schedule/test/the-arn',
        }),
      }),
    );
  });

  it('only marks the failing row as failed, not all rows', async () => {
    const tx = makeTx();
    vi.mocked(schedulerClient.createReminderSchedule)
      .mockResolvedValueOnce('arn-1')
      .mockRejectedValueOnce(new Error('aws unavailable'))
      .mockResolvedValueOnce('arn-3');
    const result = await createReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      dueDate: FUTURE_DATE,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // 2 successful rows get arn update, 1 failed row gets status=failed update
    expect(tx.deadlineNotification.update).toHaveBeenCalledTimes(3);
    const failedCalls = (
      tx.deadlineNotification.update as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[0]?.data?.deliveryStatus === 'failed');
    expect(failedCalls).toHaveLength(1);
    expect(result.created).toHaveLength(3);
  });
});

describe('cancelPendingReminders', () => {
  it('flips pending rows to cancelled + DeleteSchedule per row', async () => {
    const tx = makeTx({
      findMany: vi.fn().mockResolvedValue([
        { id: 'n1', deliveryStatus: 'pending', eventbridgeScheduleArn: 'arn:.../n1' },
        { id: 'n2', deliveryStatus: 'pending', eventbridgeScheduleArn: 'arn:.../n2' },
      ]),
    });
    vi.mocked(schedulerClient.deleteReminderSchedule).mockResolvedValue(undefined);
    const reason = 'deadline rescheduled';
    await cancelPendingReminders({ tx: asTx(tx), deadlineId: 'd1', reason });
    expect(schedulerClient.deleteReminderSchedule).toHaveBeenCalledTimes(2);
    expect(schedulerClient.deleteReminderSchedule).toHaveBeenCalledWith('deadline-n1');
    expect(schedulerClient.deleteReminderSchedule).toHaveBeenCalledWith('deadline-n2');
    expect(tx.deadlineNotification.update).toHaveBeenCalledTimes(2);
    expect(tx.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n1' },
        data: { deliveryStatus: 'cancelled', failureReason: reason },
      }),
    );
  });

  it('does not touch sent rows (findMany pre-filter on deliveryStatus=pending)', async () => {
    const tx = makeTx({
      findMany: vi.fn().mockResolvedValue([]), // simulate no pending rows
    });
    await cancelPendingReminders({ tx: asTx(tx), deadlineId: 'd1', reason: 'x' });
    expect(schedulerClient.deleteReminderSchedule).not.toHaveBeenCalled();
    expect(tx.deadlineNotification.update).not.toHaveBeenCalled();
  });

  it('passes deliveryStatus=pending filter to findMany', async () => {
    const tx = makeTx({
      findMany: vi.fn().mockResolvedValue([]),
    });
    await cancelPendingReminders({ tx: asTx(tx), deadlineId: 'd1', reason: 'test' });
    expect(tx.deadlineNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deliveryStatus: 'pending' }),
      }),
    );
  });

  it('uses deterministic schedule name (deadline-{id}), not the stored ARN', async () => {
    const tx = makeTx({
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'abc-123',
          deliveryStatus: 'pending',
          eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/garageos/xyx',
        },
      ]),
    });
    vi.mocked(schedulerClient.deleteReminderSchedule).mockResolvedValue(undefined);
    await cancelPendingReminders({ tx: asTx(tx), deadlineId: 'd1', reason: 'test' });
    expect(schedulerClient.deleteReminderSchedule).toHaveBeenCalledWith('deadline-abc-123');
  });
});

describe('replaceReminders', () => {
  it('cancels pending then creates new for new dueDate', async () => {
    const tx = makeTx({
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'old1', deliveryStatus: 'pending', eventbridgeScheduleArn: 'arn:.../old1' },
        ]),
    });
    vi.mocked(schedulerClient.deleteReminderSchedule).mockResolvedValue(undefined);
    vi.mocked(schedulerClient.createReminderSchedule).mockResolvedValue('arn-new');
    await replaceReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      newDueDate: FUTURE_DATE,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    expect(schedulerClient.deleteReminderSchedule).toHaveBeenCalledTimes(1);
    expect(schedulerClient.createReminderSchedule).toHaveBeenCalledTimes(3);
  });

  it('returns CreateRemindersResult from the create phase', async () => {
    const tx = makeTx({
      findMany: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(schedulerClient.createReminderSchedule).mockResolvedValue('arn-new');
    const result = await replaceReminders({
      tx: asTx(tx),
      deadlineId: 'd1',
      newDueDate: FUTURE_DATE,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    expect(result.created).toHaveLength(3);
    expect(result.partial).toBe(false);
  });
});

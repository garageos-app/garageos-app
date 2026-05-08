import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import * as dispatcherMod from '../../../../src/lib/notifications/dispatcher.js';
import * as recipientResolverMod from '../../../../src/lib/notifications/recipient-resolver.js';
import type {
  AppLike,
  SchedulerInvocationDetail,
} from '../../../../src/lib/deadlines/scheduler-invocation.js';
import { processSchedulerInvocation } from '../../../../src/lib/deadlines/scheduler-invocation.js';
import type { CustomerForNotification } from '../../../../src/lib/notifications/types.js';

vi.mock('../../../../src/lib/notifications/dispatcher.js', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('../../../../src/lib/notifications/recipient-resolver.js', () => ({
  resolveCurrentOwner: vi.fn(),
}));

// FakePrisma exposes only the delegate consumed by processSchedulerInvocation.
// Double-cast via unknown satisfies the compiler while keeping test code readable
// (same pattern as scheduling.test.ts / asTx).
interface FakePrisma {
  deadlineNotification: {
    findUnique: ReturnType<typeof vi.fn>;
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

beforeEach(() => {
  vi.mocked(dispatcherMod.dispatchNotification).mockReset();
  vi.mocked(recipientResolverMod.resolveCurrentOwner).mockReset();
});

const baseRow = {
  id: 'dn1',
  deadlineId: 'd1',
  deliveryStatus: 'pending',
  reminderType: 't_minus_30',
  scheduledFor: new Date('2026-12-01T07:00:00Z'),
  deadline: {
    id: 'd1',
    status: 'open',
    tenantId: 't',
    vehicleId: 'v',
    dueDate: new Date('2026-12-31'),
    dueOdometerKm: null,
    description: 'rev',
    interventionType: { nameIt: 'Revisione' },
    vehicle: { id: 'v', plate: 'AB123CD' },
  },
};

const baseRecipient = (
  prefs: Record<string, boolean> = { deadline_reminder: true },
): CustomerForNotification => ({
  id: 'cust',
  email: 'a@b.com',
  firstName: 'A',
  lastName: 'B',
  isBusiness: false,
  businessName: null,
  status: 'active',
  notificationPreferences: { email: prefs },
});

const baseDetail: SchedulerInvocationDetail = {
  deadlineNotificationId: 'dn1',
  reminderType: 't_minus_30',
};

function makePrisma(overrides: Partial<FakePrisma['deadlineNotification']> = {}): FakePrisma {
  return {
    deadlineNotification: {
      findUnique: vi.fn(),
      update: vi.fn(),
      ...overrides,
    },
  };
}

describe('processSchedulerInvocation', () => {
  it('returns skipped_already_processed when row deliveryStatus != pending', async () => {
    const fake = makePrisma({
      findUnique: vi.fn().mockResolvedValue({ ...baseRow, deliveryStatus: 'sent' }),
    });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'skipped_already_processed' });
  });

  it('returns skipped_already_processed when row missing entirely (deleted between schedule and invocation)', async () => {
    const fake = makePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
    });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({
      app,
      detail: { deadlineNotificationId: 'missing', reminderType: 't_minus_30' },
    });
    expect(result).toEqual({ status: 'skipped_already_processed' });
    expect(fake.deadlineNotification.update).not.toHaveBeenCalled();
  });

  it('returns skipped_deadline_cancelled when parent deadline status != open', async () => {
    const fake = makePrisma({
      findUnique: vi
        .fn()
        .mockResolvedValue({ ...baseRow, deadline: { ...baseRow.deadline, status: 'cancelled' } }),
    });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'skipped_deadline_cancelled' });
    expect(fake.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: 'cancelled' }),
      }),
    );
  });

  it('returns skipped_no_owner when resolveCurrentOwner returns null', async () => {
    const fake = makePrisma({ findUnique: vi.fn().mockResolvedValue(baseRow) });
    vi.mocked(recipientResolverMod.resolveCurrentOwner).mockResolvedValue(null);
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'skipped_no_owner' });
    expect(fake.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: 'failed',
          failureReason: 'no_current_owner',
        }),
      }),
    );
  });

  it('returns skipped_preferences when dispatcher returns pref-off', async () => {
    const fake = makePrisma({ findUnique: vi.fn().mockResolvedValue(baseRow) });
    vi.mocked(recipientResolverMod.resolveCurrentOwner).mockResolvedValue(
      baseRecipient({ deadline_reminder: false }),
    );
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({
      sent: false,
      skipped: 'pref-off',
    });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'skipped_preferences' });
    expect(fake.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: 'cancelled',
          failureReason: 'preference_disabled',
        }),
      }),
    );
  });

  it('returns sent on dispatcher success + flips row to sent', async () => {
    const fake = makePrisma({ findUnique: vi.fn().mockResolvedValue(baseRow) });
    vi.mocked(recipientResolverMod.resolveCurrentOwner).mockResolvedValue(baseRecipient());
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({ sent: true });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'sent' });
    expect(fake.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: 'sent' }),
      }),
    );
  });

  it('returns failed on dispatcher error + flips row to failed (Scheduler retries)', async () => {
    const fake = makePrisma({ findUnique: vi.fn().mockResolvedValue(baseRow) });
    vi.mocked(recipientResolverMod.resolveCurrentOwner).mockResolvedValue(baseRecipient());
    vi.mocked(dispatcherMod.dispatchNotification).mockResolvedValue({
      sent: false,
      error: 'SES throttle',
    });
    const app = makeFakeApp(fake);
    const result = await processSchedulerInvocation({ app, detail: baseDetail });
    expect(result).toEqual({ status: 'failed', error: 'SES throttle' });
    expect(fake.deadlineNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: 'failed', failureReason: 'SES throttle' }),
      }),
    );
  });

  it('uses app.withContext({role: admin}) for cross-tenant access', async () => {
    const fake = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const app = makeFakeApp(fake);
    await processSchedulerInvocation({
      app,
      detail: { deadlineNotificationId: 'x', reminderType: 't_minus_30' },
    });
    // Verify the first arg to withContext is the admin-role context.
    // Cast to Mock so .mock is accessible without TypeScript complaint.
    const withContextMock = app.withContext as unknown as ReturnType<typeof vi.fn>;
    expect(withContextMock).toHaveBeenCalledWith({ role: 'admin' }, expect.any(Function));
  });
});

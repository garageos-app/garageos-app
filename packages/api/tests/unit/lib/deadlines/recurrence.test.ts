import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import * as scheduling from '../../../../src/lib/deadlines/scheduling.js';
import { createNextRecurringDeadline } from '../../../../src/lib/deadlines/recurrence.js';

vi.mock('../../../../src/lib/deadlines/scheduling.js', () => ({
  createReminders: vi.fn().mockResolvedValue({ created: [], partial: false }),
  cancelPendingReminders: vi.fn(),
  replaceReminders: vi.fn(),
}));

interface FakeTx {
  deadline: {
    create: ReturnType<typeof vi.fn>;
  };
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

function makeTx(): FakeTx {
  return {
    deadline: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-deadline-1',
        ...data,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
    deadlineNotification: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.mocked(scheduling.createReminders).mockReset();
  vi.mocked(scheduling.createReminders).mockResolvedValue({ created: [], partial: false });
});

describe('createNextRecurringDeadline', () => {
  it('returns null when isRecurring=false', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2026-12-31T00:00:00Z'),
      dueOdometerKm: null,
      description: null,
      isRecurring: false,
      recurringMonths: null,
      recurringKm: null,
      completedByInterventionId: 'i1',
    };
    const result = await createNextRecurringDeadline({ tx: asTx(tx), completed });
    expect(result).toBeNull();
    expect(tx.deadline.create).not.toHaveBeenCalled();
  });

  it('returns null when isRecurring=true but recurringMonths is null', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2026-12-31T00:00:00Z'),
      dueOdometerKm: null,
      description: null,
      isRecurring: true,
      recurringMonths: null,
      recurringKm: 10000,
      completedByInterventionId: 'i1',
    };
    const result = await createNextRecurringDeadline({ tx: asTx(tx), completed });
    expect(result).toBeNull();
  });

  it('creates next deadline at oldDueDate + recurringMonths (anniversary)', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2026-12-31T00:00:00Z'),
      dueOdometerKm: 100000,
      description: 'Revisione',
      isRecurring: true,
      recurringMonths: 12,
      recurringKm: 20000,
      completedByInterventionId: 'i-completing',
    };
    await createNextRecurringDeadline({ tx: asTx(tx), completed });
    const call = tx.deadline.create.mock.calls[0]![0];
    expect(call.data.dueDate.toISOString()).toBe('2027-12-31T00:00:00.000Z');
    expect(call.data.dueOdometerKm).toBe(120000);
    expect(call.data.description).toBe('Revisione');
    expect(call.data.isRecurring).toBe(true);
    expect(call.data.recurringMonths).toBe(12);
    expect(call.data.recurringKm).toBe(20000);
    expect(call.data.sourceInterventionId).toBe('i-completing');
    expect(call.data.completedByInterventionId).toBeNull();
    expect(call.data.completedAt).toBeNull();
    expect(call.data.status).toBe('open');
  });

  it('still creates the deadline row when new dueDate is in the past', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2024-01-01T00:00:00Z'),
      dueOdometerKm: null,
      description: null,
      isRecurring: true,
      recurringMonths: 12,
      recurringKm: null,
      completedByInterventionId: 'i1',
    };
    await createNextRecurringDeadline({ tx: asTx(tx), completed });
    expect(tx.deadline.create).toHaveBeenCalledTimes(1);
    expect(scheduling.createReminders).toHaveBeenCalledTimes(1);
  });

  it('passes dueOdometerKm null when old.dueOdometerKm is null', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2026-12-31T00:00:00Z'),
      dueOdometerKm: null,
      description: null,
      isRecurring: true,
      recurringMonths: 12,
      recurringKm: 20000,
      completedByInterventionId: null,
    };
    await createNextRecurringDeadline({ tx: asTx(tx), completed });
    expect(tx.deadline.create.mock.calls[0]![0].data.dueOdometerKm).toBeNull();
  });

  it('handles month-end overflow (Jan 31 + 1mo = Feb 28/29)', async () => {
    const tx = makeTx();
    const completed = {
      id: 'old',
      tenantId: 't',
      locationId: 'l',
      vehicleId: 'v',
      interventionTypeId: 'it',
      dueDate: new Date('2027-01-31T00:00:00Z'),
      dueOdometerKm: null,
      description: null,
      isRecurring: true,
      recurringMonths: 1,
      recurringKm: null,
      completedByInterventionId: null,
    };
    await createNextRecurringDeadline({ tx: asTx(tx), completed });
    // Feb 2027 has 28 days (2027 is not a leap year). Anniversary overflow snaps to last day of intended month.
    expect(tx.deadline.create.mock.calls[0]![0].data.dueDate.toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@garageos/database';

import { cancelPersonalDeadlinesForVehicleTransfer } from '../../../../src/lib/personal-deadlines/cancel-on-transfer.js';

// FakePrisma exposes only the two delegates the helper consumes. Double-cast
// via unknown keeps the test readable (same pattern as sweep.test.ts).
interface FakePrisma {
  personalDeadline: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  personalDeadlineReminder: {
    updateMany: ReturnType<typeof vi.fn>;
  };
}

function asTx(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const VEHICLE_ID = 'veh-1';
const PREV_OWNER = 'seller-1';

describe('cancelPersonalDeadlinesForVehicleTransfer (BR-297)', () => {
  it('cancels active deadlines and only their pending reminders, leaving completed/sent untouched', async () => {
    // The previous owner has 1 open + 1 overdue + 1 completed deadline on the
    // vehicle. findMany (status in open|overdue) returns only the two active
    // ones. Each active deadline has both a pending and a sent reminder; the
    // reminder updateMany filters deliveryStatus:'pending', so only the 2
    // pending reminders are cancelled.
    const findMany = vi.fn().mockResolvedValue([{ id: 'pd-open' }, { id: 'pd-overdue' }]);
    const pdrUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const pdUpdateMany = vi.fn().mockResolvedValue({ count: 2 });

    const fake: FakePrisma = {
      personalDeadline: { findMany, updateMany: pdUpdateMany },
      personalDeadlineReminder: { updateMany: pdrUpdateMany },
    };

    const result = await cancelPersonalDeadlinesForVehicleTransfer(asTx(fake), {
      vehicleId: VEHICLE_ID,
      previousOwnerCustomerId: PREV_OWNER,
    });

    expect(result).toEqual({ cancelledDeadlines: 2, cancelledReminders: 2 });

    // findMany scopes vehicle + customer + active statuses.
    expect(findMany.mock.calls[0]![0]).toEqual({
      where: {
        vehicleId: VEHICLE_ID,
        customerId: PREV_OWNER,
        status: { in: ['open', 'overdue'] },
      },
      select: { id: true },
    });

    // Reminder updateMany targets only pending reminders of the active deadlines.
    expect(pdrUpdateMany.mock.calls[0]![0]).toEqual({
      where: { personalDeadlineId: { in: ['pd-open', 'pd-overdue'] }, deliveryStatus: 'pending' },
      data: { deliveryStatus: 'cancelled', failureReason: 'ownership_transferred' },
    });

    // Deadline updateMany cancels exactly the selected ids.
    expect(pdUpdateMany.mock.calls[0]![0]).toEqual({
      where: { id: { in: ['pd-open', 'pd-overdue'] } },
      data: { status: 'cancelled' },
    });
  });

  it('scopes to the previous owner: a different customer is not selected', async () => {
    // The fake findMany honors the where.customerId filter, so a deadline of a
    // different customer is never returned to the helper.
    const rows = [
      { id: 'pd-seller', customerId: 'seller-1' },
      { id: 'pd-other', customerId: 'other-cust' },
    ];
    const findMany = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { customerId: string } }) =>
        rows.filter((r) => r.customerId === where.customerId).map((r) => ({ id: r.id })),
      );
    const pdrUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const pdUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    const fake: FakePrisma = {
      personalDeadline: { findMany, updateMany: pdUpdateMany },
      personalDeadlineReminder: { updateMany: pdrUpdateMany },
    };

    const result = await cancelPersonalDeadlinesForVehicleTransfer(asTx(fake), {
      vehicleId: VEHICLE_ID,
      previousOwnerCustomerId: PREV_OWNER,
    });

    expect(result.cancelledDeadlines).toBe(1);
    expect(pdUpdateMany.mock.calls[0]![0].where).toEqual({ id: { in: ['pd-seller'] } });
    expect(pdrUpdateMany.mock.calls[0]![0].where.personalDeadlineId).toEqual({ in: ['pd-seller'] });
  });

  it('empty case: no active deadlines -> returns zeros and skips both updateMany calls', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const pdrUpdateMany = vi.fn();
    const pdUpdateMany = vi.fn();

    const fake: FakePrisma = {
      personalDeadline: { findMany, updateMany: pdUpdateMany },
      personalDeadlineReminder: { updateMany: pdrUpdateMany },
    };

    const result = await cancelPersonalDeadlinesForVehicleTransfer(asTx(fake), {
      vehicleId: VEHICLE_ID,
      previousOwnerCustomerId: PREV_OWNER,
    });

    expect(result).toEqual({ cancelledDeadlines: 0, cancelledReminders: 0 });
    expect(pdrUpdateMany).not.toHaveBeenCalled();
    expect(pdUpdateMany).not.toHaveBeenCalled();
  });
});

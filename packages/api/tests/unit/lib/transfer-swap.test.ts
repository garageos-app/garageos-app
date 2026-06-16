import { Prisma } from '@garageos/database';
import { describe, expect, it, vi } from 'vitest';

import { confirmTransferSwap } from '../../../src/lib/transfer-swap.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const INPUT = {
  transferId: 'tr-1',
  vehicleId: 'veh-1',
  fromCustomerId: 'seller-1',
  toCustomerId: 'buyer-1',
  now: NOW,
};

// Minimal fake transaction client: only the methods confirmTransferSwap touches.
function fakeTx(
  overrides: {
    transferUpdateCount?: number;
    ownershipUpdateCount?: number;
    ownershipCreate?: ReturnType<typeof vi.fn>;
    // Row returned by the re-read on a failed CAS. Default: a still-pending,
    // not-yet-expired row → the failure is a concurrent-confirm race (422).
    transferFindFirst?: { status: string; expiresAt: Date } | null;
  } = {},
) {
  return {
    vehicleTransfer: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.transferUpdateCount ?? 1 }),
      findFirst: vi
        .fn()
        .mockResolvedValue(
          overrides.transferFindFirst === undefined
            ? { status: 'pending_seller_confirmation', expiresAt: new Date(NOW.getTime() + 60_000) }
            : overrides.transferFindFirst,
        ),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.ownershipUpdateCount ?? 1 }),
      create: overrides.ownershipCreate ?? vi.fn().mockResolvedValue({ id: 'own-new' }),
    },
    // BR-297: confirmTransferSwap now cancels the seller's active personal
    // deadlines inside the same tx. Default to "no active deadlines".
    personalDeadline: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    personalDeadlineReminder: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('confirmTransferSwap', () => {
  it('CAS-flips the transfer, closes the old ownership, opens the new one', async () => {
    const tx = fakeTx();
    await confirmTransferSwap(tx as never, INPUT);

    expect(tx.vehicleTransfer.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'tr-1', status: 'pending_seller_confirmation', expiresAt: { gt: NOW } },
      data: { status: 'completed', completedAt: NOW },
    });
    expect(tx.vehicleOwnership.updateMany.mock.calls[0]![0]).toEqual({
      where: { vehicleId: 'veh-1', customerId: 'seller-1', endedAt: null },
      data: { endedAt: NOW, transferReason: 'purchase', transferNotes: null },
    });
    expect(tx.vehicleOwnership.create.mock.calls[0]![0]).toEqual({
      data: { vehicleId: 'veh-1', customerId: 'buyer-1', startedAt: NOW },
    });
  });

  it('throws not_pending_seller (422) when the CAS loses the race', async () => {
    const tx = fakeTx({ transferUpdateCount: 0 });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.not_pending_seller',
      statusCode: 422,
    });
    expect(tx.vehicleOwnership.updateMany).not.toHaveBeenCalled();
  });

  it('throws ownership_conflict (409) when no active ownership is closed', async () => {
    const tx = fakeTx({ ownershipUpdateCount: 0 });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.ownership_conflict',
      statusCode: 409,
    });
    expect(tx.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('maps a uq_ownership_vehicle_active P2002 to ownership_conflict (409)', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('race', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['uq_ownership_vehicle_active'] },
      }),
    );
    const tx = fakeTx({ ownershipCreate: create });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.ownership_conflict',
      statusCode: 409,
    });
  });

  it('rethrows a non-P2002 database error unchanged', async () => {
    const dbError = new Prisma.PrismaClientKnownRequestError('boom', {
      code: 'P2003',
      clientVersion: 'x',
      meta: { field_name: 'fk' },
    });
    const create = vi.fn().mockRejectedValue(dbError);
    const tx = fakeTx({ ownershipCreate: create });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toBe(dbError);
  });

  it('throws confirmation.expired (410) when the CAS fails because the row is expired by status', async () => {
    const tx = fakeTx({
      transferUpdateCount: 0,
      transferFindFirst: { status: 'expired', expiresAt: new Date(NOW.getTime() + 60_000) },
    });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.expired',
      statusCode: 410,
    });
    expect(tx.vehicleOwnership.updateMany).not.toHaveBeenCalled();
  });

  it('throws confirmation.expired (410) when the CAS fails because expiresAt has passed', async () => {
    const tx = fakeTx({
      transferUpdateCount: 0,
      transferFindFirst: {
        status: 'pending_seller_confirmation',
        expiresAt: new Date(NOW.getTime() - 1),
      },
    });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.expired',
      statusCode: 410,
    });
  });

  it('throws not_pending_seller (422) when the row disappears before the re-read', async () => {
    const tx = fakeTx({ transferUpdateCount: 0, transferFindFirst: null });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.not_pending_seller',
      statusCode: 422,
    });
  });
});

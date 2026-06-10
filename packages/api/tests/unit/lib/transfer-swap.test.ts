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
  } = {},
) {
  return {
    vehicleTransfer: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.transferUpdateCount ?? 1 }),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.ownershipUpdateCount ?? 1 }),
      create: overrides.ownershipCreate ?? vi.fn().mockResolvedValue({ id: 'own-new' }),
    },
  };
}

describe('confirmTransferSwap', () => {
  it('CAS-flips the transfer, closes the old ownership, opens the new one', async () => {
    const tx = fakeTx();
    await confirmTransferSwap(tx as never, INPUT);

    expect(tx.vehicleTransfer.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'tr-1', status: 'pending_seller_confirmation' },
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
});

import { describe, expect, it, vi } from 'vitest';
import { resolveCurrentOwner } from '../../../../src/lib/notifications/recipient-resolver.js';

interface OwnershipFindFirst {
  vehicleOwnership: {
    findFirst: ReturnType<typeof vi.fn>;
  };
}

function makeTx(stub: ReturnType<typeof vi.fn>): OwnershipFindFirst {
  return { vehicleOwnership: { findFirst: stub } };
}

describe('resolveCurrentOwner', () => {
  it('returns the customer when one active ownership exists', async () => {
    const stub = vi.fn().mockResolvedValue({
      customer: {
        id: 'cust-1',
        email: 'mario@test.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        isBusiness: false,
        businessName: null,
        notificationPreferences: {},
        status: 'active',
      },
    });
    const result = await resolveCurrentOwner(makeTx(stub) as never, 'veh-1');
    expect(result).not.toBeNull();
    expect(result!.email).toBe('mario@test.it');
    expect(stub).toHaveBeenCalledWith({
      where: { vehicleId: 'veh-1', endedAt: null },
      include: expect.any(Object),
    });
  });

  it('returns null when no active ownership', async () => {
    const stub = vi.fn().mockResolvedValue(null);
    const result = await resolveCurrentOwner(makeTx(stub) as never, 'veh-1');
    expect(result).toBeNull();
  });

  it('returns null when customer status is deleted', async () => {
    const stub = vi.fn().mockResolvedValue({
      customer: {
        id: 'cust-1',
        email: 'deleted-abc123@garageos.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        isBusiness: false,
        businessName: null,
        notificationPreferences: {},
        status: 'deleted',
      },
    });
    const result = await resolveCurrentOwner(makeTx(stub) as never, 'veh-1');
    expect(result).toBeNull();
  });

  it('returns null when email looks like deleted-hash placeholder (BR-220)', async () => {
    const stub = vi.fn().mockResolvedValue({
      customer: {
        id: 'cust-1',
        email: 'deleted-deadbeef@garageos.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        isBusiness: false,
        businessName: null,
        notificationPreferences: {},
        status: 'active', // edge: status mid-state, but email is hashed
      },
    });
    const result = await resolveCurrentOwner(makeTx(stub) as never, 'veh-1');
    expect(result).toBeNull();
  });
});

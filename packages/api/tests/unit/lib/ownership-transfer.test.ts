import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@garageos/database';

import {
  performOwnershipTransfer,
  type OwnershipTransferInput,
} from '../../../src/lib/ownership-transfer.js';

// FakePrisma stub for performOwnershipTransfer.
// Uses vi.fn().mockImplementation with typed local interfaces so the
// parameters stay typed without `any`. The tx cast to `never` at call
// sites is the accepted pattern in this codebase (see dispute-attachments.test.ts).

interface StubVehicle {
  id: string;
  certifiedByTenantId: string | null;
  createdByTenantId: string | null;
  status: string;
  plate: string;
}
interface StubOwnership {
  id: string;
  vehicleId: string;
  customerId: string;
  endedAt: Date | null;
}
interface StubTransfer {
  id: string;
  vehicleId: string;
  status: string;
}
interface StubCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isBusiness: boolean;
  businessName: string | null;
  notificationPreferences: unknown;
  status: 'active' | 'pending_verification' | 'deleted';
}
interface StubRelation {
  tenantId: string;
  customerId: string;
  interventionCount: number;
}
interface StubAccessLog {
  tenantId: string;
  vehicleId: string;
  userId: string;
  action: string;
}

interface StubState {
  vehicles: Map<string, StubVehicle>;
  ownerships: Map<string, StubOwnership>;
  transfers: Map<string, StubTransfer>;
  customers: Map<string, StubCustomer>;
  relations: Map<string, StubRelation>;
  accessLogs: StubAccessLog[];
  tenants: Map<string, { id: string; businessName: string }>;
}

interface VehicleFindFirstWhere {
  id: string;
  OR?: Array<{ certifiedByTenantId?: string; createdByTenantId?: string }>;
}
interface OwnershipFindFirstWhere {
  vehicleId: string;
  endedAt: null;
}
interface OwnershipUpdateWhere {
  id: string;
}
interface OwnershipCreateData {
  vehicleId: string;
  customerId: string;
  startedAt: Date;
  transferReason: string;
  transferNotes: string | null;
}
interface TransferFindFirstWhere {
  vehicleId: string;
  status: { in: string[] };
}
interface TransferCreateData {
  vehicleId: string;
  fromCustomerId: string;
  toCustomerId: string;
  method: string;
  status: string;
  expiresAt: Date;
  completedAt: Date;
  documentUrl?: string | null;
}
interface CustomerFindUniqueWhere {
  id: string;
}
interface CustomerFindFirstWhere {
  email: string;
}
interface CustomerCreateData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  codiceFiscale: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
}
interface CustomerTenantRelationUpsertWhere {
  tenantId_customerId: { tenantId: string; customerId: string };
}
interface CustomerTenantRelationCreateData {
  tenantId: string;
  customerId: string;
  interventionCount: number;
}
interface AccessLogCreateData {
  vehicleId: string;
  tenantId: string;
  userId: string;
  action: string;
}

function makeStub() {
  const state: StubState = {
    vehicles: new Map(),
    ownerships: new Map(),
    transfers: new Map(),
    customers: new Map(),
    relations: new Map(),
    accessLogs: [],
    tenants: new Map(),
  };

  const tx = {
    vehicle: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: VehicleFindFirstWhere }) => {
        for (const v of state.vehicles.values()) {
          if (v.id !== where.id) continue;
          if (where.OR) {
            const match = where.OR.some(
              (o) =>
                (o.certifiedByTenantId !== undefined &&
                  v.certifiedByTenantId === o.certifiedByTenantId) ||
                (o.createdByTenantId !== undefined && v.createdByTenantId === o.createdByTenantId),
            );
            if (!match) continue;
          }
          return v;
        }
        return null;
      }),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: OwnershipFindFirstWhere }) => {
        for (const o of state.ownerships.values()) {
          if (o.vehicleId === where.vehicleId && o.endedAt === null) return Promise.resolve(o);
        }
        return Promise.resolve(null);
      }),
      update: vi
        .fn()
        .mockImplementation(
          ({ where, data }: { where: OwnershipUpdateWhere; data: Partial<StubOwnership> }) => {
            const o = state.ownerships.get(where.id);
            if (o) Object.assign(o, data);
            return Promise.resolve(o);
          },
        ),
      create: vi.fn().mockImplementation(({ data }: { data: OwnershipCreateData }) => {
        const id = `own-${state.ownerships.size + 1}`;
        const row: StubOwnership = {
          id,
          vehicleId: data.vehicleId,
          customerId: data.customerId,
          endedAt: null,
        };
        state.ownerships.set(id, row);
        return Promise.resolve({ id, customerId: data.customerId, startedAt: data.startedAt });
      }),
    },
    vehicleTransfer: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: TransferFindFirstWhere }) => {
        for (const t of state.transfers.values()) {
          if (t.vehicleId === where.vehicleId && where.status.in.includes(t.status)) {
            return Promise.resolve(t);
          }
        }
        return Promise.resolve(null);
      }),
      create: vi.fn().mockImplementation(({ data }: { data: TransferCreateData }) => {
        const id = `tr-${state.transfers.size + 1}`;
        const row: StubTransfer = { id, vehicleId: data.vehicleId, status: data.status };
        state.transfers.set(id, row);
        return Promise.resolve({ id, completedAt: data.completedAt });
      }),
    },
    customer: {
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: CustomerFindUniqueWhere }) =>
          Promise.resolve(state.customers.get(where.id) ?? null),
        ),
      findFirst: vi.fn().mockImplementation(({ where }: { where: CustomerFindFirstWhere }) => {
        for (const c of state.customers.values()) {
          if (c.email === where.email) return Promise.resolve(c);
        }
        return Promise.resolve(null);
      }),
      create: vi.fn().mockImplementation(({ data }: { data: CustomerCreateData }) => {
        const id = `c-${state.customers.size + 1}`;
        const row: StubCustomer = {
          id,
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          isBusiness: data.isBusiness ?? false,
          businessName: data.businessName ?? null,
          notificationPreferences: {},
          status: 'active',
        };
        state.customers.set(id, row);
        return Promise.resolve({ id });
      }),
    },
    customerTenantRelation: {
      upsert: vi
        .fn()
        .mockImplementation(
          ({
            where,
            create,
          }: {
            where: CustomerTenantRelationUpsertWhere;
            update: Record<string, never>;
            create: CustomerTenantRelationCreateData;
          }) => {
            const key = `${where.tenantId_customerId.tenantId}:${where.tenantId_customerId.customerId}`;
            if (!state.relations.has(key)) state.relations.set(key, create);
            return Promise.resolve({ id: key });
          },
        ),
    },
    accessLog: {
      create: vi.fn().mockImplementation(({ data }: { data: AccessLogCreateData }) => {
        state.accessLogs.push(data);
        return Promise.resolve(data);
      }),
    },
    tenant: {
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const t = state.tenants.get(where.id);
        if (!t) return Promise.reject(new Error('P2025'));
        return Promise.resolve(t);
      }),
    },
  };

  return { tx, state };
}

const baseInput: OwnershipTransferInput = {
  vehicleId: 'v1',
  tenantId: 't1',
  actorUserId: 'u1',
  recipient: { kind: 'existing', customerId: 'c-recipient' },
  reason: 'purchase',
  notes: null,
};

describe('performOwnershipTransfer', () => {
  let env: ReturnType<typeof makeStub>;

  beforeEach(() => {
    env = makeStub();
    env.state.vehicles.set('v1', {
      id: 'v1',
      certifiedByTenantId: 't1',
      createdByTenantId: 't1',
      status: 'certified',
      plate: 'AB123CD',
    });
    env.state.ownerships.set('own-current', {
      id: 'own-current',
      vehicleId: 'v1',
      customerId: 'c-cedente',
      endedAt: null,
    });
    env.state.customers.set('c-cedente', {
      id: 'c-cedente',
      email: 'cedente@example.com',
      firstName: 'Cedente',
      lastName: 'Test',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'active',
    });
    env.state.customers.set('c-recipient', {
      id: 'c-recipient',
      email: 'recipient@example.com',
      firstName: 'Recipient',
      lastName: 'Test',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'active',
    });
    env.state.tenants.set('t1', { id: 't1', businessName: 'Officina Test' });
  });

  it('happy path: existing recipient produces complete result', async () => {
    const result = await performOwnershipTransfer(env.tx as never, baseInput);
    expect(result.transfer.status).toBe('completed');
    expect(result.ownership.customerId).toBe('c-recipient');
    expect(env.state.ownerships.get('own-current')!.endedAt).not.toBeNull();
    expect(env.state.accessLogs).toHaveLength(1);
    const log = env.state.accessLogs[0]!;
    expect(log.action).toBe('ownership_transfer');
    expect(log.vehicleId).toBe('v1');
    expect(log.userId).toBe('u1');
  });

  it('happy path: new recipient creates customer', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: {
        kind: 'new',
        firstName: 'Anna',
        lastName: 'Rossi',
        email: 'anna@example.com',
      },
    };
    const result = await performOwnershipTransfer(env.tx as never, input);
    expect(result.transfer.status).toBe('completed');
    expect(env.tx.customer.create).toHaveBeenCalled();
    expect(result.ownership.customerId).toBe('c-3');
  });

  it('new recipient with matching email reuses existing customer', async () => {
    env.state.customers.set('c-existing', {
      id: 'c-existing',
      email: 'reuse@example.com',
      firstName: 'Mario',
      lastName: 'Bianchi',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'active',
    });
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: {
        kind: 'new',
        firstName: 'Mario',
        lastName: 'Bianchi',
        email: 'reuse@example.com',
      },
    };
    const result = await performOwnershipTransfer(env.tx as never, input);
    expect(result.ownership.customerId).toBe('c-existing');
    expect(env.tx.customer.create).not.toHaveBeenCalled();
  });

  it('new recipient P2002 race: concurrent insert resolves via refetch', async () => {
    // Pre-seed the customer that will be "found" by the refetch (simulating
    // a concurrent transaction that inserted this customer between our
    // findFirst and create calls).
    env.state.customers.set('c-race', {
      id: 'c-race',
      email: 'race@example.com',
      firstName: 'X',
      lastName: 'Y',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'active',
    });

    // Force the code path: customer.findFirst returns null on first call
    // (pre-create lookup misses), then finds c-race on the refetch after P2002.
    let findFirstCalled = 0;
    env.tx.customer.findFirst.mockImplementation(
      async ({ where }: { where: { email?: string; id?: string } }) => {
        findFirstCalled++;
        if (findFirstCalled === 1) return null; // pre-create lookup misses
        // refetch finds c-race
        if (where.email === 'race@example.com') return { id: 'c-race', email: 'race@example.com' };
        return null;
      },
    );

    // Make customer.create throw P2002
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5',
    });
    env.tx.customer.create.mockRejectedValueOnce(p2002);

    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: { kind: 'new', firstName: 'X', lastName: 'Y', email: 'race@example.com' },
    };
    const result = await performOwnershipTransfer(env.tx as never, input);
    expect(result.ownership.customerId).toBe('c-race');
    expect(env.tx.customer.create).toHaveBeenCalledTimes(1);
  });

  it('404 vehicle.not_found when vehicle missing in tenant', async () => {
    env.state.vehicles.clear();
    await expect(performOwnershipTransfer(env.tx as never, baseInput)).rejects.toMatchObject({
      name: 'vehicle.not_found',
      statusCode: 404,
    });
  });

  it('422 pending_not_transferable when vehicle.status=pending', async () => {
    env.state.vehicles.set('v1', {
      id: 'v1',
      certifiedByTenantId: 't1',
      createdByTenantId: 't1',
      status: 'pending',
      plate: 'AB123CD',
    });
    await expect(performOwnershipTransfer(env.tx as never, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.pending_not_transferable',
      statusCode: 422,
    });
  });

  it('422 archived when vehicle.status=archived', async () => {
    env.state.vehicles.set('v1', {
      id: 'v1',
      certifiedByTenantId: 't1',
      createdByTenantId: 't1',
      status: 'archived',
      plate: 'AB123CD',
    });
    await expect(performOwnershipTransfer(env.tx as never, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.archived',
      statusCode: 422,
    });
  });

  it('422 no_active_ownership when ownerships empty', async () => {
    env.state.ownerships.clear();
    await expect(performOwnershipTransfer(env.tx as never, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.no_active_ownership',
      statusCode: 422,
    });
  });

  it('409 active_transfer_exists when pending transfer present', async () => {
    env.state.transfers.set('tr-pending', {
      id: 'tr-pending',
      vehicleId: 'v1',
      status: 'pending_recipient',
    });
    await expect(performOwnershipTransfer(env.tx as never, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.active_transfer_exists',
      statusCode: 409,
    });
  });

  it('409 same_owner when recipient is current owner', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: { kind: 'existing', customerId: 'c-cedente' },
    };
    await expect(performOwnershipTransfer(env.tx as never, input)).rejects.toMatchObject({
      name: 'vehicle.transfer.same_owner',
      statusCode: 409,
    });
  });

  it('422 recipient_not_found when existing customerId missing', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: { kind: 'existing', customerId: 'c-ghost' },
    };
    await expect(performOwnershipTransfer(env.tx as never, input)).rejects.toMatchObject({
      name: 'vehicle.transfer.recipient_not_found',
      statusCode: 422,
    });
  });

  it('persists documentUrl on the transfer row when documentS3Key is provided', async () => {
    const key = 'vehicle-transfers/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf';
    await performOwnershipTransfer(env.tx as never, { ...baseInput, documentS3Key: key });
    expect(env.tx.vehicleTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentUrl: key }),
      }),
    );
  });

  it('sets documentUrl null when documentS3Key is absent', async () => {
    await performOwnershipTransfer(env.tx as never, baseInput);
    expect(env.tx.vehicleTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentUrl: null }),
      }),
    );
  });

  it('result carries the cedente as previousOwner and the vehicle plate + tenant', async () => {
    const result = await performOwnershipTransfer(env.tx as never, baseInput);
    expect(result.previousOwner).not.toBeNull();
    expect(result.previousOwner!.id).toBe('c-cedente');
    expect(result.vehiclePlate).toBe('AB123CD');
    expect(result.tenant).toEqual({ id: 't1', businessName: 'Officina Test' });
    expect(result.transferReason).toBe('purchase');
    expect(result.transferCompletedAt).toBeInstanceOf(Date);
  });

  it('previousOwner is null when the cedente is a deleted customer', async () => {
    env.state.customers.set('c-cedente', {
      id: 'c-cedente',
      email: 'cedente@example.com',
      firstName: 'Cedente',
      lastName: 'Test',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'deleted',
    });
    const result = await performOwnershipTransfer(env.tx as never, baseInput);
    expect(result.previousOwner).toBeNull();
  });
});

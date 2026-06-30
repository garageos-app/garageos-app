import { describe, expect, it, vi } from 'vitest';

import { recordVehicleAccess, recordVehiclesBatch } from '../../../src/lib/access-log.js';

// BR-154: every successful GET /vehicles/:id and /vehicles/search that
// matches logs one row in access_logs. Repeat accesses from the same
// user on the same vehicle within 30 minutes are NOT logged again
// (the trigger prevent_audit_modification blocks UPDATE/DELETE, so
// dedup has to be "skip the INSERT").

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VEHICLE = '33333333-3333-4333-8333-333333333333';
const IP = '203.0.113.42';

describe('recordVehicleAccess', () => {
  it('inserts a row when no prior log exists within the window', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({});
    const tx = { accessLog: { findFirst, create } } as never;

    await recordVehicleAccess({
      tx,
      vehicleId: VEHICLE,
      tenantId: TENANT,
      userId: USER,
      action: 'view',
      ipAddress: IP,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        vehicleId: VEHICLE,
        tenantId: TENANT,
        userId: USER,
        action: 'view',
        ipAddress: IP,
      },
    });
  });

  it('skips the insert when a log exists within 30 minutes', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'x' });
    const create = vi.fn();
    const tx = { accessLog: { findFirst, create } } as never;

    await recordVehicleAccess({
      tx,
      vehicleId: VEHICLE,
      tenantId: TENANT,
      userId: USER,
      action: 'view',
    });

    expect(create).not.toHaveBeenCalled();
  });

  it('scopes the dedup lookup to (vehicleId, userId, last 30 min)', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({});
    const tx = { accessLog: { findFirst, create } } as never;

    await recordVehicleAccess({
      tx,
      vehicleId: VEHICLE,
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
    });

    const call = findFirst.mock.calls[0]?.[0] as {
      where: { vehicleId: string; userId: string; createdAt: { gte: Date } };
    };
    expect(call.where.vehicleId).toBe(VEHICLE);
    expect(call.where.userId).toBe(USER);
    const cutoff = call.where.createdAt.gte.getTime();
    // dedup window is "now - 30min"; gte should be before now and no
    // older than 30 minutes + small jitter for test execution time.
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(cutoff).toBeGreaterThanOrEqual(Date.now() - 30 * 60 * 1000 - 5_000);
  });

  it('does not propagate an insert failure to the caller (logged only)', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockRejectedValue(new Error('disk full'));
    const tx = { accessLog: { findFirst, create } } as never;
    const log = { warn: vi.fn() };

    await expect(
      recordVehicleAccess({
        tx,
        vehicleId: VEHICLE,
        tenantId: TENANT,
        userId: USER,
        action: 'view',
        log: log as never,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('recordVehiclesBatch', () => {
  const VEHICLE_A = '33333333-3333-4333-8333-333333333333';
  const VEHICLE_B = '44444444-4444-4444-8444-444444444444';
  const VEHICLE_C = '55555555-5555-4555-8555-555555555555';

  it('returns immediately on empty vehicleIds (no DB calls)', async () => {
    const findMany = vi.fn();
    const createMany = vi.fn();
    const tx = { accessLog: { findMany, createMany } } as never;

    await recordVehiclesBatch({
      tx,
      vehicleIds: [],
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
      ipAddress: IP,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('issues exactly 1 findMany (dedup) and 1 createMany (bulk insert) when nothing is deduped', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const createMany = vi.fn().mockResolvedValue({ count: 3 });
    const tx = { accessLog: { findMany, createMany } } as never;

    await recordVehiclesBatch({
      tx,
      vehicleIds: [VEHICLE_A, VEHICLE_B, VEHICLE_C],
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
      ipAddress: IP,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    const createArg = createMany.mock.calls[0]?.[0] as {
      data: Array<{
        vehicleId: string;
        userId: string;
        tenantId: string;
        action: string;
        ipAddress?: string;
      }>;
    };
    expect(createArg.data).toHaveLength(3);
    const ids = createArg.data.map((r) => r.vehicleId).sort();
    expect(ids).toEqual([VEHICLE_A, VEHICLE_B, VEHICLE_C].sort());
    expect(createArg.data.every((r) => r.userId === USER && r.tenantId === TENANT)).toBe(true);
    expect(createArg.data.every((r) => r.action === 'search_match')).toBe(true);
    expect(createArg.data.every((r) => r.ipAddress === IP)).toBe(true);
  });

  it('skips already-deduped vehicleIds in the bulk insert', async () => {
    const findMany = vi.fn().mockResolvedValue([{ vehicleId: VEHICLE_B }]);
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { accessLog: { findMany, createMany } } as never;

    await recordVehiclesBatch({
      tx,
      vehicleIds: [VEHICLE_A, VEHICLE_B, VEHICLE_C],
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    const createArg = createMany.mock.calls[0]?.[0] as { data: Array<{ vehicleId: string }> };
    const ids = createArg.data.map((r) => r.vehicleId).sort();
    expect(ids).toEqual([VEHICLE_A, VEHICLE_C].sort());
  });

  it('skips createMany entirely when ALL vehicleIds are deduped', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ vehicleId: VEHICLE_A }, { vehicleId: VEHICLE_B }]);
    const createMany = vi.fn();
    const tx = { accessLog: { findMany, createMany } } as never;

    await recordVehiclesBatch({
      tx,
      vehicleIds: [VEHICLE_A, VEHICLE_B],
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('scopes findMany to (vehicleId IN, userId, last 30 min)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { accessLog: { findMany, createMany } } as never;

    await recordVehiclesBatch({
      tx,
      vehicleIds: [VEHICLE_A],
      tenantId: TENANT,
      userId: USER,
      action: 'search_match',
    });

    const call = findMany.mock.calls[0]?.[0] as {
      where: { vehicleId: { in: string[] }; userId: string; createdAt: { gte: Date } };
    };
    expect(call.where.vehicleId.in).toEqual([VEHICLE_A]);
    expect(call.where.userId).toBe(USER);
    const cutoff = call.where.createdAt.gte.getTime();
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(cutoff).toBeGreaterThanOrEqual(Date.now() - 30 * 60 * 1000 - 5_000);
  });

  it('does not propagate failure to the caller (logged only) — search must still respond', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('disk full'));
    const createMany = vi.fn();
    const tx = { accessLog: { findMany, createMany } } as never;
    const log = { warn: vi.fn() };

    await expect(
      recordVehiclesBatch({
        tx,
        vehicleIds: [VEHICLE_A],
        tenantId: TENANT,
        userId: USER,
        action: 'search_match',
        log: log as never,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

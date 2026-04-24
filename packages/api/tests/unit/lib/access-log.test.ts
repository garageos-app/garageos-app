import { describe, expect, it, vi } from 'vitest';

import { recordVehicleAccess } from '../../../src/lib/access-log.js';

// BR-154: every successful GET /vehicles/:id and /vehicles/search that
// matches logs one row in access_logs. Repeat accesses from the same
// user on the same vehicle within 30 minutes are NOT logged again
// (the trigger prevent_audit_modification blocks UPDATE/DELETE, so
// dedup has to be "skip the INSERT").

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VEHICLE = '33333333-3333-4333-8333-333333333333';
const LOCATION = '44444444-4444-4444-8444-444444444444';
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
      locationId: LOCATION,
      action: 'view',
      ipAddress: IP,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        vehicleId: VEHICLE,
        tenantId: TENANT,
        userId: USER,
        locationId: LOCATION,
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

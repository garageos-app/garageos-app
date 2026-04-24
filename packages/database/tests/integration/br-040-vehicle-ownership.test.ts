import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { createTenantWithLocation, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-040 extended coverage — the smoke case ("second active ownership
// rejected", "new ownership after previous ended allowed") lives in
// check-constraints.test.ts. This file covers the edge cases that
// distinguish the partial unique index from both full-table uniqueness
// and RLS-level filtering.

describe('BR-040 — single active ownership (edge cases)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function createCustomer(email: string): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Mario', 'Rossi', NOW(), NOW())
       RETURNING id`,
      [email],
    );
    return rows[0]!.id;
  }

  async function insertActiveOwnership(vehicleId: string, customerId: string): Promise<void> {
    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
      [vehicleId, customerId],
    );
  }

  it('allows the same customer to own multiple different vehicles', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId: v1 } = await createVehicle({ tenantId });
    const { vehicleId: v2 } = await createVehicle({ tenantId });
    const customerId = await createCustomer('multi-vehicle@test.local');

    await insertActiveOwnership(v1, customerId);
    await expect(insertActiveOwnership(v2, customerId)).resolves.not.toThrow();
  });

  it('allows a customer to re-own the same vehicle after the previous ownership ended', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId });
    const customer1 = await createCustomer('first@test.local');
    const customer2 = await createCustomer('second@test.local');

    // customer1 → customer2 → customer1 round-trip. Each hop closes the
    // previous ownership, so the partial unique index never sees two
    // open rows.
    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, ended_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, '2024-01-01', '2024-06-01', NOW())`,
      [vehicleId, customer1],
    );
    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, ended_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, '2024-06-01', '2024-12-01', NOW())`,
      [vehicleId, customer2],
    );

    await expect(insertActiveOwnership(vehicleId, customer1)).resolves.not.toThrow();
  });

  it('allows arbitrarily many historical (ended_at NOT NULL) ownerships for the same vehicle', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId });
    const c1 = await createCustomer('hist1@test.local');
    const c2 = await createCustomer('hist2@test.local');
    const c3 = await createCustomer('hist3@test.local');

    for (const [customerId, started, ended] of [
      [c1, '2020-01-01', '2021-01-01'],
      [c2, '2021-01-01', '2022-01-01'],
      [c3, '2022-01-01', '2023-01-01'],
    ] as const) {
      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships
           (id, vehicle_id, customer_id, started_at, ended_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
        [vehicleId, customerId, started, ended],
      );
    }

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vehicle_ownerships WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.count).toBe('3');
  });

  it('admin role does NOT bypass the partial unique index (RLS ≠ constraint)', async () => {
    // Safety belt against a misconception: `SET app.current_role=admin`
    // disables RLS filtering via is_admin_role(), but partial unique
    // indexes are core PostgreSQL constraints — unaffected by row-
    // level security. The insert must still fail.
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId });
    const customer1 = await createCustomer('admin-bypass-1@test.local');
    const customer2 = await createCustomer('admin-bypass-2@test.local');

    await withContext({ role: 'admin' }, async (tx) => {
      await tx.vehicleOwnership.create({
        data: {
          vehicleId,
          customerId: customer1,
          startedAt: new Date(),
        },
      });
    });

    await expect(
      withContext({ role: 'admin' }, async (tx) => {
        await tx.vehicleOwnership.create({
          data: {
            vehicleId,
            customerId: customer2,
            startedAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Tests for the deadlines_customer_select RLS policy (H3 prereq).
// A customer may SELECT deadlines on vehicles they currently own.
// Active ownership means vehicle_ownerships.ended_at IS NULL.
// INSERT/UPDATE/DELETE are permanently denied to the customer pool —
// deadlines are an officina-managed concept. See F-CLI-301.

describe('RLS — deadlines customer SELECT (post-migration H3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Seed: tenant, vehicle, intervention_type, deadline.
   * Optionally attach customer as owner (active or expired).
   */
  async function seedContext(opts: {
    withActiveOwnership?: boolean;
    withExpiredOwnership?: boolean;
  }): Promise<{
    tenantId: string;
    vehicleId: string;
    customerId: string;
    otherCustomerId: string;
    deadlineId: string;
    interventionTypeId: string;
  }> {
    const { rows: tRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina Test', '11111111111', 'test@off.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantId = tRows[0]!.id;

    const { rows: vRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicles
         (id, vin, plate, plate_country, make, model, year, vehicle_type, fuel_type,
          status, created_by_tenant_id, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'DL000RLS', 'IT', 'Fiat', 'Panda', 2021,
          'car'::"VehicleType", 'petrol'::"FuelType",
          'pending'::"VehicleStatus", $2, NOW(), NOW())
       RETURNING id`,
      [randomUUID().replace(/-/g, '').slice(0, 17).toUpperCase(), tenantId],
    );
    const vehicleId = vRows[0]!.id;

    const { rows: cRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Cliente', 'Test', NOW(), NOW())
       RETURNING id`,
      [`cust-dl-rls-${Date.now()}@test.it`],
    );
    const customerId = cRows[0]!.id;

    const { rows: ocRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Altro', 'Cliente', NOW(), NOW())
       RETURNING id`,
      [`other-dl-rls-${Date.now()}@test.it`],
    );
    const otherCustomerId = ocRows[0]!.id;

    if (opts.withActiveOwnership) {
      // ended_at IS NULL → active ownership (BR-040)
      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships
           (id, vehicle_id, customer_id, started_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
        [vehicleId, customerId],
      );
    }

    if (opts.withExpiredOwnership) {
      // ended_at IS NOT NULL → expired ownership
      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships
           (id, vehicle_id, customer_id, started_at, ended_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day', NOW())`,
        [vehicleId, customerId],
      );
    }

    // Retrieve a seeded system intervention type
    const { rows: itRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM intervention_types WHERE tenant_id IS NULL AND code = 'TAGLIANDO' LIMIT 1`,
    );
    const interventionTypeId = itRows[0]!.id;

    // Insert a deadline for the vehicle (chk_deadline_has_criterion: needs due_date OR due_odometer_km)
    const { rows: dRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO deadlines
         (id, tenant_id, vehicle_id, intervention_type_id,
          due_date, status, is_recurring, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3,
          CURRENT_DATE + INTERVAL '90 days', 'open'::"DeadlineStatus",
          false, NOW(), NOW())
       RETURNING id`,
      [tenantId, vehicleId, interventionTypeId],
    );
    const deadlineId = dRows[0]!.id;

    return {
      tenantId,
      vehicleId,
      customerId,
      otherCustomerId,
      deadlineId,
      interventionTypeId,
    };
  }

  // -----------------------------------------------------------------------
  // Test 1: active owner CAN read deadline on their vehicle
  // -----------------------------------------------------------------------
  it('customer with active ownership can SELECT deadline on owned vehicle', async () => {
    const { customerId, deadlineId } = await seedContext({ withActiveOwnership: true });

    // See BR-040 + F-CLI-301: active ownership (ended_at IS NULL) grants read.
    const found = await withContext({ customerId }, (tx) =>
      tx.deadline.findUnique({ where: { id: deadlineId } }),
    );
    expect(found?.id).toBe(deadlineId);
  });

  // -----------------------------------------------------------------------
  // Test 2: customer with NO ownership cannot read deadline on that vehicle
  // -----------------------------------------------------------------------
  it('customer with no ownership cannot SELECT deadline on unowned vehicle', async () => {
    const { otherCustomerId, deadlineId } = await seedContext({ withActiveOwnership: true });

    // otherCustomerId has no vehicle_ownerships row → policy denies SELECT.
    const notFound = await withContext({ customerId: otherCustomerId }, (tx) =>
      tx.deadline.findUnique({ where: { id: deadlineId } }),
    );
    expect(notFound).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 3: EXPIRED ownership (ended_at IS NOT NULL) does NOT grant read
  // -----------------------------------------------------------------------
  it('customer with expired ownership cannot SELECT deadline (ended_at IS NOT NULL)', async () => {
    const { customerId, deadlineId } = await seedContext({ withExpiredOwnership: true });

    // ended_at set → EXISTS subquery filters it out → no row returned.
    const notFound = await withContext({ customerId }, (tx) =>
      tx.deadline.findUnique({ where: { id: deadlineId } }),
    );
    expect(notFound).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 4a: customer CANNOT INSERT deadlines (defense-in-depth)
  // -----------------------------------------------------------------------
  it('customer cannot INSERT a deadline (deadlines are officina-managed)', async () => {
    const { customerId, tenantId, vehicleId, interventionTypeId } = await seedContext({
      withActiveOwnership: true,
    });

    // The deadlines_tenant_isolation policy has no FOR INSERT, so default-deny
    // applies. The new deadlines_customer_select is FOR SELECT only.
    await expect(
      withContext({ customerId }, (tx) =>
        tx.deadline.create({
          data: {
            tenantId,
            vehicleId,
            interventionTypeId,
            dueDate: new Date('2027-01-01'),
            status: 'open',
            isRecurring: false,
          },
        }),
      ),
    ).rejects.toThrow(
      /(?=.*\bdeadlines?\b)(?=.*(row-level security|policy|permission denied|denied))/i,
    );
  });

  // -----------------------------------------------------------------------
  // Test 4b: customer CANNOT UPDATE a deadline
  // -----------------------------------------------------------------------
  it('customer cannot UPDATE a deadline', async () => {
    const { customerId, deadlineId } = await seedContext({ withActiveOwnership: true });

    // No FOR UPDATE policy matches a customer context → updateMany returns 0.
    const result = await withContext({ customerId }, (tx) =>
      tx.deadline.updateMany({
        where: { id: deadlineId },
        data: { status: 'cancelled' },
      }),
    );
    expect(result.count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Admin escape hatch: admin can always SELECT regardless
  // -----------------------------------------------------------------------
  it('admin role can SELECT deadlines (escape hatch)', async () => {
    const { deadlineId } = await seedContext({ withActiveOwnership: false });

    const found = await withContext({ role: 'admin' }, (tx) =>
      tx.deadline.findUnique({ where: { id: deadlineId } }),
    );
    expect(found?.id).toBe(deadlineId);
  });
});

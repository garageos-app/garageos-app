import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, createTenantWithLocation, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// POST /v1/me/vehicles/pending (F-CLI-104 PR1).
//
// End-to-end coverage of customer pre-registration: clienti-pool JWT →
// VIN checksum (BR-001) → duplicate detection → pending Vehicle +
// active VehicleOwnership in one tx (BR-003 / BR-040), plus the
// vehicles_insert RLS negative.
//
// No claim-on-pending (BR-042) integration test here: a pending vehicle
// has garage_code NULL (chk_pending_consistency), so it can never be
// reached by a garage-code lookup — the claim path 404s before the
// pending guard. The defensive 422 me.vehicle.claim.pending branch is
// covered by tests/unit/routes/v1/me-vehicles.test.ts ("returns 422
// me.vehicle.claim.pending for a pending vehicle").

// All VINs below are ISO 3779 checksum-valid (verified against
// src/lib/vin-checksum.ts: weights 8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2,
// 9th char = weighted sum mod 11, 10 → 'X'). resetDb() truncates
// vehicles between tests, so reuse across sibling suites is safe; they
// are still unique per test for clarity.
const VIN_HAPPY = '1M8GDM9AXKP042788'; // check digit X
const VIN_DUP_CERTIFIED = 'ZFA22300405556777'; // check digit 4
const VIN_DUP_PENDING = 'ZFA22300205556888'; // check digit 2
const VIN_ISOLATION = 'ZFA22300005556999'; // check digit 0
const VIN_RLS = 'WVWZZZ1J9W3865551'; // check digit 9

// Valid request body minus VIN/plate (callers override those per test).
const BASE_BODY = {
  make: 'Fiat',
  model: 'Panda',
  year: 2020,
  vehicleType: 'car',
  fuelType: 'petrol',
} as const;

describe('POST /v1/me/vehicles/pending (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function customer(prefix: string) {
    const cognitoSub = `${prefix}-` + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    return { customerId, token };
  }

  it('creates a pending vehicle + active ownership and surfaces it in GET /v1/me/vehicles', async () => {
    const { customerId, token } = await customer('pend-ok');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, vin: VIN_HAPPY, plate: 'PD001AA' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      vehicle: Record<string, unknown>;
      ownership: { id: string; startedAt: string };
    };
    // Exact wire envelope: 11 vehicle fields, garageCode null, status
    // 'pending' (BR-003); plateCountry defaulted to 'IT' by the schema.
    expect(body.vehicle).toEqual({
      id: expect.any(String),
      garageCode: null,
      vin: VIN_HAPPY,
      plate: 'PD001AA',
      plateCountry: 'IT',
      make: 'Fiat',
      model: 'Panda',
      year: 2020,
      vehicleType: 'car',
      fuelType: 'petrol',
      status: 'pending',
    });
    expect(body.ownership.id).toBeTruthy();
    expect(typeof body.ownership.startedAt).toBe('string');

    // DB state: pending row pinned to the caller, garage_code NULL
    // (chk_pending_consistency), no tenant linkage yet (certification is
    // PR2).
    const vehicleId = body.vehicle.id as string;
    const { rows: vehicleRows } = await pgAdmin.query<{
      status: string;
      garage_code: string | null;
      created_by_customer_id: string | null;
      created_by_tenant_id: string | null;
      certified_by_tenant_id: string | null;
    }>(
      `SELECT status, garage_code, created_by_customer_id, created_by_tenant_id, certified_by_tenant_id
         FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(vehicleRows).toHaveLength(1);
    expect(vehicleRows[0]!.status).toBe('pending');
    expect(vehicleRows[0]!.garage_code).toBeNull();
    expect(vehicleRows[0]!.created_by_customer_id).toBe(customerId);
    expect(vehicleRows[0]!.created_by_tenant_id).toBeNull();
    expect(vehicleRows[0]!.certified_by_tenant_id).toBeNull();

    // BR-040: exactly one active ownership row, owned by the caller.
    const { rows: ownershipRows } = await pgAdmin.query<{
      id: string;
      customer_id: string;
      ended_at: Date | null;
    }>(`SELECT id, customer_id, ended_at FROM vehicle_ownerships WHERE vehicle_id = $1`, [
      vehicleId,
    ]);
    expect(ownershipRows).toHaveLength(1);
    expect(ownershipRows[0]!.id).toBe(body.ownership.id);
    expect(ownershipRows[0]!.customer_id).toBe(customerId);
    expect(ownershipRows[0]!.ended_at).toBeNull();

    // The pre-registered vehicle is immediately visible in the customer
    // list with the exact serialized wire values the mobile app reads.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as {
      data: Array<{
        id: string;
        garageCode: string | null;
        status: string;
        vin: string;
        currentOwnership: { id: string };
      }>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]!.id).toBe(vehicleId);
    expect(listBody.data[0]!.garageCode).toBeNull();
    expect(listBody.data[0]!.status).toBe('pending');
    expect(listBody.data[0]!.vin).toBe(VIN_HAPPY);
    expect(listBody.data[0]!.currentOwnership.id).toBe(body.ownership.id);
  });

  it('persists the optional owner-declared technical fields when provided', async () => {
    const { token } = await customer('pend-tech');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...BASE_BODY,
        vin: VIN_HAPPY,
        plate: 'PD006FF',
        version: '1.2 Easy',
        registrationDate: '2020-06-15',
        engineDisplacement: 1242,
        powerKw: 51,
        color: 'Bianco',
      },
    });
    expect(res.statusCode).toBe(201);
    const vehicleId = (res.json() as { vehicle: { id: string } }).vehicle.id;

    // The 201 envelope intentionally does NOT echo these fields; they are
    // verified at the DB layer (the mobile detail GET re-projects them).
    // registration_date is @db.Date → DATE column; assert the bare date.
    const { rows } = await pgAdmin.query<{
      version: string | null;
      registration_date: Date | null;
      engine_displacement: number | null;
      power_kw: number | null;
      color: string | null;
    }>(
      `SELECT version, registration_date, engine_displacement, power_kw, color
         FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('1.2 Easy');
    expect(rows[0]!.registration_date?.toISOString().slice(0, 10)).toBe('2020-06-15');
    expect(rows[0]!.engine_displacement).toBe(1242);
    expect(rows[0]!.power_kw).toBe(51);
    expect(rows[0]!.color).toBe('Bianco');
  });

  it('still creates the vehicle when the optional technical fields are omitted', async () => {
    const { token } = await customer('pend-no-tech');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, vin: VIN_HAPPY, plate: 'PD007GG' },
    });
    expect(res.statusCode).toBe(201);
    const vehicleId = (res.json() as { vehicle: { id: string } }).vehicle.id;

    const { rows } = await pgAdmin.query<{
      version: string | null;
      registration_date: Date | null;
      engine_displacement: number | null;
      power_kw: number | null;
      color: string | null;
    }>(
      `SELECT version, registration_date, engine_displacement, power_kw, color
         FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]).toEqual({
      version: null,
      registration_date: null,
      engine_displacement: null,
      power_kw: null,
      color: null,
    });
  });

  it('returns 400 for an invalid optional technical field (negative displacement)', async () => {
    const { token } = await customer('pend-bad-tech');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, vin: VIN_HAPPY, plate: 'PD008HH', engineDisplacement: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 duplicate_vin_certified when the VIN belongs to a certified vehicle', async () => {
    const { token } = await customer('pend-dup-cert');
    const { tenantId } = await createTenantWithLocation('pend-dup-cert');
    await createVehicle({
      createdByTenantId: tenantId,
      certifiedByTenantId: tenantId,
      vin: VIN_DUP_CERTIFIED,
      plate: 'PD002BB',
      status: 'certified',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, vin: VIN_DUP_CERTIFIED, plate: 'PD002BB' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.pending.duplicate_vin_certified',
      status: 409,
    });
  });

  it('returns 409 on a second pre-registration with the same VIN (pending duplicate)', async () => {
    const { token: tokenA } = await customer('pend-dup-a');
    const { token: tokenB } = await customer('pend-dup-b');

    const first = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...BASE_BODY, vin: VIN_DUP_PENDING, plate: 'PD003CC' },
    });
    expect(first.statusCode).toBe(201);

    // BR-001 is global across statuses: a second customer hitting the
    // same VIN gets the same 409 code even though the blocker is only
    // pending.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { ...BASE_BODY, vin: VIN_DUP_PENDING, plate: 'PD003CC' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.pending.duplicate_vin_certified',
      status: 409,
    });

    const { rows } = await pgAdmin.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM vehicles WHERE vin = $1`,
      [VIN_DUP_PENDING],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('does not leak a pre-registered vehicle to another customer in GET /v1/me/vehicles', async () => {
    const { token: tokenA } = await customer('pend-iso-a');
    const { token: tokenB } = await customer('pend-iso-b');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...BASE_BODY, vin: VIN_ISOLATION, plate: 'PD004DD' },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('RLS vehicles_insert rejects a customer-context insert without created_by_customer_id', async () => {
    const { customerId } = await customer('pend-rls');

    // The route passes the vehicles_insert policy via its
    // `created_by_customer_id IS NOT NULL` arm (it pins the column to the
    // authenticated caller). Dropping the column under the same
    // customer/user context must hit default-deny: is_admin_role() is
    // false and current_tenant_id() is NULL, so no policy arm holds.
    // app.withContext is the same non-superuser handle the routes use
    // (DATABASE_URL → app_test), so FORCE RLS applies.
    await expect(
      app.withContext({ customerId, role: 'user' }, (tx) =>
        tx.vehicle.create({
          data: {
            vin: VIN_RLS,
            plate: 'PD005EE',
            make: 'Fiat',
            model: 'Panda',
            year: 2020,
            vehicleType: 'car',
            fuelType: 'petrol',
            status: 'pending',
            // createdByCustomerId deliberately omitted.
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);

    const { rows } = await pgAdmin.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM vehicles WHERE vin = $1`,
      [VIN_RLS],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

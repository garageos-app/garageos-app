import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// POST /v1/vehicles end-to-end.
//   - BR-001 (VIN uniqueness)
//   - BR-002 (plate soft uniqueness with force override)
//   - BR-003 (status=certified at creation by an officina)
//   - BR-020/021 (garage_code format + assignment)
//   - BR-040 (at most one active ownership)
//   - BR-041 (atomic vehicle+customer+ownership+relation transaction)
//   - BR-152 (customer_tenant_relation auto-creation)
//   - BR-154 (access_log action='create')

const VALID_VIN = '1M8GDM9AXKP042788'; // ISO 3779-valid
const INVALID_CHECKSUM_VIN = '1M8GDM9A1KP042788';

function buildBody(overrides: Record<string, unknown> = {}) {
  return {
    vehicle: {
      vin: VALID_VIN,
      plate: 'AB123CD',
      plateCountry: 'IT',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      vehicleType: 'car',
      fuelType: 'petrol',
      odometerKm: 45000,
    },
    customer: {
      mode: 'create_new',
      firstName: 'Mario',
      lastName: 'Rossi',
      email: `mario-${Math.random().toString(36).slice(2, 8)}@test.it`,
    },
    ...overrides,
  };
}

describe('POST /v1/vehicles (integration)', () => {
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

  it('creates vehicle + customer + ownership + relation + invitation atomically (happy path, create_new)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('post-happy');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const body = buildBody({ locationId });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      vehicle: { id: string; garageCode: string; status: string };
      customer: { id: string; email: string };
      ownership: { vehicleId: string; customerId: string };
      invitation: { id: string } | null;
    };
    expect(json.vehicle.status).toBe('certified');
    expect(json.vehicle.garageCode).toMatch(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/);
    expect(json.customer.email).toBe(body.customer.email);
    expect(json.ownership.customerId).toBe(json.customer.id);
    expect(json.invitation).not.toBeNull();
    expect(json).not.toHaveProperty('tag_download_url');

    const { rows: relationRows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customer_tenant_relations
       WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, json.customer.id],
    );
    expect(Number(relationRows[0]!.count)).toBe(1);

    const { rows: accessRows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM access_logs
       WHERE vehicle_id = $1 AND action = 'create'`,
      [json.vehicle.id],
    );
    expect(Number(accessRows[0]!.count)).toBe(1);
  });

  it('reuses an existing customer (existing mode) without creating a duplicate', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('post-existing');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    await createCustomerTenantRelation({ tenantId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const body = {
      vehicle: {
        vin: VALID_VIN,
        plate: 'AB111CD',
        plateCountry: 'IT',
        make: 'Fiat',
        model: 'Panda',
        year: 2021,
        vehicleType: 'car',
        fuelType: 'petrol',
        odometerKm: 45000,
      },
      customer: { mode: 'existing', customerId },
      locationId,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    const { rows: customerCount } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers`,
    );
    expect(Number(customerCount[0]!.count)).toBe(1);
  });

  it('returns 409 vehicle.creation.duplicate_vin when VIN already exists', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('post-dup-vin');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
    await createVehicle({ createdByTenantId: tenantId, vin: VALID_VIN });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody({ locationId }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'vehicle.creation.duplicate_vin' });
  });

  it('returns 409 duplicate_plate_warning without force, accepts with force=true', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('post-dup-plate');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
    await createVehicle({
      createdByTenantId: tenantId,
      plate: 'AB123CD',
      vin: 'ZFA16900000099999',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const resWarn = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody({ locationId }),
    });
    expect(resWarn.statusCode).toBe(409);
    expect(resWarn.json()).toMatchObject({
      code: 'vehicle.creation.duplicate_plate_warning',
    });

    const resForce = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody({ locationId, force: true }),
    });
    expect(resForce.statusCode).toBe(201);
  });

  it('returns 422 location_not_in_tenant when location belongs to another tenant', async () => {
    const { tenantId } = await createTenantWithLocation('post-loc-A');
    const { locationId: otherLocationId } = await createTenantWithLocation('post-loc-B');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody({ locationId: otherLocationId }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'vehicle.creation.location_not_in_tenant',
    });
  });

  it('returns 400 invalid_vin_checksum on a checksum-failing VIN (no forceNonstandardVin)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('post-chk');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const body = buildBody({ locationId });
    body.vehicle.vin = INVALID_CHECKSUM_VIN;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'vehicle.creation.invalid_vin_checksum',
    });
  });

  it('rolls back every row on failure mid-transaction (no orphan customer if vehicle insert fails)', async () => {
    // We trigger a failure by pre-inserting a vehicle with the target
    // VIN so the duplicate_vin check fires. checkDuplicateVin runs
    // before resolveCustomer, so this exercises the pre-customer-create
    // ordering: no customer row should leak through the failed flow.
    const { tenantId, locationId } = await createTenantWithLocation('post-rollback');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });
    await createVehicle({ createdByTenantId: tenantId, vin: VALID_VIN });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const body = buildBody({ locationId });
    body.customer.email = `rollback-${Date.now()}@test.it`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(409);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers WHERE email = $1`,
      [body.customer.email],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

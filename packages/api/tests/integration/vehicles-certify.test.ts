import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signTestToken } from '../helpers/jwt.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';

// POST /v1/vehicles/:id/certify (F-OFF-107 PR2, BR-004).
//
// End-to-end pending→certified promotion: the pending vehicle is seeded
// through the real F-CLI-104 endpoint (exact PR1 wire), then certified
// by a workshop user. Covers garage_code generation (BR-020/021),
// BR-004 post-conditions, corrections, the double-certify CAS, the
// duplicate-VIN guard on corrections (BR-001) and the RLS rationale for
// running the route under role:'admin'.

// ISO 3779 checksum-valid VINs (see me-vehicles-pending.test.ts header;
// resetDb() truncates vehicles between tests).
const VIN_HAPPY = '1M8GDM9AXKP042788'; // check digit X
const VIN_CORRECTIONS = 'ZFA22300405556777'; // check digit 4
const VIN_CONCURRENT = 'ZFA22300205556888'; // check digit 2
const VIN_LIBRETTO = 'ZFA22300005556999'; // check digit 0
const VIN_RLS = 'WVWZZZ1J9W3865551'; // check digit 9
const VIN_COLLISION_SRC = 'ZFA22300505556111'; // check digit 5
const VIN_COLLISION_TARGET = '11111111111111111'; // all-ones canonical valid

const GO_CODE_RE = /^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/;

const PENDING_BODY = {
  make: 'Fiat',
  model: 'Panda',
  year: 2020,
  vehicleType: 'car',
  fuelType: 'petrol',
} as const;

describe('POST /v1/vehicles/:id/certify (integration)', () => {
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

  // Seed a customer-created pending vehicle through the real F-CLI-104
  // endpoint: created_by_customer_id set, both tenant columns NULL,
  // active ownership for the customer.
  async function seedPending(prefix: string, vin: string, plate: string) {
    const cognitoSub = `${prefix}-` + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const customerToken = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { ...PENDING_BODY, vin, plate },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { vehicle: { id: string }; ownership: { id: string } };
    return { customerId, vehicleId: body.vehicle.id, ownershipId: body.ownership.id };
  }

  async function workshop(prefix: string) {
    const { tenantId } = await createTenantWithLocation(prefix);
    const cognitoSub = `${prefix}-` + Math.random().toString(36).slice(2, 10);
    const { userId } = await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, userId, token };
  }

  function certify(token: string, vehicleId: string, payload: object) {
    return app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/certify`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('promotes a pending vehicle: GO-code, BR-004 post-conditions, ownership intact, access log', async () => {
    const { customerId, vehicleId, ownershipId } = await seedPending(
      'cert-h',
      VIN_HAPPY,
      'CF001AA',
    );
    const { tenantId, userId, token } = await workshop('cert-h');

    const res = await certify(token, vehicleId, { librettoVisioned: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; garageCode: string; status: string };
      currentOwnership: { id: string; customer: { redacted: boolean } };
    };
    expect(body.vehicle.id).toBe(vehicleId);
    expect(body.vehicle.garageCode).toMatch(GO_CODE_RE);
    expect(body.vehicle.status).toBe('certified');
    // BR-151: no CTR between this tenant and the owner → masked PII.
    expect(body.currentOwnership.id).toBe(ownershipId);
    expect(body.currentOwnership.customer.redacted).toBe(true);

    // BR-004 post-conditions on the row itself.
    const { rows } = await pgAdmin.query<{
      status: string;
      garage_code: string | null;
      certified_by_tenant_id: string | null;
      certified_at: Date | null;
      created_by_customer_id: string | null;
    }>(
      `SELECT status, garage_code, certified_by_tenant_id, certified_at, created_by_customer_id
         FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.status).toBe('certified');
    expect(rows[0]!.garage_code).toMatch(GO_CODE_RE);
    expect(rows[0]!.certified_by_tenant_id).toBe(tenantId);
    expect(rows[0]!.certified_at).not.toBeNull();
    expect(rows[0]!.created_by_customer_id).toBe(customerId);

    // BR-040: certification does NOT touch ownership — still the
    // customer's single active row.
    const { rows: own } = await pgAdmin.query<{ customer_id: string; ended_at: Date | null }>(
      `SELECT customer_id, ended_at FROM vehicle_ownerships WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.customer_id).toBe(customerId);
    expect(own[0]!.ended_at).toBeNull();

    // Access log row for the certification.
    const { rows: logs } = await pgAdmin.query<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM access_logs WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('update');
    expect(logs[0]!.user_id).toBe(userId);
  });

  it('persists corrections together with the certification', async () => {
    const { vehicleId } = await seedPending('cert-c', VIN_CORRECTIONS, 'CF002BB');
    const { token } = await workshop('cert-c');

    const res = await certify(token, vehicleId, {
      librettoVisioned: true,
      corrections: { plate: 'CF999ZZ', year: 2019, version: '1.2 Easy' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{
      plate: string;
      year: number;
      version: string | null;
      status: string;
      garage_code: string | null;
    }>(`SELECT plate, year, version, status, garage_code FROM vehicles WHERE id = $1`, [vehicleId]);
    expect(rows[0]!).toMatchObject({ plate: 'CF999ZZ', year: 2019, version: '1.2 Easy' });
    expect(rows[0]!.status).toBe('certified');
    expect(rows[0]!.garage_code).toMatch(GO_CODE_RE);
  });

  it('double-certify: sequential repeat gets 422 not_pending, concurrent has exactly one winner', async () => {
    const { vehicleId } = await seedPending('cert-d', VIN_CONCURRENT, 'CF003CC');
    const { token } = await workshop('cert-d');

    // Concurrent: the helper UPDATE ... WHERE garage_code IS NULL is the
    // CAS — exactly one 200, the loser maps to 422 (mirror of the
    // transfer double-confirm pattern, #181).
    const [a, b] = await Promise.all([
      certify(token, vehicleId, { librettoVisioned: true }),
      certify(token, vehicleId, { librettoVisioned: true }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(422);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.certification.not_pending',
      status: 422,
    });

    // Sequential repeat after completion: same 422.
    const again = await certify(token, vehicleId, { librettoVisioned: true });
    expect(again.statusCode).toBe(422);

    // Exactly one certified row, one garage code.
    const { rows } = await pgAdmin.query<{ status: string; garage_code: string | null }>(
      `SELECT status, garage_code FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.status).toBe('certified');
    expect(rows[0]!.garage_code).toMatch(GO_CODE_RE);
  });

  it('rejects a corrected VIN colliding with an existing vehicle and leaves the row pending', async () => {
    const { vehicleId } = await seedPending('cert-v', VIN_COLLISION_SRC, 'CF004DD');
    const { tenantId, token } = await workshop('cert-v');
    await createVehicle({
      createdByTenantId: tenantId,
      vin: VIN_COLLISION_TARGET,
      plate: 'CF005EE',
      status: 'certified',
    });

    const res = await certify(token, vehicleId, {
      librettoVisioned: true,
      corrections: { vin: VIN_COLLISION_TARGET },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.creation.duplicate_vin',
      status: 409,
    });

    const { rows } = await pgAdmin.query<{ status: string; vin: string }>(
      `SELECT status, vin FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.vin).toBe(VIN_COLLISION_SRC);
  });

  it('returns 422 libretto_required without side effects when the declaration is missing', async () => {
    const { vehicleId } = await seedPending('cert-l', VIN_LIBRETTO, 'CF006FF');
    const { token } = await workshop('cert-l');

    const res = await certify(token, vehicleId, { librettoVisioned: false });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.certification.libretto_required',
      status: 422,
    });

    const { rows } = await pgAdmin.query<{ status: string; garage_code: string | null }>(
      `SELECT status, garage_code FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.garage_code).toBeNull();
  });

  it('RLS: a tenant-context UPDATE on a customer-created pending vehicle matches 0 rows', async () => {
    // Documents WHY the route runs under role:'admin': policy
    // vehicles_update (migration 20260424100000:413-420) matches
    // is_admin_role() OR created_by/certified_by tenant — on a
    // customer-created pending vehicle both tenant columns are NULL, so
    // under a tenant context the write silently affects nothing
    // (Prisma loose-where silent-drop class, #120).
    const { vehicleId } = await seedPending('cert-r', VIN_RLS, 'CF007GG');
    const { tenantId } = await workshop('cert-r');

    const result = await app.withContext({ tenantId }, (tx) =>
      tx.vehicle.updateMany({ where: { id: vehicleId }, data: { year: 1999 } }),
    );
    expect(result.count).toBe(0);

    const { rows } = await pgAdmin.query<{ year: number }>(
      `SELECT year FROM vehicles WHERE id = $1`,
      [vehicleId],
    );
    expect(rows[0]!.year).toBe(2020);
  });
});

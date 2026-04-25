import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// GET /v1/vehicles/:id covers BR-150 (open read), BR-151 (PII by
// relation), BR-153 (redacted cross-tenant view), and BR-154 (access_log
// with 30-min dedup).

describe('GET /v1/vehicles/:id (integration)', () => {
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

  it('returns full PII when the tenant has a customer_tenant_relation', async () => {
    const { tenantId } = await createTenantWithLocation('id-related');
    const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({ firstName: 'Luca', lastName: 'Bianchi' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await createCustomerTenantRelation({ tenantId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string };
      currentOwnership: { customer: { redacted: boolean; firstName?: string } };
    };
    expect(body.vehicle.id).toBe(vehicleId);
    expect(body.currentOwnership.customer.redacted).toBe(false);
    expect(body.currentOwnership.customer.firstName).toBe('Luca');
  });

  it('redacts PII when the tenant is unrelated to the customer (BR-153)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('id-unrelated-A');
    const { tenantId: tenantB } = await createTenantWithLocation('id-unrelated-B');
    const cognitoSub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await createUser({ tenantId: tenantA, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantB });
    await createOwnership({ vehicleId, customerId });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      currentOwnership: { customer: { redacted: boolean; displayName?: string } };
    };
    expect(body.currentOwnership.customer.redacted).toBe(true);
    expect(body.currentOwnership.customer.displayName).toBe('Proprietario non in anagrafica');
  });

  it('returns 404 when the vehicle id is a valid UUID but does not exist', async () => {
    const { tenantId } = await createTenantWithLocation('id-404');
    const cognitoSub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deduplicates access_logs within a 30-minute window (BR-154)', async () => {
    const { tenantId } = await createTenantWithLocation('id-dedup');
    const cognitoSub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM access_logs
       WHERE vehicle_id = $1 AND user_id = $2 AND action = 'view'`,
      [vehicleId, userId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('writes a second access_logs row after the 30-minute window has passed', async () => {
    const { tenantId } = await createTenantWithLocation('id-relog');
    const cognitoSub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Backdate the existing row so the dedup window has lapsed. The
    // immutability trigger trg_access_logs_no_modify rejects UPDATEs
    // even from the superuser pgAdmin connection, so disable it for
    // the surgical edit and re-enable immediately. Documented at the
    // top of src/lib/access-log.ts.
    await pgAdmin.query(`ALTER TABLE access_logs DISABLE TRIGGER trg_access_logs_no_modify`);
    try {
      await pgAdmin.query(
        `UPDATE access_logs SET created_at = NOW() - INTERVAL '31 minutes'
         WHERE vehicle_id = $1 AND user_id = $2`,
        [vehicleId, userId],
      );
    } finally {
      await pgAdmin.query(`ALTER TABLE access_logs ENABLE TRIGGER trg_access_logs_no_modify`);
    }

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM access_logs
       WHERE vehicle_id = $1 AND user_id = $2`,
      [vehicleId, userId],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });
});

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

// BR-150 / BR-151 / BR-154 end-to-end: vehicles are readable
// cross-tenant (vehicles_read USING true), but PII is gated through
// customer_tenant_relations and every match writes an access_logs row.

describe('GET /v1/vehicles/search (integration)', () => {
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

  it('finds a vehicle by plate and masks the owner PII when the tenants are unrelated', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('search-plate-A');
    const { tenantId: tenantB } = await createTenantWithLocation('search-plate-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tenantA, cognitoSub });

    const { customerId } = await createCustomer({});
    const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantB });
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
      url: `/v1/vehicles/search?plate=${plate}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; currentOwnership: { customer: { redacted: boolean } } }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(vehicleId);
    expect(body.data[0]!.currentOwnership.customer.redacted).toBe(true);
  });

  it('returns full PII when the searching tenant has a customer_tenant_relation', async () => {
    const { tenantId } = await createTenantWithLocation('search-plate-related');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Luca', lastName: 'Bianchi' });
    const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantId });
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
      url: `/v1/vehicles/search?plate=${plate}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json() as {
      data: Array<{
        id: string;
        currentOwnership: { customer: { redacted: boolean; firstName?: string } };
      }>;
    };
    expect(body.data[0]!.id).toBe(vehicleId);
    expect(body.data[0]!.currentOwnership.customer.redacted).toBe(false);
    expect(body.data[0]!.currentOwnership.customer.firstName).toBe('Luca');
  });

  it('returns empty data array for a plate that matches nothing', async () => {
    const { tenantId } = await createTenantWithLocation('search-empty');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?plate=ZZ999ZZ`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('paginates with cursor and returns has_more=true when results exceed limit', async () => {
    const { tenantId } = await createTenantWithLocation('search-pagination');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const plate = 'PG000PG';
    await createVehicle({ createdByTenantId: tenantId, plate });
    const { vehicleId: v2 } = await createVehicle({ createdByTenantId: tenantId, plate });
    await createOwnership({ vehicleId: v2, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res1 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?plate=${plate}&limit=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      data: unknown[];
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data).toHaveLength(1);
    expect(body1.meta.has_more).toBe(true);
    expect(body1.meta.cursor).toBeTruthy();

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?plate=${plate}&limit=1&cursor=${encodeURIComponent(
        body1.meta.cursor!,
      )}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as { data: unknown[]; meta: { has_more: boolean } };
    expect(body2.data).toHaveLength(1);
    expect(body2.meta.has_more).toBe(false);
  });

  it('400 when no search field is provided', async () => {
    const { tenantId } = await createTenantWithLocation('search-400');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes access_logs rows with action=search_match (BR-154)', async () => {
    const { tenantId } = await createTenantWithLocation('search-audit');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?plate=${plate}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM access_logs
       WHERE vehicle_id = $1 AND user_id = $2 AND action = 'search_match'`,
      [vehicleId, userId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('finds vehicles owned by customer (active ownership only)', async () => {
    const { tenantId } = await createTenantWithLocation('search-customer-active');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { vehicleId: v1 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v2 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v3 } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId: v1, customerId });
    await createOwnership({ vehicleId: v2, customerId });
    // v3 ended → must NOT appear
    await createOwnership({
      vehicleId: v3,
      customerId,
      startedAt: new Date('2024-01-01'),
      endedAt: new Date('2025-01-01'),
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?customer=${customerId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((v) => v.id).sort();
    expect(ids).toEqual([v1, v2].sort());
    expect(ids).not.toContain(v3);
  });

  it('returns empty data array when customer has no active ownerships', async () => {
    const { tenantId } = await createTenantWithLocation('search-customer-no-vehicles');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Solo', lastName: 'Owner' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?customer=${customerId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('returns empty data array when customer does not exist', async () => {
    const { tenantId } = await createTenantWithLocation('search-customer-not-exist');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?customer=99999999-9999-4999-8999-999999999999`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('masks customer PII when searching tenant has no relation', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('search-customer-A');
    const { tenantId: tenantB } = await createTenantWithLocation('search-customer-B');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId: tenantA, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Hidden', lastName: 'Customer' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantB });
    await createOwnership({ vehicleId, customerId });
    // Only tenantB has the relation; tenantA does NOT.
    await createCustomerTenantRelation({ tenantId: tenantB, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/search?customer=${customerId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; currentOwnership: { customer: { redacted: boolean } } }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(vehicleId);
    expect(body.data[0]!.currentOwnership.customer.redacted).toBe(true);
  });
});

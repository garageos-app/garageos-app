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
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-202 customer list end-to-end. Verifies tenant-scoping (BR-151),
// alphabetical ordering, the active-ownership vehicleCount, the
// denormalized lastInterventionAt, name search, and cursor pagination.

describe('GET /v1/customers (integration)', () => {
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

  async function tokenFor(tenantId: string, cognitoSub: string): Promise<string> {
    await createUser({ tenantId, cognitoSub });
    return signTestToken({ pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic' });
  }

  it('returns only customers related to the calling tenant, ordered by name', async () => {
    const { tenantId } = await createTenantWithLocation('cl-scope');
    const { tenantId: otherTenant } = await createTenantWithLocation('cl-scope-other');
    const token = await tokenFor(tenantId, '11111111-1111-4111-8111-111111111111');

    const { customerId: rossi } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: bianchi } = await createCustomer({
      firstName: 'Anna',
      lastName: 'Bianchi',
    });
    const { customerId: hidden } = await createCustomer({ firstName: 'Zed', lastName: 'Hidden' });
    await createCustomerTenantRelation({ tenantId, customerId: rossi });
    await createCustomerTenantRelation({ tenantId, customerId: bianchi });
    await createCustomerTenantRelation({ tenantId: otherTenant, customerId: hidden });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string; lastName: string }> };
    // Alphabetical by lastName: Bianchi before Rossi; Hidden excluded.
    expect(body.data.map((c) => c.id)).toEqual([bianchi, rossi]);
  });

  it('counts only active ownerships in vehicleCount', async () => {
    const { tenantId } = await createTenantWithLocation('cl-count');
    const token = await tokenFor(tenantId, '22222222-2222-4222-8222-222222222222');

    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Conti' });
    await createCustomerTenantRelation({ tenantId, customerId });

    const { vehicleId: v1 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v2 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v3 } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId: v1, customerId });
    await createOwnership({ vehicleId: v2, customerId });
    // Terminated ownership must NOT be counted.
    await createOwnership({ vehicleId: v3, customerId, endedAt: new Date('2025-01-01') });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ id: string; vehicleCount: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.vehicleCount).toBe(2);
  });

  it('surfaces the denormalized lastInterventionAt from the CTR', async () => {
    const { tenantId } = await createTenantWithLocation('cl-last');
    const token = await tokenFor(tenantId, '33333333-3333-4333-8333-333333333333');

    const last = new Date('2026-05-01T10:00:00.000Z');
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Dati' });
    await createCustomerTenantRelation({ tenantId, customerId, lastInterventionAt: last });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ lastInterventionAt: string | null }> };
    expect(body.data[0]!.lastInterventionAt).toBe(last.toISOString());
  });

  it('filters by name via q', async () => {
    const { tenantId } = await createTenantWithLocation('cl-q');
    const token = await tokenFor(tenantId, '44444444-4444-4444-8444-444444444444');

    const { customerId: keep } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: drop } = await createCustomer({ firstName: 'Anna', lastName: 'Verdi' });
    await createCustomerTenantRelation({ tenantId, customerId: keep });
    await createCustomerTenantRelation({ tenantId, customerId: drop });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=ross',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([keep]);
  });

  it('paginates with cursor without gaps or duplicates', async () => {
    const { tenantId } = await createTenantWithLocation('cl-page');
    const token = await tokenFor(tenantId, '55555555-5555-4555-8555-555555555555');

    // Distinct last names so alphabetical order is deterministic.
    const names = ['Aldi', 'Bruno', 'Carli'];
    const ids: string[] = [];
    for (const lastName of names) {
      const { customerId } = await createCustomer({ firstName: 'Mario', lastName });
      await createCustomerTenantRelation({ tenantId, customerId });
      ids.push(customerId);
    }

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    const body1 = res1.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data.map((c) => c.id)).toEqual([ids[0], ids[1]]);
    expect(body1.meta.has_more).toBe(true);

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/customers?limit=2&cursor=${encodeURIComponent(body1.meta.cursor!)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as { data: Array<{ id: string }>; meta: { has_more: boolean } };
    expect(body2.data.map((c) => c.id)).toEqual([ids[2]]);
    expect(body2.meta.has_more).toBe(false);
  });
});

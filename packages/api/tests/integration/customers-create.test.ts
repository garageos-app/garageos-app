import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createTenantWithLocation,
  createUser,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-201 standalone create end-to-end. Verifies row + CTR persistence,
// email dedupe (reuse + link, created:false), cross-tenant link, and the
// business-name rule.

describe('POST /v1/customers (integration)', () => {
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

  function post(token: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: body as object,
    });
  }

  it('creates a customer and a CTR, returns 201 created:true', async () => {
    const { tenantId } = await createTenantWithLocation('cc-new');
    const token = await tokenFor(tenantId, '11111111-1111-4111-8111-111111111111');

    const res = await post(token, {
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'cc-new-mario@test.it',
      phone: '+39 333 1234567',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean; phone: string | null };
    expect(body.created).toBe(true);
    expect(body.phone).toBe('+39 333 1234567');

    // The new customer is visible via the tenant-scoped list (CTR exists).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=Rossi',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list.json() as { data: Array<{ id: string }> }).data.map((c) => c.id)).toContain(
      body.id,
    );
  });

  it('dedupes by email: a second create links the existing row, created:false', async () => {
    const { tenantId } = await createTenantWithLocation('cc-dupe');
    const token = await tokenFor(tenantId, '22222222-2222-4222-8222-222222222222');
    const { customerId, email } = await createCustomer({
      firstName: 'Anna',
      lastName: 'Verdi',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const res = await post(token, { firstName: 'Anna', lastName: 'Verdi', email });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.id).toBe(customerId);
  });

  it('links an email belonging to another tenant customer (cross-tenant reuse)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cc-x-a');
    const { tenantId: tenantB } = await createTenantWithLocation('cc-x-b');
    const tokenB = await tokenFor(tenantB, '33333333-3333-4333-8333-333333333333');
    const { customerId, email } = await createCustomer({ firstName: 'Luca', lastName: 'Neri' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    const res = await post(tokenB, { firstName: 'Luca', lastName: 'Neri', email });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.id).toBe(customerId);

    // tenantB now sees the customer in its list (CTR was created).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=Neri',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect((list.json() as { data: Array<{ id: string }> }).data.map((c) => c.id)).toContain(
      customerId,
    );
  });

  it('returns 422 for a business customer without businessName', async () => {
    const { tenantId } = await createTenantWithLocation('cc-biz');
    const token = await tokenFor(tenantId, '44444444-4444-4444-8444-444444444444');
    const res = await post(token, {
      firstName: 'Ditta',
      lastName: 'Owner',
      email: 'cc-biz@test.it',
      isBusiness: true,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('customer.create.business_name_required');
  });
});

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

// E2 customer search end-to-end. Verifies the tenant-scoping JOIN
// (BR-151), the ILIKE substring case-insensitive match across the
// three searchable fields, the customer_deleted + status filters, and
// cursor pagination. Cross-tenant non-leakage gets its own scenario
// because that is the load-bearing privacy guarantee.

describe('GET /v1/customers/search (integration)', () => {
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

  it('returns only customers related to the calling tenant', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cs-scope-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cs-scope-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tenantA, cognitoSub });

    const { customerId: aliceId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: bobId } = await createCustomer({ firstName: 'Mario', lastName: 'Bianchi' });
    const { customerId: carolId } = await createCustomer({ firstName: 'Mario', lastName: 'Verdi' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: aliceId });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: bobId });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId: carolId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id).sort();
    expect(ids).toEqual([aliceId, bobId].sort());
    expect(ids).not.toContain(carolId);
  });

  it('does not leak customers from other tenants (BR-151 cross-tenant)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cs-leak-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cs-leak-B');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId: tenantB, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Hidden' });
    // Only tenantA is related; tenantB is NOT.
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantB,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('matches case-insensitively on firstName, lastName, businessName', async () => {
    const { tenantId } = await createTenantWithLocation('cs-ilike');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });

    const { customerId: c1 } = await createCustomer({ firstName: 'MARINA', lastName: 'Esposito' });
    const { customerId: c2 } = await createCustomer({ firstName: 'Luca', lastName: 'MARINI' });
    const { customerId: c3 } = await createCustomer({
      firstName: 'B2B',
      lastName: 'Owner',
      isBusiness: true,
      businessName: 'MARTINI Auto Service',
    });
    const { customerId: c4 } = await createCustomer({ firstName: 'Anna', lastName: 'Bianchi' });
    await createCustomerTenantRelation({ tenantId, customerId: c1 });
    await createCustomerTenantRelation({ tenantId, customerId: c2 });
    await createCustomerTenantRelation({ tenantId, customerId: c3 });
    await createCustomerTenantRelation({ tenantId, customerId: c4 });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id).sort();
    expect(ids).toEqual([c1, c2, c3].sort());
    expect(ids).not.toContain(c4);
  });

  it('matches multi-word queries across first and last name, order-independent', async () => {
    const { tenantId } = await createTenantWithLocation('cs-multitoken');
    const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await createUser({ tenantId, cognitoSub });

    const { customerId: match } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Rossi',
    });
    const { customerId: partial } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Bianchi',
    });
    await createCustomerTenantRelation({ tenantId, customerId: match });
    await createCustomerTenantRelation({ tenantId, customerId: partial });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=${encodeURIComponent('Mario Rossi')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([match]);
    expect(body.data.map((c) => c.id)).not.toContain(partial);

    // Token order must not matter (AND across tokens).
    const reversed = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=${encodeURIComponent('Rossi Mario')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reversed.statusCode).toBe(200);
    const reversedBody = reversed.json() as { data: Array<{ id: string }> };
    expect(reversedBody.data.map((c) => c.id)).toEqual([match]);
  });

  it('returns full DTO shape including B2B fields', async () => {
    const { tenantId } = await createTenantWithLocation('cs-shape');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({
      firstName: 'Trattoria',
      lastName: 'DaLuigi',
      isBusiness: true,
      businessName: 'Trattoria Da Luigi S.r.l.',
      vatNumber: 'IT01234567890',
      phone: '+39 02 1234567',
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
      url: '/v1/customers/search?q=trattoria',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        phone: string | null;
        isBusiness: boolean;
        businessName: string | null;
        vatNumber: string | null;
        status: string;
      }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: customerId,
      firstName: 'Trattoria',
      lastName: 'DaLuigi',
      isBusiness: true,
      businessName: 'Trattoria Da Luigi S.r.l.',
      vatNumber: 'IT01234567890',
      phone: '+39 02 1234567',
      status: 'active',
    });
  });

  it('excludes customers with customer_deleted=true on the relation', async () => {
    const { tenantId } = await createTenantWithLocation('cs-deleted-rel');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });

    const { customerId: kept } = await createCustomer({ firstName: 'Mario', lastName: 'Kept' });
    const { customerId: dropped } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Dropped',
    });
    await createCustomerTenantRelation({ tenantId, customerId: kept });
    await createCustomerTenantRelation({ tenantId, customerId: dropped, customerDeleted: true });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([kept]);
    expect(body.data.map((c) => c.id)).not.toContain(dropped);
  });

  it('excludes customers with status != active', async () => {
    const { tenantId } = await createTenantWithLocation('cs-status');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub });

    const { customerId: active } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Active',
      status: 'active',
    });
    const { customerId: pending } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Pending',
      status: 'pending_verification',
    });
    const { customerId: deleted } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Deleted',
      status: 'deleted',
    });
    await createCustomerTenantRelation({ tenantId, customerId: active });
    await createCustomerTenantRelation({ tenantId, customerId: pending });
    await createCustomerTenantRelation({ tenantId, customerId: deleted });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([active]);
  });

  it('paginates with cursor and returns has_more=true when results exceed limit', async () => {
    const { tenantId } = await createTenantWithLocation('cs-pagination');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { customerId } = await createCustomer({
        firstName: 'Mario',
        lastName: `Pag${i}`,
        email: `pag-${i}-${Math.random().toString(36).slice(2, 8)}@test.it`,
      });
      await createCustomerTenantRelation({ tenantId, customerId });
      ids.push(customerId);
    }
    const expectedSorted = [...ids].sort();

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario&limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.has_more).toBe(true);
    expect(body1.meta.cursor).toBeTruthy();
    expect(body1.data.map((c) => c.id)).toEqual(expectedSorted.slice(0, 2));

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=Mario&limit=2&cursor=${encodeURIComponent(body1.meta.cursor!)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean };
    };
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0]!.id).toBe(expectedSorted[2]);
    expect(body2.meta.has_more).toBe(false);

    const allIds = [...body1.data.map((c) => c.id), ...body2.data.map((c) => c.id)].sort();
    expect(allIds).toEqual(expectedSorted);
  });

  it('returns empty data array when no row matches', async () => {
    const { tenantId } = await createTenantWithLocation('cs-empty');
    const cognitoSub = '88888888-8888-4888-8888-888888888888';
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=zzzzz',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('returns 400 when q is absent', async () => {
    const { tenantId } = await createTenantWithLocation('cs-400');
    const cognitoSub = '99999999-9999-4999-8999-999999999999';
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('matches by phone (exact stored value)', async () => {
    const { tenantId } = await createTenantWithLocation('cs-phone-exact');
    const cognitoSub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await createUser({ tenantId, cognitoSub });

    const { customerId: match } = await createCustomer({
      firstName: 'Anna',
      lastName: 'Neri',
      phone: '3331234567',
    });
    const { customerId: other } = await createCustomer({
      firstName: 'Luca',
      lastName: 'Gialli',
      phone: '3339999999',
    });
    await createCustomerTenantRelation({ tenantId, customerId: match });
    await createCustomerTenantRelation({ tenantId, customerId: other });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=3331234567',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([match]);
    expect(body.data.map((c) => c.id)).not.toContain(other);
  });

  it('matches a spaced phone query against a stored value with separators (substring-per-token)', async () => {
    const { tenantId } = await createTenantWithLocation('cs-phone-spaced');
    const cognitoSub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({
      firstName: 'Marco',
      lastName: 'Blu',
      phone: '+39 333 1234567',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    // Query "333 1234567" → tokens ["333","1234567"], both substrings of the
    // stored "+39 333 1234567" → AND match.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=${encodeURIComponent('333 1234567')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([customerId]);
  });

  it('does NOT match phone of a customer not related to the calling tenant (BR-151)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cs-phone-scope-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cs-phone-scope-B');
    const cognitoSub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await createUser({ tenantId: tenantB, cognitoSub });

    const { customerId } = await createCustomer({
      firstName: 'Hidden',
      lastName: 'Phone',
      phone: '3335550000',
    });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantB,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=3335550000',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('does NOT match on email / taxCode / vatNumber via q (PII surface regression)', async () => {
    const { tenantId } = await createTenantWithLocation('cs-no-pii-match');
    const cognitoSub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({
      firstName: 'Privacy',
      lastName: 'Guard',
      email: 'unique-pii-token@example.it',
      isBusiness: true,
      businessName: 'Guard Srl',
      vatNumber: 'IT99887766554',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    for (const needle of ['unique-pii-token', 'IT99887766554']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/customers/search?q=${encodeURIComponent(needle)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: unknown[] }).data).toEqual([]);
    }
  });
});

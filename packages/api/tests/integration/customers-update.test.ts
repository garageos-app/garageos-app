import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgAdmin } from './setup.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createTenantWithLocation,
  createUser,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

const TEST_IP = '10.20.31.42';

describe('PATCH /v1/customers/:id (integration)', () => {
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

  async function setup(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `cu-caller-${suffix}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });
    const { customerId } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 0000000',
    });
    await createCustomerTenantRelation({
      tenantId,
      customerId,
      tenantNotes: 'note iniziale',
    });
    return { tenantId, customerId, token };
  }

  function patch(token: string, id: string, body: object) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/customers/${id}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP,
      },
      payload: body,
    });
  }

  it('200: updates anagrafica fields, leaves tenantNotes untouched', async () => {
    const { customerId, token } = await setup('upd-anag');
    const res = await patch(token, customerId, {
      firstName: 'Marco',
      phone: '+39 333 9999999',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.firstName).toBe('Marco');
    expect(body.phone).toBe('+39 333 9999999');
    expect(body.tenantRelation.tenantNotes).toBe('note iniziale');
  });

  it('200: updates only tenantNotes, leaves anagrafica untouched', async () => {
    const { customerId, token } = await setup('upd-notes');
    const res = await patch(token, customerId, { tenantNotes: 'aggiornata' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.firstName).toBe('Mario');
    expect(body.tenantRelation.tenantNotes).toBe('aggiornata');
  });

  it('200: mixed update on customer + CTR in single response', async () => {
    const { customerId, token } = await setup('upd-mixed');
    const res = await patch(token, customerId, {
      firstName: 'Marco',
      addressLine: 'Via Verdi 9',
      tenantNotes: 'cliente trasferito',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.firstName).toBe('Marco');
    expect(body.addressLine).toBe('Via Verdi 9');
    expect(body.tenantRelation.tenantNotes).toBe('cliente trasferito');
  });

  it('200: toggles isBusiness with businessName and vatNumber', async () => {
    const { customerId, token } = await setup('upd-b2b');
    const res = await patch(token, customerId, {
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: '12345678901',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isBusiness).toBe(true);
    expect(body.businessName).toBe('Rossi SRL');
    expect(body.vatNumber).toBe('12345678901');
  });

  it('200: nullify a previously-set field', async () => {
    const { customerId, token } = await setup('upd-null');
    await patch(token, customerId, { phone: '+39 333 1112222' });
    const res = await patch(token, customerId, { phone: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBeNull();
  });

  it('422: empty body', async () => {
    const { customerId, token } = await setup('upd-empty');
    const res = await patch(token, customerId, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.update.empty_body');
  });

  it('422: rejects unknown field email', async () => {
    const { customerId, token } = await setup('upd-email');
    const res = await patch(token, customerId, { email: 'evil@example.com' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.update.unknown_field');
  });

  it('422: rejects unknown field cognitoSub', async () => {
    const { customerId, token } = await setup('upd-sub');
    const res = await patch(token, customerId, { cognitoSub: 'evil-sub' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.update.unknown_field');
  });

  it('400: firstName max length exceeded (Zod-level)', async () => {
    const { customerId, token } = await setup('upd-toolong');
    const res = await patch(token, customerId, { firstName: 'a'.repeat(101) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('404: caller has no CTR for this customer', async () => {
    const { token } = await setup('upd-noctr-self');
    const { tenantId: otherTenantId } = await createTenantWithLocation('upd-noctr-other');
    const { customerId: otherCustomerId } = await createCustomer({});
    await createCustomerTenantRelation({
      tenantId: otherTenantId,
      customerId: otherCustomerId,
    });
    const res = await patch(token, otherCustomerId, { firstName: 'Marco' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('customer.not_found');
  });

  it('404: customer with customerDeleted=true', async () => {
    const { tenantId, token } = await setup('upd-deletedctr');
    const { customerId: otherCustomerId } = await createCustomer({});
    await createCustomerTenantRelation({
      tenantId,
      customerId: otherCustomerId,
      customerDeleted: true,
    });
    const res = await patch(token, otherCustomerId, { firstName: 'Marco' });
    expect(res.statusCode).toBe(404);
  });

  it('idempotent: two sequential PATCHes both 200, second reflects first', async () => {
    const { customerId, token } = await setup('upd-idem');
    const r1 = await patch(token, customerId, { firstName: 'Marco' });
    expect(r1.statusCode).toBe(200);
    const r2 = await patch(token, customerId, { lastName: 'Bianchi' });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().firstName).toBe('Marco');
    expect(r2.json().lastName).toBe('Bianchi');
  });

  it('does not modify customer row when only tenantNotes changes', async () => {
    const { customerId, token } = await setup('upd-tnotes-only');
    const before = await pgAdmin.query<{ updated_at: Date }>(
      `SELECT updated_at FROM customers WHERE id = $1`,
      [customerId],
    );
    await patch(token, customerId, { tenantNotes: 'just notes' });
    const after = await pgAdmin.query<{ updated_at: Date }>(
      `SELECT updated_at FROM customers WHERE id = $1`,
      [customerId],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBe(before.rows[0]!.updated_at.getTime());
  });

  it('401: no auth header', async () => {
    const { customerId } = await setup('upd-noauth');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': TEST_IP },
      payload: { firstName: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403: clienti pool token forbidden', async () => {
    const { customerId } = await setup('upd-clienti');
    const cognitoSub = 'cust-sub-' + Math.random().toString(36).slice(2, 10);
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const res = await patch(token, customerId, { firstName: 'X' });
    expect(res.statusCode).toBe(403);
  });
});

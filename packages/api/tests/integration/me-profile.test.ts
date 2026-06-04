import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-004 PR1 — GET /v1/me + PATCH /v1/me/profile (customer self-profile).
const TEST_IP = '10.20.40.7';

describe('Customer self-profile (F-CLI-004)', () => {
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

  async function authCustomer() {
    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({
      cognitoSub: customerSub,
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+393331112233',
    });
    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });
    return { customerId, token };
  }

  it('GET /v1/me returns the caller own profile', async () => {
    const { customerId, token } = await authCustomer();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; firstName: string; lastName: string };
    expect(body.id).toBe(customerId);
    expect(body.firstName).toBe('Mario');
    expect(body.lastName).toBe('Rossi');
  });

  it('PATCH /v1/me/profile updates firstName + phone and GET reflects it', async () => {
    const { token } = await authCustomer();
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { firstName: 'Marco', phone: '+393339998877' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { firstName: string }).firstName).toBe('Marco');

    const getRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    const body = getRes.json() as { firstName: string; phone: string };
    expect(body.firstName).toBe('Marco');
    expect(body.phone).toBe('+393339998877');
  });

  it('PATCH /v1/me/profile rejects an empty body with 422', async () => {
    const { token } = await authCustomer();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('PATCH /v1/me/profile rejects email (immutable) with 422', async () => {
    const { token } = await authCustomer();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { email: 'hacker@example.com' },
    });
    expect(res.statusCode).toBe(422);
  });
});

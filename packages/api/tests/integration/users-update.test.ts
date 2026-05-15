import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('PATCH /v1/users/me (integration)', () => {
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

  async function setup(
    suffix: string,
    role: 'super_admin' | 'mechanic' = 'mechanic',
  ): Promise<{ tenantId: string; userId: string; cognitoSub: string; token: string }> {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `${suffix}-sub-${crypto.randomUUID()}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      email: `${suffix}@tenant.test`,
      firstName: 'Gianni',
      lastName: 'Bianchi',
      role,
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role,
    });
    return { tenantId, userId, cognitoSub, token };
  }

  function patch(token: string, body: object) {
    return app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: body,
    });
  }

  it('200: updates firstName + lastName', async () => {
    const { userId, token } = await setup('ok');
    const res = await patch(token, { firstName: 'Marco', lastName: 'Verdi' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(userId);
    expect(body.firstName).toBe('Marco');
    expect(body.lastName).toBe('Verdi');
  });

  it('200: nullable phone accepted', async () => {
    const { token } = await setup('phone-null');
    const res = await patch(token, { phone: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBeNull();
  });

  it('200: partial update preserves untouched fields', async () => {
    const { token } = await setup('partial');
    const res = await patch(token, { firstName: 'OnlyName' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.firstName).toBe('OnlyName');
    expect(body.lastName).toBe('Bianchi'); // untouched
  });

  it('422: empty body', async () => {
    const { token } = await setup('empty');
    const res = await patch(token, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('users.me.update.empty_body');
  });

  it('422: unknown field rejected', async () => {
    const { token } = await setup('unknown');
    const res = await patch(token, { email: 'attacker@evil.test', role: 'super_admin' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('users.me.update.unknown_field');
  });

  it('400: firstName too long', async () => {
    const { token } = await setup('toolong');
    const res = await patch(token, { firstName: 'x'.repeat(101) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('400: phone regex fail', async () => {
    const { token } = await setup('phone-bad');
    const res = await patch(token, { phone: 'not a phone' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('401: no JWT', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      payload: { firstName: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403: JWT from clienti pool', async () => {
    await createTenantWithLocation('wrong-pool');
    const clientiToken = await signTestToken({
      pool: 'clienti',
      sub: 'clienti-sub-1',
      customerId: crypto.randomUUID(),
    });
    const res = await patch(clientiToken, { firstName: 'X' });
    expect(res.statusCode).toBe(403);
  });

  it('404: cognitoSub valid but other tenantId (cross-tenant guard)', async () => {
    // Two tenants. Caller JWT carries tenantA but the user row with the
    // same cognitoSub lives under tenantB.
    const { tenantId: tenantA } = await createTenantWithLocation('cross-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cross-B');
    const cognitoSub = `cross-sub-${crypto.randomUUID()}`;
    await createUser({
      tenantId: tenantB,
      cognitoSub,
      email: 'mech@b.test',
      role: 'mechanic',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });
    const res = await patch(token, { firstName: 'X' });
    expect(res.statusCode).toBe(404);
  });
});

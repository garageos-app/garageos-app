import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('PATCH /v1/tenants/me (integration)', () => {
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
    role: 'super_admin' | 'mechanic' = 'super_admin',
  ): Promise<{ tenantId: string; token: string }> {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `${suffix}-sub-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub, role });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role,
    });
    return { tenantId, token };
  }

  function patch(token: string, body: object) {
    return app.inject({
      method: 'PATCH',
      url: '/v1/tenants/me',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: body,
    });
  }

  it('200: super_admin updates businessName + addressLine', async () => {
    const { tenantId, token } = await setup('sa-ok');
    const res = await patch(token, {
      businessName: 'Nuova Officina SRL',
      addressLine: 'Via Roma 1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(tenantId);
    expect(body.businessName).toBe('Nuova Officina SRL');
    expect(body.addressLine).toBe('Via Roma 1');
  });

  it('200: provincia lowercase saved as uppercase', async () => {
    const { token } = await setup('prov-lc');
    const res = await patch(token, { province: 'mi' });
    expect(res.statusCode).toBe(200);
    expect(res.json().province).toBe('MI');
  });

  it('200: partial update preserves untouched fields', async () => {
    const { token } = await setup('partial');
    const res = await patch(token, { phone: '+39 02 1234567' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phone).toBe('+39 02 1234567');
    // businessName remains the one set by createTenantWithLocation seed.
    expect(body.businessName).toBeTruthy();
  });

  it('200: nullable fields accept null (city, postalCode, addressLine)', async () => {
    const { token } = await setup('null-field');
    const res = await patch(token, {
      city: null,
      postalCode: null,
      addressLine: null,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.city).toBeNull();
    expect(body.postalCode).toBeNull();
    expect(body.addressLine).toBeNull();
  });

  it('400: email cannot be set to null (non-nullable in schema)', async () => {
    const { token } = await setup('email-null');
    const res = await patch(token, { email: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('403: mechanic role', async () => {
    const { token } = await setup('mech-blocked', 'mechanic');
    const res = await patch(token, { businessName: 'Hack Inc' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });

  it('422: empty body', async () => {
    const { token } = await setup('empty');
    const res = await patch(token, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.update.empty_body');
  });

  it('422: unknown field rejected (vatNumber/status/plan)', async () => {
    const { token } = await setup('unknown');
    const res = await patch(token, {
      businessName: 'Legit',
      vatNumber: '99999999999',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.update.unknown_field');
  });

  it('400: postalCode 4 digits', async () => {
    const { token } = await setup('cap-short');
    const res = await patch(token, { postalCode: '2010' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('400: email malformed', async () => {
    const { token } = await setup('email-bad');
    const res = await patch(token, { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('401: no JWT', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/tenants/me',
      payload: { businessName: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403: JWT from clienti pool', async () => {
    const clientiToken = await signTestToken({
      pool: 'clienti',
      sub: 'clienti-sub-2',
      customerId: crypto.randomUUID(),
    });
    const res = await patch(clientiToken, { businessName: 'X' });
    expect(res.statusCode).toBe(403);
  });
});

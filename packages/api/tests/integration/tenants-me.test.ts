import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// /v1/tenants/me exercises the same chain as /v1/users/me but targets
// the tenants table. The row lookup uses the tenantId from the JWT,
// not cognito_sub — so cross-tenant isolation here means: a token for
// Tenant A cannot see Tenant B's row (the JWT tenant_id is Tenant A).

describe('GET /v1/tenants/me (integration)', () => {
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

  it('returns the tenant row that matches the JWT tenant_id', async () => {
    const { tenantId } = await createTenantWithLocation('tenants-me-ok');
    const sub = `sa-ok-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: sub, role: 'super_admin' });

    const token = await signTestToken({
      pool: 'officine',
      sub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: tenantId,
      status: 'active',
    });
  });

  it('returns 401 when the JWT tenant_id points to a non-existent tenant', async () => {
    // Valid signature, plausible tenant_id UUID, no matching row in DB.
    // tenant-context middleware performs a users lookup (cognitoSub × tenantId)
    // before the handler runs — if no user row exists the middleware throws
    // 401 (not 404). Since the tenant does not exist no user can be seeded;
    // the expected status changed from 404 → 401 after the F-OFF-004
    // follow-up that added the reactive DB lookup in tenant-context.ts.
    const token = await signTestToken({
      pool: 'officine',
      tenantId: '99999999-9999-4999-8999-999999999999',
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('does not expose settings, logoUrl, or deletedAt', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('tenants-me-shape');
    const sub = `mech-shape-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: sub, role: 'mechanic', locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub,
      tenantId,
      role: 'mechanic',
      locationId,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me',
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('logoUrl');
    expect(body).not.toHaveProperty('deletedAt');
    expect(body).not.toHaveProperty('updatedAt');
    expect(body).not.toHaveProperty('taxCode');
  });

  it('401 when the Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tenants/me' });
    expect(res.statusCode).toBe(401);
  });

  it('403 when the token is from the clienti pool', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

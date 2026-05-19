import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('GET /v1/users — admin list', () => {
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

  it('returns 200 with users list (active + inactive) for super_admin', async () => {
    const { tenantId } = await createTenantWithLocation('users-list-ok');
    const adminSub = `sa-${crypto.randomUUID()}`;
    const mechSub = `mech-${crypto.randomUUID()}`;

    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin@list.test',
      role: 'super_admin',
    });
    await createUser({ tenantId, cognitoSub: mechSub, email: 'mech@list.test', role: 'mechanic' });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: { email: string; cognitoSub?: unknown }[] };
    expect(body.users).toHaveLength(2);
    expect(body.users.map((u) => u.email).sort()).toEqual(
      ['admin@list.test', 'mech@list.test'].sort(),
    );
    expect(body.users[0]).not.toHaveProperty('cognitoSub'); // never exposed
  });

  it('returns 403 for mechanic', async () => {
    const { tenantId } = await createTenantWithLocation('users-list-403');
    const mechSub = `mech-403-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: mechSub,
      email: 'mech403@list.test',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });

  it('does not leak cross-tenant users', async () => {
    const { tenantId: t1 } = await createTenantWithLocation('users-list-iso-A');
    const { tenantId: t2 } = await createTenantWithLocation('users-list-iso-B');
    const sa1Sub = `sa1-${crypto.randomUUID()}`;
    const sa2Sub = `sa2-${crypto.randomUUID()}`;

    await createUser({
      tenantId: t1,
      cognitoSub: sa1Sub,
      email: 'sa1@t1.test',
      role: 'super_admin',
    });
    await createUser({
      tenantId: t2,
      cognitoSub: sa2Sub,
      email: 'sa2@t2.test',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: sa1Sub,
      tenantId: t1,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: { email: string }[] };
    // sa1's tenant has only sa1 — t2's admin must not appear
    expect(body.users).toHaveLength(1);
    expect(body.users[0]!.email).toBe('sa1@t1.test');
  });
});

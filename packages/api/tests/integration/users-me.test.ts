import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Full chain: JWKS-verified JWT → tenantContext → withContext → RLS
// filtered query against a real Postgres container. The critical
// assertion is RLS cross-tenant isolation: a token for Tenant A cannot
// see User rows that belong to Tenant B, even if the DB row's
// cognito_sub happens to match the JWT sub.

describe('GET /v1/users/me (integration)', () => {
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

  it('returns the caller user for the matching tenant', async () => {
    const { tenantId } = await createTenantWithLocation('users-me-ok');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      email: 'mechanic@tenant-a.test',
      firstName: 'Gianni',
      lastName: 'Bianchi',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: userId,
      tenantId,
      email: 'mechanic@tenant-a.test',
      firstName: 'Gianni',
      lastName: 'Bianchi',
      role: 'mechanic',
      status: 'active',
    });
  });

  it('returns 404 when no user row matches the JWT cognito_sub', async () => {
    const { tenantId } = await createTenantWithLocation('users-me-noone');
    // No user inserted — findFirstOrThrow lands in P2025.

    const token = await signTestToken({
      pool: 'officine',
      sub: '22222222-2222-4222-8222-222222222222',
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/NOT_FOUND',
      status: 404,
    });
  });

  it('cross-tenant isolation: tenant A token cannot read tenant B user (RLS)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('users-me-isolation-A');
    const { tenantId: tenantB } = await createTenantWithLocation('users-me-isolation-B');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    // User belongs to Tenant B; the token carries Tenant A's tenantId
    // claim. Post-0004 `users_read` is permissive — the app-layer
    // (cognitoSub, tenantId) where-clause filters the row out so
    // findFirstOrThrow lands on P2025 → 404.
    await createUser({ tenantId: tenantB, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('does not expose cognito_sub, deletedAt, or updatedAt in the response', async () => {
    const { tenantId } = await createTenantWithLocation('users-me-shape');
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
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('cognitoSub');
    expect(body).not.toHaveProperty('cognito_sub');
    expect(body).not.toHaveProperty('deletedAt');
    expect(body).not.toHaveProperty('updatedAt');
    expect(body).not.toHaveProperty('lastLoginAt');
  });
});

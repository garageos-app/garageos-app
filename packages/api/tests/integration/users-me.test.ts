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

  it('returns the caller user with tenant + location names for the matching tenant', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('users-me-ok');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      locationId,
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
      // Brand-strip names (F-OFF-007 follow-up).
      tenant: { businessName: 'Test Tenant users-me-ok' },
      location: { name: 'Sede', city: 'Milano' },
    });
  });

  it('returns location: null when the user has no assigned sede', async () => {
    const { tenantId } = await createTenantWithLocation('users-me-nosede');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub }); // no locationId

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
    const body = res.json() as { location: unknown; tenant: { businessName: string } };
    expect(body.location).toBeNull();
    expect(body.tenant.businessName).toBe('Test Tenant users-me-nosede');
  });

  it('returns 401 auth.session.inactive when no user row matches the JWT cognito_sub (T7 middleware short-circuit)', async () => {
    const { tenantId } = await createTenantWithLocation('users-me-noone');
    // No user inserted — T7 tenantContext middleware cannot find the user row
    // and returns 401 before the handler is reached. A token whose user row is
    // missing/inactive/deleted (or whose tenant is suspended) is a terminal
    // denial: the same generic auth.session.inactive code as those cases
    // (BR-210), distinct from the UNAUTHORIZED returned for a bad/expired token.

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

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('auth.session.inactive');
  });

  it('cross-tenant isolation: tenant A token cannot read tenant B user (T7 middleware enforcement)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('users-me-isolation-A');
    const { tenantId: tenantB } = await createTenantWithLocation('users-me-isolation-B');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    // User belongs to Tenant B; the token carries Tenant A's tenantId claim.
    // T7 tenantContext middleware performs (cognitoSub, tenantId) lookup — the
    // row is not found under tenantA → 401 before the handler is reached.
    // Cross-tenant isolation is still enforced; the mechanism moved from
    // RLS-as-empty-result to middleware-as-401.
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

    expect(res.statusCode).toBe(401);
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

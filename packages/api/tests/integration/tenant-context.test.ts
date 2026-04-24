import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, resetDb } from './helpers.js';

// End-to-end verification that the tenant-context middleware +
// withContext + RLS chain filters rows correctly. Two tenants are
// seeded via pgAdmin (bypasses RLS); the HTTP call goes through the
// non-superuser app_test role, so the Postgres policies actually run.

describe('tenant-context + withContext RLS (integration)', () => {
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

  it('returns 401 RFC 7807 without X-Tenant-ID / X-User-ID headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/locations' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
      instance: '/test/locations',
    });
  });

  it("scopes locations to the caller's tenant (RLS active)", async () => {
    const { tenantId: tenantA, locationId: locationA } = await createTenantWithLocation('A');
    const { tenantId: tenantB, locationId: locationB } = await createTenantWithLocation('B');
    const userId = crypto.randomUUID();

    const resA = await app.inject({
      method: 'GET',
      url: '/test/locations',
      headers: { 'x-tenant-id': tenantA, 'x-user-id': userId },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json() as { locations: { id: string; tenantId: string }[] };
    expect(bodyA.locations).toHaveLength(1);
    expect(bodyA.locations[0]).toMatchObject({ id: locationA, tenantId: tenantA });

    const resB = await app.inject({
      method: 'GET',
      url: '/test/locations',
      headers: { 'x-tenant-id': tenantB, 'x-user-id': userId },
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json() as { locations: { id: string; tenantId: string }[] };
    expect(bodyB.locations).toHaveLength(1);
    expect(bodyB.locations[0]).toMatchObject({ id: locationB, tenantId: tenantB });
  });
});

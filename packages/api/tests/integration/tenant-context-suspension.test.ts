// Integration tests for BR-210: suspended tenant blocks officine login.
//
// Verifies that a valid officine JWT whose tenant has status='suspended'
// receives 401 on every tenant-scoped route, that the block is reversible,
// and that adjacent guards (user-status, admin pool isolation) are unchanged.
//
// Test matrix:
//   1. Active tenant         → 200 on GET /v1/users (baseline)
//   2. Suspended tenant      → 401 on same route (BR-210)
//   3. Re-activated tenant   → 200 again (reversible — BR-210)
//   4. Inactive user / active tenant → 401 (regression: user guard unchanged)
//   5. Suspended-tenant officine JWT on /v1/admin/* → 403 (pool isolation, not 401)

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

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

describe('tenant-context — suspended tenant blocks officine login (BR-210)', () => {
  const TEST_IP = '10.20.51.1';

  it('active tenant → 200 on a tenant-scoped route (baseline)', async () => {
    const { tenantId } = await createTenantWithLocation('susp-active');
    const sub = `sa-susp-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'susp-active@test.it',
      role: 'super_admin',
    });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it('suspended tenant → 401 on the same route (BR-210)', async () => {
    const { tenantId } = await createTenantWithLocation('susp-susp');
    const sub = `sa-susp2-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'susp-susp@test.it',
      role: 'super_admin',
    });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    // Operator suspends the tenant via direct DB update.
    await pgAdmin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    // Generic 401 — anti-enumeration: caller must not learn why (BR-210).
    expect(res.statusCode).toBe(401);
    // Same generic code as the inactive-user case below (BR-210): the code
    // must NOT distinguish "tenant suspended" from "user disabled".
    expect(res.json().code).toBe('auth.session.inactive');
  });

  it('re-activated tenant → 200 again (reversible — BR-210)', async () => {
    const { tenantId } = await createTenantWithLocation('susp-reactivate');
    const sub = `sa-react-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'susp-react@test.it',
      role: 'super_admin',
    });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    await pgAdmin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);

    const suspRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(suspRes.statusCode).toBe(401);

    // Operator re-activates the tenant.
    await pgAdmin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantId]);

    const activeRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(activeRes.statusCode).toBe(200);
  });

  it('inactive user with active tenant → still 401 (regression: user guard not weakened)', async () => {
    const { tenantId } = await createTenantWithLocation('susp-userinact');

    // A second super_admin so the target user can be inactivated without
    // triggering BR-203 (last active super_admin protection).
    const otherSub = `sa-other-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: otherSub,
      email: 'other-keep@test.it',
      role: 'super_admin',
    });

    const targetSub = `sa-target-${crypto.randomUUID()}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'userinact@test.it',
      role: 'super_admin',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: targetSub,
      tenantId,
      role: 'super_admin',
    });

    // Tenant is active; only the user is inactive.
    await pgAdmin.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [userId]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(401);
    // Same generic code as the suspended-tenant case above (BR-210).
    expect(res.json().code).toBe('auth.session.inactive');
  });

  it('suspended-tenant officine JWT on /v1/admin/* → 403 pool isolation (not 401)', async () => {
    // requirePlatformAdminsPool runs before tenantContext is ever invoked
    // for /v1/admin/* routes: pool isolation must hold regardless of tenant status.
    const { tenantId } = await createTenantWithLocation('susp-admin');
    const sub = `sa-admpool-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'susp-admin@test.it',
      role: 'super_admin',
    });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    await pgAdmin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    // 403 (pool mismatch), NOT 401 (tenant suspension) — tenant-context is
    // never reached for /v1/admin/* routes.
    expect(res.statusCode).toBe(403);
  });
});

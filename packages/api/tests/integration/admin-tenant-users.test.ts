// Integration tests for GET  /v1/admin/tenants/:id/users
//                  and PATCH /v1/admin/tenants/:id/users/:userId
//
// Auth chain: requireAuth → requirePlatformAdminsPool (platform-admin-only).
// Security: users_read RLS is USING(true); the app-layer tenantId filter is
// the ONLY cross-tenant scoping guard. The cross-tenant 404 test verifies this.
//
// Business rules tested:
//   BR-203 — last super_admin guard (role + status paths, cross-tenant)
//   BR-204 — mechanic location required (with primary-location defaulting)
//
// Cognito stubbed with aws-sdk-client-mock + _resetCognitoClientForTests()
// to avoid hitting AWS. Follows the same pattern as users-admin-update.test.ts.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import {
  AdminDisableUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  cognitoMock.reset();
  _resetCognitoClientForTests();
  // Default: Cognito commands succeed so the happy-path tests don't have to
  // stub them individually. Specific tests override as needed.
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});

// ─── 1. Pool isolation (GET) ──────────────────────────────────────────────────

describe('GET /v1/admin/tenants/:id/users — pool isolation', () => {
  const DUMMY_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

  it('returns 403 when an officine JWT is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${DUMMY_ID}/users`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when a clienti JWT is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${DUMMY_ID}/users`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 2. Pool isolation (PATCH) ────────────────────────────────────────────────

describe('PATCH /v1/admin/tenants/:id/users/:userId — pool isolation', () => {
  const DUMMY_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

  it('returns 403 when an officine JWT is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${DUMMY_ID}/users/${DUMMY_ID}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when a clienti JWT is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${DUMMY_ID}/users/${DUMMY_ID}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 3. Cross-tenant scoping guard (SECURITY CORE) ───────────────────────────
//
// users_read RLS is USING(true) — it does NOT scope by tenant.
// The app-layer { tenantId: id } filter in updateOfficineUser is the ONLY guard.
// A PATCH on /tenants/{A}/users/{userOfB} MUST return user.not_found 404.

describe('PATCH cross-tenant scoping — SECURITY CORE', () => {
  const TEST_IP = '10.30.40.10';

  it('returns user.not_found 404 when userId belongs to a different tenant', async () => {
    // Tenant A: has mechanic user targetted by the malicious request.
    const { tenantId: tenantAId, locationId: locAId } =
      await createTenantWithLocation('atu-xt-tenantA');
    const { userId: userOfAId } = await createUser({
      tenantId: tenantAId,
      cognitoSub: `sa-atu-xtA-${crypto.randomUUID()}`,
      email: 'user-xt-a@test.it',
      role: 'super_admin',
    });
    void locAId; // created for FK integrity; userId belongs to tenantA

    // Tenant B: the platform-admin issues a PATCH scoped to tenant B but
    // supplies userOfA's id — cross-tenant probe.
    const { tenantId: tenantBId } = await createTenantWithLocation('atu-xt-tenantB');
    await createUser({
      tenantId: tenantBId,
      cognitoSub: `sa-atu-xtB-${crypto.randomUUID()}`,
      email: 'admin-xt-b@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    // PATCH /tenants/{B}/users/{userOfA}: tenantId=B, userId=userOfA.
    // updateOfficineUser loads target WHERE { id: userOfA, tenantId: B } → null → 404.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantBId}/users/${userOfAId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── 4. GET happy path — lists only the path tenant's users ──────────────────

describe('GET /v1/admin/tenants/:id/users — scoping + happy path', () => {
  it('returns only the path tenant users (excludes other tenants)', async () => {
    // Tenant A: 2 users; Tenant B: 1 user. GET A must return exactly 2.
    const { tenantId: tenantAId, locationId: locAId } = await createTenantWithLocation('atu-get-A');
    await createUser({
      tenantId: tenantAId,
      cognitoSub: `sa-atu-get-A1-${crypto.randomUUID()}`,
      email: 'a1@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId: tenantAId,
      cognitoSub: `sa-atu-get-A2-${crypto.randomUUID()}`,
      email: 'a2@test.it',
      role: 'mechanic',
      locationId: locAId,
    });

    const { tenantId: tenantBId } = await createTenantWithLocation('atu-get-B');
    await createUser({
      tenantId: tenantBId,
      cognitoSub: `sa-atu-get-B1-${crypto.randomUUID()}`,
      email: 'b1@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}/users`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    type UserDto = { id: string; email: string };
    const body = res.json() as { users: UserDto[] };
    expect(body.users).toHaveLength(2);
    const emails = body.users.map((u) => u.email).sort();
    expect(emails).toEqual(['a1@test.it', 'a2@test.it']);
  });

  it('returns tenant.not_found 404 for an unknown tenant UUID', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/deadbeef-dead-4ead-beef-deadbeefcafe/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  it('returns tenant.not_found 404 for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/not-a-uuid/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });
});

// ─── 5. PATCH — unknown tenant + unknown userId ────────────────────────────────

describe('PATCH /v1/admin/tenants/:id/users/:userId — not-found paths', () => {
  const TEST_IP = '10.30.40.20';

  it('returns tenant.not_found 404 for an unknown tenant UUID', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/tenants/deadbeef-dead-4ead-beef-deadbeefcafe/users/deadbeef-dead-4ead-beef-deadbeefcafe',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  it('returns user.not_found 404 for an unknown userId (valid tenant)', async () => {
    const { tenantId } = await createTenantWithLocation('atu-patch-user-nf');
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/deadbeef-dead-4ead-beef-deadbeefcafe`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── 6. BR-203 cross-tenant — last super_admin guard ─────────────────────────

describe('PATCH — BR-203 last super_admin guard (cross-tenant)', () => {
  const TEST_IP = '10.30.40.30';

  it('returns 409 user.last_super_admin on {status:inactive} when only one admin exists', async () => {
    const { tenantId } = await createTenantWithLocation('atu-br203-inact');
    const { userId: adminId } = await createUser({
      tenantId,
      cognitoSub: `sa-atu-br203i-${crypto.randomUUID()}`,
      email: 'admin-br203i@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${adminId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.last_super_admin');
  });

  it('returns 409 user.last_super_admin on {role:mechanic} when only one admin exists', async () => {
    // BR-204 defaulting kicks in (primary location is injected), then BR-203 fires.
    const { tenantId } = await createTenantWithLocation('atu-br203-role');
    const { userId: adminId } = await createUser({
      tenantId,
      cognitoSub: `sa-atu-br203r-${crypto.randomUUID()}`,
      email: 'admin-br203r@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    // No locationId in body — defaulting injects primary. BR-203 then fires.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${adminId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ role: 'mechanic' }),
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.last_super_admin');
  });

  it('returns 200 on role demotion when a second active super_admin is present', async () => {
    const { tenantId } = await createTenantWithLocation('atu-br203-2admins');
    const { userId: adminAId } = await createUser({
      tenantId,
      cognitoSub: `sa-atu-2a-A-${crypto.randomUUID()}`,
      email: 'admin-2a-A@test.it',
      role: 'super_admin',
    });
    // Second super_admin keeps BR-203 satisfied when adminA is demoted.
    await createUser({
      tenantId,
      cognitoSub: `sa-atu-2a-B-${crypto.randomUUID()}`,
      email: 'admin-2a-B@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    // Demote adminA to mechanic; defaulting injects primary location.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${adminAId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ role: 'mechanic' }),
    });

    expect(res.statusCode).toBe(200);
    type UserDto = { role: string };
    expect((res.json() as { user: UserDto }).user.role).toBe('mechanic');
  });
});

// ─── 7. BR-204 cross-tenant — primary-location defaulting ────────────────────

describe('PATCH — BR-204 primary-location defaulting (cross-tenant)', () => {
  const TEST_IP = '10.30.40.40';

  it('injects primary location when demoting super_admin to mechanic with no locationId', async () => {
    // Two super_admins: adminA (target) + adminB (keeps BR-203 satisfied).
    const { tenantId, locationId: primaryLocationId } =
      await createTenantWithLocation('atu-br204-def');
    const { userId: adminAId } = await createUser({
      tenantId,
      cognitoSub: `sa-atu-br204a-${crypto.randomUUID()}`,
      email: 'admin-br204a@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId,
      cognitoSub: `sa-atu-br204b-${crypto.randomUUID()}`,
      email: 'admin-br204b@test.it',
      role: 'super_admin',
    });

    const adminSub = `plat-atu-br204-${crypto.randomUUID()}`;
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    // body has role=mechanic and no locationId — defaulting should inject primaryLocationId.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${adminAId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ role: 'mechanic' }),
    });

    expect(res.statusCode).toBe(200);
    type UserDto = { role: string; locationId: string | null };
    const body = res.json() as { user: UserDto };
    expect(body.user.role).toBe('mechanic');
    // locationId must equal the primary location resolved by the route handler.
    expect(body.user.locationId).toBe(primaryLocationId);
  });
});

// ─── 8. Disable + reactivate lifecycle ────────────────────────────────────────

describe('PATCH — disable then reactivate lifecycle (cross-tenant)', () => {
  const TEST_IP = '10.30.40.50';

  it('sets status=inactive then back to active, returning correct status each time', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('atu-lifecycle');
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-atu-lc-${crypto.randomUUID()}`,
      email: 'mech-atu-lc@test.it',
      role: 'mechanic',
      locationId,
    });
    // Need a super_admin so BR-203 is not triggered for the mechanic (not relevant
    // here, but having one avoids confusion).
    await createUser({
      tenantId,
      cognitoSub: `sa-atu-lc-${crypto.randomUUID()}`,
      email: 'admin-atu-lc@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({ pool: 'platform-admins' });

    // Disable.
    const disableRes = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${mechId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(disableRes.statusCode).toBe(200);
    type UserDto = { status: string };
    expect((disableRes.json() as { user: UserDto }).user.status).toBe('inactive');

    // Reactivate.
    const reactivateRes = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${mechId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'active' }),
    });
    expect(reactivateRes.statusCode).toBe(200);
    expect((reactivateRes.json() as { user: UserDto }).user.status).toBe('active');
  });
});

// ─── 9. Audit rows — actorType:'system' + actorCognitoSub ────────────────────

describe('PATCH — audit rows with actorType:system and actorCognitoSub', () => {
  const TEST_IP = '10.30.40.60';

  it('writes audit row with actorType=system and metadata.actorCognitoSub from JWT', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('atu-audit');
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-atu-audit-${crypto.randomUUID()}`,
      email: 'mech-atu-audit@test.it',
      role: 'mechanic',
      locationId,
    });
    await createUser({
      tenantId,
      cognitoSub: `sa-atu-audit-${crypto.randomUUID()}`,
      email: 'admin-atu-audit@test.it',
      role: 'super_admin',
    });

    const adminSub = `plat-atu-audit-${crypto.randomUUID()}`;
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/users/${mechId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.statusCode).toBe(200);

    // Verify audit row.
    const { rows } = await pgAdmin.query<{
      actor_type: string;
      actor_id: string | null;
      action: string;
      entity_id: string;
      tenant_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, action, entity_id, tenant_id, metadata
         FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_status_changed'`,
      [mechId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Platform admins have no tenant User row: actorType=system, actorId=null.
    expect(row.actor_type).toBe('system');
    expect(row.actor_id).toBeNull();
    // tenantId in audit log must match the path tenant (not bleed cross-tenant).
    expect(row.tenant_id).toBe(tenantId);
    // metadata must carry actorCognitoSub for traceability.
    expect(row.metadata.actorCognitoSub).toBe(adminSub);
  });
});

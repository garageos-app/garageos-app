// Integration tests for DELETE /v1/users/:id — F-OFF-004 admin soft-delete.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// BR-203: last super_admin guard (cannot delete last active super_admin)
//
// Helper pattern mirrors users-admin-update.test.ts (T11):
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / pgAdmin / resetDb.
//
// 5 cases:
//   1. Happy path: DELETE non-last super_admin → 204, status=inactive, deletedAt set, audit row.
//   2. BR-203: DELETE last super_admin → 409 user.last_super_admin.
//   3. Self-delete: DELETE own user via admin endpoint → 422 user.cannot_delete_self_via_admin.
//   4. 404 not found: DELETE non-existent UUID → 404 user.not_found.
//   5. 404 cross-tenant: DELETE another tenant's user → 404.

import {
  AdminDisableUserCommand,
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
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});

// ─── Happy path: non-last super_admin deleted ────────────────────────────────

describe('DELETE /v1/users/:id — happy path soft-delete', () => {
  const TEST_IP = '10.20.31.10';

  it('returns 204, sets status=inactive + deletedAt, emits user_soft_deleted audit row with actorId', async () => {
    const { tenantId } = await createTenantWithLocation('del-ok');

    // Actor (will issue the DELETE).
    const adminSub = `sa-del-ok-${crypto.randomUUID()}`;
    const { userId: adminId } = await createUser({
      tenantId,
      cognitoSub: adminSub,
      role: 'super_admin',
    });

    // Second super_admin — the one to be deleted.
    const targetSub = `sa-target-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-del@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // DB: target is now soft-deleted.
    const { rows } = await pgAdmin.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0]?.status).toBe('inactive');
    expect(rows[0]?.deleted_at).not.toBeNull();

    // Audit row created with actor_id = actor's DB UUID (NOT cognitoSub).
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      entity_id: string;
      actor_id: string;
    }>(
      `SELECT action, entity_id, actor_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_soft_deleted'`,
      [targetId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actor_id).toBe(adminId);
  });
});

// ─── BR-203: deleting last active super_admin ────────────────────────────────
//
// NOTE: The serial BR-203 "last super_admin" path is no longer reachable via
// legitimate non-concurrent requests after the T7 reactive middleware was
// introduced (F-OFF-004 follow-ups Item 1). An actor whose DB row is
// soft-deleted is blocked at tenantContext middleware (401) before reaching
// the BR-203 check in the route handler.
//
// The concurrent-race scenario (two simultaneous DELETE requests) is covered
// separately in: tests/integration/users-admin-br-203-race.test.ts
//
// This test is repurposed to verify the T7 middleware behavior itself:
// a soft-deleted actor's JWT is rejected at middleware regardless of intent.

describe('DELETE /v1/users/:id — BR-203 last super_admin guard', () => {
  const TEST_IP = '10.20.31.11';

  it('returns 401 when actor has been soft-deleted (T7 middleware closes JWT-vs-DB discrepancy)', async () => {
    const { tenantId } = await createTenantWithLocation('del-br203');

    // Actor: a second super_admin who will issue the DELETE.
    const actorSub = `sa-actor-br203-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: actorSub,
      email: 'actor-br203@test.it',
      role: 'super_admin',
    });

    // Target: the ONLY remaining active super_admin after we imagine actor is inactive.
    // To avoid self-delete guard we need actor ≠ target. Here actor is a separate user
    // but target is also super_admin. We seed exactly 2 super_admins then soft-delete
    // the actor directly in DB so only target remains as the last active super_admin.
    const targetSub = `sa-target-br203-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-br203@test.it',
      role: 'super_admin',
    });

    // Soft-delete actor in DB so targetId is the last active super_admin.
    await pgAdmin.query(
      `UPDATE users SET status = 'inactive'::"UserStatus", deleted_at = NOW()
        WHERE cognito_sub = $1`,
      [actorSub],
    );

    // Token still carries super_admin in JWT — requireSuperAdmin checks JWT role.
    const token = await signTestToken({
      pool: 'officine',
      sub: actorSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    // T7 middleware: actor row is inactive+deletedAt → 401 before BR-203 fires.
    expect(res.statusCode).toBe(401);
  });
});

// ─── Self-delete via admin endpoint ──────────────────────────────────────────

describe('DELETE /v1/users/:id — cannot delete self via admin endpoint', () => {
  const TEST_IP = '10.20.31.12';

  it('returns 422 user.cannot_delete_self_via_admin when actor targets their own user id', async () => {
    const { tenantId } = await createTenantWithLocation('del-self');

    const adminSub = `sa-self-${crypto.randomUUID()}`;
    const { userId: adminId } = await createUser({
      tenantId,
      cognitoSub: adminSub,
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${adminId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('user.cannot_delete_self_via_admin');
  });
});

// ─── 404: non-existent UUID ───────────────────────────────────────────────────

describe('DELETE /v1/users/:id — 404 not found', () => {
  const TEST_IP = '10.20.31.13';

  it('returns 404 user.not_found for a valid but non-existent UUID', async () => {
    const { tenantId } = await createTenantWithLocation('del-404');

    const adminSub = `sa-404-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const nonExistentId = crypto.randomUUID();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${nonExistentId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── 404: cross-tenant ───────────────────────────────────────────────────────

describe('DELETE /v1/users/:id — 404 cross-tenant', () => {
  const TEST_IP = '10.20.31.14';

  it('returns 404 user.not_found when target belongs to a different tenant', async () => {
    const { tenantId: t1Id } = await createTenantWithLocation('del-xt-t1');
    const { tenantId: t2Id } = await createTenantWithLocation('del-xt-t2');

    // Actor belongs to tenant 2.
    const actorSub = `sa-xt-del-${crypto.randomUUID()}`;
    await createUser({ tenantId: t2Id, cognitoSub: actorSub, role: 'super_admin' });

    // Target belongs to tenant 1.
    const targetSub = `mech-xt-del-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId: t1Id,
      cognitoSub: targetSub,
      email: 'mech-xt-del@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: actorSub,
      tenantId: t2Id,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── Item 1 proactive: Cognito GlobalSignOut on soft-delete ──────────────────

describe('DELETE /v1/users/:id — Cognito GlobalSignOut proactive lockout', () => {
  const TEST_IP = '10.20.31.50';

  it('calls AdminUserGlobalSignOutCommand on the target after soft-delete', async () => {
    const { tenantId } = await createTenantWithLocation('del-cog');

    const adminSub = `sa-cog-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-cog@test.it',
      role: 'super_admin',
    });

    const targetSub = `sa-target-cog-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-cog@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(204);

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Username).toBe('target-cog@test.it');

    const disableCalls = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]!.args[0].input.Username).toBe('target-cog@test.it');
  });

  it('still returns 204 even if Cognito GlobalSignOut throws (best-effort)', async () => {
    // Override the default-success mock for this single test.
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error('Cognito down'));

    const { tenantId } = await createTenantWithLocation('del-cog-fail');

    const adminSub = `sa-cog-fail-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-cog-fail@test.it',
      role: 'super_admin',
    });

    const targetSub = `sa-target-cog-fail-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-cog-fail@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    // Soft-delete in DB succeeded; Cognito signout failed best-effort.
    expect(res.statusCode).toBe(204);
  });

  it('still returns 204 even if AdminDisableUserCommand throws (best-effort)', async () => {
    // Override the default-success mock for this single test. GlobalSignOut
    // succeeds; only Disable throws — verifies the two try/catch blocks are
    // independent (one failure does not skip the other).
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error('Cognito down'));

    const { tenantId, locationId } = await createTenantWithLocation('del-disable-fail');

    const adminSub = `sa-del-disable-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-del-disable@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-del-disable-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-del-disable@test.it',
      role: 'mechanic',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.33.10',
    });

    expect(res.statusCode).toBe(204);

    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });
});

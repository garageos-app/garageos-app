// Integration tests for PATCH /v1/users/:id — F-OFF-004 admin update.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// BR-203: last super_admin guard (role change + status inactive)
//
// Helper pattern mirrors users-invitations-list-revoke.test.ts (T7):
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / pgAdmin / resetDb.
// Cognito stubbed with aws-sdk-client-mock + _resetCognitoClientForTests().
//
// 5 cases:
//   1. Role change mechanic → super_admin: 200, Cognito sync called, audit log.
//   2. BR-203: demoting last super_admin → 409 user.last_super_admin.
//   3. BR-203: status=inactive on last super_admin → 409 user.last_super_admin.
//   4. 403 for non-admin (mechanic) caller.
//   5. 404 for cross-tenant target.

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
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});

// ─── Role change mechanic → super_admin ──────────────────────────────────────

describe('PATCH /v1/users/:id — role change mechanic → super_admin', () => {
  const TEST_IP = '10.20.30.10';

  it('returns 200, syncs Cognito with custom:role, emits user_role_changed audit log', async () => {
    const { tenantId } = await createTenantWithLocation('ua-role-ok');
    const adminSub = `sa-ua-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-ua-${crypto.randomUUID()}`,
      email: 'mech-ua@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${mechId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { role: 'super_admin' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user.role).toBe('super_admin');

    // Cognito sync called exactly once with custom:role attribute.
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls.length).toBe(1);
    const attrs = cognitoCalls[0]?.args[0]?.input.UserAttributes ?? [];
    expect(attrs).toEqual(expect.arrayContaining([{ Name: 'custom:role', Value: 'super_admin' }]));

    // Audit log row created with action user_role_changed.
    const { rows: auditRows } = await pgAdmin.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_role_changed'`,
      [mechId],
    );
    expect(auditRows).toHaveLength(1);
  });
});

// ─── BR-203: demoting last super_admin ───────────────────────────────────────

describe('PATCH /v1/users/:id — BR-203 last super_admin guard (role demotion)', () => {
  const TEST_IP = '10.20.30.11';

  it('returns 409 user.last_super_admin when only super_admin tries to demote themselves', async () => {
    const { tenantId } = await createTenantWithLocation('ua-br203-role');
    const adminSub = `sa-br203-${crypto.randomUUID()}`;
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
      method: 'PATCH',
      url: `/v1/users/${adminId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { role: 'mechanic' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.last_super_admin');
  });
});

// ─── BR-203: status=inactive on last super_admin ──────────────────────────────

describe('PATCH /v1/users/:id — BR-203 last super_admin guard (status inactive)', () => {
  const TEST_IP = '10.20.30.13';

  it('returns 409 when setting status=inactive on last super_admin', async () => {
    const { tenantId } = await createTenantWithLocation('ua-br203-status');

    const adminSub = `sa-br203s-${crypto.randomUUID()}`;
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
      method: 'PATCH',
      url: `/v1/users/${adminId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.last_super_admin');
  });
});

// ─── 403 for non-admin (mechanic) caller ──────────────────────────────────────

describe('PATCH /v1/users/:id — 403 for mechanic caller', () => {
  const TEST_IP = '10.20.30.14';

  it('returns 403 when caller is mechanic (not super_admin)', async () => {
    const { tenantId } = await createTenantWithLocation('ua-403');
    const mechSub = `mech-403-${crypto.randomUUID()}`;
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: mechSub,
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${mechId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { role: 'super_admin' },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ─── 404 for cross-tenant target ──────────────────────────────────────────────

describe('PATCH /v1/users/:id — 404 cross-tenant', () => {
  const TEST_IP = '10.20.30.15';

  it('returns 404 when target belongs to a different tenant', async () => {
    const { tenantId: t1Id } = await createTenantWithLocation('ua-xt-t1');
    const { tenantId: t2Id } = await createTenantWithLocation('ua-xt-t2');
    const sa2Sub = `sa-xt-${crypto.randomUUID()}`;
    await createUser({ tenantId: t2Id, cognitoSub: sa2Sub, role: 'super_admin' });
    const { userId: otherMechId } = await createUser({
      tenantId: t1Id,
      cognitoSub: `mech-xt-${crypto.randomUUID()}`,
      email: 'mech-xt@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: sa2Sub,
      tenantId: t2Id,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${otherMechId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { role: 'super_admin' },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Cognito GlobalSignOut on status active → inactive ───────────────────────

describe('PATCH /v1/users/:id — Cognito GlobalSignOut on status active → inactive', () => {
  const TEST_IP = '10.20.32.50';

  it('calls AdminUserGlobalSignOutCommand when status transitions active → inactive', async () => {
    const { tenantId } = await createTenantWithLocation('upd-cog-inact');

    const adminSub = `sa-upd-cog-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-cog@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-cog-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-cog@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { status: 'inactive' },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(200);

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Username).toBe('mech-upd-cog@test.it');

    const disableCalls = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]!.args[0].input.Username).toBe('mech-upd-cog@test.it');
  });

  it('does NOT call AdminUserGlobalSignOutCommand on role-only PATCH (status unchanged active)', async () => {
    const { tenantId } = await createTenantWithLocation('upd-cog-rolesonly');

    const adminSub = `sa-upd-roles-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-roles@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-roles-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-roles@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { role: 'super_admin' },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(200);

    // Existing updateOfficineUserRoleAndLocation call uses
    // AdminUpdateUserAttributesCommand — assert specifically that
    // signout was NOT called for role-only change.
    const signoutCalls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(signoutCalls).toHaveLength(0);

    const disableCallsRoleOnly = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCallsRoleOnly).toHaveLength(0);
  });

  it('still returns 200 even if Cognito GlobalSignOut throws (best-effort)', async () => {
    // Override the default-success mock for this single test.
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error('Cognito down'));

    const { tenantId } = await createTenantWithLocation('upd-cog-inact-fail');

    const adminSub = `sa-upd-fail-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-fail@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-fail-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-fail@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { status: 'inactive' },
      remoteAddress: TEST_IP,
    });

    // PATCH in DB succeeded; Cognito signout failed best-effort.
    expect(res.statusCode).toBe(200);

    // Independence: disable still fires even when signOut threw.
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });

  it('still returns 200 even if AdminDisableUserCommand throws (best-effort)', async () => {
    // Override the default-success mock for this single test. GlobalSignOut
    // succeeds; only Disable throws — verifies the two try/catch blocks are
    // independent (one failure does not skip the other).
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error('Cognito down'));

    const { tenantId } = await createTenantWithLocation('upd-disable-fail');

    const adminSub = `sa-upd-disable-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-disable@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-disable-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-disable@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { status: 'inactive' },
      remoteAddress: '10.20.33.11',
    });

    expect(res.statusCode).toBe(200);

    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });
});

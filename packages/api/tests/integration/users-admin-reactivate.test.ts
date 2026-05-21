// Integration tests for POST /v1/users/:id/reactivate — F-OFF-004 reactivation
// (slice 2026-05-21). Mirror simmetrico del DELETE /v1/users/:id.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// Business rules enforced:
//   BR-204 — mechanic role requires locationId
//   BR-211 — riattivazione utente
//
// Helper pattern mirrors users-admin-delete.test.ts / users-admin-update.test.ts:
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / pgAdmin / resetDb.
// Cognito stubbed with aws-sdk-client-mock + _resetCognitoClientForTests().
//
// 10 cases:
//   1. Happy path body vuoto: 200, status=active, deletedAt=null, AdminEnableUser called.
//   2. Audit row asserts: action=user_reactivated, actor_id, metadata fields (incl. previousStatus + previousDeletedAt).
//   3. Override role + locationId=null: 200, Cognito attrs sync, audit metadata overrides.
//   4. locationId stale: 422 user.location_invalid; retry with fresh L2 → 200.
//   5. BR-204 override mechanic + null location: 422 user.location_required_for_mechanic.
//   6. Active user: 404 user.not_found (deletedAt=null defended by where-clause).
//   7. Cross-tenant target: 404 user.not_found.
//   8. Mechanic caller: 403 (requireSuperAdmin guard).
//   9. Cognito AdminEnableUser fails: 200 + x-cognito-sync-failed header, DB committed.
//  10. Cognito AdminUpdateUserAttributes fails (override): 200 + header, DB committed with override.

import {
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
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
  cognitoMock.on(AdminEnableUserCommand).resolves({});
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
});

// Helper: soft-delete a user row directly via pgAdmin (bypasses RLS).
// Mirrors users-admin-delete.test.ts inline soft-delete used to seed
// the "actor already inactive" scenario.
async function softDeleteUser(userId: string): Promise<void> {
  await pgAdmin.query(
    `UPDATE users SET status = 'inactive'::"UserStatus", deleted_at = NOW()
      WHERE id = $1`,
    [userId],
  );
}

// ─── Happy path body vuoto ───────────────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — happy path body vuoto', () => {
  const TEST_IP = '10.21.30.10';

  it('returns 200, sets status=active + deletedAt=null, calls AdminEnableUser once', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-ok');

    const adminSub = `sa-reac-ok-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    const targetSub = `mech-reac-ok-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-ok@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user.status).toBe('active');
    expect(body.user.deletedAt).toBeNull();

    // DB: target is now reactivated.
    const { rows } = await pgAdmin.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.deleted_at).toBeNull();

    // Cognito AdminEnableUser called exactly once with the target's email.
    const enableCalls = cognitoMock.commandCalls(AdminEnableUserCommand);
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0]!.args[0].input.Username).toBe('mech-reac-ok@test.it');

    // No attribute sync when body is empty (no overrides).
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);

    // No Cognito sync failure on happy path.
    expect(res.headers['x-cognito-sync-failed']).toBeUndefined();
  });
});

// ─── Audit row asserts ───────────────────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — audit row', () => {
  const TEST_IP = '10.21.30.11';

  it('emits user_reactivated audit row with actor_id + metadata (no overrides)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-audit');

    const adminSub = `sa-reac-audit-${crypto.randomUUID()}`;
    const { userId: adminId } = await createUser({
      tenantId,
      cognitoSub: adminSub,
      role: 'super_admin',
    });

    const targetSub = `mech-reac-audit-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-audit@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      entity_id: string;
      actor_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, entity_id, actor_id, metadata FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_reactivated'`,
      [targetId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actor_id).toBe(adminId);
    const meta = auditRows[0]!.metadata;
    expect(meta.targetEmail).toBe('mech-reac-audit@test.it');
    expect(meta.roleOverridden).toBe(false);
    expect(meta.locationOverridden).toBe(false);
    expect(meta.previousStatus).toBe('inactive');
    expect(typeof meta.previousDeletedAt).toBe('string');
    // The ISO-8601 format check (light): contains 'T' and 'Z'.
    expect(meta.previousDeletedAt).toMatch(/T.*Z$/);
  });
});

// ─── Override role + locationId=null ─────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — override role + locationId', () => {
  const TEST_IP = '10.21.30.12';

  it('overrides role to super_admin + locationId=null; syncs Cognito attrs and audit metadata', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-override');

    const adminSub = `sa-reac-ov-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    const targetSub = `mech-reac-ov-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-ov@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: { role: 'super_admin', locationId: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user.role).toBe('super_admin');
    expect(body.user.locationId).toBeNull();

    // Cognito sync: AdminEnableUser + AdminUpdateUserAttributes both called.
    expect(cognitoMock.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
    const attrCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(attrCalls).toHaveLength(1);
    const attrs = attrCalls[0]?.args[0]?.input.UserAttributes ?? [];
    expect(attrs).toEqual(expect.arrayContaining([{ Name: 'custom:role', Value: 'super_admin' }]));
    expect(attrs).toEqual(expect.arrayContaining([{ Name: 'custom:location_id', Value: '' }]));

    // Audit metadata reflects both overrides.
    const { rows: auditRows } = await pgAdmin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_reactivated'`,
      [targetId],
    );
    expect(auditRows).toHaveLength(1);
    const meta = auditRows[0]!.metadata;
    expect(meta.roleOverridden).toBe(true);
    expect(meta.locationOverridden).toBe(true);
    expect(meta.newRole).toBe('super_admin');
    expect(meta.newLocationId).toBeNull();
  });
});

// ─── locationId stale → 422; retry with fresh L2 → 200 ───────────────────────

describe('POST /v1/users/:id/reactivate — locationId stale', () => {
  const TEST_IP = '10.21.30.13';

  it('returns 422 user.location_invalid when assigned location is soft-deleted; retry with fresh L2 → 200', async () => {
    const { tenantId, locationId: l1Id } = await createTenantWithLocation('reac-stale');

    const adminSub = `sa-reac-stale-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    const targetSub = `mech-reac-stale-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-stale@test.it',
      role: 'mechanic',
      locationId: l1Id,
    });
    await softDeleteUser(targetId);

    // Soft-delete the assigned location L1 — now the mechanic's preserved
    // locationId points to an inactive row, so empty-body reactivate must 422.
    await pgAdmin.query(
      `UPDATE locations SET status = 'inactive'::"LocationStatus", deleted_at = NOW()
        WHERE id = $1`,
      [l1Id],
    );

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });
    expect(res1.statusCode).toBe(422);
    expect((res1.json() as { code: string }).code).toBe('user.location_invalid');

    // Now create a fresh L2 in the same tenant and retry with explicit override.
    const { rows: l2Rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code,
          country, is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede Fresh', 'Via Nuova 2', 'Roma', 'RM',
          '00100', 'IT', false, 'active'::"LocationStatus", NOW(), NOW())
       RETURNING id`,
      [tenantId],
    );
    const l2Id = l2Rows[0]!.id;

    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: { locationId: l2Id },
    });
    expect(res2.statusCode).toBe(200);
    const body = res2.json() as { user: Record<string, unknown> };
    expect(body.user.locationId).toBe(l2Id);
  });
});

// ─── BR-204 override mechanic + null location ────────────────────────────────

describe('POST /v1/users/:id/reactivate — BR-204 mechanic location required (override)', () => {
  const TEST_IP = '10.21.30.14';

  it('returns 422 user.location_required_for_mechanic when override sets role=mechanic + locationId=null', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-br204');

    const adminSub = `sa-reac-br204-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    // Seed a super_admin target so the previous role isn't already mechanic;
    // we want the violation to arise from the explicit override only.
    const targetSub = `sa-reac-br204-tgt-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'tgt-reac-br204@test.it',
      role: 'super_admin',
      locationId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: { role: 'mechanic', locationId: null },
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('user.location_required_for_mechanic');
  });
});

// ─── Active user → 404 ───────────────────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — active user', () => {
  const TEST_IP = '10.21.30.15';

  it('returns 404 user.not_found when target user is already active (deletedAt=null)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-active');

    const adminSub = `sa-reac-active-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    // Active mechanic — deletedAt remains null per createUser default.
    const targetSub = `mech-reac-active-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-active@test.it',
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
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── Cross-tenant target → 404 ───────────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — 404 cross-tenant', () => {
  const TEST_IP = '10.21.30.16';

  it('returns 404 user.not_found when target belongs to a different tenant', async () => {
    const { tenantId: t1Id, locationId: t1LocId } = await createTenantWithLocation('reac-xt-t1');
    const { tenantId: t2Id } = await createTenantWithLocation('reac-xt-t2');

    // Actor (super_admin) belongs to tenant 2.
    const actorSub = `sa-reac-xt-${crypto.randomUUID()}`;
    await createUser({ tenantId: t2Id, cognitoSub: actorSub, role: 'super_admin' });

    // Target belongs to tenant 1 — soft-deleted to be a legitimate reactivate target.
    const targetSub = `mech-reac-xt-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId: t1Id,
      cognitoSub: targetSub,
      email: 'mech-reac-xt@test.it',
      role: 'mechanic',
      locationId: t1LocId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: actorSub,
      tenantId: t2Id,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.not_found');
  });
});

// ─── Mechanic caller → 403 ───────────────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — 403 for mechanic caller', () => {
  const TEST_IP = '10.21.30.17';

  it('returns 403 when caller is mechanic (requireSuperAdmin blocks)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('reac-403');

    // Super-admin (just to keep tenant invariants) — not used to issue the call.
    await createUser({
      tenantId,
      cognitoSub: `sa-reac-403-${crypto.randomUUID()}`,
      email: 'sa-reac-403@test.it',
      role: 'super_admin',
    });

    // Mechanic caller — same tenant.
    const mechSub = `mech-reac-403-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: mechSub,
      email: 'mech-reac-403@test.it',
      role: 'mechanic',
      locationId,
    });

    // Soft-deleted target (a second mechanic in the same tenant).
    const targetSub = `mech-reac-403-tgt-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-reac-403-tgt@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(targetId);

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${targetId}/reactivate`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      remoteAddress: TEST_IP,
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });
});

// ─── Cognito AdminEnableUser failure ─────────────────────────────────────────

describe('POST /v1/users/:id/reactivate — Cognito AdminEnableUser failure', () => {
  const TEST_IP = '10.21.30.18';

  it('returns 200 with x-cognito-sync-failed header when AdminEnableUser throws', async () => {
    // Setup same as happy path
    const { tenantId, locationId } = await createTenantWithLocation('cogfail-enable');
    const adminSub = `sa-cogfail-enable-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-cogfail-enable-${crypto.randomUUID()}`,
      email: 'mech-cogfail-enable@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(mechId);

    // Override Cognito mock to make enable throw (use ServiceException, NOT UserNotFoundException
    // — the helper swallows UserNotFoundException internally per cognito.ts:376, which would
    // NOT trip the route-level catch).
    cognitoMock.on(AdminEnableUserCommand).rejects(new Error('cognito service unavailable'));

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mechId}/reactivate`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cognito-sync-failed']).toBe('true');

    // DB still committed (source of truth).
    const { rows: userRows } = await pgAdmin.query<{ status: string; deleted_at: Date | null }>(
      'SELECT status, deleted_at FROM users WHERE id = $1',
      [mechId],
    );
    expect(userRows[0]?.status).toBe('active');
    expect(userRows[0]?.deleted_at).toBeNull();
  });
});

// ─── Cognito AdminUpdateUserAttributes failure ───────────────────────────────

describe('POST /v1/users/:id/reactivate — Cognito AdminUpdateUserAttributes failure', () => {
  const TEST_IP = '10.21.30.19';

  it('returns 200 with x-cognito-sync-failed header when override fails but enable succeeds', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('cogfail-attr');
    const adminSub = `sa-cogfail-attr-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-cogfail-attr-${crypto.randomUUID()}`,
      email: 'mech-cogfail-attr@test.it',
      role: 'mechanic',
      locationId,
    });
    await softDeleteUser(mechId);

    // enable succeeds, attribute update fails.
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error('cognito attr boom'));

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mechId}/reactivate`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: { role: 'super_admin', locationId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cognito-sync-failed']).toBe('true');

    // DB still committed with the override.
    const { rows: userRows } = await pgAdmin.query<{ role: string; location_id: string | null }>(
      'SELECT role, location_id FROM users WHERE id = $1',
      [mechId],
    );
    expect(userRows[0]?.role).toBe('super_admin');
    expect(userRows[0]?.location_id).toBeNull();

    // Both Cognito calls happened.
    expect(cognitoMock.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });
});

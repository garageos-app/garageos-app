// Integration tests for POST /v1/invitations/:token/accept — F-OFF-004 accept.
// Public (no auth) endpoint; token is the credential.
//
// Cognito is stubbed with aws-sdk-client-mock (same pattern as auth-signup.test.ts).
// Helper pattern mirrors invitations-public-read.test.ts (T8):
//   buildTestServer / createTenantWithLocation / pgAdmin / resetDb.
//
// 6 cases:
//   1. Happy path — creates User, consumes invitation, returns user (no cognitoSub), audit log.
//   2. Anti-enum 404 — unknown token → 404 user.invitation.not_found.
//   3. Anti-enum 404 — already-consumed invitation → 404.
//   4. Anti-enum 404 — expired invitation → 404.
//   5. Password policy + rollback — InvalidPasswordException → 422 + AdminDeleteUser called once.
//   6. Email race 409 — existing active User with same email → 409 user.invitation.email_already_active.

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';
import { hashToken } from '../../src/lib/secure-tokens.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

const cognito = mockClient(CognitoIdentityProviderClient);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  cognito.reset();
  _resetCognitoClientForTests();
  // Default happy-path mock — individual tests override as needed.
  cognito.on(AdminCreateUserCommand).resolves({
    User: { Attributes: [{ Name: 'sub', Value: 'cog-sub-accept' }] },
  });
  cognito.on(AdminSetUserPasswordCommand).resolves({});
});

// Helper: insert an invitation row directly via pgAdmin (bypasses RLS).
// Mirrors createInvitation in invitations-public-read.test.ts.
async function createInvitation(params: {
  tenantId: string;
  targetEmail: string;
  firstName?: string;
  lastName?: string;
  role?: 'super_admin' | 'mechanic';
  locationId?: string | null;
  token: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}): Promise<{ invitationId: string }> {
  const {
    tenantId,
    targetEmail,
    firstName = 'Test',
    lastName = 'User',
    role = 'mechanic',
    locationId = null,
    token,
    expiresAt = new Date(Date.now() + 7 * 86400000),
    acceptedAt = null,
  } = params;
  const tokenHash = hashToken(token);
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, first_name, last_name,
        role, location_id, token_hash, expires_at, accepted_at, created_at)
     VALUES (gen_random_uuid(), $1, 'internal_user'::"InvitationType", $2, $3, $4,
        $5::"UserRole", $6, $7, $8, $9, NOW())
     RETURNING id`,
    [
      tenantId,
      targetEmail,
      firstName,
      lastName,
      role,
      locationId,
      tokenHash,
      expiresAt,
      acceptedAt,
    ],
  );
  return { invitationId: rows[0]!.id };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /v1/invitations/:token/accept — happy path', () => {
  const TEST_IP = '10.30.40.1';

  it('creates User row, consumes invitation, returns user (no cognitoSub), audit log', async () => {
    const { tenantId } = await createTenantWithLocation('accept-ok');

    const { invitationId } = await createInvitation({
      tenantId,
      targetEmail: 'mario@x.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'mechanic',
      token: 'accept-tok-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept-tok-1/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user.email).toBe('mario@x.com');
    expect(body.user.firstName).toBe('Mario');
    expect(body.user.lastName).toBe('Rossi');
    expect(body.user.role).toBe('mechanic');
    expect(body.user.status).toBe('active');
    // cognitoSub must never be exposed in the response (USER_ADMIN_SELECT omits it).
    expect(body.user).not.toHaveProperty('cognitoSub');

    // Invitation was consumed (acceptedAt set).
    const { rows: invRows } = await pgAdmin.query<{ accepted_at: Date | null }>(
      `SELECT accepted_at FROM invitations WHERE id = $1`,
      [invitationId],
    );
    expect(invRows[0]!.accepted_at).not.toBeNull();

    // User row was created with cognitoSub linked.
    const { rows: userRows } = await pgAdmin.query<{
      id: string;
      cognito_sub: string;
      email: string;
      status: string;
    }>(`SELECT id, cognito_sub, email, status FROM users WHERE email = 'mario@x.com'`);
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.cognito_sub).toBe('cog-sub-accept');
    expect(userRows[0]!.status).toBe('active');

    // Audit log row created with correct action and actorId = newUser.id (UUID).
    const { rows: auditRows } = await pgAdmin.query<{
      actor_id: string;
      actor_type: string;
      entity_id: string;
    }>(
      `SELECT actor_id, actor_type, entity_id
         FROM audit_logs
        WHERE entity_type = 'user'
          AND entity_id = $1
          AND action = 'user_invitation_accepted'`,
      [userRows[0]!.id],
    );
    expect(auditRows).toHaveLength(1);
    // actorId is the new user's UUID (not cognitoSub) — BR adaptation.
    expect(auditRows[0]!.actor_id).toBe(userRows[0]!.id);
    expect(auditRows[0]!.actor_type).toBe('user');
  });
});

// ─── Anti-enum 404 ────────────────────────────────────────────────────────────

describe('POST /v1/invitations/:token/accept — anti-enum 404', () => {
  const TEST_IP = '10.30.40.2';

  it('returns 404 + code user.invitation.not_found for unknown token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/unknown-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.invitation.not_found');
  });

  it('returns 404 for already-consumed invitation (anti-enum)', async () => {
    const { tenantId } = await createTenantWithLocation('accept-consumed');
    await createInvitation({
      tenantId,
      targetEmail: 'consumed@x.com',
      token: 'consumed-tok',
      acceptedAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/consumed-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for expired invitation (anti-enum)', async () => {
    const { tenantId } = await createTenantWithLocation('accept-expired');
    await createInvitation({
      tenantId,
      targetEmail: 'expired@x.com',
      token: 'expired-tok',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/expired-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Password policy + rollback ───────────────────────────────────────────────

describe('POST /v1/invitations/:token/accept — password policy + rollback', () => {
  const TEST_IP = '10.30.40.3';

  it('returns 422 password_policy when Cognito rejects password + rolls back Cognito user', async () => {
    const { tenantId } = await createTenantWithLocation('accept-pwpol');
    const { invitationId } = await createInvitation({
      tenantId,
      targetEmail: 'weak@x.com',
      firstName: 'W',
      lastName: 'P',
      role: 'mechanic',
      token: 'weak-tok',
    });

    cognito.on(AdminSetUserPasswordCommand).rejects(
      new InvalidPasswordException({
        message: 'Password does not meet requirements',
        $metadata: {},
      }),
    );
    cognito.on(AdminDeleteUserCommand).resolves({});

    // Password passes Zod min(8) so Cognito gets the call — the mocked
    // AdminSetUserPasswordCommand then rejects with InvalidPasswordException
    // and the handler maps that to 422 user.invitation.accept_password_policy.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/weak-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'weakweak' },
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('user.invitation.accept_password_policy');

    // Rollback (AdminDeleteUser) was called exactly once.
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);

    // Invitation NOT consumed — still usable.
    const { rows: invRows } = await pgAdmin.query<{ accepted_at: Date | null }>(
      `SELECT accepted_at FROM invitations WHERE id = $1`,
      [invitationId],
    );
    expect(invRows[0]!.accepted_at).toBeNull();

    // No User row created.
    const { rows: userRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'weak@x.com'`,
    );
    expect(userRows).toHaveLength(0);
  });
});

// ─── Suspended tenant — BR-210 ───────────────────────────────────────────────

describe('POST /v1/invitations/:token/accept — suspended tenant (BR-210)', () => {
  const TEST_IP = '10.30.40.5';

  it('returns 403 auth.tenant.suspended when the tenant is suspended', async () => {
    const { tenantId } = await createTenantWithLocation('accept-susp');
    await createInvitation({
      tenantId,
      targetEmail: 'susp@x.com',
      token: 'susp-tok',
    });

    await pgAdmin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);

    // Phase 1 throws before any Cognito call — no Cognito mock override needed.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/susp-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('auth.tenant.suspended');
  });

  it('returns 201 after tenant is re-activated (link is still valid)', async () => {
    const { tenantId } = await createTenantWithLocation('accept-react');
    await createInvitation({
      tenantId,
      targetEmail: 'react-inv@x.com',
      token: 'react-inv-tok',
    });

    await pgAdmin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);

    // Confirm suspended → 403.
    const suspRes = await app.inject({
      method: 'POST',
      url: '/v1/invitations/react-inv-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(suspRes.statusCode).toBe(403);
    expect((suspRes.json() as { code: string }).code).toBe('auth.tenant.suspended');

    // Re-activate — the same (still non-expired, non-consumed) link now succeeds.
    await pgAdmin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantId]);

    // Default beforeEach Cognito mock handles Phase 2+3 correctly.
    const okRes = await app.inject({
      method: 'POST',
      url: '/v1/invitations/react-inv-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });
    expect(okRes.statusCode).toBe(201);
  });
});

// ─── Email race 409 ───────────────────────────────────────────────────────────

describe('POST /v1/invitations/:token/accept — email race 409', () => {
  const TEST_IP = '10.30.40.4';

  it('returns 409 email_already_active when an active User with same email already exists', async () => {
    const { tenantId } = await createTenantWithLocation('accept-race');
    await createInvitation({
      tenantId,
      targetEmail: 'race@x.com',
      role: 'mechanic',
      token: 'race-tok',
    });
    // Pre-seed an active user with the same email (simulates race condition).
    await createUser({
      tenantId,
      cognitoSub: `precreated-${crypto.randomUUID()}`,
      email: 'race@x.com',
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/race-tok/accept',
      remoteAddress: TEST_IP,
      payload: { password: 'Password123!' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_already_active');
  });
});

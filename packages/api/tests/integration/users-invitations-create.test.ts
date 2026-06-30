// Integration tests for POST /v1/users/invitations — F-OFF-004.
// Uses aws-sdk-client-mock to intercept SES calls without hitting AWS.
// Actual helpers mirror users-list.test.ts (T5 pattern):
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / resetDb.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { _resetSesClientForTests } from '../../src/lib/ses-client.js';
import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

const sesMock = mockClient(SESv2Client);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('POST /v1/users/invitations', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // Reset the ses-client singleton so aws-sdk-client-mock hooks the fresh
    // SESv2Client instance created on next call (same pattern as other SES tests).
    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
    // Same pattern for Cognito client: reset the singleton so the mock
    // intercepts the fresh CognitoIdentityProviderClient. Default behavior
    // is "user not in pool" — the step 1bis cross-tenant check then
    // treats the email as new and continues the flow (status quo for the
    // happy-path / duplicate-pending / SES-fail cases that
    // predate the cross-tenant guard).
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: 'not found', $metadata: {} }));
  });

  it('creates an invitation + sends SES email (happy path)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-create-ok');
    const adminSub = `sa-inv-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin@inv.test',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'mario@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        role: 'mechanic',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { invitation: Record<string, unknown> };
    expect(body.invitation.targetEmail).toBe('mario@example.com');
    expect(body.invitation.role).toBe('mechanic');
    expect(body.invitation.expiresAt).toBeDefined();
    // Plaintext token must never be exposed in the response (security invariant).
    expect(body.invitation).not.toHaveProperty('token');
    // Plaintext token never leaves the SES email body; tokenHash is not in
    // INVITATION_ADMIN_SELECT, so neither field appears in the response.
    expect(body.invitation).not.toHaveProperty('tokenHash');

    // DB-side: the invitation row stores a 64-char hex token_hash and
    // does NOT have a legacy `token` column.
    const { rows: dbRows } = await pgAdmin.query<{
      token_hash: string;
      legacy_token_exists: boolean;
    }>(
      `SELECT
         token_hash,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'invitations' AND column_name = 'token'
         ) AS legacy_token_exists
       FROM invitations
       WHERE id = $1`,
      [body.invitation.id as string],
    );
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dbRows[0]!.legacy_token_exists).toBe(false);

    // SES send was called exactly once.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);

    // Audit log row must be created with actor traced to the inviting user.
    const invitationId = body.invitation.id as string;
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_id: string | null;
    }>(
      `SELECT action, entity_type, entity_id, actor_id
         FROM audit_logs
        WHERE entity_type = 'invitation' AND entity_id = $1
        LIMIT 1`,
      [invitationId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('user_invitation_created');
    // actorId must be populated — the handler looks up the Super Admin's DB UUID.
    expect(auditRows[0]!.actor_id).not.toBeNull();
  });

  it('rejects email collision with an existing active user (409)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-collision');
    const adminSub = `sa-col-${crypto.randomUUID()}`;
    const existingSub = `ex-col-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-col@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId,
      cognitoSub: existingSub,
      email: 'existing@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'existing@test.it',
        firstName: 'X',
        lastName: 'Y',
        role: 'super_admin',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('user.invitation.email_already_active');
  });

  it('rejects duplicate pending invitation — partial unique index (BR-206)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-dup');
    const adminSub = `sa-dup-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-dup@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const payload = {
      email: 'mario@dup.test',
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'mechanic' as const,
    };

    // First invite — should succeed.
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res1.statusCode).toBe(201);

    // Duplicate — same email + same tenant + still pending = P2002 on partial unique index.
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('user.invitation.duplicate_pending');
  });

  it('returns 201 even when SES send fails (best-effort)', async () => {
    // Override mock: SES throws on send.
    sesMock.on(SendEmailCommand).rejects(new Error('SES sandbox'));

    const { tenantId } = await createTenantWithLocation('inv-ses-fail');
    const adminSub = `sa-sesfail-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-sesfail@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'nomail@sesfail.test',
        firstName: 'No',
        lastName: 'Mail',
        role: 'mechanic',
      },
    });

    // Best-effort: 201 even if SES failed.
    expect(res.statusCode).toBe(201);
    // DB row must still exist — verified directly in the DB, not just via
    // the response body (mirrors the feedback_integration_test_mirror_frontend_wire
    // pattern: test what's actually persisted, not what the handler echoes back).
    const body = res.json() as { invitation: { id: string } };
    expect(body.invitation.id).toBeDefined();
    const { rows: invRows } = await pgAdmin.query<{ id: string; target_email: string }>(
      `SELECT id, target_email FROM invitations WHERE target_email = $1 LIMIT 1`,
      ['nomail@sesfail.test'],
    );
    expect(invRows).toHaveLength(1);
    expect(invRows[0]!.id).toBe(body.invitation.id);
  });

  it('blocks mechanic role with 403 (requireSuperAdmin)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-403');
    const mechSub = `mech-403-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: mechSub,
      email: 'mech-403@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });
});

// ─── Cross-tenant detection (F-OFF-004 reactivation slice) ────────────────────
// Step 1 now discriminates active vs soft-deleted same-tenant collisions.
// Step 1bis (new): Cognito early-check for cross-tenant collision in the
// single Officine pool. See spec 2026-05-21-user-reactivation-design.md §4.2.

describe('POST /v1/users/invitations — cross-tenant detection (F-OFF-004 reactivation slice)', () => {
  const TEST_IP = '10.21.30.20';
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
    cognitoMock.reset();
    _resetCognitoClientForTests();
    // No default Cognito mock here — each test sets its own expectation
    // (hit / throw / "should not be called").
  });

  it('Cognito hit + no DB user → 409 user.invitation.email_in_other_tenant, no invitation row, no SES send', async () => {
    const { tenantId } = await createTenantWithLocation('crosstenant');
    const adminSub = `sa-crosstenant-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: 'cross@x.test',
      UserAttributes: [
        { Name: 'sub', Value: 'cognito-cross-sub' },
        { Name: 'email', Value: 'cross@x.test' },
      ],
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: {
        email: 'cross@x.test',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
      },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_in_other_tenant');
    const { rows } = await pgAdmin.query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1',
      ['cross@x.test'],
    );
    expect(rows[0]?.c).toBe('0');
    // SES must not be invoked when the invitation tx fails.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('Cognito throws → 502 auth.cognito_unavailable, no invitation row', async () => {
    const { tenantId } = await createTenantWithLocation('cogfail');
    const adminSub = `sa-cogfail-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });

    cognitoMock.on(AdminGetUserCommand).rejects(new Error('cognito service unavailable'));

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: {
        email: 'new-cogfail@x.test',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
      },
    });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe('auth.cognito_unavailable');
    const { rows } = await pgAdmin.query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1',
      ['new-cogfail@x.test'],
    );
    expect(rows[0]?.c).toBe('0');
  });

  it('Same-tenant soft-deleted user → 409 user.invitation.email_soft_deleted_in_tenant, Cognito NOT called', async () => {
    const { tenantId } = await createTenantWithLocation('softdel-reinvite');
    const adminSub = `sa-softdel-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });
    const { userId: mechId } = await createUser({
      tenantId,
      cognitoSub: `mech-softdel-${crypto.randomUUID()}`,
      email: 'softdel@x.test',
      role: 'mechanic',
    });
    // Soft-delete the mechanic.
    await pgAdmin.query(
      'UPDATE users SET status = \'inactive\'::"UserStatus", deleted_at = NOW() WHERE id = $1',
      [mechId],
    );

    // Cognito mock: should not be called. Set rejects so we'd detect a stray call.
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('should not be called'));

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
      payload: {
        email: 'softdel@x.test',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
      },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe(
      'user.invitation.email_soft_deleted_in_tenant',
    );
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });
});

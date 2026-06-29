// Integration tests for POST /v1/admin/tenants/:id/users/invitations —
// Slice 3 platform-admin invite-tenant-user endpoint.
//
// Tier-1 security / RLS gate: proves the admin-context write passes RLS
// under the real garageos_app role and that pool isolation is enforced.
//
// Test groups:
//   1. Isolation matrix — no-auth 401, officine 403, clienti 403.
//   2. Mechanic happy path — 200, DB rows (invitations / audit_logs) verified,
//      locationId = primary location, magicLinkUrl present, hash ≠ plaintext.
//   3. super_admin happy path — 200, locationId null.
//   4. Duplicate pending (same tenant + email) → user.invitation.duplicate_pending 409.
//   5. Owner-email in Cognito pool → user.invitation.email_in_other_tenant 409.
//   6. Pending invitation in another tenant → user.invitation.email_in_other_tenant 409.
//   7. Unknown tenant → tenant.not_found 404.
//   8. Mechanic + no primary location → user.location_required_for_mechanic 422.
//   9. Rate-limit — 31st call from the same admin JWT sub → 429
//      admin.tenant.rate_limited; unique adminSub per describe block for isolation
//      (feedback_integration_test_rate_limit_isolation.md).
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import { _resetSesClientForTests } from '../../src/lib/ses-client.js';
import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';

import { buildTestServer } from './fixtures.js';
import { resetDb, createTenantWithLocation, createUser } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Top-level mock setup — mirrors admin-tenants-create.test.ts.
const sesMock = mockClient(SESv2Client);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const BASE_URL = '/v1/admin/tenants';

// Canonical valid body for mechanic invite — individual tests override only
// the field under test to keep diffs minimal.
const VALID_MECHANIC_BODY = {
  email: 'mechanic@rossi.it',
  firstName: 'Luigi',
  lastName: 'Ferrari',
  role: 'mechanic' as const,
};

const VALID_SUPER_ADMIN_BODY = {
  email: 'owner@rossi.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'super_admin' as const,
};

// ─── 1. Isolation matrix ─────────────────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/users/invitations — auth isolation (integration)', () => {
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

  it('returns 401 when no Authorization header is present', async () => {
    const { tenantId } = await createTenantWithLocation();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const { tenantId } = await createTenantWithLocation();
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 FORBIDDEN when a valid clienti token is used', async () => {
    const { tenantId } = await createTenantWithLocation();
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });
});

// ─── 2–8. Business cases ──────────────────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/users/invitations — business cases (integration)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let primaryLocationId: string;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();

    // Seed a tenant with a primary location for each test.
    const result = await createTenantWithLocation();
    tenantId = result.tenantId;
    primaryLocationId = result.locationId;

    // Reset SES singleton + mock — same pattern as admin-tenants-create.test.ts.
    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});

    // Reset Cognito singleton + mock. Default: email NOT in the officine pool
    // (UserNotFoundException) → exists:false → happy path proceeds.
    // Tests that need the "exists" branch override this inline.
    _resetCognitoClientForTests();
    cognitoMock.reset();
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: 'User does not exist.', $metadata: {} }));
  });

  // ── 2. Mechanic happy path ──────────────────────────────────────────────────
  it('invites a mechanic: 200, invitation row with role=mechanic and primaryLocationId, magicLinkUrl present, hash ≠ plaintext', async () => {
    const adminSub = 'admin-sub-mechanic-happy';
    const token = await signTestToken({
      pool: 'platform-admins',
      sub: adminSub,
      email: 'admin@garageos.internal',
      extraClaims: { given_name: 'Luca', family_name: 'Admin' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(200);

    type ResponseBody = {
      invitation: {
        email: string;
        role: string;
        expiresAt: string;
        emailSent: boolean;
        magicLinkUrl: string;
      };
    };
    const body = res.json() as ResponseBody;

    // ── Response shape ────────────────────────────────────────────────────────
    expect(body.invitation.email).toBe(VALID_MECHANIC_BODY.email);
    expect(body.invitation.role).toBe('mechanic');
    expect(body.invitation.expiresAt).toBeDefined();
    expect(body.invitation.emailSent).toBe(true);
    expect(body.invitation.magicLinkUrl).toMatch(/\/invitations\//);

    // ── DB: invitations row ───────────────────────────────────────────────────
    const now = Date.now();
    const { rows: invRows } = await pgAdmin.query<{
      invitation_type: string;
      role: string;
      location_id: string;
      token_hash: string;
      accepted_at: Date | null;
      expires_at: Date;
      target_email: string;
    }>(
      `SELECT invitation_type, role, location_id, token_hash,
              accepted_at, expires_at, target_email
         FROM invitations WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(invRows).toHaveLength(1);
    expect(invRows[0]!.invitation_type).toBe('internal_user');
    expect(invRows[0]!.role).toBe('mechanic');
    // mechanic must be assigned to the primary location.
    expect(invRows[0]!.location_id).toBe(primaryLocationId);
    // token_hash is a 64-char hex SHA-256 digest; plaintext never stored.
    expect(invRows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invRows[0]!.accepted_at).toBeNull();
    expect(invRows[0]!.target_email).toBe(VALID_MECHANIC_BODY.email);
    // expires_at ≈ now + 7 days (±10 s tolerance).
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAtMs = new Date(invRows[0]!.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThan(now + sevenDaysMs - 10_000);
    expect(expiresAtMs).toBeLessThan(now + sevenDaysMs + 10_000);

    // ── Security: plaintext token ≠ stored hash ───────────────────────────────
    // Extract the plaintext token from the magicLinkUrl (last URL segment).
    const plaintext = body.invitation.magicLinkUrl.split('/').pop()!;
    expect(plaintext.length).toBeGreaterThan(0);
    // The DB stores the SHA-256 hash, which must differ from the plaintext.
    expect(invRows[0]!.token_hash).not.toBe(plaintext);

    // ── DB: audit_log row ─────────────────────────────────────────────────────
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, actor_id, metadata
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'user_invited'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('user_invited');
    // Platform admins have no tenant User row → actorType='system', actorId=null.
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    // SECURITY: metadata must contain only the safe fields and must NOT include
    // the plaintext token (which appears only in the response magicLinkUrl).
    const meta = auditRows[0]!.metadata;
    expect(meta).toMatchObject({
      actorCognitoSub: adminSub,
      role: 'mechanic',
      targetEmail: VALID_MECHANIC_BODY.email,
    });
    expect(Object.keys(meta)).toHaveLength(3); // no extra keys
    // The plaintext token extracted from the response must not appear anywhere in the metadata.
    expect(JSON.stringify(meta)).not.toContain(plaintext);

    // ── AWS SDK mock call counts ──────────────────────────────────────────────
    // Cognito called once for the email cross-tenant pre-check.
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(1);
    // SES called once to dispatch the invitation email.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  // ── 3. super_admin happy path ───────────────────────────────────────────────
  it('invites a super_admin: 200, invitation row with role=super_admin and locationId=null', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_SUPER_ADMIN_BODY,
    });

    expect(res.statusCode).toBe(200);

    type ResponseBody = {
      invitation: { email: string; role: string; magicLinkUrl: string };
    };
    const body = res.json() as ResponseBody;
    expect(body.invitation.role).toBe('super_admin');
    expect(body.invitation.magicLinkUrl).toMatch(/\/invitations\//);

    // ── DB: invitation row — super_admin must have locationId=null ────────────
    const { rows: invRows } = await pgAdmin.query<{
      role: string;
      location_id: string | null;
    }>(`SELECT role, location_id FROM invitations WHERE tenant_id = $1`, [tenantId]);
    expect(invRows).toHaveLength(1);
    expect(invRows[0]!.role).toBe('super_admin');
    expect(invRows[0]!.location_id).toBeNull();
  });

  // ── 4. Duplicate pending for same (tenant, email) ───────────────────────────
  it('returns 409 user.invitation.duplicate_pending when a pending invite already exists for (tenant, email)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    // First invite succeeds.
    const first = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });
    expect(first.statusCode).toBe(200);

    // Second invite for the same (tenant, email): the pendingElsewhere check now
    // excludes the current tenant (tenantId: { not: id }), so it does NOT match
    // the row inserted above. Execution falls through to createInternalInvitation,
    // which hits the partial unique index uq_invitations_pending_internal and maps
    // P2002 → user.invitation.duplicate_pending 409 (BR-206).
    const second = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('user.invitation.duplicate_pending');
  });

  // ── 5. Email already in officine Cognito pool ───────────────────────────────
  it('returns 409 user.invitation.email_in_other_tenant when Cognito resolves the email, writes no invitation row', async () => {
    // Override: Cognito resolves → email belongs to a user already in the pool.
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: VALID_MECHANIC_BODY.email,
      UserAttributes: [
        { Name: 'sub', Value: 'existing-cognito-sub' },
        { Name: 'email', Value: VALID_MECHANIC_BODY.email },
      ],
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_in_other_tenant');

    // No invitation row must have been written (the DB tx was never entered).
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1`,
      [VALID_MECHANIC_BODY.email],
    );
    expect(rows[0]!.c).toBe('0');

    // SES must not have been invoked — handler short-circuits before email send.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  // ── 6. Pending invitation in another tenant ─────────────────────────────────
  it('returns 409 user.invitation.email_in_other_tenant when a pending internal_user invite exists in another tenant', async () => {
    // Seed: a different tenant + a non-expired pending internal_user invitation
    // for the same email. Insert via pgAdmin (BYPASSRLS) to bypass RLS.
    const otherTenantId = '00000000-0000-4000-8000-000000000099';
    await pgAdmin.query(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES ($1, 'Altra Officina SRL', '99999999999', 'altra@test.it', NOW(), NOW())`,
      [otherTenantId],
    );
    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, first_name, last_name,
          role, token_hash, expires_at, created_at)
       VALUES
         (gen_random_uuid(), $1, 'internal_user', $2, 'Luigi', 'Ferrari', 'mechanic',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          NOW() + INTERVAL '7 days', NOW())`,
      [otherTenantId, VALID_MECHANIC_BODY.email],
    );

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_in_other_tenant');

    // No invitation row written in the target tenant (the DB tx was never entered).
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.c).toBe('0');
  });

  // ── 7. Unknown tenant ───────────────────────────────────────────────────────
  it('returns 404 tenant.not_found for an unknown tenant UUID', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${unknownId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // Anti-enum: non-UUID path parameter → same 404 as unknown UUID.
  it('returns 404 tenant.not_found for a non-UUID path param (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/not-a-uuid/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 8. Mechanic + no primary location ──────────────────────────────────────
  it('returns 422 user.location_required_for_mechanic when the tenant has no primary active location', async () => {
    // Create a tenant WITHOUT any location.
    const { rows: tenantRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Senza Sede SRL', '11111111111', 'senzasede@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const noLocationTenantId = tenantRows[0]!.id;

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${noLocationTenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: VALID_MECHANIC_BODY,
    });

    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('user.location_required_for_mechanic');

    // No invitation row written.
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE tenant_id = $1`,
      [noLocationTenantId],
    );
    expect(rows[0]!.c).toBe('0');
  });

  // ── 9a. Same-tenant active user ─────────────────────────────────────────────
  // Regression: before the fix, this would fall through to the Cognito check
  // and return email_in_other_tenant 409 instead of email_already_active 409.
  it('returns 409 user.invitation.email_already_active when the email belongs to an active user in the same tenant', async () => {
    const targetEmail = 'already-active@rossi.it';
    await createUser({
      tenantId,
      cognitoSub: `existing-active-${crypto.randomUUID()}`,
      email: targetEmail,
      role: 'mechanic',
      locationId: primaryLocationId,
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { email: targetEmail, firstName: 'Già', lastName: 'Attivo', role: 'mechanic' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_already_active');

    // No invitation row written.
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1`,
      [targetEmail],
    );
    expect(rows[0]!.c).toBe('0');

    // SES must not have been called.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  // ── 9b. Same-tenant soft-deleted user ──────────────────────────────────────
  // Regression: before the fix, soft-deleted same-tenant users would also
  // fall through to the Cognito check and return email_in_other_tenant 409.
  it('returns 409 user.invitation.email_soft_deleted_in_tenant when the email belongs to a soft-deleted user in the same tenant', async () => {
    const targetEmail = 'soft-deleted@rossi.it';
    // Insert a soft-deleted user directly (pgAdmin bypasses RLS — same pattern
    // as other direct-insert fixtures in this file).
    await pgAdmin.query(
      `INSERT INTO users
         (id, tenant_id, location_id, cognito_sub, email, first_name, last_name,
          role, status, deleted_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Soft', 'Deleted',
               'mechanic'::"UserRole", 'inactive'::"UserStatus", NOW(), NOW(), NOW())`,
      [tenantId, primaryLocationId, `soft-del-sub-${crypto.randomUUID()}`, targetEmail],
    );

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { email: targetEmail, firstName: 'Soft', lastName: 'Deleted', role: 'mechanic' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe(
      'user.invitation.email_soft_deleted_in_tenant',
    );

    // No invitation row written.
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1`,
      [targetEmail],
    );
    expect(rows[0]!.c).toBe('0');

    // SES must not have been called.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

// ─── 9. Rate-limit ───────────────────────────────────────────────────────────
// Unique adminSub per describe block so each describe gets its own rate-limit
// bucket (feedback_integration_test_rate_limit_isolation.md).
// Key derivation: admin-tenant:${jwt.sub} — confirmed in adminTenantRateLimitKey.

describe('POST /v1/admin/tenants/:id/users/invitations — rate-limit (integration)', () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    const result = await createTenantWithLocation();
    tenantId = result.tenantId;

    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
    _resetCognitoClientForTests();
    cognitoMock.reset();
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: 'User does not exist.', $metadata: {} }));
  });

  // Sanity: a single call from a fresh admin sub is not rate-limited.
  it('single invite call from a fresh admin sub returns non-429 (under the limit)', async () => {
    const adminSub = `rl-sanity-invite-${crypto.randomUUID()}`;
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const res = await app.inject({
      method: 'POST',
      url: `${BASE_URL}/${tenantId}/users/invitations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{}', // empty body → Zod 400 inside handler, counted by rate-limit
    });

    expect(res.statusCode).not.toBe(429);
  });

  // Rate-limit: 31st call from the same admin sub triggers 429.
  // Requests 1-30 each get a non-429 response (400 VALIDATION_ERROR from Zod,
  // since the empty body is validated inside the handler after the rate-limit
  // hook runs). Request 31 is blocked before the handler by the plugin.
  it('31st call from the same admin JWT sub returns 429 admin.tenant.rate_limited', async () => {
    const adminSub = `rl-burst-invite-${crypto.randomUUID()}`;
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const fire = () =>
      app.inject({
        method: 'POST',
        url: `${BASE_URL}/${tenantId}/users/invitations`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{}', // empty body → Zod 400 inside handler, counted by rate-limit
      });

    for (let i = 0; i < 30; i++) {
      const res = await fire();
      // Each of the first 30 calls passes the rate-limit hook (counter ≤ 30)
      // and reaches the handler, which rejects with 400 VALIDATION_ERROR.
      expect(res.statusCode).not.toBe(429);
    }

    // 31st call: rate-limit plugin fires before the handler → 429.
    const limited = await fire();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((limited.json() as { code: string }).code).toBe('admin.tenant.rate_limited');
  });
});

// Integration tests for POST /v1/admin/tenants — Slice 1 platform-admin create-tenant.
//
// Tier-1 security / RLS gate: proves the admin-context write passes RLS under
// the real garageos_app role (unit tests mock withContext) and that pool
// isolation is bidirectional.
//
// Test groups:
//   1. Isolation matrix — no-auth 401, officine 403, clienti 403;
//      + reverse boundary: platform-admins token rejected on POST /v1/customers.
//   2. Happy path — 201, DB rows (tenants / locations / invitations / audit_logs)
//      verified via pgAdmin, Cognito + SES mocks exercised, no token in response.
//   3. Duplicate VAT → 409 tenant.vat_number_duplicate, no second tenant row.
//   4. Owner-email in other tenant (Cognito resolves) → 409
//      user.invitation.email_in_other_tenant, NO tenant / location / invitation rows.
//   5. VAT invalid format → 400 tenant.vat_number_invalid.
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
import { resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Top-level mock setup — mirrors users-invitations-create.test.ts:23-24.
const sesMock = mockClient(SESv2Client);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

// ─── 1. Isolation matrix ─────────────────────────────────────────────────────

describe('POST /v1/admin/tenants — auth isolation (integration)', () => {
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
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
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
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
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
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  // Reverse boundary: a platform-admins token must NOT gain access to
  // officine-pool routes (requireOfficinaPool guard). Locks the bidirectional
  // isolation invariant — platform-admins ↔ officine pools are mutually exclusive.
  it('returns 403 when a platform-admins token is used on POST /v1/customers (reverse boundary)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        firstName: 'Luca',
        lastName: 'Bianchi',
        email: 'luca@bianchi.it',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });
});

// ─── 2–5. Business cases ──────────────────────────────────────────────────────

// Canonical valid payload — reused across cases; individual tests override
// only the field under test to keep diffs minimal.
const VALID_BODY = {
  businessName: 'Autofficina Rossi SRL',
  vatNumber: '12345678901', // 11 digits — passes the regex in the handler
  email: 'officina@rossi.it',
  ownerFirstName: 'Mario',
  ownerLastName: 'Rossi',
  ownerEmail: 'mario.rossi@rossi.it',
};

describe('POST /v1/admin/tenants — business cases (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // Reset SES singleton + mock — same pattern as users-invitations-create.test.ts.
    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
    // Reset Cognito singleton + mock. Default: owner email NOT in the officine
    // Cognito pool (UserNotFoundException) → exists:false → happy path proceeds.
    // Tests that need the "exists" branch override this inline.
    _resetCognitoClientForTests();
    cognitoMock.reset();
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: 'User does not exist.', $metadata: {} }));
  });

  // ── 2. Happy path ────────────────────────────────────────────────────────────
  it('creates tenant + location + invitation + audit log and returns 201 (happy path)', async () => {
    const adminSub = 'admin-sub-happy-path';
    const token = await signTestToken({
      pool: 'platform-admins',
      sub: adminSub,
      email: 'admin@garageos.internal',
      extraClaims: { given_name: 'Luca', family_name: 'Admin' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);

    type ResponseBody = {
      tenant: { id: string; businessName: string; vatNumber: string; status: string };
      invitation: { ownerEmail: string; expiresAt: string; emailSent: boolean };
    };
    const body = res.json() as ResponseBody;

    // ── Response shape ──────────────────────────────────────────────────────
    expect(body.tenant.id).toBeDefined();
    expect(body.tenant.businessName).toBe(VALID_BODY.businessName);
    expect(body.tenant.vatNumber).toBe(VALID_BODY.vatNumber);
    expect(body.tenant.status).toBe('active');
    expect(body.invitation.ownerEmail).toBe(VALID_BODY.ownerEmail);
    expect(body.invitation.expiresAt).toBeDefined();
    expect(body.invitation.emailSent).toBe(true);
    // Security: plaintext token must never be returned in the HTTP response.
    expect(body.invitation).not.toHaveProperty('token');

    const tenantId = body.tenant.id;

    // ── DB: tenants row ─────────────────────────────────────────────────────
    const { rows: tenantRows } = await pgAdmin.query<{
      business_name: string;
      vat_number: string;
      status: string;
      billing_status: string;
      plan: string;
    }>(
      `SELECT business_name, vat_number, status, billing_status, plan
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.business_name).toBe(VALID_BODY.businessName);
    expect(tenantRows[0]!.vat_number).toBe(VALID_BODY.vatNumber);
    expect(tenantRows[0]!.status).toBe('active');
    expect(tenantRows[0]!.billing_status).toBe('manual');
    expect(tenantRows[0]!.plan).toBe('starter');

    // ── DB: locations row — primary location with handler placeholder values ─
    const { rows: locationRows } = await pgAdmin.query<{
      id: string;
      name: string;
      is_primary: boolean;
    }>(`SELECT id, name, is_primary FROM locations WHERE tenant_id = $1`, [tenantId]);
    expect(locationRows).toHaveLength(1);
    expect(locationRows[0]!.name).toBe('Sede principale');
    expect(locationRows[0]!.is_primary).toBe(true);
    const locationId = locationRows[0]!.id;

    // ── DB: invitations row ─────────────────────────────────────────────────
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
    expect(invRows[0]!.role).toBe('super_admin');
    expect(invRows[0]!.location_id).toBe(locationId);
    // token_hash is a 64-char hex SHA-256 digest; plaintext never stored.
    expect(invRows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invRows[0]!.accepted_at).toBeNull();
    expect(invRows[0]!.target_email).toBe(VALID_BODY.ownerEmail);
    // expires_at ≈ now + 7 days (±10 s tolerance for test execution time).
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAtMs = new Date(invRows[0]!.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThan(now + sevenDaysMs - 10_000);
    expect(expiresAtMs).toBeLessThan(now + sevenDaysMs + 10_000);

    // ── DB: audit_logs row ──────────────────────────────────────────────────
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_id: string;
    }>(
      `SELECT action, actor_type, actor_id, entity_id
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'tenant_created'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('tenant_created');
    // Platform admins have no tenant User row → actorType='system', actorId=null.
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.entity_id).toBe(tenantId);

    // ── AWS SDK mock call counts ────────────────────────────────────────────
    // Cognito called once for the ownerEmail cross-tenant pre-check.
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(1);
    // SES called once to dispatch the owner invitation email.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  // ── 3. Duplicate VAT ─────────────────────────────────────────────────────────
  it('returns 409 tenant.vat_number_duplicate and writes no second tenant row', async () => {
    // Pre-seed a tenant with the same VAT directly via the admin connection
    // (bypasses RLS — fixture setup, not application logic under test).
    await pgAdmin.query(
      `INSERT INTO tenants
         (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Preesistente SRL', $1, 'preesistente@test.it', NOW(), NOW())`,
      [VALID_BODY.vatNumber],
    );

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('tenant.vat_number_duplicate');

    // Exactly one tenant row with this VAT — the pre-seeded one.
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tenants WHERE vat_number = $1`,
      [VALID_BODY.vatNumber],
    );
    expect(rows[0]!.c).toBe('1');
  });

  // ── 4. Owner-email already in another tenant ──────────────────────────────────
  it('returns 409 user.invitation.email_in_other_tenant when Cognito resolves, writes no rows', async () => {
    // Override default: Cognito resolves → owner email belongs to an existing user
    // in the officine pool (i.e., another tenant). The handler throws before
    // entering the DB transaction, so no tenant / location / invitation row is written.
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: VALID_BODY.ownerEmail,
      UserAttributes: [
        { Name: 'sub', Value: 'existing-cognito-sub' },
        { Name: 'email', Value: VALID_BODY.ownerEmail },
      ],
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('user.invitation.email_in_other_tenant');

    // No tenant row must have been written (the DB tx was never entered).
    const { rows: tenantRows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tenants WHERE vat_number = $1`,
      [VALID_BODY.vatNumber],
    );
    expect(tenantRows[0]!.c).toBe('0');

    // No invitation row either.
    const { rows: invRows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM invitations WHERE target_email = $1`,
      [VALID_BODY.ownerEmail],
    );
    expect(invRows[0]!.c).toBe('0');

    // SES must not have been invoked — the handler short-circuits before email send.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  // ── 5. VAT invalid format ─────────────────────────────────────────────────────
  it('returns 400 tenant.vat_number_invalid when VAT is not 11 digits', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        ...VALID_BODY,
        vatNumber: 'ABC', // fails the /^[0-9]{11}$/ regex in the handler
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('tenant.vat_number_invalid');
  });
});

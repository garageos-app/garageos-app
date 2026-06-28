// Integration tests for POST /v1/admin/tenants/:id/regenerate-invitation
// — Slice 2 platform-admin recovery endpoint.
//
// Tier-1 coverage (from brief):
//   1. Pool isolation: no-auth 401, officine 403, clienti 403.
//   2. Happy path: active tenant + pending invite → 200; magicLinkUrl ends
//      with a 68-char token; old token dead at GET /v1/invitations/:old (404)
//      while new token resolves (200); expiresAt ≈ now+7d; audit row written.
//   3. Already-accepted invite → 410 user.invitation.already_accepted.
//   4. No invitation (legacy tenant) → 404 user.invitation.not_found.
//   5. Suspended tenant → 409 tenant.invalid_status.
//   6. Unknown tenant UUID → 404 tenant.not_found.
//   7. Non-UUID :id → 404 tenant.not_found (anti-enum).
//   8. Email transport throws → still 200 emailSent:false with valid magicLinkUrl.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import { _resetSesClientForTests } from '../../src/lib/ses-client.js';
import { hashToken } from '../../src/lib/secure-tokens.js';

import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

const sesMock = mockClient(SESv2Client);

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTenant(params: { status?: string } = {}): Promise<{
  tenantId: string;
  businessName: string;
}> {
  const { status = 'active' } = params;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const businessName = `Test Officina ${suffix}`;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO tenants
       (id, business_name, vat_number, email, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"TenantStatus", NOW(), NOW())
     RETURNING id`,
    [businessName, `${Math.floor(Math.random() * 1e11)}`, `${suffix}@test.it`, status],
  );
  return { tenantId: rows[0]!.id, businessName };
}

// Inserts an invitation row via pgAdmin (bypasses RLS — fixture only).
// Returns the invitation id and the raw token string (64-hex tokenHash).
// `tokenHash` is a fixed 64-char hex so the old-token test can probe the
// public-read endpoint with a known plaintext via the inverse hashToken lookup.
// Because we need a real plaintext→hash pair, we generate one here.
async function seedInvitation(params: {
  tenantId: string;
  targetEmail?: string;
  firstName?: string;
  lastName?: string;
  acceptedAt?: Date | null;
  expiresAt?: Date;
  tokenPlaintext?: string;
}): Promise<{ invitationId: string; tokenPlaintext: string; tokenHash: string }> {
  const {
    tenantId,
    targetEmail = 'owner@test.it',
    firstName = 'Mario',
    lastName = 'Rossi',
    acceptedAt = null,
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  } = params;

  // Generate a real token pair so we can probe the accept endpoint with the
  // correct plaintext (hashToken is the inverse — token → hash).
  // Use a fixed pair when the caller passes tokenPlaintext explicitly.
  const { randomUUID } = await import('node:crypto');
  const tokenPlaintext = params.tokenPlaintext ?? randomUUID() + randomUUID().replace(/-/g, '');
  const tokenHash = hashToken(tokenPlaintext);

  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, first_name, last_name,
        role, token_hash, expires_at, accepted_at, created_at)
     VALUES
       (gen_random_uuid(), $1, 'internal_user', $2, $3, $4, 'super_admin',
        $5, $6, $7, NOW())
     RETURNING id`,
    [tenantId, targetEmail, firstName, lastName, tokenHash, expiresAt, acceptedAt],
  );
  return { invitationId: rows[0]!.id, tokenPlaintext, tokenHash };
}

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/regenerate-invitation — pool isolation (integration)', () => {
  let app: FastifyInstance;
  const PLACEHOLDER_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

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
      url: `/v1/admin/tenants/${PLACEHOLDER_ID}/regenerate-invitation`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${PLACEHOLDER_ID}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 when a valid clienti token is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${PLACEHOLDER_ID}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
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

describe('POST /v1/admin/tenants/:id/regenerate-invitation — business cases (integration)', () => {
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
  });

  // ── 2. Happy path ─────────────────────────────────────────────────────────────
  it('returns 200 with magicLinkUrl (68-char token), kills old token, writes audit (happy path)', async () => {
    const { tenantId } = await seedTenant();
    const { tokenPlaintext: oldToken } = await seedInvitation({ tenantId });

    // Verify old token resolves BEFORE regeneration (sanity check).
    const readBeforeRes = await app.inject({
      method: 'GET',
      url: `/v1/invitations/${oldToken}`,
    });
    expect(readBeforeRes.statusCode).toBe(200);

    const adminSub = 'admin-sub-regen-happy';
    const token = await signTestToken({
      pool: 'platform-admins',
      sub: adminSub,
      extraClaims: { given_name: 'Luigi', family_name: 'Admin' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(200);

    type ResponseBody = {
      invitation: {
        ownerEmail: string;
        expiresAt: string;
        emailSent: boolean;
        magicLinkUrl: string;
      };
    };
    const body = res.json() as ResponseBody;

    // ── Response shape ────────────────────────────────────────────────────────
    expect(body.invitation.ownerEmail).toBe('owner@test.it');
    expect(body.invitation.emailSent).toBe(true);

    // magicLinkUrl ends with the 68-char plaintext token.
    const { magicLinkUrl } = body.invitation;
    expect(magicLinkUrl).toContain('/invitations/');
    const newToken = magicLinkUrl.split('/invitations/')[1]!;
    expect(newToken).toHaveLength(68);

    // expiresAt ≈ now + 7 days (±10 s tolerance).
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAtMs = new Date(body.invitation.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAtMs).toBeGreaterThan(now + sevenDaysMs - 10_000);
    expect(expiresAtMs).toBeLessThan(now + sevenDaysMs + 10_000);

    // ── Old token is now dead (hash no longer matches any row) ───────────────
    // GET /v1/invitations/:old_token should return 404 user.invitation.not_found
    // because the tokenHash was overwritten by the regenerate endpoint.
    const readOldRes = await app.inject({
      method: 'GET',
      url: `/v1/invitations/${oldToken}`,
    });
    expect(readOldRes.statusCode).toBe(404);
    expect((readOldRes.json() as { code: string }).code).toBe('user.invitation.not_found');

    // ── New token resolves correctly at GET /v1/invitations/:new_token ────────
    const readNewRes = await app.inject({
      method: 'GET',
      url: `/v1/invitations/${newToken}`,
    });
    expect(readNewRes.statusCode).toBe(200);
    type ReadBody = { invitation: { ownerEmail?: string; targetEmail?: string } };
    // invitations-public-read returns { targetEmail } as field name per the DTO.
    const readBody = readNewRes.json() as ReadBody;
    expect(readBody.invitation).toBeDefined();

    // ── DB: invitation row has new hash, old hash gone ────────────────────────
    const newTokenHash = hashToken(newToken);
    const { rows: invRows } = await pgAdmin.query<{
      token_hash: string;
      expires_at: Date;
    }>(`SELECT token_hash, expires_at FROM invitations WHERE tenant_id = $1`, [tenantId]);
    expect(invRows).toHaveLength(1);
    expect(invRows[0]!.token_hash).toBe(newTokenHash);
    // Confirm old hash is gone.
    expect(invRows[0]!.token_hash).not.toBe(hashToken(oldToken));

    // ── DB: audit_logs row written ────────────────────────────────────────────
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_type: string;
    }>(
      `SELECT action, actor_type, actor_id, entity_type
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'tenant_invitation_regenerated'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('tenant_invitation_regenerated');
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.entity_type).toBe('invitation');

    // SES called once for the regenerated invitation email.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  // ── 3. Already-accepted invitation ───────────────────────────────────────────
  it('returns 410 user.invitation.already_accepted when the invite has been accepted', async () => {
    const { tenantId } = await seedTenant();
    await seedInvitation({
      tenantId,
      acceptedAt: new Date(Date.now() - 1_000), // accepted 1 second ago
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(410);
    expect((res.json() as { code: string }).code).toBe('user.invitation.already_accepted');
  });

  // ── 4. No invitation row (legacy tenant) ──────────────────────────────────────
  it('returns 404 user.invitation.not_found when no invitation row exists', async () => {
    // Seed a tenant without seeding an invitation (legacy / manually provisioned).
    const { tenantId } = await seedTenant();

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.invitation.not_found');
  });

  // ── 5. Suspended tenant ───────────────────────────────────────────────────────
  // BR-210: a suspended/cancelled tenant must not onboard — regenerating a
  // magic-link for a suspended tenant is blocked.
  it('returns 409 tenant.invalid_status when the tenant is suspended (BR-210)', async () => {
    const { tenantId } = await seedTenant({ status: 'suspended' });
    await seedInvitation({ tenantId }); // pending invite exists but tenant is suspended

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('tenant.invalid_status');
  });

  // ── 6. Unknown tenant UUID ────────────────────────────────────────────────────
  it('returns 404 tenant.not_found for a well-formed UUID that does not exist', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${unknownId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 7. Non-UUID :id (anti-enum) ───────────────────────────────────────────────
  it('returns 404 tenant.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/not-a-uuid/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 8. Email transport throws → still 200 emailSent:false ────────────────────
  // The whole point of this endpoint: the operator can hand off the magicLinkUrl
  // directly even when the email transport is broken.
  it('returns 200 emailSent:false with valid magicLinkUrl when email transport throws', async () => {
    const { tenantId } = await seedTenant();
    await seedInvitation({ tenantId });

    // Override the SES mock to throw on this test.
    sesMock.reset();
    sesMock.on(SendEmailCommand).rejects(new Error('SES unavailable in test'));

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/regenerate-invitation`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    // Response is still 200 — email failure is best-effort.
    expect(res.statusCode).toBe(200);

    type ResponseBody = {
      invitation: {
        ownerEmail: string;
        expiresAt: string;
        emailSent: boolean;
        magicLinkUrl: string;
      };
    };
    const body = res.json() as ResponseBody;

    expect(body.invitation.emailSent).toBe(false);

    // magicLinkUrl is still valid and usable (the DB row was committed).
    const { magicLinkUrl } = body.invitation;
    expect(magicLinkUrl).toContain('/invitations/');
    const newToken = magicLinkUrl.split('/invitations/')[1]!;
    expect(newToken).toHaveLength(68);

    // New token resolves at the public-read endpoint → link is genuinely usable.
    const readRes = await app.inject({
      method: 'GET',
      url: `/v1/invitations/${newToken}`,
    });
    expect(readRes.statusCode).toBe(200);

    // Confirm the SES mock WAS called (failure was transport-level, not skipped).
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });
});

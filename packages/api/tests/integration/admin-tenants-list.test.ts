// Integration tests for GET /v1/admin/tenants — Slice 2 platform-admin list-tenants.
//
// Tier-1 security / business logic:
//   1. Pool isolation — officine 403, clienti 403, no-auth 401.
//   2. Happy path — 200; seeds 4 tenant shapes and verifies each owner status:
//        (a) pending invitation   → invitationStatus: 'pending'
//        (b) accepted invitation  → invitationStatus: 'accepted'  (suspended tenant still appears)
//        (c) expired invitation   → invitationStatus: 'expired'
//        (d) no invitation        → owner: null  (legacy / rebuild-tenants.mjs tenants)
//   3. Soft-deleted tenant excluded (deletedAt set).
//   4. Descending createdAt ordering verified.
//   5. Multiple invitations per tenant → most-recent wins.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import type { TenantAdminListItem } from '../../src/lib/dtos/tenant-admin.js';

import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('GET /v1/admin/tenants — pool isolation (integration)', () => {
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
    const res = await app.inject({ method: 'GET', url: '/v1/admin/tenants' });
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
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
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
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
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

// Helper: insert a tenant row via pgAdmin (bypasses RLS — fixture setup only).
// Returns the generated tenant id.
async function seedTenant(params: {
  businessName: string;
  vatNumber: string;
  email?: string;
  status?: string;
  createdAtOffset?: string; // e.g. "NOW() - INTERVAL '1 day'"
  deletedAt?: string | null; // e.g. "NOW()" or null
}): Promise<string> {
  const {
    businessName,
    vatNumber,
    email = `${vatNumber}@test.it`,
    status = 'active',
    createdAtOffset = 'NOW()',
    deletedAt = null,
  } = params;

  const deletedAtSql = deletedAt !== null ? deletedAt : 'NULL';

  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO tenants
       (id, business_name, vat_number, email, status, deleted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"TenantStatus",
             ${deletedAtSql}, ${createdAtOffset}, NOW())
     RETURNING id`,
    [businessName, vatNumber, email, status],
  );
  return rows[0]!.id;
}

// Helper: insert an invitation for a tenant via pgAdmin (bypasses RLS).
// token_hash is a fixed-length placeholder (64 hex chars) since the real
// magic-link token is irrelevant for list-endpoint tests.
async function seedInvitation(params: {
  tenantId: string;
  targetEmail: string;
  acceptedAt?: string | null; // SQL expr, e.g. "NOW() - INTERVAL '1 day'" or null
  expiresAt?: string; // SQL expr, e.g. "NOW() + INTERVAL '7 days'"
  createdAt?: string; // SQL expr for ordering control
  tokenHashSuffix?: string; // distinguish multiple rows per tenant (2 hex chars)
}): Promise<void> {
  const {
    tenantId,
    targetEmail,
    acceptedAt = null,
    expiresAt = "NOW() + INTERVAL '7 days'",
    createdAt = 'NOW()',
    tokenHashSuffix = 'aa',
  } = params;

  const acceptedAtSql = acceptedAt !== null ? acceptedAt : 'NULL';
  // token_hash must be unique (64-char hex). Build it from suffix + padding.
  const hash = tokenHashSuffix.padEnd(64, 'a');

  await pgAdmin.query(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, first_name, last_name,
        role, token_hash, expires_at, accepted_at, created_at)
     VALUES
       (gen_random_uuid(), $1, 'internal_user', $2, 'Owner', 'Test',
        'super_admin', $3, ${expiresAt}, ${acceptedAtSql}, ${createdAt})`,
    [tenantId, targetEmail, hash],
  );
}

describe('GET /v1/admin/tenants — business cases (integration)', () => {
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

  // ── 2. Four tenant shapes ─────────────────────────────────────────────────

  it('returns 200 with correct owner for each of the 4 tenant shapes (pending / accepted / expired / null)', async () => {
    // Seed tenants with different createdAt offsets so desc ordering is predictable.
    // A is newest → appears first in response.
    const [idA, idB, idC, idD] = await Promise.all([
      // Tenant A: active + pending invitation (newest)
      seedTenant({
        businessName: 'Officina A Pending',
        vatNumber: '11111111111',
        status: 'active',
        createdAtOffset: 'NOW()',
      }),
      // Tenant B: SUSPENDED + accepted invitation
      seedTenant({
        businessName: 'Officina B Accepted',
        vatNumber: '22222222222',
        status: 'suspended',
        createdAtOffset: "NOW() - INTERVAL '1 day'",
      }),
      // Tenant C: active + expired invitation
      seedTenant({
        businessName: 'Officina C Expired',
        vatNumber: '33333333333',
        status: 'active',
        createdAtOffset: "NOW() - INTERVAL '2 days'",
      }),
      // Tenant D: active + NO invitation (legacy)
      seedTenant({
        businessName: 'Officina D Legacy',
        vatNumber: '44444444444',
        status: 'active',
        createdAtOffset: "NOW() - INTERVAL '3 days'",
      }),
    ]);

    // Seed invitations for A, B, C; leave D with none.
    await Promise.all([
      seedInvitation({
        tenantId: idA,
        targetEmail: 'owner-a@test.it',
        acceptedAt: null,
        expiresAt: "NOW() + INTERVAL '7 days'",
        tokenHashSuffix: 'aa',
      }),
      seedInvitation({
        tenantId: idB,
        targetEmail: 'owner-b@test.it',
        acceptedAt: "NOW() - INTERVAL '2 days'",
        expiresAt: "NOW() + INTERVAL '5 days'",
        tokenHashSuffix: 'bb',
      }),
      seedInvitation({
        tenantId: idC,
        targetEmail: 'owner-c@test.it',
        acceptedAt: null,
        expiresAt: "NOW() - INTERVAL '1 day'", // expired
        tokenHashSuffix: 'cc',
      }),
    ]);

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    type ResponseBody = { tenants: TenantAdminListItem[] };
    const body = res.json() as ResponseBody;
    expect(Array.isArray(body.tenants)).toBe(true);

    // Exactly 4 tenants returned (soft-deleted not seeded here).
    expect(body.tenants).toHaveLength(4);

    // ── Ordering: newest first ──────────────────────────────────────────────
    // A (newest) → B → C → D (oldest). Verify by businessName.
    expect(body.tenants[0]!.businessName).toBe('Officina A Pending');
    expect(body.tenants[1]!.businessName).toBe('Officina B Accepted');
    expect(body.tenants[2]!.businessName).toBe('Officina C Expired');
    expect(body.tenants[3]!.businessName).toBe('Officina D Legacy');

    // ── createdAt is an ISO-8601 string ───────────────────────────────────
    for (const t of body.tenants) {
      expect(typeof t.createdAt).toBe('string');
      expect(isNaN(new Date(t.createdAt).getTime())).toBe(false);
    }

    // ── Tenant A: pending invitation ──────────────────────────────────────
    const tenantA = body.tenants[0]!;
    expect(tenantA.id).toBe(idA);
    expect(tenantA.owner).not.toBeNull();
    expect(tenantA.owner!.email).toBe('owner-a@test.it');
    expect(tenantA.owner!.invitationStatus).toBe('pending');

    // ── Tenant B: accepted invitation, SUSPENDED status (still in list) ──
    const tenantB = body.tenants[1]!;
    expect(tenantB.id).toBe(idB);
    expect(tenantB.status).toBe('suspended'); // suspended tenants still appear
    expect(tenantB.owner).not.toBeNull();
    expect(tenantB.owner!.email).toBe('owner-b@test.it');
    expect(tenantB.owner!.invitationStatus).toBe('accepted');

    // ── Tenant C: expired invitation ──────────────────────────────────────
    const tenantC = body.tenants[2]!;
    expect(tenantC.id).toBe(idC);
    expect(tenantC.owner).not.toBeNull();
    expect(tenantC.owner!.email).toBe('owner-c@test.it');
    expect(tenantC.owner!.invitationStatus).toBe('expired');

    // ── Tenant D: no invitation → owner: null ────────────────────────────
    const tenantD = body.tenants[3]!;
    expect(tenantD.id).toBe(idD);
    expect(tenantD.owner).toBeNull();
  });

  // ── 3. Soft-deleted tenant excluded ───────────────────────────────────────

  it('excludes tenants with deletedAt set', async () => {
    const [idActive] = await Promise.all([
      seedTenant({
        businessName: 'Officina Visibile',
        vatNumber: '55555555555',
        status: 'active',
        deletedAt: null,
      }),
      seedTenant({
        businessName: 'Officina Cancellata',
        vatNumber: '66666666666',
        status: 'active',
        deletedAt: 'NOW()',
      }),
    ]);

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenants: TenantAdminListItem[] };
    expect(body.tenants).toHaveLength(1);
    expect(body.tenants[0]!.id).toBe(idActive);
  });

  // ── 4. Empty list ──────────────────────────────────────────────────────────

  it('returns 200 with an empty array when no tenants exist', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenants: [] });
  });

  // ── 5. Multiple invitations → most-recent wins ────────────────────────────

  it('picks the most-recent invitation per tenant when multiple exist', async () => {
    const tenantId = await seedTenant({
      businessName: 'Officina Multi-Invite',
      vatNumber: '77777777777',
    });

    // Older invitation: pending (expiresAt future, acceptedAt null)
    await seedInvitation({
      tenantId,
      targetEmail: 'old-owner@test.it',
      acceptedAt: null,
      expiresAt: "NOW() + INTERVAL '7 days'",
      createdAt: "NOW() - INTERVAL '2 days'", // older
      tokenHashSuffix: 'dd',
    });

    // Newer invitation: accepted (most recent → must win)
    await seedInvitation({
      tenantId,
      targetEmail: 'new-owner@test.it',
      acceptedAt: "NOW() - INTERVAL '1 day'",
      expiresAt: "NOW() + INTERVAL '6 days'",
      createdAt: "NOW() - INTERVAL '1 day'", // newer
      tokenHashSuffix: 'ee',
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenants: TenantAdminListItem[] };
    expect(body.tenants).toHaveLength(1);

    const t = body.tenants[0]!;
    // Most-recent (newer, accepted) invitation wins over older pending one.
    expect(t.owner!.email).toBe('new-owner@test.it');
    expect(t.owner!.invitationStatus).toBe('accepted');
  });
});

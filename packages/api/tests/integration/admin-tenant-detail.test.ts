// Integration tests for GET  /v1/admin/tenants/:id
//                  and PATCH /v1/admin/tenants/:id
//
// Tier-1 security / business logic — platform-admin tenant detail + profile edit.
//
// Test groups:
//   1. Pool isolation (shared for both endpoints): 403 officine, 403 clienti.
//   2. GET happy path: 200, all TENANT_ME fields present.
//   3. GET unknown UUID → 404 tenant.not_found.
//   4. GET malformed UUID → 404 tenant.not_found (anti-enum).
//   5. PATCH happy path: edits businessName + phone → 200, row updated,
//      audit row tenant_profile_updated with actorType:'system' +
//      metadata.actorCognitoSub.
//   6. PATCH vatNumber duplicate (used by another tenant) → 409 tenant.vat_number_duplicate.
//   7. PATCH malformed vatNumber (not 11 digits) → 400 tenant.vat_number_invalid.
//   8. PATCH unknown key → 422 tenants.me.update.unknown_field.
//   9. PATCH empty body → 422 tenants.me.update.empty_body.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// ─── Seed helper ─────────────────────────────────────────────────────────────
// Inserts a tenant row via pgAdmin (bypasses RLS — fixture setup only).
// Returns the generated tenant id. Unique VAT per call avoids collisions.
async function seedTenant(params: {
  vatNumber: string;
  businessName?: string;
  email?: string;
  status?: string;
}): Promise<string> {
  const {
    vatNumber,
    businessName = `Test Officina ${vatNumber}`,
    email = `${vatNumber}@test.it`,
    status = 'active',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO tenants
       (id, business_name, vat_number, email, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"TenantStatus", NOW(), NOW())
     RETURNING id`,
    [businessName, vatNumber, email, status],
  );
  return rows[0]!.id;
}

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('GET /v1/admin/tenants/:id — pool isolation (integration)', () => {
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

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${id}`,
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
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${id}`,
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

describe('PATCH /v1/admin/tenants/:id — pool isolation (integration)', () => {
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

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${id}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ businessName: 'Test' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('returns 403 FORBIDDEN when a valid clienti token is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${id}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ businessName: 'Test' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });
});

// ─── 2–9. Business cases ──────────────────────────────────────────────────────

describe('GET + PATCH /v1/admin/tenants/:id — business cases (integration)', () => {
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

  // ── 2. GET happy path ────────────────────────────────────────────────────────
  it('returns 200 with all TENANT_ME fields for an existing tenant (platform-admin)', async () => {
    const vatNumber = '10000000001';
    const tenantId = await seedTenant({ vatNumber, businessName: 'Officina Test' });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    type TenantDto = {
      id: string;
      businessName: string;
      vatNumber: string;
      email: string;
      phone: unknown;
      addressLine: unknown;
      city: unknown;
      province: unknown;
      postalCode: unknown;
      status: string;
      plan: string;
      billingStatus: string;
      createdAt: string;
      onboardingCompletedAt: string | null;
    };
    const body = res.json() as { tenant: TenantDto };
    expect(body.tenant.id).toBe(tenantId);
    expect(body.tenant.businessName).toBe('Officina Test');
    expect(body.tenant.vatNumber).toBe(vatNumber);
    // Verify all TENANT_ME fields are present in the response.
    expect(body.tenant).toHaveProperty('email');
    expect(body.tenant).toHaveProperty('phone');
    expect(body.tenant).toHaveProperty('addressLine');
    expect(body.tenant).toHaveProperty('city');
    expect(body.tenant).toHaveProperty('province');
    expect(body.tenant).toHaveProperty('postalCode');
    expect(body.tenant).toHaveProperty('status');
    expect(body.tenant).toHaveProperty('plan');
    expect(body.tenant).toHaveProperty('billingStatus');
    expect(body.tenant).toHaveProperty('createdAt');
    expect(body.tenant).toHaveProperty('onboardingCompletedAt');
    // settings must NOT leak through serializeTenantMe.
    expect(body.tenant).not.toHaveProperty('settings');
  });

  // ── 3. GET unknown UUID → 404 tenant.not_found ──────────────────────────────
  it('returns 404 tenant.not_found for an unknown (valid-format) UUID', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${unknownId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 4. GET malformed UUID → 404 tenant.not_found (anti-enum) ────────────────
  it('returns 404 tenant.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 5. PATCH happy path ──────────────────────────────────────────────────────
  it('edits businessName + phone, returns 200 with updated row and writes audit log', async () => {
    const vatNumber = '20000000002';
    const tenantId = await seedTenant({ vatNumber });
    const adminSub = 'admin-sub-patch-happy';
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ businessName: 'Officina Aggiornata', phone: '+39 333 0000001' }),
    });

    expect(res.statusCode).toBe(200);
    type TenantDto = { id: string; businessName: string; phone: string | null };
    const body = res.json() as { tenant: TenantDto };
    expect(body.tenant.id).toBe(tenantId);
    expect(body.tenant.businessName).toBe('Officina Aggiornata');
    expect(body.tenant.phone).toBe('+39 333 0000001');

    // DB: verify row was actually updated.
    const { rows: tenantRows } = await pgAdmin.query<{
      business_name: string;
      phone: string | null;
    }>(`SELECT business_name, phone FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenantRows[0]!.business_name).toBe('Officina Aggiornata');
    expect(tenantRows[0]!.phone).toBe('+39 333 0000001');

    // DB: audit log tenant_profile_updated with actorType:'system' and
    // metadata.actorCognitoSub matching the signed token sub.
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_id: string;
      metadata: unknown;
    }>(
      `SELECT action, actor_type, actor_id, entity_id, metadata
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'tenant_profile_updated'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('tenant_profile_updated');
    // Platform admins have no tenant User row → actorType='system', actorId=null.
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.entity_id).toBe(tenantId);
    // metadata must carry actorCognitoSub from the JWT.
    const metadata = auditRows[0]!.metadata as Record<string, unknown>;
    expect(metadata.actorCognitoSub).toBe(adminSub);
    expect(Array.isArray(metadata.changed)).toBe(true);
  });

  // ── 6. PATCH vatNumber duplicate → 409 tenant.vat_number_duplicate ───────────
  it('returns 409 tenant.vat_number_duplicate when vatNumber is used by another tenant', async () => {
    // Seed two tenants with different VATs.
    const vatA = '30000000003';
    const vatB = '40000000004';
    const tenantA = await seedTenant({ vatNumber: vatA });
    await seedTenant({ vatNumber: vatB }); // tenantB's VAT is taken
    const token = await signTestToken({ pool: 'platform-admins' });

    // Attempt to update tenantA's VAT to vatB — collision expected.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantA}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ vatNumber: vatB }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.vat_number_duplicate');
  });

  // ── 7. PATCH malformed vatNumber → 400 tenant.vat_number_invalid ─────────────
  it('returns 400 tenant.vat_number_invalid for a vatNumber that is not 11 digits', async () => {
    const vatNumber = '50000000005';
    const tenantId = await seedTenant({ vatNumber });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ vatNumber: '123' }), // too short
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.vat_number_invalid');
  });

  // ── 8. PATCH unknown key → 422 tenants.me.update.unknown_field ───────────────
  it('returns 422 tenants.me.update.unknown_field for an unknown key in body', async () => {
    const vatNumber = '60000000006';
    const tenantId = await seedTenant({ vatNumber });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ nonExistentField: 'value' }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenants.me.update.unknown_field');
  });

  // ── 9. PATCH empty body → 422 tenants.me.update.empty_body ──────────────────
  it('returns 422 tenants.me.update.empty_body when body has no recognized fields', async () => {
    const vatNumber = '70000000007';
    const tenantId = await seedTenant({ vatNumber });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenants.me.update.empty_body');
  });
});

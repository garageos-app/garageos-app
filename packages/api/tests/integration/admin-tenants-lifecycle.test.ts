// Integration tests for POST /v1/admin/tenants/:id/suspend
//                  and POST /v1/admin/tenants/:id/reactivate
//
// Tier-1 security / business logic — BR-210 lifecycle transitions.
//
// Test groups:
//   1. Pool isolation (shared for both endpoints): 401, 403 officine, 403 clienti.
//   2. suspend happy path: active → suspended + audit row tenant_suspended.
//   3. suspend already-suspended → 409 tenant.invalid_status.
//   4. reactivate happy path: suspended → active + audit row tenant_reactivated.
//   5. reactivate already-active → 409 tenant.invalid_status.
//   6. Unknown UUID → 404 tenant.not_found.
//   7. Non-UUID :id → 404 tenant.not_found (anti-enum).
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
// Returns the generated tenant id.
async function seedTenant(params: { vatNumber: string; status?: string }): Promise<string> {
  const { vatNumber, status = 'active' } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO tenants
       (id, business_name, vat_number, email, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"TenantStatus", NOW(), NOW())
     RETURNING id`,
    [`Test Officina ${vatNumber}`, vatNumber, `${vatNumber}@test.it`, status],
  );
  return rows[0]!.id;
}

// ─── 1. Pool isolation (suspend) ─────────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/suspend — pool isolation (integration)', () => {
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
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/suspend`,
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

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/suspend`,
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

  it('returns 403 FORBIDDEN when a valid clienti token is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/suspend`,
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

// ─── 1b. Pool isolation (reactivate) ─────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/reactivate — pool isolation (integration)', () => {
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
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/reactivate`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: 401 });
  });

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/reactivate`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 FORBIDDEN when a valid clienti token is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${id}/reactivate`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 2–7. Business cases ─────────────────────────────────────────────────────

describe('POST /v1/admin/tenants/:id/suspend|reactivate — business cases (integration)', () => {
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

  // ── 2. suspend happy path ────────────────────────────────────────────────────
  it('suspends an active tenant and writes tenant_suspended audit row (BR-210)', async () => {
    const tenantId = await seedTenant({ vatNumber: '11111111111', status: 'active' });
    const adminSub = 'admin-sub-suspend-happy';
    const token = await signTestToken({
      pool: 'platform-admins',
      sub: adminSub,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/suspend`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(200);

    type ResponseBody = { tenant: { id: string; status: string } };
    const body = res.json() as ResponseBody;
    expect(body.tenant.id).toBe(tenantId);
    expect(body.tenant.status).toBe('suspended');

    // ── DB: tenant row updated ──────────────────────────────────────────────
    const { rows: tenantRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(tenantRows[0]!.status).toBe('suspended');

    // ── DB: audit log written in-tx ─────────────────────────────────────────
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_id: string;
    }>(
      `SELECT action, actor_type, actor_id, entity_id
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'tenant_suspended'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('tenant_suspended');
    // Platform admins have no tenant User row → actorType='system', actorId=null.
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.entity_id).toBe(tenantId);
  });

  // ── 3. suspend already-suspended → 409 tenant.invalid_status ────────────────
  it('returns 409 tenant.invalid_status when suspending an already-suspended tenant (BR-210)', async () => {
    const tenantId = await seedTenant({ vatNumber: '22222222222', status: 'suspended' });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/suspend`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.invalid_status');

    // DB: tenant status must not have changed.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(rows[0]!.status).toBe('suspended');
  });

  // ── 4. reactivate happy path ─────────────────────────────────────────────────
  it('reactivates a suspended tenant and writes tenant_reactivated audit row (BR-210)', async () => {
    const tenantId = await seedTenant({ vatNumber: '33333333333', status: 'suspended' });
    const adminSub = 'admin-sub-reactivate-happy';
    const token = await signTestToken({
      pool: 'platform-admins',
      sub: adminSub,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/reactivate`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(200);

    type ResponseBody = { tenant: { id: string; status: string } };
    const body = res.json() as ResponseBody;
    expect(body.tenant.id).toBe(tenantId);
    expect(body.tenant.status).toBe('active');

    // ── DB: tenant row updated ──────────────────────────────────────────────
    const { rows: tenantRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(tenantRows[0]!.status).toBe('active');

    // ── DB: audit log written in-tx ─────────────────────────────────────────
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_id: string;
    }>(
      `SELECT action, actor_type, actor_id, entity_id
         FROM audit_logs
        WHERE tenant_id = $1 AND action = 'tenant_reactivated'`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('tenant_reactivated');
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.entity_id).toBe(tenantId);
  });

  // ── 5. reactivate already-active → 409 tenant.invalid_status ───────────────
  it('returns 409 tenant.invalid_status when reactivating an already-active tenant (BR-210)', async () => {
    const tenantId = await seedTenant({ vatNumber: '44444444444', status: 'active' });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/reactivate`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.invalid_status');

    // DB: tenant status must not have changed.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(rows[0]!.status).toBe('active');
  });

  // ── 6. Unknown UUID → 404 tenant.not_found ───────────────────────────────────
  it('returns 404 tenant.not_found for an unknown (valid-format) UUID on suspend', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    // Valid UUID v4 that does not exist in the DB.
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${unknownId}/suspend`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  it('returns 404 tenant.not_found for an unknown (valid-format) UUID on reactivate', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${unknownId}/reactivate`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  // ── 7. Non-UUID :id → 404 tenant.not_found (anti-enum) ──────────────────────
  // An invalid UUID format is treated identically to an unknown UUID to avoid
  // leaking which IDs are valid (anti-enumeration).
  it('returns 404 tenant.not_found for a non-UUID :id on suspend (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants/not-a-uuid/suspend',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });

  it('returns 404 tenant.not_found for a non-UUID :id on reactivate (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants/not-a-uuid/reactivate',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('tenant.not_found');
  });
});

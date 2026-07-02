// Integration tests for the platform-admin intervention-type catalog CRUD:
//   GET    /v1/admin/intervention-types
//   POST   /v1/admin/intervention-types
//   PATCH  /v1/admin/intervention-types/:id
//   DELETE /v1/admin/intervention-types/:id
//
// Tier-1 security / business logic — platform-admin catalog governance.
// BR-306: catalogo scrivibile solo dal platform admin (requirePlatformAdminsPool
// + RLS is_admin_role()).
//
// Test groups:
//   1. Pool isolation: 403 officine, 403 clienti on GET and POST.
//   2. GET happy path: includes an inactive seeded type + checklistItemCount +
//      category→nameIt ordering.
//   3. POST happy path: 201, row persisted with tenant_id IS NULL, audit row.
//   4. POST duplicate global code → 409 admin.intervention_type.code_conflict
//      (app-layer pre-check, NOT a P2002 catch).
//   5. POST invalid body (category out of enum) → 400 VALIDATION_ERROR.
//   6. PATCH happy path → 200, field updated.
//   7. PATCH unknown id → 404 admin.intervention_type.not_found.
//   8. PATCH unknown field (.strict()) → 400 VALIDATION_ERROR.
//   9. DELETE unused type → 204, row gone, checklist items cascade-deleted.
//  10. DELETE type referenced by an intervention → 409 admin.intervention_type.in_use.
//  11. DELETE unknown id → 404 admin.intervention_type.not_found.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.
// NOTE: resetDb() does NOT truncate intervention_types (see helpers.ts) —
// every seeded code in this file uses a unique random suffix to avoid
// collisions with rows left behind by other tests / db:seed data.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { createIntervention, createTenant, createUser, createVehicle, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// ─── Seed helpers ────────────────────────────────────────────────────────────

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Inserts a GLOBAL intervention type (tenant_id IS NULL) directly via
// pgAdmin (bypasses RLS — fixture setup only). @updatedAt columns require
// an explicit updated_at = NOW() on raw INSERT.
async function seedGlobalType(params: {
  code?: string;
  nameIt?: string;
  description?: string | null;
  category?: 'maintenance' | 'repair' | 'tires' | 'body' | 'inspection' | 'other';
  active?: boolean;
  suggestsDeadline?: boolean;
  defaultDeadlineMonths?: number | null;
  defaultDeadlineKm?: number | null;
}): Promise<{ id: string; code: string }> {
  const {
    code = uniqueCode('ZTEST'),
    nameIt = `Test type ${code}`,
    description = null,
    category = 'maintenance',
    active = true,
    suggestsDeadline = false,
    defaultDeadlineMonths = null,
    defaultDeadlineKm = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, description, category, suggests_deadline,
        default_deadline_months, default_deadline_km, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2, $3, $4::"InterventionTypeCategory", $5, $6, $7, $8, NOW(), NOW())
     RETURNING id`,
    [
      code,
      nameIt,
      description,
      category,
      suggestsDeadline,
      defaultDeadlineMonths,
      defaultDeadlineKm,
      active,
    ],
  );
  return { id: rows[0]!.id, code };
}

async function seedChecklistItem(params: {
  interventionTypeId: string;
  code?: string;
  nameIt?: string;
  sortOrder?: number;
  active?: boolean;
}): Promise<{ id: string; code: string }> {
  const {
    interventionTypeId,
    code = uniqueCode('ITEM'),
    nameIt = `Test item ${code}`,
    sortOrder = 0,
    active = true,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_items
       (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id`,
    [interventionTypeId, code, nameIt, sortOrder, active],
  );
  return { id: rows[0]!.id, code };
}

type InterventionTypeAdminDto = {
  id: string;
  code: string;
  nameIt: string;
  description: string | null;
  icon: string | null;
  category: string;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
  active: boolean;
  checklistItemCount: number;
  createdAt: string;
  updatedAt: string;
};

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('Admin intervention-types — pool isolation (integration)', () => {
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

  it('GET returns 403 FORBIDDEN with an officine token', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('GET returns 403 FORBIDDEN with a clienti token', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('POST returns 403 FORBIDDEN with an officine token', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        code: uniqueCode('POOL'),
        nameIt: 'Test',
        category: 'maintenance',
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('POST returns 403 FORBIDDEN with a clienti token', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        code: uniqueCode('POOL'),
        nameIt: 'Test',
        category: 'maintenance',
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });
});

// ─── 2–11. Business cases ──────────────────────────────────────────────────────

describe('Admin intervention-types — business cases (integration)', () => {
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
  it('GET includes an inactive type + correct checklistItemCount + category→nameIt order', async () => {
    // Two types in DIFFERENT categories so relative ordering is checkable
    // regardless of pre-existing rows in the table (resetDb does not
    // truncate intervention_types — see helpers.ts).
    const bodyTypeA = await seedGlobalType({ category: 'body', nameIt: 'ZZZ Body type' });
    const maintenanceTypeB = await seedGlobalType({
      category: 'maintenance',
      nameIt: 'AAA Maint type',
    });
    const inactiveType = await seedGlobalType({ category: 'other', active: false });
    await seedChecklistItem({ interventionTypeId: inactiveType.id });
    await seedChecklistItem({ interventionTypeId: inactiveType.id });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeAdminDto[] };
    const codes = body.data.map((t) => t.code);

    // Inactive type is included (unlike the officine-facing endpoint).
    const inactiveDto = body.data.find((t) => t.code === inactiveType.code);
    expect(inactiveDto).toBeDefined();
    expect(inactiveDto!.active).toBe(false);
    expect(inactiveDto!.checklistItemCount).toBe(2);

    // category asc → nameIt asc: 'body' < 'maintenance' alphabetically, so
    // bodyTypeA must appear before maintenanceTypeB regardless of other rows.
    expect(codes.indexOf(bodyTypeA.code)).toBeLessThan(codes.indexOf(maintenanceTypeB.code));

    const activeDto = body.data.find((t) => t.code === maintenanceTypeB.code);
    expect(activeDto!.checklistItemCount).toBe(0);
  });

  // ── 3. POST happy path ───────────────────────────────────────────────────────
  it('POST creates a global type, persists tenant_id NULL, writes audit row', async () => {
    const code = uniqueCode('POSTOK');
    const adminSub = 'admin-sub-post-happy';
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        code,
        nameIt: 'Tagliando test',
        category: 'maintenance',
        suggestsDeadline: true,
        defaultDeadlineMonths: 12,
        defaultDeadlineKm: 15000,
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { interventionType: InterventionTypeAdminDto };
    expect(body.interventionType.code).toBe(code);
    expect(body.interventionType.checklistItemCount).toBe(0);

    const { rows } = await pgAdmin.query<{ tenant_id: string | null; code: string }>(
      `SELECT tenant_id, code FROM intervention_types WHERE code = $1`,
      [code],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBeNull();

    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_id: string;
      tenant_id: string | null;
      metadata: unknown;
    }>(
      `SELECT action, actor_type, actor_id, entity_id, tenant_id, metadata
         FROM audit_logs WHERE action = 'intervention_type_created' AND entity_id = $1`,
      [body.interventionType.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.tenant_id).toBeNull();
    const metadata = auditRows[0]!.metadata as Record<string, unknown>;
    expect(metadata.actorCognitoSub).toBe(adminSub);
  });

  // ── 4. POST duplicate global code → 409 ──────────────────────────────────────
  it('POST returns 409 admin.intervention_type.code_conflict for a duplicate global code', async () => {
    const existing = await seedGlobalType({});
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        code: existing.code,
        nameIt: 'Duplicato',
        category: 'maintenance',
      }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.code_conflict');
  });

  // ── 5. POST invalid body → 400 VALIDATION_ERROR ──────────────────────────────
  it('POST returns 400 VALIDATION_ERROR when category is out of enum', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        code: uniqueCode('BADCAT'),
        nameIt: 'Test',
        category: 'not-a-real-category',
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    const json = res.json() as { code: string; errors?: unknown[] };
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors!.length).toBeGreaterThan(0);
  });

  // ── 6. PATCH happy path ──────────────────────────────────────────────────────
  it('PATCH updates an editable field and returns 200', async () => {
    const seeded = await seedGlobalType({ nameIt: 'Nome originale' });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/intervention-types/${seeded.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Nome aggiornato' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionType: InterventionTypeAdminDto };
    expect(body.interventionType.nameIt).toBe('Nome aggiornato');

    const { rows } = await pgAdmin.query<{ name_it: string }>(
      `SELECT name_it FROM intervention_types WHERE id = $1`,
      [seeded.id],
    );
    expect(rows[0]!.name_it).toBe('Nome aggiornato');

    const { rows: auditRows } = await pgAdmin.query(
      `SELECT action FROM audit_logs WHERE action = 'intervention_type_updated' AND entity_id = $1`,
      [seeded.id],
    );
    expect(auditRows).toHaveLength(1);
  });

  // ── 6b. PATCH description: null → clears a previously set value ─────────────
  it('PATCH with description: null clears a previously set description (SQL NULL)', async () => {
    const seeded = await seedGlobalType({ description: 'Descrizione originale' });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/intervention-types/${seeded.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ description: null }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionType: InterventionTypeAdminDto };
    expect(body.interventionType.description).toBeNull();

    const { rows } = await pgAdmin.query<{ description: string | null }>(
      `SELECT description FROM intervention_types WHERE id = $1`,
      [seeded.id],
    );
    expect(rows[0]!.description).toBeNull();
  });

  // ── 7. PATCH unknown id → 404 ────────────────────────────────────────────────
  it('PATCH returns 404 admin.intervention_type.not_found for an unknown id', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/intervention-types/${unknownId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Non importa' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  // ── 7b. PATCH malformed UUID → 404 (anti-enum) ───────────────────────────────
  it('PATCH returns 404 admin.intervention_type.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/intervention-types/not-a-uuid',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Non importa' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  // ── 8. PATCH unknown field → 400 VALIDATION_ERROR ────────────────────────────
  it('PATCH returns 400 VALIDATION_ERROR for an unrecognized field (.strict())', async () => {
    const seeded = await seedGlobalType({});
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/intervention-types/${seeded.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'SHOULD_NOT_BE_EDITABLE' }),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  // ── 9. DELETE unused type → 204 + cascade ────────────────────────────────────
  it('DELETE removes an unused type and cascades its checklist items', async () => {
    const seeded = await seedGlobalType({});
    const item = await seedChecklistItem({ interventionTypeId: seeded.id });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/intervention-types/${seeded.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const { rows: typeRows } = await pgAdmin.query(
      `SELECT id FROM intervention_types WHERE id = $1`,
      [seeded.id],
    );
    expect(typeRows).toHaveLength(0);

    const { rows: itemRows } = await pgAdmin.query(
      `SELECT id FROM intervention_checklist_items WHERE id = $1`,
      [item.id],
    );
    expect(itemRows).toHaveLength(0);

    const { rows: auditRows } = await pgAdmin.query(
      `SELECT action FROM audit_logs WHERE action = 'intervention_type_deleted' AND entity_id = $1`,
      [seeded.id],
    );
    expect(auditRows).toHaveLength(1);
  });

  // ── 10. DELETE referenced type → 409 in_use ──────────────────────────────────
  it('DELETE returns 409 admin.intervention_type.in_use when referenced by an intervention', async () => {
    const seeded = await seedGlobalType({});
    const { tenantId } = await createTenant();
    const { userId } = await createUser({ tenantId, cognitoSub: `sub-${randomUUID()}` });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: seeded.id,
      interventionDate: '2026-01-01',
      odometerKm: 50000,
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/intervention-types/${seeded.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.in_use');

    // Row must NOT have been deleted.
    const { rows } = await pgAdmin.query(`SELECT id FROM intervention_types WHERE id = $1`, [
      seeded.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  // ── 11. DELETE unknown id → 404 ───────────────────────────────────────────────
  it('DELETE returns 404 admin.intervention_type.not_found for an unknown id', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/intervention-types/${unknownId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });
});

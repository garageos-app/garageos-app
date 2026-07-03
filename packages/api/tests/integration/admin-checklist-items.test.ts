// Integration tests for the platform-admin checklist-item catalog CRUD:
//   GET    /v1/admin/intervention-types/:id/checklist-items
//   POST   /v1/admin/intervention-types/:id/checklist-items
//   PATCH  /v1/admin/checklist-items/:id
//   DELETE /v1/admin/checklist-items/:id
//
// Tier-1 security / business logic — platform-admin catalog governance.
// BR-306: catalogo scrivibile solo dal platform admin (requirePlatformAdminsPool
// + RLS is_admin_role()). BR-307: code univoco per tipo (uq_checklist_item_code_type).
//
// Test groups:
//   1. Pool isolation: 403 officine, 403 clienti on the nested GET and POST.
//   2. GET happy path: includes an inactive item, ordered sortOrder→nameIt.
//   3. GET for an unknown parent type → 404 admin.intervention_type.not_found.
//   4. POST happy path: 201, row persisted, audit row.
//   5. POST duplicate code within the SAME type → 409 admin.checklist_item.code_conflict.
//   6. POST same code on a DIFFERENT type → 201 (proves per-type scoping).
//   7. POST for an unknown parent type → 404 admin.intervention_type.not_found.
//   8. PATCH happy path → 200, field updated, audit row.
//   9. PATCH unknown id → 404 admin.checklist_item.not_found.
//  10. PATCH unrecognized field (.strict()) → 400 VALIDATION_ERROR.
//  11. DELETE → 204, row gone, audit row.
//  12. DELETE unknown id → 404 admin.checklist_item.not_found.
//  13. Snapshot survival (BR-303/D8): deleting a checklist item referenced by
//      an intervention_checklist_selections row nulls checklist_item_id but
//      preserves label_snapshot.
//  14. Anti-enum: malformed UUID on every route → same 404 as an unknown id.
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
}): Promise<{ id: string; code: string }> {
  const { code = uniqueCode('ZTYPE'), nameIt = `Test type ${code}` } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, suggests_deadline,
        default_deadline_months, default_deadline_km, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2, false, NULL, NULL, true, NOW(), NOW())
     RETURNING id`,
    [code, nameIt],
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

// Direct pgAdmin insert of an intervention_checklist_selections row
// (bypasses RLS — fixture setup only, mirrors createIntervention). Used
// exclusively by the snapshot-survival test (item l): label_snapshot and
// checklist_item_id are the two columns that matter post-DELETE.
async function seedChecklistSelection(params: {
  interventionId: string;
  tenantId: string;
  checklistItemId: string;
  labelSnapshot: string;
}): Promise<{ id: string }> {
  const { interventionId, tenantId, checklistItemId, labelSnapshot } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_selections
       (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
     RETURNING id`,
    [interventionId, tenantId, checklistItemId, labelSnapshot],
  );
  return { id: rows[0]!.id };
}

type ChecklistItemAdminDto = {
  id: string;
  interventionTypeId: string;
  code: string;
  nameIt: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('Admin checklist-items — pool isolation (integration)', () => {
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
    const type = await seedGlobalType({});
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
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
    const type = await seedGlobalType({});
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('POST returns 403 FORBIDDEN with an officine token', async () => {
    const type = await seedGlobalType({});
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: uniqueCode('POOL'), nameIt: 'Test' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('POST returns 403 FORBIDDEN with a clienti token', async () => {
    const type = await seedGlobalType({});
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: uniqueCode('POOL'), nameIt: 'Test' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });
});

// ─── 2–14. Business cases ───────────────────────────────────────────────────

describe('Admin checklist-items — business cases (integration)', () => {
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
  it('GET includes an inactive item, ordered sortOrder asc then nameIt asc', async () => {
    const type = await seedGlobalType({});
    const itemB = await seedChecklistItem({
      interventionTypeId: type.id,
      sortOrder: 1,
      nameIt: 'ZZZ second',
    });
    const itemA = await seedChecklistItem({
      interventionTypeId: type.id,
      sortOrder: 0,
      nameIt: 'AAA first',
    });
    const inactiveItem = await seedChecklistItem({
      interventionTypeId: type.id,
      sortOrder: 0,
      nameIt: 'BBB inactive',
      active: false,
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: ChecklistItemAdminDto[] };
    expect(body.data).toHaveLength(3);

    const codes = body.data.map((i) => i.code);
    // sortOrder 0 group (itemA, inactiveItem) sorted by nameIt: AAA < BBB.
    // itemB (sortOrder 1) comes last.
    expect(codes).toEqual([itemA.code, inactiveItem.code, itemB.code]);

    const inactiveDto = body.data.find((i) => i.code === inactiveItem.code);
    expect(inactiveDto!.active).toBe(false);
  });

  // ── 3. GET unknown parent type → 404 ─────────────────────────────────────────
  it('GET returns 404 admin.intervention_type.not_found for an unknown parent type', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intervention-types/${unknownId}/checklist-items`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  // ── 4. POST happy path ───────────────────────────────────────────────────────
  it('POST creates a checklist item, persists it, writes audit row', async () => {
    const type = await seedGlobalType({});
    const code = uniqueCode('POSTOK');
    const adminSub = 'admin-sub-post-happy';
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code, nameIt: 'Controllo livelli', sortOrder: 3 }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { checklistItem: ChecklistItemAdminDto };
    expect(body.checklistItem.code).toBe(code);
    expect(body.checklistItem.interventionTypeId).toBe(type.id);
    expect(body.checklistItem.sortOrder).toBe(3);
    expect(body.checklistItem.active).toBe(true);

    const { rows } = await pgAdmin.query<{ intervention_type_id: string; code: string }>(
      `SELECT intervention_type_id, code FROM intervention_checklist_items WHERE code = $1`,
      [code],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intervention_type_id).toBe(type.id);

    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      entity_type: string;
      entity_id: string;
      tenant_id: string | null;
      metadata: unknown;
    }>(
      `SELECT action, actor_type, actor_id, entity_type, entity_id, tenant_id, metadata
         FROM audit_logs WHERE action = 'checklist_item_created' AND entity_id = $1`,
      [body.checklistItem.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.entity_type).toBe('intervention_checklist_item');
    expect(auditRows[0]!.actor_type).toBe('system');
    expect(auditRows[0]!.actor_id).toBeNull();
    expect(auditRows[0]!.tenant_id).toBeNull();
    const metadata = auditRows[0]!.metadata as Record<string, unknown>;
    expect(metadata.actorCognitoSub).toBe(adminSub);
  });

  // ── 5. POST duplicate code within the SAME type → 409 ────────────────────────
  it('POST returns 409 admin.checklist_item.code_conflict for a duplicate code in the same type', async () => {
    const type = await seedGlobalType({});
    const existing = await seedChecklistItem({ interventionTypeId: type.id });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${type.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: existing.code, nameIt: 'Duplicato' }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('admin.checklist_item.code_conflict');
  });

  // ── 6. POST same code on a DIFFERENT type → 201 (per-type scoping) ──────────
  it('POST allows the same code on a different type (scoped uniqueness)', async () => {
    const typeA = await seedGlobalType({});
    const typeB = await seedGlobalType({});
    const existing = await seedChecklistItem({ interventionTypeId: typeA.id });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${typeB.id}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: existing.code, nameIt: 'Stesso codice, altro tipo' }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { checklistItem: ChecklistItemAdminDto };
    expect(body.checklistItem.code).toBe(existing.code);
    expect(body.checklistItem.interventionTypeId).toBe(typeB.id);
  });

  // ── 7. POST unknown parent type → 404 ────────────────────────────────────────
  it('POST returns 404 admin.intervention_type.not_found for an unknown parent type', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intervention-types/${unknownId}/checklist-items`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: uniqueCode('ORPHAN'), nameIt: 'Test' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  // ── 8. PATCH happy path ──────────────────────────────────────────────────────
  it('PATCH updates an editable field and returns 200', async () => {
    const type = await seedGlobalType({});
    const seeded = await seedChecklistItem({
      interventionTypeId: type.id,
      nameIt: 'Nome originale',
    });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/checklist-items/${seeded.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Nome aggiornato', active: false }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { checklistItem: ChecklistItemAdminDto };
    expect(body.checklistItem.nameIt).toBe('Nome aggiornato');
    expect(body.checklistItem.active).toBe(false);

    const { rows } = await pgAdmin.query<{ name_it: string; active: boolean }>(
      `SELECT name_it, active FROM intervention_checklist_items WHERE id = $1`,
      [seeded.id],
    );
    expect(rows[0]!.name_it).toBe('Nome aggiornato');
    expect(rows[0]!.active).toBe(false);

    const { rows: auditRows } = await pgAdmin.query(
      `SELECT action FROM audit_logs WHERE action = 'checklist_item_updated' AND entity_id = $1`,
      [seeded.id],
    );
    expect(auditRows).toHaveLength(1);
  });

  // ── 9. PATCH unknown id → 404 ─────────────────────────────────────────────────
  it('PATCH returns 404 admin.checklist_item.not_found for an unknown id', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/checklist-items/${unknownId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Non importa' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.checklist_item.not_found');
  });

  // ── 10. PATCH unknown field → 400 VALIDATION_ERROR ───────────────────────────
  it('PATCH returns 400 VALIDATION_ERROR for an unrecognized field (.strict())', async () => {
    const type = await seedGlobalType({});
    const seeded = await seedChecklistItem({ interventionTypeId: type.id });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/checklist-items/${seeded.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'SHOULD_NOT_BE_EDITABLE' }),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  // ── 11. DELETE → 204 + row gone ───────────────────────────────────────────────
  it('DELETE removes a checklist item and writes an audit row', async () => {
    const type = await seedGlobalType({});
    const seeded = await seedChecklistItem({ interventionTypeId: type.id });
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/checklist-items/${seeded.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const { rows } = await pgAdmin.query(
      `SELECT id FROM intervention_checklist_items WHERE id = $1`,
      [seeded.id],
    );
    expect(rows).toHaveLength(0);

    const { rows: auditRows } = await pgAdmin.query(
      `SELECT action FROM audit_logs WHERE action = 'checklist_item_deleted' AND entity_id = $1`,
      [seeded.id],
    );
    expect(auditRows).toHaveLength(1);
  });

  // ── 12. DELETE unknown id → 404 ───────────────────────────────────────────────
  it('DELETE returns 404 admin.checklist_item.not_found for an unknown id', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/checklist-items/${unknownId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.checklist_item.not_found');
  });

  // ── 13. Snapshot survival (BR-303/D8) ─────────────────────────────────────────
  it('DELETE preserves historical selections: checklist_item_id → NULL, label_snapshot intact', async () => {
    const type = await seedGlobalType({});
    const item = await seedChecklistItem({
      interventionTypeId: type.id,
      nameIt: 'Sostituzione olio',
    });
    const { tenantId } = await createTenant();
    const { userId } = await createUser({ tenantId, cognitoSub: `sub-${randomUUID()}` });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-01-01',
      odometerKm: 50000,
    });
    const selection = await seedChecklistSelection({
      interventionId,
      tenantId,
      checklistItemId: item.id,
      labelSnapshot: 'Sostituzione olio',
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/checklist-items/${item.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{
      checklist_item_id: string | null;
      label_snapshot: string;
    }>(
      `SELECT checklist_item_id, label_snapshot FROM intervention_checklist_selections WHERE id = $1`,
      [selection.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.checklist_item_id).toBeNull();
    expect(rows[0]!.label_snapshot).toBe('Sostituzione olio');
  });

  // ── 14. Anti-enum: malformed UUID → same 404 ─────────────────────────────────
  it('GET returns 404 admin.intervention_type.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intervention-types/not-a-uuid/checklist-items',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  it('POST returns 404 admin.intervention_type.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intervention-types/not-a-uuid/checklist-items',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: uniqueCode('ANTI'), nameIt: 'Test' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.intervention_type.not_found');
  });

  it('PATCH returns 404 admin.checklist_item.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/checklist-items/not-a-uuid',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nameIt: 'Non importa' }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.checklist_item.not_found');
  });

  it('DELETE returns 404 admin.checklist_item.not_found for a non-UUID :id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/checklist-items/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.checklist_item.not_found');
  });
});

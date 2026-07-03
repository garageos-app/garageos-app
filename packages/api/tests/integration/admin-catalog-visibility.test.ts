// Integration tests for the platform-admin per-tenant catalog visibility
// endpoints:
//   GET /v1/admin/tenants/:tenantId/catalog-visibility
//   PUT /v1/admin/tenants/:tenantId/catalog-visibility
//
// Tier-1 security / business logic — BR-304 (opt-out model) + BR-306
// (platform-admin-only write governance) + RLS tenant isolation.
//
// Test groups:
//   1. Pool isolation: 403 officine, 403 clienti on GET and PUT.
//   2. GET happy path: active type + active items → all visible:true;
//      inactive type / inactive item are excluded from the payload.
//   3. GET with exclusions applied: excluded type/item → visible:false.
//   4. GET unknown tenant (valid UUID + malformed UUID) → 404.
//   5. PUT happy path: atomic replace, old exclusion gone, new ones present,
//      audit row written.
//   6. PUT empties everything: 0 exclusion rows remain.
//   7. PUT invalid_ref (type): unknown UUID → 422, no writes (rollback check).
//   8. PUT invalid_ref (item): unknown UUID → 422.
//   9. PUT unknown tenant → 404.
//  10. PUT unknown field (.strict()) → 400 VALIDATION_ERROR.
//  11. RLS isolation: GET tenant A must not see tenant B's exclusions.
//  12. PUT preserves the exclusion row of a type deactivated after being
//      excluded (Deviation #2 — final-review fix): the deleteMany scoping
//      must not wipe exclusions on catalog entries the client can no
//      longer see/resend.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.
// NOTE: resetDb() truncates `tenants` CASCADE, which cascade-deletes rows in
// tenant_intervention_type_exclusions / tenant_checklist_item_exclusions
// (both FK tenant_id onDelete: Cascade) — no explicit wipe of those tables
// is needed. intervention_types/intervention_checklist_items are NOT
// truncated (see helpers.ts), so every seeded code uses a unique suffix.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { createTenant, resetDb } from './helpers.js';
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
  active?: boolean;
}): Promise<{ id: string; code: string }> {
  const { code = uniqueCode('ZVIS'), nameIt = `Test type ${code}`, active = true } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2, $3, NOW(), NOW())
     RETURNING id`,
    [code, nameIt, active],
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
    code = uniqueCode('VITEM'),
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

async function seedTypeExclusion(tenantId: string, interventionTypeId: string): Promise<void> {
  await pgAdmin.query(
    `INSERT INTO tenant_intervention_type_exclusions (tenant_id, intervention_type_id, created_at)
     VALUES ($1, $2, NOW())`,
    [tenantId, interventionTypeId],
  );
}

async function seedItemExclusion(tenantId: string, checklistItemId: string): Promise<void> {
  await pgAdmin.query(
    `INSERT INTO tenant_checklist_item_exclusions (tenant_id, checklist_item_id, created_at)
     VALUES ($1, $2, NOW())`,
    [tenantId, checklistItemId],
  );
}

type CatalogVisibilityItemDto = {
  id: string;
  code: string;
  nameIt: string;
  sortOrder: number;
  visible: boolean;
};

type CatalogVisibilityTypeDto = {
  id: string;
  code: string;
  nameIt: string;
  visible: boolean;
  checklistItems: CatalogVisibilityItemDto[];
};

function url(tenantId: string): string {
  return `/v1/admin/tenants/${tenantId}/catalog-visibility`;
}

// ─── 1. Pool isolation ────────────────────────────────────────────────────────

describe('Admin catalog-visibility — pool isolation (integration)', () => {
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
    const { tenantId } = await createTenant();
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('GET returns 403 FORBIDDEN with a clienti token', async () => {
    const { tenantId } = await createTenant();
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('PUT returns 403 FORBIDDEN with an officine token', async () => {
    const { tenantId } = await createTenant();
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [], excludedItemIds: [] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('PUT returns 403 FORBIDDEN with a clienti token', async () => {
    const { tenantId } = await createTenant();
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [], excludedItemIds: [] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });
});

// ─── 2–11. Business cases ──────────────────────────────────────────────────────

describe('Admin catalog-visibility — business cases (integration)', () => {
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
  it('GET returns visible:true for active type/items and omits inactive rows', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item1 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 1 });
    const item2 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });
    const inactiveType = await seedGlobalType({ active: false });
    const inactiveItem = await seedChecklistItem({ interventionTypeId: type.id, active: false });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { types: CatalogVisibilityTypeDto[] } };

    const dto = body.data.types.find((t) => t.id === type.id);
    expect(dto).toBeDefined();
    expect(dto!.visible).toBe(true);
    const itemCodes = dto!.checklistItems.map((i) => i.code);
    expect(itemCodes).toContain(item1.code);
    expect(itemCodes).toContain(item2.code);
    expect(itemCodes).not.toContain(inactiveItem.code);
    expect(dto!.checklistItems.every((i) => i.visible)).toBe(true);
    // sortOrder asc: item2 (sortOrder 0) before item1 (sortOrder 1).
    expect(itemCodes.indexOf(item2.code)).toBeLessThan(itemCodes.indexOf(item1.code));

    // Inactive global type must not appear at all.
    expect(body.data.types.some((t) => t.id === inactiveType.id)).toBe(false);
  });

  // ── 3. GET with exclusions applied ──────────────────────────────────────────
  it('GET reflects visible:false on excluded type and item', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item = await seedChecklistItem({ interventionTypeId: type.id });
    const otherType = await seedGlobalType({});
    const otherItem = await seedChecklistItem({ interventionTypeId: otherType.id });

    await seedTypeExclusion(tenantId, type.id);
    await seedItemExclusion(tenantId, item.id);

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { types: CatalogVisibilityTypeDto[] } };

    const excludedTypeDto = body.data.types.find((t) => t.id === type.id)!;
    expect(excludedTypeDto.visible).toBe(false);
    const excludedItemDto = excludedTypeDto.checklistItems.find((i) => i.id === item.id)!;
    expect(excludedItemDto.visible).toBe(false);

    const otherTypeDto = body.data.types.find((t) => t.id === otherType.id)!;
    expect(otherTypeDto.visible).toBe(true);
    const otherItemDto = otherTypeDto.checklistItems.find((i) => i.id === otherItem.id)!;
    expect(otherItemDto.visible).toBe(true);
  });

  // ── 4. GET unknown / malformed tenant → 404 ─────────────────────────────────
  it('GET returns 404 admin.catalog_visibility.tenant_not_found for an unknown tenant', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = 'deadbeef-dead-4ead-beef-deadbeefcafe';

    const res = await app.inject({
      method: 'GET',
      url: url(unknownId),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.catalog_visibility.tenant_not_found');
  });

  it('GET returns 404 admin.catalog_visibility.tenant_not_found for a non-UUID tenantId (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'GET',
      url: url('not-a-uuid'),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.catalog_visibility.tenant_not_found');
  });

  // ── 5. PUT happy path (atomic replace) ──────────────────────────────────────
  it('PUT atomically replaces the exclusion set and writes an audit row', async () => {
    const { tenantId } = await createTenant();
    const oldExcludedType = await seedGlobalType({});
    await seedTypeExclusion(tenantId, oldExcludedType.id);

    const newExcludedType = await seedGlobalType({});
    const newExcludedItemType = await seedGlobalType({});
    const newExcludedItem = await seedChecklistItem({
      interventionTypeId: newExcludedItemType.id,
    });

    const adminSub = 'admin-sub-put-happy';
    const token = await signTestToken({ pool: 'platform-admins', sub: adminSub });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        excludedTypeIds: [newExcludedType.id],
        excludedItemIds: [newExcludedItem.id],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { excludedTypeIds: string[]; excludedItemIds: string[] };
    expect(body.excludedTypeIds).toEqual([newExcludedType.id]);
    expect(body.excludedItemIds).toEqual([newExcludedItem.id]);

    const { rows: typeExclRows } = await pgAdmin.query<{ intervention_type_id: string }>(
      `SELECT intervention_type_id FROM tenant_intervention_type_exclusions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(typeExclRows).toHaveLength(1);
    expect(typeExclRows[0]!.intervention_type_id).toBe(newExcludedType.id);

    const { rows: itemExclRows } = await pgAdmin.query<{ checklist_item_id: string }>(
      `SELECT checklist_item_id FROM tenant_checklist_item_exclusions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(itemExclRows).toHaveLength(1);
    expect(itemExclRows[0]!.checklist_item_id).toBe(newExcludedItem.id);

    const { rows: auditRows } = await pgAdmin.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_logs
        WHERE action = 'catalog_visibility_updated' AND entity_id = $1`,
      [tenantId],
    );
    expect(auditRows).toHaveLength(1);
    const metadata = auditRows[0]!.metadata as Record<string, unknown>;
    expect(metadata.actorCognitoSub).toBe(adminSub);
    expect(metadata.excludedTypes).toBe(1);
    expect(metadata.excludedItems).toBe(1);
  });

  // ── 6. PUT empties everything ───────────────────────────────────────────────
  it('PUT with empty arrays removes all exclusions for the tenant', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item = await seedChecklistItem({ interventionTypeId: type.id });
    await seedTypeExclusion(tenantId, type.id);
    await seedItemExclusion(tenantId, item.id);

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [], excludedItemIds: [] }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ excludedTypeIds: [], excludedItemIds: [] });

    const { rows: typeExclRows } = await pgAdmin.query(
      `SELECT 1 FROM tenant_intervention_type_exclusions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(typeExclRows).toHaveLength(0);
    const { rows: itemExclRows } = await pgAdmin.query(
      `SELECT 1 FROM tenant_checklist_item_exclusions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(itemExclRows).toHaveLength(0);
  });

  // ── 7. PUT invalid_ref (type) ────────────────────────────────────────────────
  it('PUT returns 422 admin.catalog_visibility.invalid_ref for an unknown type id, without writing', async () => {
    const { tenantId } = await createTenant();
    const existingType = await seedGlobalType({});
    await seedTypeExclusion(tenantId, existingType.id);
    const unknownId = randomUUID();

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [unknownId], excludedItemIds: [] }),
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('admin.catalog_visibility.invalid_ref');

    // Rollback check: the pre-existing exclusion must remain intact.
    const { rows } = await pgAdmin.query<{ intervention_type_id: string }>(
      `SELECT intervention_type_id FROM tenant_intervention_type_exclusions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intervention_type_id).toBe(existingType.id);
  });

  // ── 8. PUT invalid_ref (item) ────────────────────────────────────────────────
  it('PUT returns 422 admin.catalog_visibility.invalid_ref for an unknown checklist item id', async () => {
    const { tenantId } = await createTenant();
    const unknownId = randomUUID();

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [], excludedItemIds: [unknownId] }),
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('admin.catalog_visibility.invalid_ref');
  });

  // ── 9. PUT unknown tenant → 404 ──────────────────────────────────────────────
  it('PUT returns 404 admin.catalog_visibility.tenant_not_found for an unknown tenant', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const unknownId = randomUUID();

    const res = await app.inject({
      method: 'PUT',
      url: url(unknownId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [], excludedItemIds: [] }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('admin.catalog_visibility.tenant_not_found');
  });

  // ── 10. PUT unknown field → 400 VALIDATION_ERROR ────────────────────────────
  it('PUT returns 400 VALIDATION_ERROR for an unrecognized field (.strict())', async () => {
    const { tenantId } = await createTenant();
    const token = await signTestToken({ pool: 'platform-admins' });

    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        excludedTypeIds: [],
        excludedItemIds: [],
        somethingElse: true,
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  // ── 12. PUT preserves exclusion for a deactivated type (Deviation #2) ───────
  it('PUT preserves the exclusion row of a type that became inactive after exclusion', async () => {
    const { tenantId } = await createTenant();

    // T: excluded while active, then deactivated. The client's GET no
    // longer returns T once inactive, so a subsequent PUT payload can never
    // include T.id — the scoped deleteMany must leave T's exclusion intact.
    const typeT = await seedGlobalType({});
    await seedTypeExclusion(tenantId, typeT.id);
    await pgAdmin.query(`UPDATE intervention_types SET active = false WHERE id = $1`, [typeT.id]);

    // U: a normal active type the admin explicitly excludes in this PUT.
    const typeU = await seedGlobalType({});

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ excludedTypeIds: [typeU.id], excludedItemIds: [] }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { excludedTypeIds: string[]; excludedItemIds: string[] };
    expect(body.excludedTypeIds).toEqual([typeU.id]);

    const { rows } = await pgAdmin.query<{ intervention_type_id: string }>(
      `SELECT intervention_type_id FROM tenant_intervention_type_exclusions
        WHERE tenant_id = $1
        ORDER BY intervention_type_id`,
      [tenantId],
    );
    const excludedIds = rows.map((r) => r.intervention_type_id).sort();
    expect(excludedIds).toEqual([typeT.id, typeU.id].sort());
  });

  // ── 11. RLS isolation (negative) ────────────────────────────────────────────
  it('GET for tenant A does not include tenant B exclusions', async () => {
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    const type = await seedGlobalType({});
    const item = await seedChecklistItem({ interventionTypeId: type.id });

    // Exclusions seeded on tenant B only.
    await seedTypeExclusion(tenantB, type.id);
    await seedItemExclusion(tenantB, item.id);

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: url(tenantA),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { types: CatalogVisibilityTypeDto[] } };
    const dto = body.data.types.find((t) => t.id === type.id)!;
    expect(dto.visible).toBe(true);
    const itemDto = dto.checklistItems.find((i) => i.id === item.id)!;
    expect(itemDto.visible).toBe(true);
  });
});

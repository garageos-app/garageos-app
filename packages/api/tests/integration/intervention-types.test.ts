// Integration tests for GET /v1/intervention-types (officine-facing catalog
// endpoint, rewritten under the PR-4 checklist-redesign arc, Task 2).
//
// New contract:
//   - BR-304 (opt-out visibility): the catalog is fully global
//     (intervention_types.tenant_id IS NULL) — a type/checklist item is
//     visible to a tenant unless excluded via
//     tenant_intervention_type_exclusions / tenant_checklist_item_exclusions.
//   - BR-305 (selectability gate): a type is offered only if, after
//     exclusions, it retains >=1 active checklist item; otherwise it is
//     omitted entirely.
//
// This file supersedes the pre-redesign intervention-types-list.test.ts,
// which was deleted: it asserted tenant-owned "custom" rows, a concept the
// admin catalog no longer creates (admin-intervention-types.ts only ever
// writes tenant_id: null — see PR-2 #245) and the new route no longer
// queries for.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { createTenant, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Per feedback_integration_test_rate_limit_isolation.md — unique IP per
// describe block keeps the @fastify/rate-limit bucket isolated when the
// app is shared via beforeAll across tests.
const TEST_IP = '10.20.30.42';

// ─── Seed helpers (mirrors admin-catalog-visibility.test.ts) ────────────────

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Inserts a GLOBAL intervention type (tenant_id IS NULL) directly via
// pgAdmin (bypasses RLS — fixture setup only). @updatedAt columns require
// an explicit updated_at = NOW() on raw INSERT. intervention_types is NOT
// wiped by resetDb() (see helpers.ts), so every seeded code must be unique.
async function seedGlobalType(params: {
  code?: string;
  nameIt?: string;
  active?: boolean;
}): Promise<{ id: string; code: string }> {
  const { code = uniqueCode('ITYP'), nameIt = `Test type ${code}`, active = true } = params;
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
    code = uniqueCode('IITM'),
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

type ChecklistItemDto = { id: string; code: string; nameIt: string; sortOrder: number };
type InterventionTypeDto = {
  id: string;
  code: string;
  nameIt: string;
  custom: boolean;
  checklistItems: ChecklistItemDto[];
};

// Hardcoded sub shared across all authedRequest calls. tenant-context
// middleware requires an active users row matching cognitoSub × tenantId,
// so each caller must seed a user with this sub before invoking
// authedRequest (resetDb wipes users between tests so a per-test seed is
// required — createUser is idempotent-enough per test since each test
// creates its own fresh tenant).
const AUTHED_SUB = '11111111-1111-4111-8111-111111111111';

async function authedRequest(app: FastifyInstance, tenantId: string) {
  await createUser({
    tenantId,
    cognitoSub: AUTHED_SUB,
    email: 'test-mechanic@test.it',
    role: 'mechanic',
  });
  const token = await signTestToken({
    pool: 'officine',
    sub: AUTHED_SUB,
    tenantId,
    role: 'mechanic',
  });
  return app.inject({
    method: 'GET',
    url: '/v1/intervention-types',
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
  });
}

describe('GET /v1/intervention-types (integration)', () => {
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

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  it('returns the type with its active checklist items ordered by sortOrder, custom:false', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item1 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 1 });
    const item2 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    const dto = body.data.find((t) => t.id === type.id);
    expect(dto).toBeDefined();
    expect(dto!.custom).toBe(false);
    expect(dto!.checklistItems).toHaveLength(2);
    // sortOrder asc: item2 (0) before item1 (1).
    expect(dto!.checklistItems.map((i) => i.id)).toEqual([item2.id, item1.id]);
  });

  // ── 2. Item exclusion ──────────────────────────────────────────────────────
  it('omits an excluded checklist item but keeps the type with the remaining item', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item1 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });
    const item2 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 1 });
    await seedItemExclusion(tenantId, item1.id);

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    const dto = body.data.find((t) => t.id === type.id)!;
    expect(dto).toBeDefined();
    expect(dto.checklistItems).toHaveLength(1);
    expect(dto.checklistItems[0]!.id).toBe(item2.id);
  });

  // ── 3. BR-305 — all checklist items excluded → type omitted ───────────────
  it('BR-305: omits the type entirely when all its checklist items are excluded', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    const item1 = await seedChecklistItem({ interventionTypeId: type.id });
    const item2 = await seedChecklistItem({ interventionTypeId: type.id });
    await seedItemExclusion(tenantId, item1.id);
    await seedItemExclusion(tenantId, item2.id);

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    expect(body.data.find((t) => t.id === type.id)).toBeUndefined();
  });

  // ── 4. BR-305 — type excluded at the type level ────────────────────────────
  it('BR-305: omits a type excluded at the type level even though it has visible items', async () => {
    const { tenantId } = await createTenant();
    const type = await seedGlobalType({});
    await seedChecklistItem({ interventionTypeId: type.id });
    await seedTypeExclusion(tenantId, type.id);

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    expect(body.data.find((t) => t.id === type.id)).toBeUndefined();
  });

  // ── 5. Inactive type / inactive item ────────────────────────────────────────
  it('omits an inactive type entirely, and an inactive item within an active type', async () => {
    const { tenantId } = await createTenant();
    const inactiveType = await seedGlobalType({ active: false });
    await seedChecklistItem({ interventionTypeId: inactiveType.id });

    const activeType = await seedGlobalType({});
    const activeItem = await seedChecklistItem({ interventionTypeId: activeType.id });
    const inactiveItem = await seedChecklistItem({
      interventionTypeId: activeType.id,
      active: false,
    });

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };

    expect(body.data.find((t) => t.id === inactiveType.id)).toBeUndefined();
    const dto = body.data.find((t) => t.id === activeType.id)!;
    expect(dto).toBeDefined();
    expect(dto.checklistItems.map((i) => i.id)).toEqual([activeItem.id]);
    expect(dto.checklistItems.find((i) => i.id === inactiveItem.id)).toBeUndefined();
  });

  // ── 5b. nameIt ASC ordering (contract guarantee, APPENDICE_A §2.1bis) ───────
  it('orders the types by nameIt ASC regardless of insertion order', async () => {
    const { tenantId } = await createTenant();
    // Insert alphabetically out of insertion order (Zeta first, then Alfa),
    // each with an active checklist item so both survive the BR-305 gate.
    // A passing assertion therefore exercises server-side ordering rather
    // than incidentally reflecting insertion order.
    const zeta = await seedGlobalType({ nameIt: 'Zeta Tipo Ordinamento' });
    await seedChecklistItem({ interventionTypeId: zeta.id });
    const alfa = await seedGlobalType({ nameIt: 'Alfa Tipo Ordinamento' });
    await seedChecklistItem({ interventionTypeId: alfa.id });

    const res = await authedRequest(app, tenantId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };

    // Global monotonic check across the whole payload.
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i - 1]!.nameIt.localeCompare(body.data[i]!.nameIt)).toBeLessThanOrEqual(0);
    }
    // Explicit relative-position check for the two seeded types.
    const alfaIdx = body.data.findIndex((t) => t.id === alfa.id);
    const zetaIdx = body.data.findIndex((t) => t.id === zeta.id);
    expect(alfaIdx).toBeGreaterThanOrEqual(0);
    expect(zetaIdx).toBeGreaterThan(alfaIdx);
  });

  // ── 6. Tenant isolation (negative) ──────────────────────────────────────────
  it('does not apply tenant B exclusions to tenant A (RLS/app-layer isolation)', async () => {
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    const type = await seedGlobalType({});
    const item = await seedChecklistItem({ interventionTypeId: type.id });

    // Exclusions seeded on tenant B only.
    await seedTypeExclusion(tenantB, type.id);
    await seedItemExclusion(tenantB, item.id);

    const res = await authedRequest(app, tenantA);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    const dto = body.data.find((t) => t.id === type.id);
    expect(dto).toBeDefined();
    expect(dto!.checklistItems.map((i) => i.id)).toContain(item.id);
  });

  // ── Route contract: auth / pool gating ──────────────────────────────────────
  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/intervention-types',
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });

  it('returns 403 for a clienti pool token', async () => {
    const { tenantId } = await createTenant();
    const token = await signTestToken({
      pool: 'clienti',
      sub: '22222222-2222-4222-8222-222222222222',
      tenantId,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
  });
});

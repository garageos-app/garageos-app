// Integration tests for GET /v1/me/intervention-types (customer-facing
// global catalog endpoint, PR-1 checklist-redesign follow-up, Task 4).
//
// Contract:
//   - Same source rows as the officina GET /v1/intervention-types
//     (intervention_types.tenant_id IS NULL, active), but WITHOUT the
//     per-tenant exclusion overlay: customers are not tenant-scoped, so
//     they always see the full global catalog.
//   - BR-305 (selectability gate): a type is offered only if it has >=1
//     active checklist item; otherwise it is omitted entirely.
//   - No deadline fields, no `custom` field (customer wire shape is a
//     strict subset of the officina one).
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Per feedback_integration_test_rate_limit_isolation.md — unique IP per
// describe block keeps the @fastify/rate-limit bucket isolated when the
// app is shared via beforeAll across tests.
const TEST_IP = '10.50.14.1';

// ─── Seed helpers (mirrors intervention-types.test.ts) ──────────────────────

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
  const { code = uniqueCode('MITYP'), nameIt = `Test type ${code}`, active = true } = params;
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
    code = uniqueCode('MIITM'),
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

type ChecklistItemDto = { id: string; code: string; name_it: string; sort_order: number };
type InterventionTypeDto = {
  id: string;
  code: string;
  name_it: string;
  icon: string | null;
  checklist_items: ChecklistItemDto[];
};

describe('GET /v1/me/intervention-types (integration)', () => {
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

  it('returns the global catalog with checklist items for a customer', async () => {
    const cognitoSub = 'me-ityp-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const type = await seedGlobalType({});
    const item1 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 1 });
    const item2 = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    const dto = body.data.find((t) => t.id === type.id);
    expect(dto).toBeDefined();
    expect(dto).toMatchObject({
      id: type.id,
      code: type.code,
      name_it: expect.any(String),
    });
    // Wire shape is a strict subset of the officina catalog: no deadline
    // fields, no `custom` field.
    expect(dto).not.toHaveProperty('custom');
    expect(dto).not.toHaveProperty('suggests_deadline');
    expect(dto).not.toHaveProperty('default_deadline_months');
    expect(dto).not.toHaveProperty('default_deadline_km');
    expect(Array.isArray(dto!.checklist_items)).toBe(true);
    // sortOrder asc: item2 (0) before item1 (1).
    expect(dto!.checklist_items.map((i) => i.id)).toEqual([item2.id, item1.id]);
    expect(dto!.checklist_items[0]).toMatchObject({ sort_order: expect.any(Number) });
  });

  it('omits types with zero active checklist items (BR-305)', async () => {
    const cognitoSub = 'me-ityp-br305-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    // Type with only an inactive item — must be omitted entirely.
    const zeroItemType = await seedGlobalType({});
    await seedChecklistItem({ interventionTypeId: zeroItemType.id, active: false });

    // Control: a type with at least one active item stays visible.
    const visibleType = await seedGlobalType({});
    const visibleItem = await seedChecklistItem({ interventionTypeId: visibleType.id });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: InterventionTypeDto[] };
    expect(body.data.find((t) => t.id === zeroItemType.id)).toBeUndefined();
    const dto = body.data.find((t) => t.id === visibleType.id);
    expect(dto).toBeDefined();
    expect(dto!.checklist_items.map((i) => i.id)).toEqual([visibleItem.id]);
  });

  it('rejects the officina pool with 403', async () => {
    const { tenantId } = await createTenantWithLocation('me-ityp-403');
    const officinaSub = 'me-ityp-off-' + Math.random().toString(36).slice(2, 10);
    await createUser({
      tenantId,
      cognitoSub: officinaSub,
      email: 'mechanic-ityp@test.it',
      role: 'mechanic',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: officinaSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(403);
  });
});

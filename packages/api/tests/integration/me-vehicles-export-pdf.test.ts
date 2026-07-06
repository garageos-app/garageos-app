import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Direct pgAdmin insert for a checklist item fixture — bypasses RLS
// (fixture setup only). Mirrors interventions-detail.test.ts / interventions-pdf.test.ts.
async function seedChecklistItem(params: {
  interventionTypeId: string;
  nameIt?: string;
  sortOrder?: number;
}): Promise<{ id: string; nameIt: string }> {
  const { interventionTypeId, nameIt = `Test item ${uniqueCode('IITM')}`, sortOrder = 0 } = params;
  const code = uniqueCode('IITM');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_items
       (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, NOW(), NOW())
     RETURNING id`,
    [interventionTypeId, code, nameIt, sortOrder],
  );
  return { id: rows[0]!.id, nameIt };
}

// Direct pgAdmin insert of an intervention_checklist_selections row —
// bypasses the create/patch routes entirely so this test can seed a
// selection with a controlled label_snapshot/sort_order_snapshot regardless
// of the checklist item's own current catalog values (BR-303 snapshot
// semantics — mirrors interventions-detail.test.ts `seedSelection`).
async function seedChecklistSelection(params: {
  interventionId: string;
  tenantId: string;
  checklistItemId: string;
  labelSnapshot: string;
  sortOrderSnapshot?: number | null;
}): Promise<{ id: string }> {
  const {
    interventionId,
    tenantId,
    checklistItemId,
    labelSnapshot,
    sortOrderSnapshot = 0,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_selections
       (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, sort_order_snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
     RETURNING id`,
    [interventionId, tenantId, checklistItemId, labelSnapshot, sortOrderSnapshot],
  );
  return { id: rows[0]!.id };
}

describe('GET /v1/me/vehicles/:id/export.pdf (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    await ensureSystemInterventionType('MECCANICO');
    vi.clearAllMocks();
  });

  async function seedShopIntervention(args: {
    tenantId: string;
    userId: string;
    vehicleId: string;
    status?: 'active' | 'disputed' | 'cancelled';
    date?: string;
  }) {
    const type = await ensureSystemInterventionType('MECCANICO');
    return createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId: args.vehicleId,
      interventionTypeId: type.id,
      interventionDate: args.date ?? '2026-05-20',
      odometerKm: 55000,
      description: 'Cambio olio e filtri',
      partsReplaced: [],
      status: args.status ?? 'active',
    });
  }

  it('200 — owner: streams application/pdf', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-owner');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-owner' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-owner' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await seedShopIntervention({ tenantId, userId, vehicleId });

    const type = await ensureSystemInterventionType('MECCANICO');
    const item = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });
    await seedChecklistSelection({
      interventionId,
      tenantId,
      checklistItemId: item.id,
      labelSnapshot: item.nameIt,
      sortOrderSnapshot: 0,
    });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-owner', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`storico-${vehicleId}.pdf`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('404 — non-owner customer: me.vehicle.not_found', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-iso');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-iso' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-iso' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await seedShopIntervention({ tenantId, userId, vehicleId });

    const { customerId: otherId } = await createCustomer({ cognitoSub: 'cust-me-pdf-other' });
    const token = await signTestToken({
      pool: 'clienti',
      sub: 'cust-me-pdf-other',
      customerId: otherId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('me.vehicle.not_found');
  });

  it('404 — ex-owner (endedAt set): me.vehicle.not_found', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-ex');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-ex' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-ex' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({
      vehicleId,
      customerId,
      endedAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    await seedShopIntervention({ tenantId, userId, vehicleId });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-ex', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 — cross-tenant history + cancelled excluded: streams application/pdf', async () => {
    // Vehicle owned by the customer, with interventions from TWO tenants plus a
    // cancelled one that must be excluded (BR-150).
    const a = await createTenantWithLocation('me-pdf-xt-A');
    const b = await createTenantWithLocation('me-pdf-xt-B');
    const userA = await createUser({
      tenantId: a.tenantId,
      cognitoSub: 'mech-xtA',
    });
    const userB = await createUser({
      tenantId: b.tenantId,
      cognitoSub: 'mech-xtB',
    });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-xt' });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await createOwnership({ vehicleId, customerId });

    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      date: '2026-01-10',
    });
    await seedShopIntervention({
      tenantId: b.tenantId,
      userId: userB.userId,
      vehicleId,
      date: '2026-03-10',
    });
    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      date: '2026-04-10',
      status: 'cancelled',
    });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-xt', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('200 — vehicle with no shop interventions: empty history still generates a PDF', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-empty');
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-empty' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-empty', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

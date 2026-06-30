import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-401 — GET /v1/vehicles/:vehicleId/deadlines.
//
// Read-only list endpoint usable by both pools:
//   - Officina (tenant context) — RLS filters via deadlines_tenant_isolation,
//     so cross-tenant deadlines are invisible (returns an empty page rather
//     than a 404 because vehicles_read is permissive USING(true) per BR-150).
//   - Customer (clienti context) — RLS filters via deadlines_customer_select
//     (migration 20260508130000), admitting deadlines on vehicles owned by
//     the customer (active ownership).
//
// Customer 404: explicit pre-check against vehicle_ownerships (an empty
// list could leak vehicle existence; we collapse "no ownership" to a
// flat 404).

const TEST_IP = '10.20.31.2';

// Direct pgAdmin insert helper (bypasses RLS). Mirrors createIntervention
// from helpers.ts: integration tests seed deadlines without driving the
// public POST /deadlines path so the list-endpoint test stays focused.
async function seedDeadline(params: {
  tenantId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string; // YYYY-MM-DD
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
  description?: string | null;
}): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    vehicleId,
    interventionTypeId,
    dueDate,
    status = 'open',
    description = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines
       (id, tenant_id, vehicle_id, intervention_type_id,
        due_date, description, is_recurring, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, false,
        $6::"DeadlineStatus", NOW(), NOW())
     RETURNING id`,
    [tenantId, vehicleId, interventionTypeId, dueDate, description, status],
  );
  return { deadlineId: rows[0]!.id };
}

describe('GET /v1/vehicles/:vehicleId/deadlines (F-OFF-401)', () => {
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

  it('200 returns deadlines for vehicle ordered by dueDate ASC', async () => {
    const { tenantId } = await createTenantWithLocation('list-asc');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // Insert in non-sorted order to verify the orderBy.
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-06-01',
      description: 'mid',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-01-01',
      description: 'first',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-12-01',
      description: 'last',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ description: string | null; dueDate: string }>;
      nextCursor: string | null;
    };
    expect(body.deadlines).toHaveLength(3);
    expect(body.deadlines.map((d) => d.description)).toEqual(['first', 'mid', 'last']);
    expect(body.nextCursor).toBeNull();
  });

  it('?status=open filter applied', async () => {
    const { tenantId } = await createTenantWithLocation('list-status');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-01-01',
      status: 'open',
      description: 'open-1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-02-01',
      status: 'completed',
      description: 'completed-1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-03-01',
      status: 'cancelled',
      description: 'cancelled-1',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines?status=open`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ status: string; description: string | null }>;
    };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.status).toBe('open');
    expect(body.deadlines[0]!.description).toBe('open-1');
  });

  it('?limit=2 returns 2 rows + nextCursor', async () => {
    const { tenantId } = await createTenantWithLocation('list-limit');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-01-01',
      description: 'd1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-02-01',
      description: 'd2',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-03-01',
      description: 'd3',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines?limit=2`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ id: string; description: string | null }>;
      nextCursor: string | null;
    };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.map((d) => d.description)).toEqual(['d1', 'd2']);
    expect(body.nextCursor).toBe(body.deadlines[1]!.id);
  });

  it('?cursor= proceeds pagination', async () => {
    const { tenantId } = await createTenantWithLocation('list-cursor');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-01-01',
      description: 'd1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-02-01',
      description: 'd2',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-03-01',
      description: 'd3',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const firstRes = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines?limit=2`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json() as {
      deadlines: Array<{ id: string; description: string | null }>;
      nextCursor: string | null;
    };
    const cursor = firstBody.nextCursor!;
    expect(cursor).toBeTruthy();

    const secondRes = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines?limit=2&cursor=${cursor}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json() as {
      deadlines: Array<{ id: string; description: string | null }>;
      nextCursor: string | null;
    };
    expect(secondBody.deadlines).toHaveLength(1);
    expect(secondBody.deadlines[0]!.description).toBe('d3');
    expect(secondBody.nextCursor).toBeNull();
  });

  it('cross-tenant officina returns 200 with empty deadlines (vehicles globally readable; tenant RLS filters)', async () => {
    // BR-150: vehicles_read USING(true) — vehicle visible cross-tenant.
    // deadlines_tenant_isolation: deadlines scoped to caller tenant only.
    // Net effect for caller B looking at vehicle owned by tenant A: 200
    // with empty list (mirrors POST behavior — see deadlines-create.test.ts).
    const a = await createTenantWithLocation('xt-a');
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await seedDeadline({
      tenantId: a.tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-01-01',
    });

    const b = await createTenantWithLocation('xt-b');
    const bSub = `office-b-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: b.tenantId,
      cognitoSub: bSub,
      role: 'super_admin',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: bSub,
      tenantId: b.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: unknown[]; nextCursor: string | null };
    expect(body.deadlines).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
  });

  it('customer with active ownership reads via dualPoolContext', async () => {
    const { tenantId } = await createTenantWithLocation('cust-owns');
    const tenantSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub: tenantSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId, customerId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-04-15',
      description: 'tagliando dovuto',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ description: string | null; vehicleId: string }>;
    };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.description).toBe('tagliando dovuto');
    expect(body.deadlines[0]!.vehicleId).toBe(vehicleId);
  });

  it('customer without ownership returns 404', async () => {
    const { tenantId } = await createTenantWithLocation('cust-noown');
    const tenantSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub: tenantSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // Owner customer, but caller is a DIFFERENT customer with no ownership.
    const ownerSub = `cust-owner-${randomUUID().slice(0, 8)}`;
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    await createOwnership({ vehicleId, customerId: ownerId });

    const otherSub = `cust-other-${randomUUID().slice(0, 8)}`;
    const { customerId: otherId } = await createCustomer({ cognitoSub: otherSub });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-04-15',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: otherSub,
      customerId: otherId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('vehicle.not_found');
  });

  it('customer with ENDED ownership returns 404 (defense in depth)', async () => {
    // ended_at IS NOT NULL → no active ownership → 404.
    const { tenantId } = await createTenantWithLocation('cust-ended');
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    // Insert ownership directly with ended_at set.
    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships
         (id, vehicle_id, customer_id, started_at, ended_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW() - INTERVAL '1 year', NOW() - INTERVAL '1 day', NOW())`,
      [vehicleId, customerId],
    );

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-04-15',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
  });

  it('401 without auth header', async () => {
    const { tenantId } = await createTenantWithLocation('noauth');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(401);
  });

  it('empty list returns {deadlines: [], nextCursor: null}', async () => {
    const { tenantId } = await createTenantWithLocation('empty');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: unknown[]; nextCursor: string | null };
    expect(body.deadlines).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});

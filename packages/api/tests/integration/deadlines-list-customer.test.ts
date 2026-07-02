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

// F-CLI-301 — GET /v1/me/deadlines.
//
// Customer-pool list of all deadlines on vehicles the authenticated
// customer currently owns. Isolation is RLS-enforced
// (deadlines_customer_select policy, migration 20260508130000) — the
// handler does no application-side ownership join.
//
// Default status filter: open|overdue. Explicit ?status= overrides.

const TEST_IP = '10.20.31.6';

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

describe('GET /v1/me/deadlines (F-CLI-301)', () => {
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

  it('200 returns only deadlines on customer-owned vehicles (RLS filter)', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-owns');
    const type = await ensureSystemInterventionType('MECCANICO');

    // Vehicle A: owned by the calling customer.
    const { vehicleId: ownedVehicle } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1OWNED00000001',
      plate: 'ME010OW',
    });
    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId: ownedVehicle, customerId });

    // Vehicle B: owned by a DIFFERENT customer.
    const { vehicleId: otherVehicle } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1OTHER00000001',
      plate: 'ME010OT',
    });
    const { customerId: otherCustomerId } = await createCustomer({
      cognitoSub: `cust-other-${randomUUID().slice(0, 8)}`,
    });
    await createOwnership({ vehicleId: otherVehicle, customerId: otherCustomerId });

    await seedDeadline({
      tenantId,
      vehicleId: ownedVehicle,
      interventionTypeId: type.id,
      dueDate: '2027-04-15',
      description: 'mine',
    });
    await seedDeadline({
      tenantId,
      vehicleId: otherVehicle,
      interventionTypeId: type.id,
      dueDate: '2027-05-15',
      description: 'not mine',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ description: string | null; vehicleId: string }>;
      nextCursor: string | null;
    };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.description).toBe('mine');
    expect(body.deadlines[0]!.vehicleId).toBe(ownedVehicle);
    expect(body.nextCursor).toBeNull();
  });

  it('default filter excludes completed and cancelled (status defaults to open|overdue)', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-default');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId, customerId });

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
      status: 'overdue',
      description: 'overdue-1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-03-01',
      status: 'completed',
      description: 'completed-1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-04-01',
      status: 'cancelled',
      description: 'cancelled-1',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ status: string; description: string | null }>;
    };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.map((d) => d.status).sort()).toEqual(['open', 'overdue']);
  });

  it('?status=completed overrides default and returns completed only', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-status');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId, customerId });

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
      description: 'done-1',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-03-01',
      status: 'completed',
      description: 'done-2',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines?status=completed',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ status: string; description: string | null }>;
    };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.every((d) => d.status === 'completed')).toBe(true);
    expect(body.deadlines.map((d) => d.description)).toEqual(['done-1', 'done-2']);
  });

  it('cursor pagination returns subsequent pages', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-cursor');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId, customerId });

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
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const firstRes = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines?limit=2',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json() as {
      deadlines: Array<{ id: string; description: string | null }>;
      nextCursor: string | null;
    };
    expect(firstBody.deadlines).toHaveLength(2);
    expect(firstBody.deadlines.map((d) => d.description)).toEqual(['d1', 'd2']);
    const cursor = firstBody.nextCursor!;
    expect(cursor).toBeTruthy();

    const secondRes = await app.inject({
      method: 'GET',
      url: `/v1/me/deadlines?limit=2&cursor=${cursor}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json() as {
      deadlines: Array<{ description: string | null }>;
      nextCursor: string | null;
    };
    expect(secondBody.deadlines).toHaveLength(1);
    expect(secondBody.deadlines[0]!.description).toBe('d3');
    expect(secondBody.nextCursor).toBeNull();
  });

  it('customer who owns nothing returns empty array', async () => {
    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: unknown[]; nextCursor: string | null };
    expect(body.deadlines).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('customer with ENDED ownership does not see those vehicles deadlines (RLS endedAt IS NULL)', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-ended');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });

    // Insert ownership with ended_at set: customer used to own it.
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
      description: 'past',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: unknown[]; nextCursor: string | null };
    expect(body.deadlines).toEqual([]);
  });

  it('officina-pool token denied with 403 (requireClientiPool guard)', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-officine');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(403);
  });

  it('401 without auth header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(401);
  });

  it('response includes nested vehicle and interventionType', async () => {
    const { tenantId } = await createTenantWithLocation('me-dl-nested');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1NESTED0000001',
      plate: 'ME020NE',
      make: 'Fiat',
      model: 'Panda',
    });

    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    await createOwnership({ vehicleId, customerId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: '2027-04-15',
      description: 'tagliando',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{
        id: string;
        vehicle: { id: string; plate: string; make: string; model: string };
        interventionType: { id: string; code: string; nameIt: string };
      }>;
    };
    expect(body.deadlines).toHaveLength(1);
    const row = body.deadlines[0]!;
    expect(row.vehicle).toEqual({
      id: vehicleId,
      plate: 'ME020NE',
      make: 'Fiat',
      model: 'Panda',
    });
    expect(row.interventionType.id).toBe(type.id);
    expect(row.interventionType.code).toBe('MECCANICO');
    expect(typeof row.interventionType.nameIt).toBe('string');
  });
});

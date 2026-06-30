import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-402 + BR-151 end-to-end: deadlines tenant-isolated by RLS,
// customer PII gated by customer_tenant_relations existence.

interface SeedDeadlineParams {
  tenantId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate?: Date | null;
  dueOdometerKm?: number | null;
  description?: string | null;
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
}

async function seedDeadline(params: SeedDeadlineParams): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    vehicleId,
    interventionTypeId,
    dueDate = new Date('2025-12-31'),
    dueOdometerKm = null,
    description = null,
    status = 'open',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines (id, tenant_id, vehicle_id, intervention_type_id,
        due_date, due_odometer_km, description, status, is_recurring, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::"DeadlineStatus", false, NOW(), NOW())
     RETURNING id`,
    [tenantId, vehicleId, interventionTypeId, dueDate, dueOdometerKm, description, status],
  );
  return { deadlineId: rows[0]!.id };
}

describe('GET /v1/deadlines (integration)', () => {
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

  it('returns only deadlines for the calling tenant (RLS isolation)', async () => {
    const { tenantId: tA } = await createTenantWithLocation('dl-iso-A');
    const { tenantId: tB } = await createTenantWithLocation('dl-iso-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tA, cognitoSub });

    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');

    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vA2 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });

    await seedDeadline({
      tenantId: tA,
      vehicleId: vA1,
      interventionTypeId: typeId,
      dueDate: new Date('2025-08-01'),
    });
    await seedDeadline({
      tenantId: tA,
      vehicleId: vA2,
      interventionTypeId: typeId,
      dueDate: new Date('2025-09-01'),
    });
    await seedDeadline({
      tenantId: tB,
      vehicleId: vB,
      interventionTypeId: typeId,
      dueDate: new Date('2025-08-01'),
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deadlines: Array<{ vehicleId: string }>;
      nextCursor: string | null;
    };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.map((d) => d.vehicleId).sort()).toEqual([vA1, vA2].sort());
  });

  it('default status filter excludes completed and cancelled', async () => {
    const { tenantId } = await createTenantWithLocation('dl-status-default');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('GOMME');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'open',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'completed',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'cancelled',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ status: string }> };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.status).toBe('open');
  });

  it('?status=cancelled override returns cancelled rows', async () => {
    const { tenantId } = await createTenantWithLocation('dl-status-override');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('REVISIONE');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'open',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'cancelled',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines?status=cancelled',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ status: string }> };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.status).toBe('cancelled');
  });

  it('filters by intervention_type_id', async () => {
    const { tenantId } = await createTenantWithLocation('dl-type-filter');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
    const { id: typeA } = await ensureSystemInterventionType('TAGLIANDO');
    const { id: typeB } = await ensureSystemInterventionType('GOMME');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({ tenantId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, vehicleId, interventionTypeId: typeB });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?intervention_type_id=${typeA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ interventionTypeId: string }> };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.every((d) => d.interventionTypeId === typeA)).toBe(true);
  });

  it('returns customer PII when tenant is related to the customer', async () => {
    const { tenantId } = await createTenantWithLocation('dl-pii-related');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await createCustomerTenantRelation({ tenantId, customerId });
    await seedDeadline({ tenantId, vehicleId, interventionTypeId: typeId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as {
      deadlines: Array<{
        vehicle: {
          currentOwnership: {
            customer: { redacted: boolean; firstName?: string; lastName?: string };
          } | null;
        };
      }>;
    };
    expect(body.deadlines).toHaveLength(1);
    const cust = body.deadlines[0]!.vehicle.currentOwnership!.customer;
    expect(cust.redacted).toBe(false);
    expect(cust.firstName).toBe('Mario');
    expect(cust.lastName).toBe('Rossi');
  });

  it('redacts customer PII when tenant is NOT related (BR-151)', async () => {
    const { tenantId: tA } = await createTenantWithLocation('dl-pii-A');
    const { tenantId: tB } = await createTenantWithLocation('dl-pii-B');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId: tA, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');

    // Customer + vehicle + ownership exist but tenant A has NO CTR with the customer.
    const { customerId } = await createCustomer({ firstName: 'Hidden', lastName: 'Customer' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tA });
    await createOwnership({ vehicleId, customerId });
    // Only tenant B is related (decoy — proves nontrivial CTR query):
    await createCustomerTenantRelation({ tenantId: tB, customerId });

    await seedDeadline({ tenantId: tA, vehicleId, interventionTypeId: typeId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as {
      deadlines: Array<{
        vehicle: {
          currentOwnership: {
            customer: { redacted: boolean; displayName?: string };
          } | null;
        };
      }>;
    };
    expect(body.deadlines).toHaveLength(1);
    const cust = body.deadlines[0]!.vehicle.currentOwnership!.customer;
    expect(cust.redacted).toBe(true);
    expect(cust.displayName).toBe('Proprietario non in anagrafica');
  });

  it('paginates with cursor', async () => {
    const { tenantId } = await createTenantWithLocation('dl-pagination');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const seededIds: string[] = [];
    for (const day of [1, 2, 3]) {
      const { deadlineId } = await seedDeadline({
        tenantId,
        vehicleId,
        interventionTypeId: typeId,
        dueDate: new Date(`2025-08-0${day}`),
      });
      seededIds.push(deadlineId);
    }

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/deadlines?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    const body1 = res1.json() as { deadlines: Array<{ id: string }>; nextCursor: string | null };
    expect(body1.deadlines).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?limit=2&cursor=${body1.nextCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as { deadlines: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.deadlines).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();

    const allIds = [
      ...body1.deadlines.map((d) => d.id),
      ...body2.deadlines.map((d) => d.id),
    ].sort();
    expect(allIds).toEqual([...seededIds].sort());
  });

  it('returns 401 without auth and 403 for clienti pool tokens', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v1/deadlines' });
    expect(noAuth.statusCode).toBe(401);

    const customerCognitoSub = '88888888-8888-4888-8888-888888888888';
    const customerToken = await signTestToken({
      pool: 'clienti',
      sub: customerCognitoSub,
      customerId: customerCognitoSub,
    });
    const wrongPool = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(wrongPool.statusCode).toBe(403);
  });
});

describe('GET /v1/deadlines — BR-205 relaxed (sede unica)', () => {
  // BR-205 is relaxed: mechanics now see all tenant deadlines regardless
  // of the location originally attached to a deadline record.
  // Tenant isolation is unchanged.
  const LOC_IP = '10.20.42.2';
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

  it('mechanic sees all tenant deadlines (BR-205 relaxed — sede unica)', async () => {
    const { tenantId } = await createTenantWithLocation('dl-all');
    const cognitoSub = '20000000-0000-4000-8000-000000000001';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      dueDate: new Date('2026-08-01'),
      description: 'deadline-one',
    });
    await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: typeId,
      dueDate: new Date('2026-08-02'),
      description: 'deadline-two',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: Array<{ description: string | null }> };
    expect(body.deadlines.map((d) => d.description).sort()).toEqual(
      ['deadline-one', 'deadline-two'].sort(),
    );
  });
});

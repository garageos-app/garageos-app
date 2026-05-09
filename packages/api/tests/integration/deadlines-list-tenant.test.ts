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
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-402 + BR-151 end-to-end: deadlines tenant-isolated by RLS,
// customer PII gated by customer_tenant_relations existence.

interface SeedDeadlineParams {
  tenantId: string;
  locationId: string;
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
    locationId,
    vehicleId,
    interventionTypeId,
    dueDate = null,
    dueOdometerKm = null,
    description = null,
    status = 'open',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines (id, tenant_id, location_id, vehicle_id, intervention_type_id,
        due_date, due_odometer_km, description, status, is_recurring, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::"DeadlineStatus", false, NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId,
      dueDate,
      dueOdometerKm,
      description,
      status,
    ],
  );
  return { deadlineId: rows[0]!.id };
}

async function seedInterventionType(params: {
  code: string;
  nameIt: string;
  category?: 'maintenance' | 'tires' | 'repair' | 'inspection' | 'body' | 'other';
}): Promise<{ id: string }> {
  const { code, nameIt, category = 'maintenance' } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types (id, code, name_it, description, icon, category,
        suggests_deadline, custom, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '', 'wrench', $3::"InterventionTypeCategory",
        true, false, NOW(), NOW())
     RETURNING id`,
    [code, nameIt, category],
  );
  return { id: rows[0]!.id };
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
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('dl-iso-A');
    const { tenantId: tB, locationId: lB } = await createTenantWithLocation('dl-iso-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tA, cognitoSub });

    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });

    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vA2 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });

    await seedDeadline({
      tenantId: tA,
      locationId: lA,
      vehicleId: vA1,
      interventionTypeId: typeId,
      dueDate: new Date('2025-08-01'),
    });
    await seedDeadline({
      tenantId: tA,
      locationId: lA,
      vehicleId: vA2,
      interventionTypeId: typeId,
      dueDate: new Date('2025-09-01'),
    });
    await seedDeadline({
      tenantId: tB,
      locationId: lB,
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
    const { tenantId, locationId } = await createTenantWithLocation('dl-status-default');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'GOMME', nameIt: 'Gomme' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'open',
    });
    await seedDeadline({
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'completed',
    });
    await seedDeadline({
      tenantId,
      locationId,
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
    const { tenantId, locationId } = await createTenantWithLocation('dl-status-override');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'REVISIONE', nameIt: 'Revisione' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId: typeId,
      status: 'open',
    });
    await seedDeadline({
      tenantId,
      locationId,
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
    const { tenantId, locationId } = await createTenantWithLocation('dl-type-filter');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
    const { id: typeA } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { id: typeB } = await seedInterventionType({ code: 'GOMME', nameIt: 'Gomme' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeB });

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
    const { tenantId, locationId } = await createTenantWithLocation('dl-pii-related');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await createCustomerTenantRelation({ tenantId, customerId });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId });

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
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('dl-pii-A');
    const { tenantId: tB } = await createTenantWithLocation('dl-pii-B');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId: tA, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });

    // Customer + vehicle + ownership exist but tenant A has NO CTR with the customer.
    const { customerId } = await createCustomer({ firstName: 'Hidden', lastName: 'Customer' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tA });
    await createOwnership({ vehicleId, customerId });
    // Only tenant B is related (decoy — proves nontrivial CTR query):
    await createCustomerTenantRelation({ tenantId: tB, customerId });

    await seedDeadline({ tenantId: tA, locationId: lA, vehicleId, interventionTypeId: typeId });

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
    const { tenantId, locationId } = await createTenantWithLocation('dl-pagination');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const seededIds: string[] = [];
    for (const day of [1, 2, 3]) {
      const { deadlineId } = await seedDeadline({
        tenantId,
        locationId,
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

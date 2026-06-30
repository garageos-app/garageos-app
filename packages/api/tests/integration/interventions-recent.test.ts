import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Integration coverage for GET /v1/interventions/recent (F-OFF-501 PR2).
// Validates: tenant isolation (RLS), status filter (active+disputed,
// excludes cancelled), deterministic ordering (createdAt DESC, id DESC
// tiebreaker), and limit boundary (50 ok, 51 → 400). Unique IP per
// describe block (memory feedback_integration_test_rate_limit_isolation,
// range 10.20.50.x — free vs existing ranges).

const TEST_IP = '10.20.50.2';

describe('GET /v1/interventions/recent (integration)', () => {
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

  it('returns only interventions of the calling tenant (RLS isolation)', async () => {
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('rec-iso-A');
    const { tenantId: tB, locationId: lB } = await createTenantWithLocation('rec-iso-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    const { userId: uA } = await createUser({ tenantId: tA, cognitoSub });
    const { userId: uB } = await createUser({
      tenantId: tB,
      cognitoSub: '22222222-2222-4222-8222-222222222222',
    });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId: vA } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });

    await createIntervention({
      tenantId: tA,
      locationId: lA,
      userId: uA,
      vehicleId: vA,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'Tenant A intervention',
    });
    await createIntervention({
      tenantId: tB,
      locationId: lB,
      userId: uB,
      vehicleId: vB,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 60000,
      title: 'Tenant B intervention',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.summary).toBe('Tenant A intervention');
  });

  it('excludes cancelled interventions; includes active and disputed', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rec-status');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'Active one',
      status: 'active',
    });
    await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 51000,
      title: 'Disputed one',
      status: 'disputed',
    });
    await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-22',
      odometerKm: 52000,
      title: 'Cancelled one',
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
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ summary: string; status: string }> };
    expect(body.items).toHaveLength(2);
    const summaries = body.items.map((i) => i.summary).sort();
    expect(summaries).toEqual(['Active one', 'Disputed one']);
  });

  it('orders by createdAt DESC with id DESC tiebreaker', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rec-order');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // Force identical createdAt to exercise tiebreaker by id DESC.
    const sharedCreatedAt = new Date('2026-05-23T10:00:00.000Z');
    const { interventionId: i1 } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-23',
      odometerKm: 50000,
      title: 'A',
      createdAt: sharedCreatedAt,
    });
    const { interventionId: i2 } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-23',
      odometerKm: 51000,
      title: 'B',
      createdAt: sharedCreatedAt,
    });
    // Newer createdAt — must appear first regardless of id.
    const { interventionId: i3 } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-23',
      odometerKm: 52000,
      title: 'C',
      createdAt: new Date('2026-05-23T11:00:00.000Z'),
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    const body = res.json() as { items: Array<{ id: string; summary: string }> };
    expect(body.items[0]!.id).toBe(i3); // newest createdAt
    // i1 vs i2 share createdAt → id DESC tiebreaker (lexicographic UUID compare)
    const expectedSecond = i1 > i2 ? i1 : i2;
    const expectedThird = i1 > i2 ? i2 : i1;
    expect(body.items[1]!.id).toBe(expectedSecond);
    expect(body.items[2]!.id).toBe(expectedThird);
  });

  it('respects limit query param (cap 50, default 10)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rec-limit');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    for (let i = 0; i < 12; i++) {
      await createIntervention({
        tenantId,
        locationId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-23',
        odometerKm: 50000 + i,
        title: `Row ${i}`,
      });
    }

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    // Default = 10
    const resDefault = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect((resDefault.json() as { items: unknown[] }).items).toHaveLength(10);

    // limit=5
    const res5 = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?limit=5',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect((res5.json() as { items: unknown[] }).items).toHaveLength(5);

    // limit=51 → 400
    const res51 = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?limit=51',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res51.statusCode).toBe(400);
  });

  it('401 without authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/interventions/recent — BR-205 relaxed (sede unica)', () => {
  // BR-205 is relaxed: mechanics now see all tenant interventions regardless
  // of which location an intervention was originally registered at.
  // Tenant isolation is unchanged (a mechanic in tenant A cannot see tenant B's interventions).
  const LOC_IP = '10.20.41.2';
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

  it('mechanic sees all tenant interventions (BR-205 relaxed — sede unica)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rec-all');
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const cognitoSub = '10000000-0000-4000-8000-000000000001';
    const { userId } = await createUser({ tenantId, cognitoSub });

    // Create two interventions — both should be visible to the mechanic.
    await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'First intervention',
    });
    await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 51000,
      title: 'Second intervention',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items.map((i) => i.summary).sort()).toEqual(
      ['First intervention', 'Second intervention'].sort(),
    );
  });
});

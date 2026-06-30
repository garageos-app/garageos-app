import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createDispute,
  createIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Integration coverage for GET /v1/disputes/open (F-OFF-501 PR3).
// Validates: tenant isolation (RLS via intervention scope), status
// classification (open → pendingResponse; responded+escalated →
// inProgress; resolved_by_cancellation+closed_by_admin excluded),
// BR-151 PII fallback "Cliente" when no CustomerTenantRelation,
// isBusiness vs persona-fisica naming, count vs items truncation
// (take=20 hard). Unique IP per describe block (memory
// feedback_integration_test_rate_limit_isolation): 10.20.60.x range.

const TEST_IP = '10.20.60.2';

describe('GET /v1/disputes/open (integration)', () => {
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

  it('returns only disputes of the calling tenant (RLS isolation via intervention)', async () => {
    const { tenantId: tA } = await createTenantWithLocation('do-iso-A');
    const { tenantId: tB } = await createTenantWithLocation('do-iso-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    const { userId: uA } = await createUser({ tenantId: tA, cognitoSub });
    const { userId: uB } = await createUser({
      tenantId: tB,
      cognitoSub: '22222222-2222-4222-8222-222222222222',
    });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId: vA } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });
    const { customerId: cA } = await createCustomer({ email: 'do-iso-a@test.it' });
    const { customerId: cB } = await createCustomer({ email: 'do-iso-b@test.it' });
    await createCustomerTenantRelation({ tenantId: tA, customerId: cA });
    await createCustomerTenantRelation({ tenantId: tB, customerId: cB });
    const { interventionId: iA } = await createIntervention({
      tenantId: tA,
      userId: uA,
      vehicleId: vA,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'A',
    });
    const { interventionId: iB } = await createIntervention({
      tenantId: tB,
      userId: uB,
      vehicleId: vB,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 60000,
      title: 'B',
    });
    await createDispute({ interventionId: iA, customerId: cA, status: 'open' });
    await createDispute({ interventionId: iB, customerId: cB, status: 'open' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingResponse: { count: number; items: Array<{ id: string }> };
    };
    expect(body.pendingResponse.count).toBe(1);
    expect(body.pendingResponse.items).toHaveLength(1);
  });

  it('classifies 5 dispute statuses correctly (open → pending; responded+escalated → inProgress; resolved+closed excluded)', async () => {
    const { tenantId } = await createTenantWithLocation('do-status');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({ email: 'do-status@test.it' });
    await createCustomerTenantRelation({ tenantId, customerId });

    async function mkIntervention(km: number) {
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-20',
        odometerKm: km,
        title: `int-${km}`,
      });
      return interventionId;
    }

    const iOpen = await mkIntervention(10000);
    const iResp = await mkIntervention(10001);
    const iEsc = await mkIntervention(10002);
    const iResolved = await mkIntervention(10003);
    const iClosed = await mkIntervention(10004);

    await createDispute({ interventionId: iOpen, customerId, status: 'open' });
    await createDispute({ interventionId: iResp, customerId, status: 'responded' });
    await createDispute({ interventionId: iEsc, customerId, status: 'escalated' });
    await createDispute({
      interventionId: iResolved,
      customerId,
      status: 'resolved_by_cancellation',
      resolvedAt: new Date('2026-05-25'),
    });
    await createDispute({
      interventionId: iClosed,
      customerId,
      status: 'closed_by_admin',
      resolvedAt: new Date('2026-05-26'),
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingResponse: { count: number };
      inProgress: { count: number; items: Array<{ status: string }> };
    };
    expect(body.pendingResponse.count).toBe(1);
    expect(body.inProgress.count).toBe(2);
    const statuses = body.inProgress.items.map((i) => i.status).sort();
    expect(statuses).toEqual(['escalated', 'responded']);
  });

  it('falls back to "Cliente" when CustomerTenantRelation is missing (BR-151)', async () => {
    const { tenantId } = await createTenantWithLocation('do-pii');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({
      email: 'no-relation@test.it',
      firstName: 'Hidden',
      lastName: 'Customer',
    });

    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'pii-test',
    });
    await createDispute({ interventionId, customerId, status: 'open' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingResponse: { items: Array<{ customerName: string }> };
    };
    expect(body.pendingResponse.items[0]!.customerName).toBe('Cliente');
  });

  it('uses businessName when isBusiness=true and relation visible', async () => {
    const { tenantId } = await createTenantWithLocation('do-biz');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({
      email: 'biz@test.it',
      isBusiness: true,
      businessName: 'Trasporti SRL',
      firstName: 'Mario',
      lastName: 'Rossi',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      title: 'biz-test',
    });
    await createDispute({ interventionId, customerId, status: 'open' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingResponse: { items: Array<{ customerName: string }> };
    };
    expect(body.pendingResponse.items[0]!.customerName).toBe('Trasporti SRL');
  });

  it('exposes count for full group even when items truncated at 20', async () => {
    // LIMIT_PER_GROUP=20 in src/routes/v1/disputes-open.ts; +2 to assert
    // truncation: count reflects full group while items[] caps at the limit.
    const TOTAL_DISPUTES = 22;
    const { tenantId } = await createTenantWithLocation('do-limit');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({ email: 'limit@test.it' });
    await createCustomerTenantRelation({ tenantId, customerId });

    for (let i = 0; i < TOTAL_DISPUTES; i++) {
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-20',
        odometerKm: 50000 + i,
        title: `int-${i}`,
      });
      await createDispute({ interventionId, customerId, status: 'open' });
    }

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    const body = res.json() as {
      pendingResponse: { count: number; items: unknown[] };
    };
    expect(body.pendingResponse.count).toBe(TOTAL_DISPUTES);
    expect(body.pendingResponse.items).toHaveLength(20);
  });

  it('401 without authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/disputes/open — BR-205 relaxed (sede unica)', () => {
  // BR-205 is relaxed: mechanics now see all tenant disputes regardless
  // of which location the underlying intervention was registered at.
  // Tenant isolation is unchanged.
  const LOC_IP = '10.20.43.2';
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

  it('mechanic sees all tenant disputes (BR-205 relaxed — sede unica)', async () => {
    const { tenantId } = await createTenantWithLocation('do-all');
    const cognitoSub = '30000000-0000-4000-8000-000000000001';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({ email: 'do-all@test.it' });
    await createCustomerTenantRelation({ tenantId, customerId });

    // Create two disputes — both should be visible to the mechanic.
    const mkDispute = async (km: number) => {
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-20',
        odometerKm: km,
        title: `int-${km}`,
      });
      await createDispute({ interventionId, customerId, status: 'open' });
    };
    await mkDispute(10000);
    await mkDispute(10001);

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pendingResponse: { count: number; items: unknown[] } };
    expect(body.pendingResponse.count).toBe(2);
    expect(body.pendingResponse.items).toHaveLength(2);
  });
});

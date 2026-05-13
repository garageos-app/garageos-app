import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createVehicle,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Pin the client IP for this describe block. The detail route doesn't
// opt into @fastify/rate-limit today, but future per-route limits would
// key on remoteAddress; pinning makes the keyer deterministic. Tasks
// that DO exercise rate-limit semantics (POST in this slice) MUST use a
// distinct IP per test — see feedback_integration_test_rate_limit_isolation.
const TEST_IP = '10.50.13.1';

describe('GET /v1/me/private-interventions/:id (integration)', () => {
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

  it('returns 404 private_intervention.not_found for unknown id', async () => {
    const cognitoSub = 'me-pi-404-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/private-interventions/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('returns the private intervention for the owning customer', async () => {
    const cognitoSub = 'me-pi-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pi-ok');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDETAIL000000001',
      plate: 'PI001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      odometerKm: 43500,
      customType: 'Olio fai-da-te',
      description: 'Cambio olio garage personale',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: privateInterventionId,
      vehicle_id: vehicleId,
      intervention_date: '2026-03-10',
      odometer_km: 43500,
      type: null,
      custom_type: 'Olio fai-da-te',
      description: 'Cambio olio garage personale',
    });
  });

  it('returns 404 for soft-deleted private intervention (BR-080 + soft delete)', async () => {
    const cognitoSub = 'me-pi-soft-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pi-soft');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PISOFTDEL00000001',
      plate: 'PI002AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      deletedAt: new Date(),
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('returns 404 for private intervention of another customer (BR-080 cross-customer RLS)', async () => {
    const cognitoSubA = 'me-pi-cross-a-' + Math.random().toString(36).slice(2, 10);
    const cognitoSubB = 'me-pi-cross-b-' + Math.random().toString(36).slice(2, 10);
    const { customerId: customerIdA } = await createCustomer({ cognitoSub: cognitoSubA });
    const { customerId: customerIdB } = await createCustomer({ cognitoSub: cognitoSubB });
    const { tenantId } = await createTenantWithLocation('me-pi-cross');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PICROSS0000000001',
      plate: 'PI003AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId: customerIdB });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId: customerIdB,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const tokenA = await signTestToken({
      pool: 'clienti',
      sub: cognitoSubA,
      customerId: customerIdA,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('returns 200 for private intervention on a transferred vehicle (BR-082)', async () => {
    // BR-082: private interventions stay with the customer who created
    // them, even after the vehicle is transferred. Detail-by-id must
    // remain accessible to the original customer.
    const cognitoSubSeller = 'me-pi-br082-' + Math.random().toString(36).slice(2, 10);
    const { customerId: sellerId } = await createCustomer({ cognitoSub: cognitoSubSeller });
    const { customerId: buyerId } = await createCustomer({
      cognitoSub: 'me-pi-buyer-' + Math.random().toString(36).slice(2, 10),
    });
    const { tenantId } = await createTenantWithLocation('me-pi-br082');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PITRANSFER0000001',
      plate: 'PI004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    // Original ownership (seller), then transfer to buyer
    await createOwnership({ vehicleId, customerId: sellerId, endedAt: new Date('2026-01-01') });
    await createOwnership({ vehicleId, customerId: buyerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId: sellerId,
      vehicleId,
      interventionDate: '2025-06-01',
      description: 'Pre-transfer private record',
    });

    const tokenSeller = await signTestToken({
      pool: 'clienti',
      sub: cognitoSubSeller,
      customerId: sellerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${tokenSeller}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: privateInterventionId,
      vehicle_id: vehicleId,
      description: 'Pre-transfer private record',
    });
  });
});

describe('GET /v1/me/vehicles/:id/private-interventions (integration)', () => {
  let app: FastifyInstance;
  const TEST_IP_LIST = '10.50.13.2';

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 404 me.vehicle.not_found for unowned vehicle', async () => {
    const cognitoSub = 'me-pil-noown-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-noown');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTNOOWN000001',
      plate: 'PL001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    // No ownership for this customer.

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'me.vehicle.not_found' });
  });

  it('returns private interventions sorted by interventionDate desc', async () => {
    const cognitoSub = 'me-pil-sort-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-sort');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTSORT0000001',
      plate: 'PL002AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-01-15',
      description: 'oldest',
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'newest',
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-02-20',
      description: 'middle',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ intervention_date: string; description: string }>;
      meta: { has_more: boolean };
    };
    expect(body.data.map((d) => d.description)).toEqual(['newest', 'middle', 'oldest']);
    expect(body.meta.has_more).toBe(false);
  });

  it('paginates with compound cursor (interventionDate desc, id desc)', async () => {
    const cognitoSub = 'me-pil-pag-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-pag');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTPAG00000001',
      plate: 'PL003AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    for (let i = 0; i < 5; i++) {
      await createPrivateIntervention({
        customerId,
        vehicleId,
        interventionDate: `2026-03-${String(10 - i).padStart(2, '0')}`,
        description: `entry-${i}`,
      });
    }

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions?limit=2`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json() as {
      data: Array<{ id: string; intervention_date: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(b1.data).toHaveLength(2);
    expect(b1.meta.has_more).toBe(true);
    expect(b1.meta.cursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions?limit=2&cursor=${b1.meta.cursor}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });
    expect(page2.statusCode).toBe(200);
    const b2 = page2.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(b2.data).toHaveLength(2);
    expect(b2.data[0]!.id).not.toBe(b1.data[0]!.id);
    expect(b2.data[0]!.id).not.toBe(b1.data[1]!.id);
  });

  it('returns empty list for a vehicle with no private interventions', async () => {
    const cognitoSub = 'me-pil-empty-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-empty');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTEMPTY000001',
      plate: 'PL004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: [], meta: { has_more: false } });
  });

  it('excludes soft-deleted rows from the list (BR-080 + soft delete)', async () => {
    const cognitoSub = 'me-pil-soft-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-soft');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTSOFT0000001',
      plate: 'PL005AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'alive',
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-11',
      description: 'soft-deleted',
      deletedAt: new Date(),
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ description: string }> };
    expect(body.data.map((d) => d.description)).toEqual(['alive']);
  });
});

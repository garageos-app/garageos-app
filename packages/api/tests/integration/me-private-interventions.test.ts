import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createAttachment,
  createCustomer,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
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

    // randomUUID() produces a real v4 UUID that passes z.uuid() but cannot
    // collide with any seeded row — exercises the not_found path, not Zod.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${randomUUID()}`,
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

  it('detail includes attachments[] array (empty when none)', async () => {
    const cognitoSub = 'me-pi-att-empty-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pi-att-empty');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIATTEMPTY000001',
      plate: 'PI100AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attachments: [] });
  });

  it('detail includes 3 attachments sorted by createdAt asc', async () => {
    const cognitoSub = 'me-pi-att-3-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pi-att-3');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIATT3000000001',
      plate: 'PI101AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });
    // Seed 3 attachments. We rely on the natural ORDER BY createdAt asc with
    // a tiny sleep between inserts to keep ordering deterministic.
    for (const fname of ['a.jpg', 'b.jpg', 'c.jpg']) {
      await createAttachment({
        ownerType: 'private_intervention',
        ownerId: privateInterventionId,
        customerId,
        uploadedByCustomerId: customerId,
        fileName: fname,
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    // Also seed one that should be excluded (deletedAt or processed=false).
    await createAttachment({
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      customerId,
      uploadedByCustomerId: customerId,
      fileName: 'pending.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      processed: false,
    });
    await createAttachment({
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      customerId,
      uploadedByCustomerId: customerId,
      fileName: 'deleted.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      deletedAt: new Date(),
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { attachments: Array<{ file_name: string }> };
    expect(body.attachments.map((a) => a.file_name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
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
    // Seeded dates (DESC): 2026-03-10, -09, -08, -07, -06 → 5 rows, limit=2.
    // Page1 must be [03-10, 03-09]; Page2 anchored after 03-09 must be
    // [03-08, 03-07]. Asserting full date sequence catches cursor-anchoring
    // bugs that a non-overlap-only assertion would miss.
    expect(b1.data).toHaveLength(2);
    expect(b1.data.map((d) => d.intervention_date)).toEqual(['2026-03-10', '2026-03-09']);
    expect(b1.meta.has_more).toBe(true);
    expect(b1.meta.cursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions?limit=2&cursor=${b1.meta.cursor}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });
    expect(page2.statusCode).toBe(200);
    const b2 = page2.json() as {
      data: Array<{ id: string; intervention_date: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(b2.data).toHaveLength(2);
    expect(b2.data.map((d) => d.intervention_date)).toEqual(['2026-03-08', '2026-03-07']);
    expect(b2.meta.has_more).toBe(true);
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

  it('list includes attachments_count per row (0/1/3 mix)', async () => {
    const cognitoSub = 'me-pil-count-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pil-count');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PILISTCOUNT00001',
      plate: 'PL100AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId: idZero } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'zero',
    });
    const { privateInterventionId: idOne } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-11',
      description: 'one',
    });
    const { privateInterventionId: idThree } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-12',
      description: 'three',
    });
    await createAttachment({
      ownerType: 'private_intervention',
      ownerId: idOne,
      customerId,
      uploadedByCustomerId: customerId,
    });
    for (let i = 0; i < 3; i++) {
      await createAttachment({
        ownerType: 'private_intervention',
        ownerId: idThree,
        customerId,
        uploadedByCustomerId: customerId,
      });
    }
    // Soft-deleted attachment on idZero — must not count.
    await createAttachment({
      ownerType: 'private_intervention',
      ownerId: idZero,
      customerId,
      uploadedByCustomerId: customerId,
      deletedAt: new Date(),
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_LIST },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; description: string; attachments_count: number }>;
    };
    // Sorted by interventionDate desc → three, one, zero.
    expect(body.data.map((d) => ({ desc: d.description, count: d.attachments_count }))).toEqual([
      { desc: 'three', count: 3 },
      { desc: 'one', count: 1 },
      { desc: 'zero', count: 0 },
    ]);
  });
});

describe('POST /v1/me/vehicles/:id/private-interventions (integration)', () => {
  let app: FastifyInstance;
  const TEST_IP_POST = '10.50.13.3';

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a private intervention with custom_type (201)', async () => {
    const cognitoSub = 'me-pip-custom-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-custom');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTCUST0000001',
      plate: 'PP001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: 43500,
        intervention_type_id: null,
        custom_type: 'Olio fai-da-te',
        description: 'Cambio olio + filtro garage personale',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      vehicle_id: vehicleId,
      intervention_date: '2026-03-10',
      odometer_km: 43500,
      type: null,
      custom_type: 'Olio fai-da-te',
      description: 'Cambio olio + filtro garage personale',
    });
  });

  it('creates a private intervention with intervention_type_id (201)', async () => {
    const cognitoSub = 'me-pip-type-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-type');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTTYPE0000001',
      plate: 'PP002AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('CAMBIO_OLIO');

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: 43500,
        intervention_type_id: interventionType.id,
        custom_type: null,
        description: 'Cambio olio',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: { id: interventionType.id, name_it: 'Cambio olio' },
      custom_type: null,
    });
  });

  it('returns 400 VALIDATION_ERROR when both intervention_type_id and custom_type are null', async () => {
    const cognitoSub = 'me-pip-bothnull-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-bothnull');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTNULL0000001',
      plate: 'PP003AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: null,
        description: 'Senza tipo',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 VALIDATION_ERROR when both intervention_type_id and custom_type are set', async () => {
    const cognitoSub = 'me-pip-both-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-both');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTBOTH0000001',
      plate: 'PP004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('TAGLIANDO');

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: interventionType.id,
        custom_type: 'Custom',
        description: 'Entrambi set',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 422 private_intervention.vehicle_not_owned for unowned vehicle (BR-080)', async () => {
    const cognitoSub = 'me-pip-unown-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-unown');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTUNOWN000001',
      plate: 'PP005AA',
      make: 'Fiat',
      model: 'Panda',
    });
    // No ownership for this customer.

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fai-da-te',
        description: 'Non posseduto',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'private_intervention.vehicle_not_owned' });
  });

  it('returns 422 vehicle_not_owned for transferred vehicle (endedAt set)', async () => {
    const cognitoSub = 'me-pip-trans-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { customerId: newOwnerId } = await createCustomer({
      cognitoSub: 'me-pip-newown-' + Math.random().toString(36).slice(2, 10),
    });
    const { tenantId } = await createTenantWithLocation('me-pip-trans');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTTRANS000001',
      plate: 'PP006AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId, endedAt: new Date('2026-01-01') });
    await createOwnership({ vehicleId, customerId: newOwnerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fai-da-te',
        description: 'Veicolo trasferito',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'private_intervention.vehicle_not_owned' });
  });

  it('returns 422 private_intervention.date_future for future intervention_date', async () => {
    const cognitoSub = 'me-pip-future-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-future');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTFUT00000001',
      plate: 'PP007AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    // Today + 365 days, formatted as YYYY-MM-DD UTC, guaranteed future
    // regardless of when this test runs.
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: futureDate,
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'futura',
        description: 'Data futura',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'private_intervention.date_future' });
  });

  it('returns 422 VALIDATION_ERROR for non-existent intervention_type_id', async () => {
    const cognitoSub = 'me-pip-badtype-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-badtype');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTBAD00000001',
      plate: 'PP008AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        // Valid-format UUID v4 that doesn't exist in DB — exercises the
        // application-layer existence check rather than Zod's z.uuid().
        intervention_type_id: randomUUID(),
        custom_type: null,
        description: 'Type inesistente',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns 429 private_intervention.rate_limit after 50 creates in 24h (BR-085)', async () => {
    const cognitoSub = 'me-pip-rate-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-rate');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTRATE0000001',
      plate: 'PP009AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    // Seed 50 existing rows via the test helper — direct DB inserts bypass
    // the rate-limit check, simulating "50 already created today".
    for (let i = 0; i < 50; i++) {
      await createPrivateIntervention({
        customerId,
        vehicleId,
        interventionDate: '2026-03-10',
        description: `seed-${i}`,
      });
    }

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'over-limit',
        description: 'Eccede 50',
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'private_intervention.rate_limit' });
  });

  it('accepts the 50th create but rejects the 51st (BR-085 boundary)', async () => {
    const cognitoSub = 'me-pip-rate2-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-rate2');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPOSTRATEBND0001',
      plate: 'PP010AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    // Seed 49 — the next POST is the 50th and must succeed.
    for (let i = 0; i < 49; i++) {
      await createPrivateIntervention({
        customerId,
        vehicleId,
        interventionDate: '2026-03-10',
        description: `seed-${i}`,
      });
    }

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res50 = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fiftieth',
        description: 'Cinquantesimo',
      },
    });
    expect(res50.statusCode).toBe(201);

    const res51 = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_POST,
      },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fifty-first',
        description: 'Cinquantunesimo',
      },
    });
    expect(res51.statusCode).toBe(429);
  });
});

describe('PATCH /v1/me/private-interventions/:id (integration)', () => {
  let app: FastifyInstance;
  const TEST_IP_PATCH = '10.50.13.4';

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('200 patches description only', async () => {
    const cognitoSub = 'me-pip-desc-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-desc');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHDESC000001',
      plate: 'PA001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'old description',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { description: 'new description' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: privateInterventionId,
      description: 'new description',
    });
  });

  it('200 patches all mutable fields at once', async () => {
    const cognitoSub = 'me-pip-all-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-all');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHALL0000001',
      plate: 'PA002AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('CAMBIO_OLIO');
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      odometerKm: 40000,
      customType: 'old',
      description: 'old',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: {
        intervention_date: '2026-04-10',
        odometer_km: 45000,
        intervention_type_id: interventionType.id,
        custom_type: null,
        description: 'updated',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      intervention_date: '2026-04-10',
      odometer_km: 45000,
      type: { id: interventionType.id, name_it: 'Cambio olio' },
      custom_type: null,
      description: 'updated',
    });
  });

  it('200 swaps custom_type → intervention_type_id (atomic)', async () => {
    const cognitoSub = 'me-pip-swap1-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-swap1');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHSWP1000001',
      plate: 'PA003AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('TAGLIANDO');
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      customType: 'custom-old',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: {
        intervention_type_id: interventionType.id,
        custom_type: null,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      type: { id: interventionType.id, name_it: 'Tagliando' },
      custom_type: null,
    });
  });

  it('200 swaps intervention_type_id → custom_type (atomic)', async () => {
    const cognitoSub = 'me-pip-swap2-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-swap2');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHSWP2000001',
      plate: 'PA004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('GOMME');
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      customType: null,
    });
    // Seed with type-id (createPrivateIntervention helper doesn't accept it directly,
    // so we patch the row directly via pgAdmin).
    await pgAdmin.query(
      `UPDATE private_interventions SET intervention_type_id = $1, custom_type = NULL WHERE id = $2`,
      [interventionType.id, privateInterventionId],
    );

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: {
        intervention_type_id: null,
        custom_type: 'newly-custom',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      type: null,
      custom_type: 'newly-custom',
    });
  });

  it('422 private_intervention.date_future when intervention_date is in the future', async () => {
    const cognitoSub = 'me-pip-fut-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-fut');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHFUT0000001',
      plate: 'PA005AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { intervention_date: futureDate },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'private_intervention.date_future' });
  });

  it('422 VALIDATION_ERROR for non-existent intervention_type_id', async () => {
    const cognitoSub = 'me-pip-badtype-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-badtype');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHBAD0000001',
      plate: 'PA006AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { intervention_type_id: randomUUID(), custom_type: null },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('422 VALIDATION_ERROR when payload would set both fields non-null', async () => {
    const cognitoSub = 'me-pip-xor1-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-xor1');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHXOR1000001',
      plate: 'PA007AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const interventionType = await ensureSystemInterventionType('REVISIONE');
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      customType: 'starting-custom',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { intervention_type_id: interventionType.id }, // would result in both set
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('422 VALIDATION_ERROR when payload would set both fields to null', async () => {
    const cognitoSub = 'me-pip-xor2-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-xor2');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHXOR2000001',
      plate: 'PA008AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      customType: 'starting-custom',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { custom_type: null }, // current has type_id=null too → both null
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('400 VALIDATION_ERROR for empty description string', async () => {
    const cognitoSub = 'me-pip-emp-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-emp');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHEMP0000001',
      plate: 'PA009AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { description: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404 cross-customer PATCH attempt', async () => {
    const cognitoSubA = 'me-pip-cross-a-' + Math.random().toString(36).slice(2, 10);
    const cognitoSubB = 'me-pip-cross-b-' + Math.random().toString(36).slice(2, 10);
    const { customerId: customerIdA } = await createCustomer({ cognitoSub: cognitoSubA });
    const { customerId: customerIdB } = await createCustomer({ cognitoSub: cognitoSubB });
    const { tenantId } = await createTenantWithLocation('me-pip-cross');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHCROSS00001',
      plate: 'PA010AA',
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
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { description: 'hijack' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('404 PATCH on already-soft-deleted private intervention', async () => {
    const cognitoSub = 'me-pip-soft-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-soft');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHSOFT000001',
      plate: 'PA011AA',
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
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { description: 'cannot patch deleted' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('200 PATCH after vehicle transfer (BR-082)', async () => {
    const cognitoSubSeller = 'me-pip-br082-' + Math.random().toString(36).slice(2, 10);
    const { customerId: sellerId } = await createCustomer({ cognitoSub: cognitoSubSeller });
    const { customerId: buyerId } = await createCustomer({
      cognitoSub: 'me-pip-buyer-' + Math.random().toString(36).slice(2, 10),
    });
    const { tenantId } = await createTenantWithLocation('me-pip-br082');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHBR0820001',
      plate: 'PA012AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId: sellerId, endedAt: new Date('2026-01-01') });
    await createOwnership({ vehicleId, customerId: buyerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId: sellerId,
      vehicleId,
      interventionDate: '2025-06-01',
      description: 'pre-transfer',
    });

    const tokenSeller = await signTestToken({
      pool: 'clienti',
      sub: cognitoSubSeller,
      customerId: sellerId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${tokenSeller}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { description: 'post-transfer correction' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ description: 'post-transfer correction' });
  });

  it('200 PATCH with empty body is a no-op (still touches updatedAt)', async () => {
    const cognitoSub = 'me-pip-noop-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-noop');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHNOOP000001',
      plate: 'PA013AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'unchanged',
    });

    // Empty body PATCH semantic: handler succeeds, returns unchanged
    // detail shape. Prisma may short-circuit `update({data: {}})` without
    // issuing SQL, so `updated_at` is NOT guaranteed to advance — we only
    // assert the 200 + payload echo. Caller-side "ping" use-case can rely
    // on the 200 status, not on timestamp change.
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      description: string;
      intervention_date: string;
    };
    expect(body.description).toBe('unchanged');
    expect(body.intervention_date).toBe('2026-03-10');
  });

  it('400 VALIDATION_ERROR for unknown body field (strict mode)', async () => {
    const cognitoSub = 'me-pip-strict-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pip-strict');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIPATCHSTRC00001',
      plate: 'PA014AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PATCH,
      },
      payload: { vehicle_id: randomUUID() }, // can't change vehicle_id via PATCH
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/me/private-interventions/:id (integration)', () => {
  let app: FastifyInstance;
  const TEST_IP_DELETE = '10.50.13.5';

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('204 happy path soft-deletes', async () => {
    const cognitoSub = 'me-pid-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pid-ok');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELOK0000000001',
      plate: 'PD001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');

    // Verify deletedAt is set in DB.
    const { rows } = await pgAdmin.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM private_interventions WHERE id = $1`,
      [privateInterventionId],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('404 DELETE on non-existent id', async () => {
    const cognitoSub = 'me-pid-404-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('404 DELETE on cross-customer private intervention (BR-080 RLS)', async () => {
    const cognitoSubA = 'me-pid-cross-a-' + Math.random().toString(36).slice(2, 10);
    const cognitoSubB = 'me-pid-cross-b-' + Math.random().toString(36).slice(2, 10);
    const { customerId: customerIdA } = await createCustomer({ cognitoSub: cognitoSubA });
    const { customerId: customerIdB } = await createCustomer({ cognitoSub: cognitoSubB });
    const { tenantId } = await createTenantWithLocation('me-pid-cross');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELCROSS000001',
      plate: 'PD002AA',
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
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });

    // Verify B's row was NOT modified.
    const { rows } = await pgAdmin.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM private_interventions WHERE id = $1`,
      [privateInterventionId],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it('404 DELETE on already-deleted (idempotency check)', async () => {
    const cognitoSub = 'me-pid-idem-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pid-idem');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELIDEM0000001',
      plate: 'PD003AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      deletedAt: new Date('2026-03-11'),
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('GET detail after DELETE returns 404', async () => {
    const cognitoSub = 'me-pid-getafter-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pid-getafter');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELGET00000001',
      plate: 'PD004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });
    expect(get.statusCode).toBe(404);
  });

  it('GET list after DELETE excludes the row', async () => {
    const cognitoSub = 'me-pid-listafter-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pid-listafter');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELLIST00000001',
      plate: 'PD005AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
      description: 'to-delete',
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-11',
      description: 'to-keep',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { data: Array<{ description: string }> };
    expect(body.data.map((d) => d.description)).toEqual(['to-keep']);
  });

  it('DELETE does not cascade-delete attached files (orphan policy)', async () => {
    const cognitoSub = 'me-pid-orphan-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-pid-orphan');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'PIDELORPHAN00001',
      plate: 'PD006AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });
    // Seed an attachment directly. customerId XOR per chk_attachment_owner_consistent.
    const { attachmentId } = await createAttachment({
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      customerId,
      uploadedByCustomerId: customerId,
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${privateInterventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_DELETE },
    });

    // Verify attachment row still exists (no cascade soft delete).
    const { rows } = await pgAdmin.query<{ id: string; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM attachments WHERE id = $1`,
      [attachmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

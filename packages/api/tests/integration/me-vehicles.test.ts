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

// /v1/me/vehicles* (F-CLI-105 / F-CLI-106).
//
// End-to-end coverage: clienti-pool JWT verification (real
// aws-jwt-verify against the in-process JWKS), pool guard, customer
// context plumbing, and ownership-scoped reads. BR-040 visibility
// (active ownership only) is exercised by happy-path + sold-vehicle
// scenarios.

describe('GET /v1/me/vehicles (integration)', () => {
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

  it('returns the customer active vehicles', async () => {
    const cognitoSub = 'me-veh-list-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-veh-list');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1U2A1234567890',
      plate: 'ME001AB',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({
      pool: 'clienti',
      sub: cognitoSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; vin: string; currentOwnership: { id: string } }>;
      meta: { has_more: boolean };
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(vehicleId);
    expect(body.data[0]!.vin).toBe('ZFA1U2A1234567890');
    expect(body.data[0]!.currentOwnership.id).toBeTruthy();
    expect(body.meta.has_more).toBe(false);
  });

  it('excludes vehicles whose ownership has ended (sold/transferred)', async () => {
    const cognitoSub = 'me-veh-ended-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-veh-ended');

    const { vehicleId: activeId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1ACTIVE0000001',
      plate: 'ME002AC',
    });
    await createOwnership({ vehicleId: activeId, customerId });

    const { vehicleId: soldId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1SOLD000000001',
      plate: 'ME003SO',
    });
    const { ownershipId: soldOwnershipId } = await createOwnership({
      vehicleId: soldId,
      customerId,
    });
    // Mark the second ownership as ended — the customer no longer owns
    // this vehicle and it must drop out of /me/vehicles.
    await pgAdmin.query(`UPDATE vehicle_ownerships SET ended_at = NOW() WHERE id = $1`, [
      soldOwnershipId,
    ]);

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((v) => v.id)).toEqual([activeId]);
  });

  it('does not leak vehicles owned by other customers', async () => {
    const myCognitoSub = 'me-veh-iso-self-' + Math.random().toString(36).slice(2, 10);
    const otherCognitoSub = 'me-veh-iso-other-' + Math.random().toString(36).slice(2, 10);
    const { customerId: myId } = await createCustomer({ cognitoSub: myCognitoSub });
    const { customerId: otherId } = await createCustomer({
      email: `other-${Math.random().toString(36).slice(2, 10)}@test.it`,
      cognitoSub: otherCognitoSub,
    });
    const { tenantId } = await createTenantWithLocation('me-veh-iso');

    const { vehicleId: mine } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1MINE000000001',
      plate: 'ME004MI',
    });
    await createOwnership({ vehicleId: mine, customerId: myId });

    const { vehicleId: theirs } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1THEIR00000001',
      plate: 'ME005TH',
    });
    await createOwnership({ vehicleId: theirs, customerId: otherId });

    const token = await signTestToken({ pool: 'clienti', sub: myCognitoSub, customerId: myId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((v) => v.id)).toEqual([mine]);
  });

  it('rejects officine pool tokens with 403', async () => {
    const { tenantId } = await createTenantWithLocation('me-veh-officine');
    const token = await signTestToken({
      pool: 'officine',
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/vehicles' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/me/vehicles/:id (integration)', () => {
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

  it('returns the vehicle detail and active ownership for the owning customer', async () => {
    const cognitoSub = 'me-veh-id-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-veh-id-ok');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1DETAIL0000001',
      plate: 'ME006DT',
      make: 'Alfa Romeo',
      model: 'Giulia',
      year: 2022,
    });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; make: string; model: string; year: number };
      currentOwnership: { id: string; startedAt: string };
    };
    expect(body.vehicle.id).toBe(vehicleId);
    expect(body.vehicle.make).toBe('Alfa Romeo');
    expect(body.vehicle.model).toBe('Giulia');
    expect(body.vehicle.year).toBe(2022);
    expect(body.currentOwnership.id).toBeTruthy();
  });

  it('returns 404 when the vehicle is owned by another customer', async () => {
    const myCognitoSub = 'me-veh-id-other-' + Math.random().toString(36).slice(2, 10);
    const { customerId: myId } = await createCustomer({ cognitoSub: myCognitoSub });
    const { customerId: otherId } = await createCustomer({
      email: `else-${Math.random().toString(36).slice(2, 10)}@test.it`,
    });
    const { tenantId } = await createTenantWithLocation('me-veh-id-other');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1OTHER00000001',
      plate: 'ME007OT',
    });
    await createOwnership({ vehicleId, customerId: otherId });

    const token = await signTestToken({ pool: 'clienti', sub: myCognitoSub, customerId: myId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.not_found',
      status: 404,
    });
  });

  it('returns 404 when the customer used to own the vehicle but ownership ended', async () => {
    const cognitoSub = 'me-veh-id-past-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('me-veh-id-past');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1PAST000000001',
      plate: 'ME008PA',
    });
    const { ownershipId } = await createOwnership({ vehicleId, customerId });
    await pgAdmin.query(`UPDATE vehicle_ownerships SET ended_at = NOW() WHERE id = $1`, [
      ownershipId,
    ]);

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the vehicle id does not exist at all', async () => {
    const cognitoSub = 'me-veh-id-noexist-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects officine pool tokens with 403', async () => {
    const { tenantId } = await createTenantWithLocation('me-veh-id-officine');
    const token = await signTestToken({
      pool: 'officine',
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/me/vehicles/:id/access-log (integration)', () => {
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

  async function seedAccess(params: {
    vehicleId: string;
    tenantId: string;
    locationId: string;
    userId: string;
    action: string;
    createdAt: string; // ISO
  }) {
    await pgAdmin.query(
      `INSERT INTO access_logs (vehicle_id, tenant_id, location_id, user_id, action, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5::"AccessLogAction", $6::inet, $7, $8)`,
      [
        params.vehicleId,
        params.tenantId,
        params.locationId,
        params.userId,
        params.action,
        '203.0.113.7',
        'seed-agent/1.0',
        params.createdAt,
      ],
    );
  }

  it('returns only view + intervention create, redacted, newest first, with relation-gated mechanic name', async () => {
    const cognitoSub = 'me-acc-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    // Tenant A: customer HAS a relation -> mechanic name visible.
    const { tenantId: tenantA, locationId: locA } = await createTenantWithLocation('me-acc-a');
    const { userId: mechA } = await createUser({
      tenantId: tenantA,
      locationId: locA,
      cognitoSub: cognitoSub + '-mA',
      email: `mA-${cognitoSub}@example.com`,
      firstName: 'Anna',
      lastName: 'Verdi',
      role: 'mechanic',
    });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    // Tenant B: NO relation -> mechanic name hidden.
    const { tenantId: tenantB, locationId: locB } = await createTenantWithLocation('me-acc-b');
    const { userId: mechB } = await createUser({
      tenantId: tenantB,
      locationId: locB,
      cognitoSub: cognitoSub + '-mB',
      email: `mB-${cognitoSub}@example.com`,
      firstName: 'Bruno',
      lastName: 'Neri',
      role: 'mechanic',
    });

    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantA,
      vin: 'ZFA1ACCESS0000001',
      plate: 'ME900AC',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    // T0 < T1 < T2 < T3 < T4 (oldest..newest)
    await seedAccess({
      vehicleId,
      tenantId: tenantA,
      locationId: locA,
      userId: mechA,
      action: 'vehicle_registered',
      createdAt: '2026-06-01T08:00:00.000Z',
    }); // excluded
    await seedAccess({
      vehicleId,
      tenantId: tenantA,
      locationId: locA,
      userId: mechA,
      action: 'view',
      createdAt: '2026-06-02T08:00:00.000Z',
    });
    await seedAccess({
      vehicleId,
      tenantId: tenantA,
      locationId: locA,
      userId: mechA,
      action: 'create',
      createdAt: '2026-06-03T08:00:00.000Z',
    });
    await seedAccess({
      vehicleId,
      tenantId: tenantB,
      locationId: locB,
      userId: mechB,
      action: 'search_match',
      createdAt: '2026-06-04T08:00:00.000Z',
    }); // excluded
    await seedAccess({
      vehicleId,
      tenantId: tenantB,
      locationId: locB,
      userId: mechB,
      action: 'view',
      createdAt: '2026-06-05T08:00:00.000Z',
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        action: string;
        tenantName: string;
        locationCity: string | null;
        occurredAt: string;
        mechanicName?: string;
      }>;
      meta: { has_more: boolean };
    };

    // 3 surfaced rows (vehicle_registered + search_match excluded), newest first.
    expect(body.data.map((e) => e.action)).toEqual(['view', 'new_intervention', 'view']);
    expect(body.data.map((e) => e.occurredAt)).toEqual([
      '2026-06-05T08:00:00.000Z',
      '2026-06-03T08:00:00.000Z',
      '2026-06-02T08:00:00.000Z',
    ]);
    // Newest is tenant B (no relation) -> mechanic name hidden.
    // createTenantWithLocation stores business_name = `Test Tenant <suffix>`
    // and a hardcoded city 'Milano'.
    expect(body.data[0]!.tenantName).toBe('Test Tenant me-acc-b');
    expect(body.data[0]).not.toHaveProperty('mechanicName');
    expect(body.data[0]!.locationCity).toBe('Milano');
    // Tenant A rows (related) -> mechanic name visible.
    expect(body.data[1]!.mechanicName).toBe('Anna Verdi');
    expect(body.data[2]!.mechanicName).toBe('Anna Verdi');
    // Redaction: no internal fields anywhere.
    for (const entry of body.data) {
      expect(entry).not.toHaveProperty('ipAddress');
      expect(entry).not.toHaveProperty('userAgent');
      expect(entry).not.toHaveProperty('userId');
      expect(entry).not.toHaveProperty('tenantId');
    }
  });

  it('paginates newest-first across a page boundary via cursor', async () => {
    const cognitoSub = 'me-acc-pg-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId, locationId } = await createTenantWithLocation('me-acc-pg');
    const { userId } = await createUser({
      tenantId,
      locationId,
      cognitoSub: cognitoSub + '-m',
      email: `m-${cognitoSub}@example.com`,
      firstName: 'Carla',
      lastName: 'Gialli',
      role: 'mechanic',
    });
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1ACCESSPG00001',
      plate: 'ME901PG',
    });
    await createOwnership({ vehicleId, customerId });
    for (let i = 1; i <= 3; i++) {
      await seedAccess({
        vehicleId,
        tenantId,
        locationId,
        userId,
        action: 'view',
        createdAt: `2026-06-0${i}T08:00:00.000Z`,
      });
    }

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log?limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    const b1 = page1.json() as {
      data: Array<{ occurredAt: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(b1.data.map((e) => e.occurredAt)).toEqual([
      '2026-06-03T08:00:00.000Z',
      '2026-06-02T08:00:00.000Z',
    ]);
    expect(b1.meta.has_more).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log?limit=2&cursor=${b1.meta.cursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const b2 = page2.json() as {
      data: Array<{ occurredAt: string }>;
      meta: { has_more: boolean };
    };
    expect(b2.data.map((e) => e.occurredAt)).toEqual(['2026-06-01T08:00:00.000Z']);
    expect(b2.meta.has_more).toBe(false);
  });

  it('returns 404 for a vehicle the customer does not own (cross-customer)', async () => {
    const ownerSub = 'me-acc-own-' + Math.random().toString(36).slice(2, 10);
    const otherSub = 'me-acc-oth-' + Math.random().toString(36).slice(2, 10);
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    const { customerId: otherId } = await createCustomer({ cognitoSub: otherSub });
    const { tenantId } = await createTenantWithLocation('me-acc-x');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1ACCESSXC00001',
      plate: 'ME902XC',
    });
    await createOwnership({ vehicleId, customerId: ownerId });

    const otherToken = await signTestToken({ pool: 'clienti', sub: otherSub, customerId: otherId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

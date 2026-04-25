import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
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

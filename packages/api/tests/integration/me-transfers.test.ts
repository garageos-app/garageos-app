import { randomUUID } from 'node:crypto';

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
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-401 PR1 — POST/GET /v1/me/transfers.
describe('Customer transfer initiate (F-CLI-401)', () => {
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

  // Creates an authenticated customer who owns a certified vehicle.
  async function ownerWithVehicle() {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, vehicleId, token };
  }

  function postTransfer(token: string, vehicleId: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/transfers',
      headers: { authorization: `Bearer ${token}` },
      payload: { vehicleId, method: 'physical_code' },
    });
  }

  it('initiates a pending_recipient transfer without moving ownership', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    const res = await postTransfer(token, vehicleId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending_recipient');
    expect(body.transferCode).toMatch(/^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/);

    // Ownership unchanged: the customer still owns the vehicle.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().data.map((v: { id: string }) => v.id)).toContain(vehicleId);
  });

  it('rejects a second active transfer for the same vehicle (BR-047)', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(201);
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(409);
  });

  it('returns 403 when the caller is not the active owner (BR-040)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    const { customerId: ownerId } = await createCustomer({
      cognitoSub: `o-${randomUUID().slice(0, 8)}`,
    });
    await createOwnership({ vehicleId, customerId: ownerId });

    const strangerSub = `s-${randomUUID().slice(0, 8)}`;
    const { customerId: strangerId } = await createCustomer({ cognitoSub: strangerSub });
    const token = await signTestToken({
      pool: 'clienti',
      sub: strangerSub,
      customerId: strangerId,
    });

    expect((await postTransfer(token, vehicleId)).statusCode).toBe(403);
  });

  it('returns 422 for a pending (non-certified) vehicle (BR-046)', async () => {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'pending' });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(422);
  });

  it('does not leak another seller transfer via GET :id (app-layer scoping)', async () => {
    const a = await ownerWithVehicle();
    const created = await postTransfer(a.token, a.vehicleId);
    const transferId = created.json().id;

    const strangerSub = `s-${randomUUID().slice(0, 8)}`;
    const { customerId: strangerId } = await createCustomer({ cognitoSub: strangerSub });
    const strangerToken = await signTestToken({
      pool: 'clienti',
      sub: strangerSub,
      customerId: strangerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/transfers/${transferId}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists only the caller transfers', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    await postTransfer(token, vehicleId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

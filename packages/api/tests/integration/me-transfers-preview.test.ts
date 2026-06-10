import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createTransfer,
  createVehicle,
  getActiveOwnerCustomerId,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-401 PR4 — read-only preview of a transfer by code.
describe('Customer transfer preview (F-CLI-401 PR4)', () => {
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

  async function makeCustomer() {
    const sub = `c-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, token };
  }

  async function certifiedVehicleOwnedBy(customerId: string) {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    return { vehicleId };
  }

  function get(token: string, url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  function post(token: string, url: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
  }

  it('previews a pending transfer without side effects, then accept still works', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferCode } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Double peek: read-only, repeatable.
    const first = await get(buyer.token, `/v1/me/transfers/${transferCode}/preview`);
    expect(first.statusCode).toBe(200);
    const { transfer } = first.json();
    expect(transfer.status).toBe('pending_recipient');
    expect(transfer.vehicle.plate).toBeDefined();
    expect((await get(buyer.token, `/v1/me/transfers/${transferCode}/preview`)).statusCode).toBe(
      200,
    );

    // The peek must not have burned the code nor moved anything.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);
    const accepted = await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().transfer.status).toBe('pending_seller_confirmation');
  });

  it('returns 403 when the seller previews their own code', async () => {
    const seller = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferCode } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await get(seller.token, `/v1/me/transfers/${transferCode}/preview`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('transfer.acceptance.self_not_allowed');
  });

  it('returns 410 for an expired transfer', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferCode } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await get(buyer.token, `/v1/me/transfers/${transferCode}/preview`);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('transfer.acceptance.expired');
  });

  it('returns 404 for an unknown code', async () => {
    const buyer = await makeCustomer();
    const res = await get(buyer.token, '/v1/me/transfers/TR-0000-0000/preview');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('transfer.not_found');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers/TR-0000-0000/preview',
    });
    expect(res.statusCode).toBe(401);
  });
});

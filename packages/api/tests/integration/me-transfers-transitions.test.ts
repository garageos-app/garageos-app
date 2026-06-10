import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createTransfer,
  createVehicle,
  getActiveOwnerCustomerId,
  getTransferById,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-401 PR2 — accept / confirm / reject transitions + atomic swap.
describe('Customer transfer transitions (F-CLI-401 PR2)', () => {
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

  function post(token: string, url: string, payload?: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: (payload ?? {}) as never,
    });
  }

  it('runs the full happy path: accept -> confirm -> ownership moves', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);

    const created = await post(seller.token, '/v1/me/transfers', {
      vehicleId,
      method: 'physical_code',
    });
    expect(created.statusCode).toBe(201);
    const { id: transferId, transferCode } = created.json();

    const accepted = await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().transfer.status).toBe('pending_seller_confirmation');
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);

    const confirmed = await post(seller.token, `/v1/me/transfers/${transferId}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().transfer.status).toBe('completed');

    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);
    const dbRow = await getTransferById(transferId);
    expect(dbRow?.status).toBe('completed');
    expect(dbRow?.completedAt).not.toBeNull();

    const buyerList = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(buyerList.json().data.map((v: { id: string }) => v.id)).toContain(vehicleId);
  });

  it('blocks the seller from accepting their own transfer (403)', async () => {
    const seller = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const created = await post(seller.token, '/v1/me/transfers', {
      vehicleId,
      method: 'physical_code',
    });
    const { transferCode } = created.json();
    expect((await post(seller.token, `/v1/me/transfers/${transferCode}/accept`)).statusCode).toBe(
      403,
    );
  });

  it('rejects acceptance of an expired transfer (410)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferCode } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`)).statusCode).toBe(
      410,
    );
  });

  it('rejects confirmation after expiry (410)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await post(seller.token, `/v1/me/transfers/${transferId}/confirm`)).statusCode).toBe(
      410,
    );
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);
  });

  it('lets the recipient reject after accepting', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
    });
    const res = await post(buyer.token, `/v1/me/transfers/${transferId}/reject`, {
      reason: 'non piu interessato',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('rejected');
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);
  });

  it('lets the seller cancel a pending transfer (BR-048)', async () => {
    const seller = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const created = await post(seller.token, '/v1/me/transfers', {
      vehicleId,
      method: 'physical_code',
    });
    const { id: transferId } = created.json();
    expect((await post(seller.token, `/v1/me/transfers/${transferId}/reject`)).statusCode).toBe(
      200,
    );
    expect(
      (await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' }))
        .statusCode,
    ).toBe(201);
  });

  it('hides the seller private interventions from the new owner (F-CLI-405)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    await createPrivateIntervention({
      customerId: seller.customerId,
      vehicleId,
      interventionDate: '2026-01-15',
      description: 'Segreto del cedente',
    });

    const created = await post(seller.token, '/v1/me/transfers', {
      vehicleId,
      method: 'physical_code',
    });
    const { id: transferId, transferCode } = created.json();
    await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`);
    await post(seller.token, `/v1/me/transfers/${transferId}/confirm`);
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);

    const buyerView = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(buyerView.statusCode).toBe(200);
    expect(buyerView.json().data).toHaveLength(0);
  });

  it('completes exactly one swap under concurrent double-confirm', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
    });

    const [a, b] = await Promise.all([
      post(seller.token, `/v1/me/transfers/${transferId}/confirm`),
      post(seller.token, `/v1/me/transfers/${transferId}/confirm`),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);
  });
});

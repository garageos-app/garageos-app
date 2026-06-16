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
import { pgAdmin } from './setup.js';
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

  // BR-297: on confirm/swap, the seller's active personal deadlines on the
  // vehicle (and their pending reminders) become cancelled; completed/cancelled
  // history is immutable, and the buyer's (empty) deadlines are unaffected.
  it('cancels the seller active personal deadlines on swap (BR-297)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);

    // Seller's open deadline on the vehicle, with a pending reminder.
    const { rows: dlRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadlines
         (id, customer_id, vehicle_id, category, due_date, notify_email, notify_push,
          status, reminder_lead_days, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'insurance'::"PersonalDeadlineCategory", $3::date,
          true, true, 'open'::"PersonalDeadlineStatus", '{}', NOW(), NOW())
       RETURNING id`,
      [seller.customerId, vehicleId, '2099-12-31'],
    );
    const deadlineId = dlRows[0]!.id;
    const { rows: remRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadline_reminders
         (id, personal_deadline_id, scheduled_for, kind, delivery_status, created_at)
       VALUES (gen_random_uuid(), $1, $2::date, 'lead'::"PersonalDeadlineReminderKind",
          'pending', NOW())
       RETURNING id`,
      [deadlineId, '2099-12-01'],
    );
    const reminderId = remRows[0]!.id;

    const created = await post(seller.token, '/v1/me/transfers', {
      vehicleId,
      method: 'physical_code',
    });
    const { id: transferId, transferCode } = created.json();
    expect((await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`)).statusCode).toBe(
      200,
    );
    const confirmed = await post(seller.token, `/v1/me/transfers/${transferId}/confirm`);
    expect(confirmed.statusCode).toBe(200);

    // The swap itself still succeeded.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);

    // The seller's deadline + its reminder are now cancelled.
    const dl = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM personal_deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(dl.rows[0]!.status).toBe('cancelled');
    const rem = await pgAdmin.query<{ delivery_status: string; failure_reason: string | null }>(
      `SELECT delivery_status, failure_reason FROM personal_deadline_reminders WHERE id = $1`,
      [reminderId],
    );
    expect(rem.rows[0]!.delivery_status).toBe('cancelled');
    expect(rem.rows[0]!.failure_reason).toBe('ownership_transferred');

    // The buyer owns no personal deadlines on the vehicle.
    const buyerDeadlines = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM personal_deadlines
         WHERE vehicle_id = $1 AND customer_id = $2`,
      [vehicleId, buyer.customerId],
    );
    expect(buyerDeadlines.rows[0]!.count).toBe('0');
  });
});

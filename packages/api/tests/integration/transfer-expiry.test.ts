import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processTransferExpiry } from '../../src/lib/transfers/expire-transfers.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createTransfer,
  createVehicle,
  getActiveOwnerCustomerId,
  getTransferById,
  resetDb,
} from './helpers.js';

// F-CLI-401 PR3 — processTransferExpiry sweep end-to-end (integration).
describe('Transfer expiry sweep (F-CLI-401 PR3)', () => {
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

  // Thin adapter matching AppLike: binds withContext and log from the
  // real FastifyInstance so the sweep runs against the test Postgres
  // container under role:'admin' (bypasses RLS, as in production Lambda).
  function sweepApp() {
    return { withContext: app.withContext.bind(app), log: app.log };
  }

  // Shared helper: a certified vehicle already owned by `customerId`.
  async function certifiedVehicleOwnedBy(customerId: string) {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    return { vehicleId };
  }

  // Case 1 — pending_recipient and pending_seller_confirmation past expiresAt
  // are flipped to 'expired'. BR-047 slot is freed (proven by inserting a
  // second active transfer on the same vehicle after the sweep). Seller
  // ownership is left untouched.
  it('flips past-due pending transfers to expired, frees BR-047 slot, leaves ownership unchanged', async () => {
    const { customerId: sellerId } = await createCustomer({ cognitoSub: null });
    const { customerId: buyerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await certifiedVehicleOwnedBy(sellerId);

    // Seed a pending_recipient transfer with a past expiresAt.
    const { transferId: transferIdA } = await createTransfer({
      vehicleId,
      fromCustomerId: sellerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result1 = await processTransferExpiry({ app: sweepApp() });

    // Exactly one row matches (resetDb leaves a clean slate); toBe(1) also
    // guards against the sweep touching rows it shouldn't (e.g. cross-tenant).
    expect(result1.sweptCount).toBe(1);
    expect((await getTransferById(transferIdA))?.status).toBe('expired');

    // BR-047 slot is now free: insert a pending_seller_confirmation transfer
    // on the same vehicle (would violate uq_transfer_vehicle_active if the
    // first transfer were still 'pending_recipient').
    const { transferId: transferIdB } = await createTransfer({
      vehicleId,
      fromCustomerId: sellerId,
      toCustomerId: buyerId,
      status: 'pending_seller_confirmation',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result2 = await processTransferExpiry({ app: sweepApp() });

    expect(result2.sweptCount).toBe(1);
    expect((await getTransferById(transferIdB))?.status).toBe('expired');

    // Seller ownership is untouched — vehicle stays with the seller.
    // See BR-043: on timeout ownership never moves.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(sellerId);
  });

  // Case 2 — pending_validation transfers (F-CLI-404 / BR-044) must NOT be
  // touched by the sweep, even when past expiresAt.
  // Fresh vehicle required: uq_transfer_vehicle_active covers
  // pending_validation, so a vehicle with an existing active transfer could
  // not host a second one.
  it('does NOT touch pending_validation transfers (BR-044)', async () => {
    const { customerId: sellerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await certifiedVehicleOwnedBy(sellerId);

    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: sellerId,
      // claim_without_seller is the method that produces pending_validation
      // (the buyer claims without prior seller involvement). See F-CLI-404.
      method: 'claim_without_seller',
      status: 'pending_validation',
      expiresAt: new Date(Date.now() - 60_000),
    });

    await processTransferExpiry({ app: sweepApp() });

    // Status must remain pending_validation — the sweep explicitly excludes it.
    expect((await getTransferById(transferId))?.status).toBe('pending_validation');
  });

  // Case 3 — a pending transfer whose expiresAt is in the future must not be
  // touched by the sweep.
  it('does NOT touch pending transfers that have not yet expired', async () => {
    const { customerId: sellerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await certifiedVehicleOwnedBy(sellerId);

    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: sellerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 h in the future
    });

    await processTransferExpiry({ app: sweepApp() });

    expect((await getTransferById(transferId))?.status).toBe('pending_recipient');
  });
});

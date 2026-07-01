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

// POST /v1/vehicles/:id/ownership-transfer (F-OFF-110, BR-049).
// Officina-mediated single-step transfer. Lib spec:
// docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md

describe('POST /v1/vehicles/:id/ownership-transfer (integration)', () => {
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

  async function setupScenario(opts?: {
    vehicleStatus?: 'certified' | 'pending' | 'archived';
    actorRole?: 'super_admin' | 'mechanic';
  }): Promise<{
    tenantId: string;
    actorJwt: string;
    cedente: { customerId: string; email: string };
    cessionario: { customerId: string; email: string };
    vehicleId: string;
  }> {
    const prefix = 'ot-' + Math.random().toString(36).slice(2, 6);
    const { tenantId } = await createTenantWithLocation(prefix);

    const actorCognitoSub = 'ot-actor-' + Math.random().toString(36).slice(2, 10);
    const role = opts?.actorRole ?? 'super_admin';
    await createUser({ tenantId, cognitoSub: actorCognitoSub, role });

    const cedente = await createCustomer({
      email: `cedente-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`,
    });
    await createCustomerTenantRelation({ tenantId, customerId: cedente.customerId });

    const cessionario = await createCustomer({
      email: `cess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`,
    });
    await createCustomerTenantRelation({ tenantId, customerId: cessionario.customerId });

    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: opts?.vehicleStatus ?? 'certified',
    });
    await createOwnership({ vehicleId, customerId: cedente.customerId });

    const actorJwt = await signTestToken({
      pool: 'officine',
      sub: actorCognitoSub,
      tenantId,
      role,
    });

    return { tenantId, actorJwt, cedente, cessionario, vehicleId };
  }

  it('200: happy path with existing recipient (super_admin)', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
        notes: 'Vendita usato',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfer.status).toBe('completed');
    expect(body.ownership.customerId).toBe(s.cessionario.customerId);
    expect(body.vehicle.id).toBe(s.vehicleId);
  });

  it('200: happy path mechanic role can execute', async () => {
    const s = await setupScenario({ actorRole: 'mechanic' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'other',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: new recipient creates customer + tenant relation', async () => {
    const s = await setupScenario();
    const newEmail = `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'new', firstName: 'Anna', lastName: 'Rossi', email: newEmail },
        reason: 'inheritance',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfer.status).toBe('completed');
    expect(body.ownership.customerId).not.toBe(s.cedente.customerId);
  });

  it('200: new recipient with same-tenant email match reuses customer', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Different',
          lastName: 'Name',
          email: s.cessionario.email,
        },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ownership.customerId).toBe(s.cessionario.customerId);
  });

  it('200: new recipient with cross-tenant email match reuses customer', async () => {
    const s = await setupScenario();
    const otherTenant = await createTenantWithLocation(
      'ot-cross-' + Math.random().toString(36).slice(2, 6),
    );
    const sharedEmail = `cross-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`;
    const sharedCustomer = await createCustomer({ email: sharedEmail });
    await createCustomerTenantRelation({
      tenantId: otherTenant.tenantId,
      customerId: sharedCustomer.customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Cross',
          lastName: 'Tenant',
          email: sharedEmail,
        },
        reason: 'company_assignment',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ownership.customerId).toBe(sharedCustomer.customerId);
  });

  it('400: missing reason', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401: missing auth', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404: vehicle from other tenant', async () => {
    const s = await setupScenario();
    const other = await createTenantWithLocation(
      'ot-other-' + Math.random().toString(36).slice(2, 6),
    );
    const { vehicleId: otherVehicleId } = await createVehicle({
      createdByTenantId: other.tenantId,
      certifiedByTenantId: other.tenantId,
      status: 'certified',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${otherVehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');
  });

  it('422: vehicle pending', async () => {
    const s = await setupScenario({ vehicleStatus: 'pending' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.pending_not_transferable');
  });

  it('422: vehicle archived', async () => {
    const s = await setupScenario({ vehicleStatus: 'archived' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.archived');
  });

  it('409: same_owner — cessionario is current owner', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cedente.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.transfer.same_owner');
  });

  it('422: recipient_not_found — existing customerId ghost', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: '00000000-0000-4000-8000-000000000001' },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.recipient_not_found');
  });

  it('409: active_transfer_exists when pending transfer present', async () => {
    const s = await setupScenario();
    // Seed pending transfer via pgAdmin (admin connection bypasses RLS).
    await pgAdmin.query(
      `INSERT INTO vehicle_transfers
         (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2,
          'initiated_by_seller'::"TransferMethod",
          'pending_recipient'::"TransferStatus",
          NOW() + INTERVAL '7 days', NOW(), NOW())`,
      // transfer_code is VARCHAR(20); keep payload <=20 chars (10-digit ms suffix fits).
      [s.vehicleId, `P-${Date.now().toString().slice(-10)}`],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.transfer.active_transfer_exists');
  });

  it('200: new recipient isBusiness=true persists businessName + vatNumber', async () => {
    const s = await setupScenario();
    const newEmail = `biz-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Acme',
          lastName: 'SRL',
          email: newEmail,
          isBusiness: true,
          businessName: 'Acme SRL',
          vatNumber: 'IT12345678901',
        },
        reason: 'company_assignment',
      },
    });
    expect(res.statusCode).toBe(200);
    // Verify business fields persisted via pgAdmin (raw query on customers)
    const { rows } = await pgAdmin.query<{
      is_business: boolean;
      business_name: string;
      vat_number: string;
    }>(`SELECT is_business, business_name, vat_number FROM customers WHERE email = $1`, [newEmail]);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row!.is_business).toBe(true);
    expect(row!.business_name).toBe('Acme SRL');
    expect(row!.vat_number).toBe('IT12345678901');
  });

  it('403: customer pool JWT rejected by requireOfficinaPool', async () => {
    const s = await setupScenario();
    const customerJwt = await signTestToken({
      pool: 'clienti',
      sub: 'cust-jwt-' + Math.random().toString(36).slice(2, 8),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${customerJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('422: no_active_ownership when vehicle has no active owner', async () => {
    const s = await setupScenario();
    // End the current ownership (orphan the vehicle) via pgAdmin
    await pgAdmin.query(
      `UPDATE vehicle_ownerships SET ended_at = NOW() WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [s.vehicleId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.no_active_ownership');
  });

  it('BR-045 privacy: post-transfer GET /vehicles/:id returns only new owner', async () => {
    const s = await setupScenario();
    const txfer = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(txfer.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${s.vehicleId}`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    // Verify cedente customerId NOT present in any field of the response
    // (BR-045: cedente PII not transferred to new owner / not surfaced via
    // active ownership query). The endpoint exposes only the active row.
    const text = JSON.stringify(body);
    expect(text).toContain(s.cessionario.customerId);
    expect(text).not.toContain(s.cedente.customerId);
  });
});

// ─── F-OFF-110 PR-2 — personal deadline cancellation on transfer ─────────────
// POST /v1/vehicles/:id/ownership-transfer

describe('POST /v1/vehicles/:id/ownership-transfer — BR-297 (integration)', () => {
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

  // Helper: full certified-vehicle scenario ready for a transfer request.
  async function setupTransferScenario(): Promise<{
    tenantId: string;
    actorJwt: string;
    cedente: { customerId: string; email: string };
    cessionario: { customerId: string; email: string };
    vehicleId: string;
  }> {
    const prefix = 'ds-' + Math.random().toString(36).slice(2, 6);
    const { tenantId } = await createTenantWithLocation(prefix);

    const actorSub = 'ds-actor-' + Math.random().toString(36).slice(2, 10);
    await createUser({ tenantId, cognitoSub: actorSub, role: 'super_admin' });

    const cedente = await createCustomer({
      email: `cedente-ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`,
    });
    await createCustomerTenantRelation({ tenantId, customerId: cedente.customerId });

    const cessionario = await createCustomer({
      email: `cess-ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.it`,
    });
    await createCustomerTenantRelation({ tenantId, customerId: cessionario.customerId });

    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    await createOwnership({ vehicleId, customerId: cedente.customerId });

    const actorJwt = await signTestToken({
      pool: 'officine',
      sub: actorSub,
      tenantId,
      role: 'super_admin',
    });

    return { tenantId, actorJwt, cedente, cessionario, vehicleId };
  }

  // BR-297: on officina-mediated transfer, the cedente's active personal
  // deadlines on the vehicle (and their pending reminders) become cancelled;
  // the swap itself still completes.
  it('200: cancels the cedente active personal deadlines (BR-297)', async () => {
    const s = await setupTransferScenario();

    const { rows: dlRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadlines
         (id, customer_id, vehicle_id, category, due_date, notify_email, notify_push,
          status, reminder_lead_days, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'insurance'::"PersonalDeadlineCategory", $3::date,
          true, true, 'open'::"PersonalDeadlineStatus", '{}', NOW(), NOW())
       RETURNING id`,
      [s.cedente.customerId, s.vehicleId, '2099-12-31'],
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

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownership.customerId).toBe(s.cessionario.customerId);

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
  });
});

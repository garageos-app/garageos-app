import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as s3Module from '../../src/lib/s3.js';

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
    locationId: string;
    actorJwt: string;
    cedente: { customerId: string; email: string };
    cessionario: { customerId: string; email: string };
    vehicleId: string;
  }> {
    const prefix = 'ot-' + Math.random().toString(36).slice(2, 6);
    const { tenantId, locationId } = await createTenantWithLocation(prefix);

    const actorCognitoSub = 'ot-actor-' + Math.random().toString(36).slice(2, 10);
    const role = opts?.actorRole ?? 'super_admin';
    await createUser({ tenantId, cognitoSub: actorCognitoSub, role, locationId });

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
      locationId,
    });

    return { tenantId, locationId, actorJwt, cedente, cessionario, vehicleId };
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

// ─── F-OFF-110 PR-2 — libretto presign endpoint ──────────────────────────────
// POST /v1/vehicles/:id/ownership-transfer/document-upload-url

describe('POST /v1/vehicles/:id/ownership-transfer/document-upload-url (integration)', () => {
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

  // Helper: seed a tenant + actor JWT + a certified vehicle belonging to
  // that tenant. No vehicle_ownership row is created — the presign
  // endpoint only needs the actor to be super_admin/mechanic and the
  // vehicle to be visible to the tenant; an active owner is not required.
  async function setupPresignScenario(): Promise<{
    tenantId: string;
    locationId: string;
    actorJwt: string;
    vehicleId: string;
  }> {
    const prefix = 'ps-' + Math.random().toString(36).slice(2, 6);
    const { tenantId, locationId } = await createTenantWithLocation(prefix);

    const actorSub = 'ps-actor-' + Math.random().toString(36).slice(2, 10);
    await createUser({ tenantId, cognitoSub: actorSub, role: 'super_admin', locationId });

    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    const actorJwt = await signTestToken({
      pool: 'officine',
      sub: actorSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    return { tenantId, locationId, actorJwt, vehicleId };
  }

  it('200: happy path — s3Key has vehicle-transfers/<vehicleId>/ prefix and uploadUrl contains X-Amz-Signature=', async () => {
    // Test 1 — presign happy path.
    // globalSetup seeds fake AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY so
    // the SDK presigner can build a valid signature without real creds.
    const { vehicleId, actorJwt } = await setupPresignScenario();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/ownership-transfer/document-upload-url`,
      headers: { authorization: `Bearer ${actorJwt}` },
      payload: {
        fileName: 'libretto.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1_048_576,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      s3Key: string;
      uploadUrl: string;
      uploadMethod: string;
      expiresAt: string;
    }>();
    expect(body.s3Key).toMatch(new RegExp(`^vehicle-transfers/${vehicleId}/`));
    expect(body.uploadUrl).toContain('X-Amz-Signature=');
    expect(body.uploadMethod).toBe('PUT');
  });

  it('404: vehicle.not_found when vehicle belongs to a different tenant', async () => {
    // Test 2 — presign 404: vehicle exists but belongs to another tenant.
    const { actorJwt } = await setupPresignScenario();

    // Create a vehicle owned by a completely different tenant.
    const other = await createTenantWithLocation(
      'ps-other-' + Math.random().toString(36).slice(2, 6),
    );
    const { vehicleId: otherVehicleId } = await createVehicle({
      createdByTenantId: other.tenantId,
      certifiedByTenantId: other.tenantId,
      status: 'certified',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${otherVehicleId}/ownership-transfer/document-upload-url`,
      headers: { authorization: `Bearer ${actorJwt}` },
      payload: {
        fileName: 'libretto.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 500_000,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('vehicle.not_found');
  });
});

// ─── F-OFF-110 PR-2 — documentS3Key on the transfer endpoint ─────────────────
// POST /v1/vehicles/:id/ownership-transfer with optional documentS3Key

describe('POST /v1/vehicles/:id/ownership-transfer — documentS3Key (integration)', () => {
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
  // Restore any per-test S3 spies after each test so they don't bleed
  // across tests within this describe block.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: full certified-vehicle scenario ready for a transfer request.
  async function setupTransferScenario(): Promise<{
    tenantId: string;
    locationId: string;
    actorJwt: string;
    cedente: { customerId: string; email: string };
    cessionario: { customerId: string; email: string };
    vehicleId: string;
  }> {
    const prefix = 'ds-' + Math.random().toString(36).slice(2, 6);
    const { tenantId, locationId } = await createTenantWithLocation(prefix);

    const actorSub = 'ds-actor-' + Math.random().toString(36).slice(2, 10);
    await createUser({ tenantId, cognitoSub: actorSub, role: 'super_admin', locationId });

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
      locationId,
    });

    return { tenantId, locationId, actorJwt, cedente, cessionario, vehicleId };
  }

  it('200: valid documentS3Key is persisted as documentUrl on the VehicleTransfer row', async () => {
    // Test 3 — documentS3Key happy path. Spy headObject so the route
    // believes the object exists without hitting real S3.
    const s = await setupTransferScenario();
    const docKey = `vehicle-transfers/${s.vehicleId}/${randomUUID()}.pdf`;

    vi.spyOn(s3Module, 'headObject').mockResolvedValue({
      contentLength: 1_048_576,
      contentType: 'application/pdf',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
        documentS3Key: docKey,
      },
    });

    expect(res.statusCode).toBe(200);

    // Assert the persisted VehicleTransfer row carries the key.
    const { rows } = await pgAdmin.query<{ document_url: string | null }>(
      `SELECT document_url FROM vehicle_transfers WHERE vehicle_id = $1 LIMIT 1`,
      [s.vehicleId],
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.document_url).toBe(docKey);
  });

  it('422: vehicle.transfer.document_invalid when S3 object does not exist', async () => {
    // Test 4 — headObject throws S3ObjectNotFoundError → 422.
    const s = await setupTransferScenario();
    const docKey = `vehicle-transfers/${s.vehicleId}/${randomUUID()}.pdf`;

    vi.spyOn(s3Module, 'headObject').mockRejectedValue(
      new s3Module.S3ObjectNotFoundError('missing'),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
        documentS3Key: docKey,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('vehicle.transfer.document_invalid');
  });

  it('422: vehicle.transfer.document_invalid when documentS3Key prefix is for a different vehicle', async () => {
    // Test 5 — cross-vehicle key. The route's isValidDocumentKey() rejects
    // the key shape BEFORE calling headObject, so no S3 spy is needed.
    const s = await setupTransferScenario();
    const differentVehicleId = randomUUID();
    const crossKey = `vehicle-transfers/${differentVehicleId}/${randomUUID()}.pdf`;

    const headObjectSpy = vi.spyOn(s3Module, 'headObject');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.actorJwt}` },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.customerId },
        reason: 'purchase',
        documentS3Key: crossKey,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('vehicle.transfer.document_invalid');
    // Regex guard fires before S3 is consulted.
    expect(headObjectSpy).not.toHaveBeenCalled();
  });

  it('200: transfer without documentS3Key still completes and documentUrl is null (regression)', async () => {
    // Test 6 — regression: PR-1 behaviour preserved when no document is
    // attached. No S3 spy needed (headObject never called).
    const s = await setupTransferScenario();

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

    // Assert the VehicleTransfer row has no documentUrl.
    const { rows } = await pgAdmin.query<{ document_url: string | null }>(
      `SELECT document_url FROM vehicle_transfers WHERE vehicle_id = $1 LIMIT 1`,
      [s.vehicleId],
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.document_url).toBeNull();
  });
});

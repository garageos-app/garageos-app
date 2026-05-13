// packages/api/tests/integration/attachments.test.ts
//
// Integration tests for POST /v1/attachments/upload-url (phase 1) and
// POST /v1/attachments/:id/confirm (phase 2).
// Exercises both handlers against a real Testcontainers PostgreSQL instance;
// S3 calls are stubbed with aws-sdk-client-mock.
//
// F-OFF-305 — attachment upload + confirm flow.

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../src/lib/s3.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

const s3Mock = mockClient(S3Client);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(HeadObjectCommand).resolves({
    ContentLength: 1024,
    ContentType: 'image/jpeg',
  });
});

// Setup helper: create a tenant + intervention so attachments can target it.
async function setupTenantWithIntervention(): Promise<{
  tenantId: string;
  locationId: string;
  userId: string;
  cognitoSub: string;
  interventionId: string;
  token: string;
}> {
  const { tenantId, locationId } = await createTenantWithLocation();
  const cognitoSub = crypto.randomUUID();
  const { userId } = await createUser({
    tenantId,
    locationId,
    cognitoSub,
    role: 'super_admin',
  });
  const { customerId } = await createCustomer({});
  const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
  await createOwnership({ vehicleId, customerId });
  const { id: interventionTypeId } = await ensureSystemInterventionType('TAGLIANDO');
  const { interventionId } = await createIntervention({
    tenantId,
    locationId,
    userId,
    vehicleId,
    interventionTypeId,
    interventionDate: '2026-01-01',
    odometerKm: 1000,
  });

  const token = await signTestToken({
    sub: cognitoSub,
    tenantId,
    role: 'super_admin',
    locationId,
    pool: 'officine',
  });

  return {
    tenantId,
    locationId,
    userId,
    cognitoSub,
    interventionId,
    token,
  };
}

const VALID_BODY_TEMPLATE = {
  owner_type: 'intervention',
  file_name: 'foto.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 1024,
};

describe('POST /v1/attachments/upload-url + confirm — integration', () => {
  it('full happy flow: upload-url → confirm sets processed=true', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id, callback_url } = upload.json() as {
      attachment_id: string;
      callback_url: string;
    };

    const confirm = await app.inject({
      method: 'POST',
      url: callback_url,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { processed: boolean }).processed).toBe(true);

    // Verify DB state via raw SQL (pgAdmin is a pg client, not Prisma).
    const { rows } = await pgAdmin.query<{
      processed: boolean;
      uploaded_by_user_id: string;
      tenant_id: string;
    }>(
      `SELECT processed, uploaded_by_user_id, tenant_id
         FROM attachments
        WHERE id = $1`,
      [attachment_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed).toBe(true);
    expect(rows[0]!.uploaded_by_user_id).toBe(ctx.userId);
  });

  it('cross-tenant isolation: officina A cannot confirm attachment of officina B (RLS-as-404)', async () => {
    const tenantA = await setupTenantWithIntervention();
    const tenantB = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantA.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as { attachment_id: string };

    // Tenant B tries to confirm tenant A's attachment — must get 404.
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${tenantB.token}` },
    });
    expect(confirm.statusCode).toBe(404);
    expect((confirm.json() as { code: string }).code).toBe('attachment.confirm.not_found');
  });

  it('idempotent confirm: chiamato 2 volte ritorna 200 stesso payload', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as { attachment_id: string };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
  });

  it('clienti pool JWT → 403', async () => {
    const ctx = await setupTenantWithIntervention();
    const { customerId } = await createCustomer({});
    const clientiToken = await signTestToken({
      sub: crypto.randomUUID(),
      customerId,
      pool: 'clienti',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${clientiToken}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('no JWT → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      payload: { ...VALID_BODY_TEMPLATE, owner_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('cross-tenant intervention reference → 404 (RLS scoping)', async () => {
    const tenantA = await setupTenantWithIntervention();
    const tenantB = await setupTenantWithIntervention();

    // Tenant A tries to attach a file to an intervention owned by tenant B.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantB.interventionId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('attachment.upload.intervention_not_found');
  });

  it('uploadedByUserId persisted correctly from JWT user.id', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as {
      attachment_id: string;
      upload_url: string;
      callback_url: string;
    };

    const { rows } = await pgAdmin.query<{
      uploaded_by_user_id: string;
      tenant_id: string;
    }>(`SELECT uploaded_by_user_id, tenant_id FROM attachments WHERE id = $1`, [attachment_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uploaded_by_user_id).toBe(ctx.userId);
    expect(rows[0]!.tenant_id).toBe(ctx.tenantId);
  });

  it('attachment row visible only to its tenant via RLS', async () => {
    const tenantA = await setupTenantWithIntervention();
    // Create a second tenant (tenantB's rows exist but attachment belongs to A only).
    await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantA.interventionId },
    });
    expect(upload.statusCode).toBe(201);

    // pgAdmin bypasses RLS — we verify only one attachment row exists globally.
    const { rows } = await pgAdmin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM attachments`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA.tenantId);
  });
});

describe('POST /v1/attachments/upload-url — intervention_dispute cross-pool', () => {
  it('officina-pool can upload its own response attachment for an open dispute', async () => {
    const ctx = await setupTenantWithIntervention();
    // Create a customer dispute to satisfy the "open dispute" guard
    const { customerId } = await createCustomer({});
    await pgAdmin.query(
      `INSERT INTO intervention_disputes
         (id, intervention_id, customer_id, reason_category, customer_description,
          status, resolved_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2,
          'not_performed'::"DisputeReasonCategory",
          'Contestazione di test lunga abbastanza.',
          'open'::"DisputeStatus", NULL, NOW(), NOW())`,
      [ctx.interventionId, customerId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {
        owner_type: 'intervention_dispute',
        owner_id: ctx.interventionId,
        file_name: 'risposta.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
      },
    });
    expect(res.statusCode).toBe(201);
    const { attachment_id } = res.json() as { attachment_id: string };

    // Verify: row has tenant_id set, customer_id NULL, uploaded_by_user_id set
    const { rows } = await pgAdmin.query<{
      tenant_id: string;
      customer_id: string | null;
      uploaded_by_user_id: string;
      uploaded_by_customer_id: string | null;
    }>(
      `SELECT tenant_id, customer_id, uploaded_by_user_id, uploaded_by_customer_id
         FROM attachments WHERE id = $1`,
      [attachment_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(ctx.tenantId);
    expect(rows[0]!.customer_id).toBeNull();
    expect(rows[0]!.uploaded_by_user_id).toBe(ctx.userId);
    expect(rows[0]!.uploaded_by_customer_id).toBeNull();
  });

  it('customer-pool can upload its own dispute attachment when current owner', async () => {
    const ctx = await setupTenantWithIntervention();
    const customerCognitoSub = `cust-dispute-${crypto.randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerCognitoSub });
    // Add an ownership for the vehicle (setupTenantWithIntervention already created one
    // with a different customer; we need one for this specific customer)
    // Resolve vehicleId from the intervention
    const { rows: intRows } = await pgAdmin.query<{ vehicle_id: string }>(
      `SELECT vehicle_id FROM interventions WHERE id = $1`,
      [ctx.interventionId],
    );
    const vehicleId = intRows[0]!.vehicle_id;
    // End the existing ownership first to be safe (BR-040 — only one active owner)
    await pgAdmin.query(
      `UPDATE vehicle_ownerships SET ended_at = NOW() WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    // Insert a fresh active ownership for this customer
    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
      [vehicleId, customerId],
    );

    const customerToken = await signTestToken({
      pool: 'clienti',
      sub: customerCognitoSub,
      customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        owner_type: 'intervention_dispute',
        owner_id: ctx.interventionId,
        file_name: 'prova.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
      },
    });
    expect(res.statusCode).toBe(201);
    const { attachment_id } = res.json() as { attachment_id: string };

    // Verify: row has tenant_id (intervention's tenant), customer_id (uploader),
    // uploaded_by_customer_id (uploader)
    const { rows } = await pgAdmin.query<{
      tenant_id: string;
      customer_id: string | null;
      uploaded_by_customer_id: string | null;
      uploaded_by_user_id: string | null;
    }>(
      `SELECT tenant_id, customer_id, uploaded_by_customer_id, uploaded_by_user_id
         FROM attachments WHERE id = $1`,
      [attachment_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(ctx.tenantId);
    expect(rows[0]!.customer_id).toBe(customerId);
    expect(rows[0]!.uploaded_by_customer_id).toBe(customerId);
    expect(rows[0]!.uploaded_by_user_id).toBeNull();
  });

  it('customer-pool 403 not_owner when customer no longer owns the vehicle', async () => {
    const ctx = await setupTenantWithIntervention();
    const customerCognitoSub = `cust-ex-${crypto.randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerCognitoSub });

    // Resolve vehicleId and end all active ownerships (customer is already not owner)
    const { rows: intRows } = await pgAdmin.query<{ vehicle_id: string }>(
      `SELECT vehicle_id FROM interventions WHERE id = $1`,
      [ctx.interventionId],
    );
    const vehicleId = intRows[0]!.vehicle_id;
    await pgAdmin.query(
      `UPDATE vehicle_ownerships SET ended_at = NOW() WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    // This customer never owned it (no ownership row inserted)

    const customerToken = await signTestToken({
      pool: 'clienti',
      sub: customerCognitoSub,
      customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        owner_type: 'intervention_dispute',
        owner_id: ctx.interventionId,
        file_name: 'prova.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
      },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe(
      'attachment.upload.intervention_dispute_not_owner',
    );
  });
});

describe('POST /v1/attachments/upload-url — private_intervention (integration)', () => {
  const TEST_IP_PI = '10.50.14.1';

  it('201 returns presigned PUT URL for owner_type=private_intervention (clienti pool)', async () => {
    const cognitoSub = 'att-pi-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('att-pi-ok');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ATTPIOK0000000001',
      plate: 'AP001AA',
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
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: privateInterventionId,
        file_name: 'oil-change.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 250_000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      attachment_id: string;
      upload_url: string;
      expires_at: string;
    };
    expect(body.attachment_id).toBeTruthy();
    expect(body.upload_url).toMatch(/^https:\/\/.+/);

    // Verify s3_key shape via DB (not response — buildPresignedPayload doesn't surface it).
    const { rows: keyRows } = await pgAdmin.query<{ s3_key: string }>(
      `SELECT s3_key FROM attachments WHERE id = $1`,
      [body.attachment_id],
    );
    expect(keyRows[0]!.s3_key).toContain(
      `attachments/private_intervention/${privateInterventionId}/`,
    );

    // Verify the attachment row was persisted with the XOR shape.
    const { rows } = await pgAdmin.query<{
      owner_type: string;
      tenant_id: string | null;
      customer_id: string;
      uploaded_by_user_id: string | null;
      uploaded_by_customer_id: string;
      processed: boolean;
    }>(
      `SELECT owner_type, tenant_id, customer_id, uploaded_by_user_id,
              uploaded_by_customer_id, processed
       FROM attachments WHERE id = $1`,
      [body.attachment_id],
    );
    expect(rows[0]).toMatchObject({
      owner_type: 'private_intervention',
      tenant_id: null,
      customer_id: customerId,
      uploaded_by_user_id: null,
      uploaded_by_customer_id: customerId,
      processed: false,
    });
  });

  it('404 when owner_id is a non-existent private intervention', async () => {
    const cognitoSub = 'att-pi-404-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: randomUUID(),
        file_name: 'x.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'attachment.upload.private_intervention_not_found' });
  });

  it('404 when owner_id belongs to a different customer (BR-080 RLS)', async () => {
    const cognitoSubA = 'att-pi-cross-a-' + Math.random().toString(36).slice(2, 10);
    const cognitoSubB = 'att-pi-cross-b-' + Math.random().toString(36).slice(2, 10);
    const { customerId: customerIdA } = await createCustomer({ cognitoSub: cognitoSubA });
    const { customerId: customerIdB } = await createCustomer({ cognitoSub: cognitoSubB });
    const { tenantId } = await createTenantWithLocation('att-pi-cross');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ATTPICROSS00001',
      plate: 'AP002AA',
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
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${tokenA}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: privateInterventionId,
        file_name: 'x.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'attachment.upload.private_intervention_not_found' });
  });

  it('404 when owner_id is soft-deleted', async () => {
    const cognitoSub = 'att-pi-soft-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('att-pi-soft');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ATTPISOFT0000001',
      plate: 'AP003AA',
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
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: privateInterventionId,
        file_name: 'x.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'attachment.upload.private_intervention_not_found' });
  });

  it('403 when officina-pool attempts owner_type=private_intervention', async () => {
    const cognitoSub = 'att-pi-officina-' + Math.random().toString(36).slice(2, 10);
    const { tenantId, locationId } = await createTenantWithLocation('att-pi-officina');
    const { userId } = await createUser({
      tenantId,
      locationId,
      cognitoSub,
      role: 'mechanic',
    });
    void userId;

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: randomUUID(),
        file_name: 'x.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'attachment.upload.officina_pool_not_allowed_for_private',
    });
  });
});

describe('POST /v1/attachments/:id/confirm — private_intervention (integration)', () => {
  const TEST_IP_PI = '10.50.14.2';

  it('confirms a private_intervention attachment (clienti pool)', async () => {
    // This exercises the existing clienti confirm branch (no code change in
    // F2) end-to-end against a private_intervention attachment row.
    const cognitoSub = 'att-pi-confirm-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('att-pi-confirm');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ATTPICONF000001',
      plate: 'AP004AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });

    // Step 1: upload-url to create the unprocessed attachment.
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': TEST_IP_PI,
      },
      payload: {
        owner_type: 'private_intervention',
        owner_id: privateInterventionId,
        file_name: 'confirmed.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 5000,
      },
    });
    expect(uploadRes.statusCode).toBe(201);
    const { attachment_id } = uploadRes.json() as {
      attachment_id: string;
    };

    // Step 2: override S3 HeadObject mock to return matching ContentLength + ContentType.
    // The module-level beforeEach already sets a default mock with 1024 bytes;
    // we need to override per test because this attachment has size_bytes=5000.
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 5000,
      ContentType: 'image/jpeg',
    });

    // Step 3: confirm.
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_PI },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json()).toMatchObject({
      id: attachment_id,
      processed: true,
    });

    // Step 4: verify processed=true in DB.
    const { rows } = await pgAdmin.query<{ processed: boolean }>(
      `SELECT processed FROM attachments WHERE id = $1`,
      [attachment_id],
    );
    expect(rows[0]!.processed).toBe(true);
  });
});

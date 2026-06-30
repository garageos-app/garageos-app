import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock presignGetObject to avoid hitting real S3 credentials.
// Lesson feedback_aws_sdk_presigner_credentials_chain.md: getSignedUrl
// calls the credential provider chain separately from S3Client.send;
// mocking at the module level sidesteps both the chain and the live AWS call.
vi.mock('../../src/lib/s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/s3.js')>();
  return {
    ...actual,
    presignGetObject: vi.fn().mockResolvedValue('https://s3.example/signed-url'),
  };
});

import { buildTestServer } from './fixtures.js';
import {
  createAttachment,
  createCustomer,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
// '10.30.40.1' is taken by interventions-detail.test.ts.
const TEST_IP = '10.30.40.2';

describe('GET /v1/attachments/:id/view-url', () => {
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

  // -----------------------------------------------------------------------
  // Shared setup helpers
  // -----------------------------------------------------------------------

  async function setupCaller(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `vu-caller-${suffix.slice(0, 20)}`;
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, token };
  }

  async function insertAttachment(params: {
    tenantId: string;
    ownerType?: string;
    processed?: boolean;
    deletedAt?: string | null;
  }): Promise<{ attachmentId: string }> {
    const { tenantId, ownerType = 'intervention', processed = true, deletedAt = null } = params;
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO attachments
         (id, owner_type, owner_id, tenant_id, file_name, mime_type,
          size_bytes, s3_key, s3_bucket, processed, deleted_at, created_at)
       VALUES (gen_random_uuid(), $1::"AttachmentOwnerType", gen_random_uuid(), $2,
          'test.pdf', 'application/pdf', 12345,
          'attachments/intervention/test-key.pdf', 'garageos-dev',
          $3, $4::timestamptz, NOW())
       RETURNING id`,
      [ownerType, tenantId, processed, deletedAt],
    );
    return { attachmentId: rows[0]!.id };
  }

  // -----------------------------------------------------------------------
  // Scenario 1: Happy path
  // -----------------------------------------------------------------------
  it('returns 200 with presigned url and expires_at when attachment is valid', async () => {
    const { tenantId, token } = await setupCaller('vu-happy');
    const { attachmentId } = await insertAttachment({ tenantId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.url).toBe('https://s3.example/signed-url');
    expect(typeof body.expires_at).toBe('string');
    // expires_at should be in the future (15 min from now)
    expect(new Date(body.expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  // -----------------------------------------------------------------------
  // Scenario 2: 404 attachment not found
  // -----------------------------------------------------------------------
  it('returns 404 when attachment UUID does not exist', async () => {
    const { token } = await setupCaller('vu-404');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/attachments/ffffffff-ffff-4fff-8fff-ffffffffffff/view-url',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attachment.not_found');
  });

  // -----------------------------------------------------------------------
  // Scenario 3: cross-tenant read of an `intervention` attachment is now
  // ALLOWED (BR-150/BR-153 shared logbook). A different officina may presign
  // the shop-record attachment of another tenant's intervention.
  // -----------------------------------------------------------------------
  it('returns 200 for a cross-tenant intervention attachment (BR-153)', async () => {
    const { tenantId: tenantA } = await setupCaller('vu-xA');
    const { attachmentId } = await insertAttachment({ tenantId: tenantA });

    // Caller is tenantB
    const { token: tokenB } = await setupCaller('vu-xB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).url).toBe('https://s3.example/signed-url');
  });

  // -----------------------------------------------------------------------
  // Scenario 3b: cross-tenant read of a reserved (`intervention_dispute`)
  // attachment stays blocked — the ownerType gate rejects with 422 even
  // though RLS now surfaces the row cross-tenant. No dispute evidence leaks.
  // -----------------------------------------------------------------------
  it('returns 422 (not 200) for a cross-tenant intervention_dispute attachment', async () => {
    const { tenantId: tenantA } = await setupCaller('vu-disp-xA');
    const { rows: callerUserRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`,
      [tenantA],
    );
    const uploaderId = callerUserRows[0]!.id;
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO attachments
         (id, owner_type, owner_id, tenant_id, customer_id,
          uploaded_by_user_id, uploaded_by_customer_id,
          file_name, mime_type, size_bytes, s3_key, s3_bucket,
          processed, deleted_at, created_at)
       VALUES (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
          gen_random_uuid(), $1, NULL, $2, NULL,
          'evidence.pdf', 'application/pdf', 12345,
          'attachments/dispute/test.pdf', 'garageos-dev',
          TRUE, NULL, NOW())
       RETURNING id`,
      [tenantA, uploaderId],
    );
    const attachmentId = rows[0]!.id;

    // Caller is tenantB
    const { token: tokenB } = await setupCaller('vu-disp-xB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.owner_not_supported');
  });

  // Scenario 4 removed: the old `403 clienti pool` test asserted the now-
  // obsolete `requireOfficinaPool` middleware reject. F2 Task 7 switched
  // view-url to dualPool; clienti+private_intervention is the supported
  // path. The replacement scenarios (clienti+intervention RLS-hidden 404,
  // clienti+intervention_dispute deferred 422) live in the new describe
  // block at the bottom of this file.

  // -----------------------------------------------------------------------
  // Scenario 5: 400 invalid UUID
  // -----------------------------------------------------------------------
  it('returns 400 when id param is not a valid UUID', async () => {
    const { token } = await setupCaller('vu-400');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/attachments/not-a-uuid/view-url',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Scenario 6: 422 owner type unsupported
  //
  // The officine lookup is no longer tenant-scoped (BR-153 cross-tenant
  // read), so any non-`intervention` ownerType reaches the 422 gate. Use
  // `intervention_dispute` here. Insert directly (the shared helper assumes
  // the 'intervention' owner shape).
  // -----------------------------------------------------------------------
  it('returns 422 when attachment ownerType is not intervention', async () => {
    const { tenantId, token } = await setupCaller('vu-422');
    // Need a user row in the same tenant for uploaded_by_user_id.
    const cognitoSub = `vu-422-uploader-${Date.now()}`;
    const { rows: userRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 LIMIT 1`,
      [cognitoSub],
    );
    // setupCaller already created a user with a different sub — fetch its id.
    const { rows: callerUserRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const uploaderId = userRows[0]?.id ?? callerUserRows[0]!.id;

    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO attachments
         (id, owner_type, owner_id, tenant_id, customer_id,
          uploaded_by_user_id, uploaded_by_customer_id,
          file_name, mime_type, size_bytes, s3_key, s3_bucket,
          processed, deleted_at, created_at)
       VALUES (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
          gen_random_uuid(), $1, NULL, $2, NULL,
          'evidence.pdf', 'application/pdf', 12345,
          'attachments/dispute/test.pdf', 'garageos-dev',
          TRUE, NULL, NOW())
       RETURNING id`,
      [tenantId, uploaderId],
    );
    const attachmentId = rows[0]!.id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.owner_not_supported');
  });
});

describe('GET /v1/attachments/:id/view-url — clienti+private_intervention (integration)', () => {
  let app: FastifyInstance;
  const TEST_IP_VIEW = '10.50.15.1';

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('200 returns presigned GET URL for clienti+private_intervention attachment', async () => {
    const cognitoSub = 'view-pi-ok-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('view-pi-ok');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'VIEWPIOK00000001',
      plate: 'VP001AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-03-10',
    });
    const { attachmentId } = await createAttachment({
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      customerId,
      uploadedByCustomerId: customerId,
      processed: true,
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_VIEW },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; expires_at: string };
    expect(body.url).toMatch(/^https:\/\/.+/);
    expect(body.expires_at).toBeTruthy();
  });

  it('404 clienti requesting intervention attachment (RLS hides → not_found)', async () => {
    // Clienti context can't see the intervention-owned attachment because
    // RLS scopes by customerId; the row's customerId is null (tenant-side
    // attachment), so it's not visible. Response is 404 not 422 — RLS
    // hides the row before the ownerType check runs.
    const cognitoSub = 'view-cli-int-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('view-cli-int');
    const { attachmentId } = await createAttachment({
      ownerType: 'intervention',
      ownerId: randomUUID(),
      tenantId,
      uploadedByUserId: null,
      processed: true,
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_VIEW },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'attachment.not_found' });
  });

  it('422 clienti requesting intervention_dispute (deferred)', async () => {
    // Clienti CAN see intervention_dispute attachments via RLS (they uploaded
    // them themselves on their own dispute), but view-url for that ownerType
    // is deferred to a future customer dispute UI slice. F2 only ships
    // private_intervention support for clienti.
    const cognitoSub = 'view-cli-disp-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId } = await createTenantWithLocation('view-cli-disp');
    const { attachmentId } = await createAttachment({
      ownerType: 'intervention_dispute',
      ownerId: randomUUID(),
      tenantId,
      customerId,
      uploadedByCustomerId: customerId,
      processed: true,
    });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_VIEW },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'attachment.owner_not_supported' });
  });

  it("404 clienti requesting another customer's private_intervention attachment", async () => {
    const cognitoSubA = 'view-cli-cross-a-' + Math.random().toString(36).slice(2, 10);
    const cognitoSubB = 'view-cli-cross-b-' + Math.random().toString(36).slice(2, 10);
    const { customerId: customerIdA } = await createCustomer({ cognitoSub: cognitoSubA });
    const { customerId: customerIdB } = await createCustomer({ cognitoSub: cognitoSubB });
    const { tenantId } = await createTenantWithLocation('view-cli-cross');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'VIEWCROSS000001',
      plate: 'VP002AA',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId: customerIdB });
    const { privateInterventionId } = await createPrivateIntervention({
      customerId: customerIdB,
      vehicleId,
      interventionDate: '2026-03-10',
    });
    const { attachmentId } = await createAttachment({
      ownerType: 'private_intervention',
      ownerId: privateInterventionId,
      customerId: customerIdB,
      uploadedByCustomerId: customerIdB,
      processed: true,
    });

    const tokenA = await signTestToken({
      pool: 'clienti',
      sub: cognitoSubA,
      customerId: customerIdA,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-forwarded-for': TEST_IP_VIEW },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'attachment.not_found' });
  });
});

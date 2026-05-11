import type { FastifyInstance } from 'fastify';
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
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
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
    const { tenantId, locationId } = await createTenantWithLocation(suffix);
    const cognitoSub = `vu-caller-${suffix.slice(0, 20)}`;
    await createUser({ tenantId, cognitoSub, locationId });
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
  // Scenario 3: 404 wrong tenant (cross-tenant isolation)
  // -----------------------------------------------------------------------
  it('returns 404 when attachment belongs to a different tenant', async () => {
    const { tenantId: tenantA } = await setupCaller('vu-xA');
    const { attachmentId } = await insertAttachment({ tenantId: tenantA });

    // Caller is tenantB
    const { token: tokenB } = await setupCaller('vu-xB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attachment.not_found');
  });

  // -----------------------------------------------------------------------
  // Scenario 4: 403 clienti pool
  // -----------------------------------------------------------------------
  it('returns 403 when caller is in the clienti pool', async () => {
    const token = await signTestToken({
      pool: 'clienti',
      customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/attachments/ffffffff-ffff-4fff-8fff-ffffffffffff/view-url',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(403);
  });

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
  // -----------------------------------------------------------------------
  it('returns 422 when attachment ownerType is not intervention', async () => {
    const { tenantId, token } = await setupCaller('vu-422');
    const { attachmentId } = await insertAttachment({
      tenantId,
      ownerType: 'private_intervention',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/view-url`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.owner_not_supported');
  });
});

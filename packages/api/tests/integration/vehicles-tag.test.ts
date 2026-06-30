import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getOrCreateTagPresignedUrl at module level so no real S3 or PDF
// rendering calls are made — see feedback_aws_sdk_presigner_credentials_chain.
// Must be declared before the module-under-test is imported transitively
// via buildTestServer() so Vitest hoists the mock correctly.
vi.mock('../../src/lib/vehicle-tag-s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/vehicle-tag-s3.js')>();
  return {
    ...actual,
    getOrCreateTagPresignedUrl: vi.fn(),
  };
});

import { getOrCreateTagPresignedUrl } from '../../src/lib/vehicle-tag-s3.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
const TEST_IP = '10.20.31.60';

// Shared mock return value for presigned URL scenarios.
const MOCK_EXPIRES_AT = new Date(Date.now() + 3600 * 1000);

describe('GET /v1/vehicles/:id/tag (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Ensure AWS SDK doesn't attempt real credential chain resolution —
    // feedback_aws_sdk_presigner_credentials_chain.
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    process.env.S3_ATTACHMENTS_BUCKET ??= 'garageos-test-attachments';

    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    // Default mock: cache miss path (HeadObject → NoSuchKey → PutObject → presign).
    // Tests that need cache-hit override this per-test.
    vi.mocked(getOrCreateTagPresignedUrl).mockImplementation(async ({ garageCode }) => ({
      url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/tags/${garageCode}.pdf?X-Amz-Signature=test`,
      expiresAt: MOCK_EXPIRES_AT,
      cacheHit: false,
    }));
  });

  // -----------------------------------------------------------------------
  // Helper: set up a caller (tenant + user + signed token).
  // -----------------------------------------------------------------------
  async function setupCaller(suffix: string, role: 'mechanic' | 'super_admin' = 'mechanic') {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `tag-caller-${suffix.slice(0, 20)}`;
    await createUser({ tenantId, cognitoSub, role });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role,
    });
    return { tenantId, token, cognitoSub };
  }

  // -----------------------------------------------------------------------
  // Helper: count vehicle_tag_prints rows for a vehicle.
  // -----------------------------------------------------------------------
  async function countTagPrints(vehicleId: string): Promise<number> {
    const { rows } = await pgAdmin.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM vehicle_tag_prints WHERE vehicle_id = $1`,
      [vehicleId],
    );
    return parseInt(rows[0]!.cnt, 10);
  }

  // -----------------------------------------------------------------------
  // Scenario 1: Happy path — tenant A user → tenant A certified vehicle.
  // Verify 200 + tag_download_url contains tags/<garage_code>.pdf + expires_at
  // is ISO + 1 audit row inserted with correct fields.
  // -----------------------------------------------------------------------
  it('200 — certified vehicle: returns presigned URL + expires_at, inserts audit row', async () => {
    const { tenantId, token, cognitoSub } = await setupCaller('tag-happy');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tag_download_url: string; expires_at: string }>();

    // URL shape: must contain tags/<garage_code>.pdf (BR-026 S3 key).
    expect(body.tag_download_url).toContain(`tags/${garageCode!}.pdf`);

    // expires_at must be a valid ISO string in the future.
    expect(typeof body.expires_at).toBe('string');
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Audit row inserted for this print event.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(1);

    // Verify the audit row has correct fields by querying directly.
    const { rows } = await pgAdmin.query<{
      vehicle_id: string;
      tenant_id: string;
      kind: string;
    }>(
      `SELECT vehicle_id, tenant_id, kind
         FROM vehicle_tag_prints
        WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vehicle_id).toBe(vehicleId);
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.kind).toBe('first');

    // getOrCreateTagPresignedUrl was called with correct bucket + garageCode.
    expect(getOrCreateTagPresignedUrl).toHaveBeenCalledOnce();
    expect(vi.mocked(getOrCreateTagPresignedUrl).mock.calls[0]![0]).toMatchObject({
      bucket: process.env.S3_ATTACHMENTS_BUCKET,
      garageCode: garageCode!,
    });

    // Suppress unused variable TS error for cognitoSub (used only to confirm user seeded).
    void cognitoSub;
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Cross-tenant — tenant A user → tenant B vehicle → 404.
  // The route scopes findFirst({ where: { id, tenantId } }) to the caller's
  // tenant, so tenant B's vehicle is invisible → 404 vehicle.not_found.
  // -----------------------------------------------------------------------
  it('404 vehicle.not_found — cross-tenant vehicle request denied by RLS scope', async () => {
    const { token: tokenA } = await setupCaller('tag-xA');
    const { tenantId: tenantB } = await createTenantWithLocation('tag-xB');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantB,
      status: 'certified',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');

    // No audit row must be inserted on 404.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);

    // S3 must not be touched on 404.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Two consecutive prints for the same vehicle.
  // Both return 200 and 2 audit rows with kind='first'.
  // Second request is a cache-hit (getOrCreateTagPresignedUrl called twice
  // but returns cacheHit=true the second time — S3 PutObject not repeated,
  // but audit INSERT fires each time as every print is logged).
  // -----------------------------------------------------------------------
  it('two prints on same vehicle → 2 audit rows kind=first, second request cache-hits', async () => {
    const { tenantId, token } = await setupCaller('tag-two');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    // First request: cache miss.
    vi.mocked(getOrCreateTagPresignedUrl).mockImplementationOnce(async ({ garageCode: gc }) => ({
      url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/tags/${gc}.pdf?X-Amz-Signature=test`,
      expiresAt: MOCK_EXPIRES_AT,
      cacheHit: false,
    }));
    const res1 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res1.statusCode).toBe(200);

    // Second request: cache hit — S3 key already exists.
    vi.mocked(getOrCreateTagPresignedUrl).mockImplementationOnce(async ({ garageCode: gc }) => ({
      url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/tags/${gc}.pdf?X-Amz-Signature=test`,
      expiresAt: MOCK_EXPIRES_AT,
      cacheHit: true,
    }));
    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res2.statusCode).toBe(200);

    // Both calls reached the S3 helper.
    expect(getOrCreateTagPresignedUrl).toHaveBeenCalledTimes(2);

    // Two audit rows, both kind='first' (PR1 always logs kind='first').
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(2);

    const { rows } = await pgAdmin.query<{ kind: string }>(
      `SELECT kind FROM vehicle_tag_prints WHERE vehicle_id = $1 ORDER BY created_at`,
      [vehicleId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('first');
    expect(rows[1]!.kind).toBe('first');

    void garageCode;
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Pending vehicle → 409 vehicle.not_certified.
  // Status guard fires before S3 and before audit INSERT.
  // -----------------------------------------------------------------------
  it('409 vehicle.not_certified — pending vehicle: no audit row inserted', async () => {
    const { tenantId, token } = await setupCaller('tag-pending');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'pending',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.not_certified');

    // No audit row on status-guard rejection.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Archived vehicle → 409 vehicle.archived.
  // Status guard fires before S3 and before audit INSERT.
  // -----------------------------------------------------------------------
  it('409 vehicle.archived — archived vehicle: no audit row inserted', async () => {
    const { tenantId, token } = await setupCaller('tag-archived');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      // Archived vehicles carry a garage_code (they were certified before archival).
      garageCode: 'GO-234-ARCV',
      status: 'archived',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.archived');

    // No audit row on status-guard rejection.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 6: Auth missing → 401.
  // -----------------------------------------------------------------------
  it('401 — missing Authorization header', async () => {
    const { tenantId } = await createTenantWithLocation('tag-noauth');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(401);

    // No audit row on unauthenticated request.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);
  });
});

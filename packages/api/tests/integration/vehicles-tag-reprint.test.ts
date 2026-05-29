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
const TEST_IP = '10.20.31.61';

// Shared mock expiry for presigned URL scenarios.
const MOCK_EXPIRES_AT = new Date(Date.now() + 3600 * 1000);

describe('POST /v1/vehicles/:id/tag-reprint (integration)', () => {
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
    // Default mock: cache-hit path (PDF already uploaded by prior first-print).
    // Reprint tests always have an audit row seeded, so cache-hit is realistic.
    vi.mocked(getOrCreateTagPresignedUrl).mockImplementation(async ({ garageCode }) => ({
      url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/tags/${garageCode}.pdf?X-Amz-Signature=test`,
      expiresAt: MOCK_EXPIRES_AT,
      cacheHit: true,
    }));
  });

  // -----------------------------------------------------------------------
  // Helper: set up a caller (tenant + user + signed token).
  // -----------------------------------------------------------------------
  async function setupCaller(suffix: string, role: 'mechanic' | 'super_admin' = 'mechanic') {
    const { tenantId, locationId } = await createTenantWithLocation(suffix);
    const cognitoSub = `reprint-caller-${suffix.slice(0, 18)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId, role });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role,
    });
    return { tenantId, locationId, userId, token, cognitoSub };
  }

  // -----------------------------------------------------------------------
  // Helper: insert a first-print audit row to satisfy BR-028 never_printed gate.
  // -----------------------------------------------------------------------
  async function seedFirstPrint(vehicleId: string, tenantId: string, userId: string) {
    await pgAdmin.query(
      `INSERT INTO vehicle_tag_prints (vehicle_id, tenant_id, printed_by_user_id, kind)
       VALUES ($1, $2, $3, 'first')`,
      [vehicleId, tenantId, userId],
    );
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
  // Scenario 1: Happy 200 — certified vehicle, prior first-print audit, reprint
  // with reason='damaged' + documentVerified=true. Verify 200, 2 audit rows
  // total (first + reprint), reprint row has correct fields.
  // -----------------------------------------------------------------------
  it('200 — reason=damaged: 2 audit rows total, reprint row has correct fields', async () => {
    const { tenantId, userId, token } = await setupCaller('rp-happy');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    await seedFirstPrint(vehicleId, tenantId, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tag_download_url: string; expires_at: string }>();

    // URL shape: must contain tags/<garage_code>.pdf (BR-026 S3 key).
    expect(body.tag_download_url).toContain(`tags/${garageCode!}.pdf`);

    // expires_at must be a valid ISO string in the future.
    expect(typeof body.expires_at).toBe('string');
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // 2 audit rows total: first (seeded) + reprint (this request).
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(2);

    // Verify the reprint row fields.
    const { rows } = await pgAdmin.query<{
      vehicle_id: string;
      tenant_id: string;
      kind: string;
      reason: string | null;
      reason_note: string | null;
      document_verified: boolean;
    }>(
      `SELECT vehicle_id, tenant_id, kind, reason, reason_note, document_verified
         FROM vehicle_tag_prints
        WHERE vehicle_id = $1 AND kind = 'reprint'`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vehicle_id).toBe(vehicleId);
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.kind).toBe('reprint');
    expect(rows[0]!.reason).toBe('damaged');
    expect(rows[0]!.reason_note).toBeNull();
    expect(rows[0]!.document_verified).toBe(true);

    // S3 helper called once with correct args.
    expect(getOrCreateTagPresignedUrl).toHaveBeenCalledOnce();
    expect(vi.mocked(getOrCreateTagPresignedUrl).mock.calls[0]![0]).toMatchObject({
      bucket: process.env.S3_ATTACHMENTS_BUCKET,
      garageCode: garageCode!,
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Happy 200 with reasonNote — reason='other' + reasonNote set.
  // Verify reprint audit row has reason_note populated.
  // -----------------------------------------------------------------------
  it('200 — reason=other + reasonNote: audit row has reason_note populated', async () => {
    const { tenantId, userId, token } = await setupCaller('rp-note');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    await seedFirstPrint(vehicleId, tenantId, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'other', reasonNote: 'Tag scolorito illeggibile', documentVerified: true },
    });

    expect(res.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{ reason: string; reason_note: string | null }>(
      `SELECT reason, reason_note
         FROM vehicle_tag_prints
        WHERE vehicle_id = $1 AND kind = 'reprint'`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('other');
    expect(rows[0]!.reason_note).toBe('Tag scolorito illeggibile');
  });

  // -----------------------------------------------------------------------
  // Scenario 3: 409 vehicle_tag.never_printed — certified vehicle without any
  // prior audit row. BR-028: reprint requires at least one prior first print.
  // -----------------------------------------------------------------------
  it('409 vehicle_tag.never_printed — no prior audit row: reprint blocked', async () => {
    const { tenantId, token } = await setupCaller('rp-never');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    // Deliberately NOT seeding a first-print audit row.

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle_tag.never_printed');

    // Audit count must remain 0.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 4: 409 vehicle.archived — archived vehicle with prior audit row.
  // Status guard fires before the never_printed check and before S3.
  // -----------------------------------------------------------------------
  it('409 vehicle.archived — archived vehicle with prior audit: no new row', async () => {
    const { tenantId, userId, token } = await setupCaller('rp-arch');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      garageCode: 'GO-234-ARCR',
      status: 'archived',
    });
    // Seed an audit row to confirm status guard fires first (not never_printed).
    await seedFirstPrint(vehicleId, tenantId, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.archived');

    // Only the seeded first-print row remains.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(1);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 5: 409 vehicle.not_certified — pending vehicle.
  // Status guard fires before S3 and before audit INSERT.
  // -----------------------------------------------------------------------
  it('409 vehicle.not_certified — pending vehicle: no audit row inserted', async () => {
    const { tenantId, token } = await setupCaller('rp-pend');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'pending',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.not_certified');

    // No audit row inserted.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(0);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Scenario 6: 400 documentVerified=false — Zod z.literal(true) rejects false.
  // See BR-028: document verification is a precondition for reprint.
  // -----------------------------------------------------------------------
  it('400 — documentVerified=false rejected by Zod z.literal(true)', async () => {
    const { tenantId, userId, token } = await setupCaller('rp-docf');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    await seedFirstPrint(vehicleId, tenantId, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: false },
    });

    expect(res.statusCode).toBe(400);

    // No new audit row inserted on validation failure.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(1); // only the seeded first-print
  });

  // -----------------------------------------------------------------------
  // Scenario 7: 400 reason='other' without reasonNote — Zod .refine rejects.
  // reasonNote is required when reason='other' (BR-028 free-text mandate).
  // -----------------------------------------------------------------------
  it("400 — reason='other' without reasonNote rejected by Zod refine", async () => {
    const { tenantId, userId, token } = await setupCaller('rp-oth');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });
    await seedFirstPrint(vehicleId, tenantId, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'other', documentVerified: true },
    });

    expect(res.statusCode).toBe(400);

    // No new audit row inserted on validation failure.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(1); // only the seeded first-print
  });

  // -----------------------------------------------------------------------
  // Scenario 8: 404 cross-tenant scope — vehicle belongs to tenant A, caller
  // is tenant B. Route scopes findFirst to caller's tenant → 404.
  // -----------------------------------------------------------------------
  it('404 vehicle.not_found — cross-tenant vehicle request denied', async () => {
    // Tenant A owns the vehicle.
    const { tenantId: tenantA, userId: userA } = await setupCaller('rp-xA');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantA,
      status: 'certified',
    });
    await seedFirstPrint(vehicleId, tenantA, userA);

    // Tenant B attempts the reprint.
    const { token: tokenB } = await setupCaller('rp-xB');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/tag-reprint`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
      payload: { reason: 'damaged', documentVerified: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');

    // Only the seeded first-print row from tenant A remains; no reprint added.
    const printCount = await countTagPrints(vehicleId);
    expect(printCount).toBe(1);

    // S3 must not be touched.
    expect(getOrCreateTagPresignedUrl).not.toHaveBeenCalled();
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock generateInterventionPdfPresignedUrl at module level so no real S3 or
// PDF rendering calls are made — mirrors how vehicles-tag.test.ts mocks
// vehicle-tag-s3.js. Must be declared before the module-under-test is imported
// transitively via buildTestServer() so Vitest hoists the mock correctly.
vi.mock('../../src/lib/intervention-pdf-s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/intervention-pdf-s3.js')>();
  return {
    ...actual,
    generateInterventionPdfPresignedUrl: vi.fn(),
  };
});

// resolveTenantLogo issues a GetObject call — swallow it so no AWS creds
// are needed. The logo-missing-graceful scenario (case 6) exercises the
// logo-null return path; the mock default already returns null for every test.
vi.mock('../../src/lib/tenant-logo.js', () => ({
  resolveTenantLogo: vi.fn(),
}));

import { generateInterventionPdfPresignedUrl } from '../../src/lib/intervention-pdf-s3.js';
import { resolveTenantLogo } from '../../src/lib/tenant-logo.js';
import { buildTestServer } from './fixtures.js';
import { pgAdmin } from './setup.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createIntervention,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
// 10.20.42.x is free across all existing integration test files.
const TEST_IP = '10.20.42.1';

// Presigned URL returned by the mock for every happy-path call.
const MOCK_EXPIRES_AT = new Date(Date.now() + 3600 * 1000);

describe('GET /v1/interventions/:id/pdf (integration)', () => {
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
    // resetDb() truncates intervention_types as a CASCADE side-effect of
    // TRUNCATE tenants — re-seed so each test has a stable type FK.
    await ensureSystemInterventionType('TAGLIANDO');
    vi.clearAllMocks();
    // Default mock: logo resolver returns null (no logo) + S3 helper returns
    // a stable presigned URL. Per-test overrides replace this as needed.
    vi.mocked(resolveTenantLogo).mockResolvedValue(null);
    vi.mocked(generateInterventionPdfPresignedUrl).mockImplementation(
      async ({ tenantId, interventionId }) => ({
        url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/intervention-pdfs/${tenantId}/${interventionId}.pdf?X-Amz-Signature=test`,
        expiresAt: MOCK_EXPIRES_AT,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Helper: create a tenant + location + mechanic user + signed token.
  // -----------------------------------------------------------------------
  async function setupCaller(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `pdf-caller-${suffix.slice(0, 18)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, userId, token };
  }

  // -----------------------------------------------------------------------
  // Helper: seed a minimal intervention + vehicle for a given tenant.
  // -----------------------------------------------------------------------
  async function setupIntervention(args: {
    tenantId: string;
    userId: string;
    status?: 'active' | 'disputed' | 'cancelled';
  }) {
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: args.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-20',
      odometerKm: 55000,
      title: 'Tagliando PDF',
      description: 'Cambio olio e filtri',
      partsReplaced: [{ name: 'Olio motore', code: 'OIL-5W40', quantity: 5, notes: null }],
      status: args.status ?? 'active',
    });
    return { interventionId, vehicleId };
  }

  // -----------------------------------------------------------------------
  // Case 1 — 200 owner visible (BR-040 + BR-151 relation gated).
  // Customer has a CustomerTenantRelation for tenant A → PII visible.
  // Assert: 200, pdf_download_url shape, generateInterventionPdfPresignedUrl
  // called once with the correct tenantId + interventionId.
  // -----------------------------------------------------------------------
  it('200 — owner with CustomerTenantRelation: PII visible, returns pdf_download_url, S3 called once', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-owner-vis');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    // BR-040: active owner = endedAt null.
    await createOwnership({ vehicleId, customerId });
    // BR-151: CTR row makes PII visible.
    await createCustomerTenantRelation({ tenantId, customerId });

    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-20',
      odometerKm: 55000,
      title: 'Tagliando PDF',
      description: 'Cambio olio',
      partsReplaced: [],
      status: 'active',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ pdf_download_url: string; expires_at: string }>();

    // URL must contain the canonical S3 key shape: intervention-pdfs/<tenantId>/<interventionId>.pdf
    expect(body.pdf_download_url).toContain(`intervention-pdfs/${tenantId}/${interventionId}.pdf`);
    // expires_at must be a valid ISO string.
    expect(typeof body.expires_at).toBe('string');
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // generateInterventionPdfPresignedUrl called exactly once (PDF always re-rendered).
    expect(generateInterventionPdfPresignedUrl).toHaveBeenCalledOnce();
    expect(vi.mocked(generateInterventionPdfPresignedUrl).mock.calls[0]![0]).toMatchObject({
      bucket: process.env.S3_ATTACHMENTS_BUCKET,
      tenantId,
      interventionId,
    });
    // BR-151: customer has a CTR → PII visible → full name forwarded to PDF renderer.
    expect(vi.mocked(generateInterventionPdfPresignedUrl).mock.calls[0]![0].data.customerName).toBe(
      'Mario Rossi',
    );
  });

  // -----------------------------------------------------------------------
  // Case 2 — 404 cross-tenant: intervention belongs to tenant A; caller is
  // tenant B. Route scopes findFirst {id, tenantId} → invisible → 404.
  // Assert: 404 code=intervention.not_found; S3 NOT called.
  // -----------------------------------------------------------------------
  it('404 — cross-tenant: intervention.not_found, S3 not called', async () => {
    const { tenantId: tenantA, userId: userA } = await setupCaller('pdf-xtA');
    const { interventionId } = await setupIntervention({
      tenantId: tenantA,
      userId: userA,
    });

    // Caller is tenant B.
    const { token: tokenB } = await setupCaller('pdf-xtB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('intervention.not_found');
    // S3 must not be touched on 404.
    expect(generateInterventionPdfPresignedUrl).not.toHaveBeenCalled();
    // Logo resolver must not be reached either — 404 exits before any enrichment.
    expect(resolveTenantLogo).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Case 3 — 200 owner WITHOUT CustomerTenantRelation (BR-151 placeholder).
  // Customer owns the vehicle (BR-040 endedAt=null) but has no CTR for this
  // tenant → PII not visible → route still generates PDF with redacted name.
  // Assert: 200; S3 called once. (Content of PDF is not asserted — integration
  // value is the DB path completing without error.)
  // -----------------------------------------------------------------------
  it('200 — owner without CustomerTenantRelation: BR-151 placeholder, still generates PDF', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-no-rel');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    // Active ownership exists (BR-040).
    await createOwnership({ vehicleId, customerId });
    // Intentionally NO CustomerTenantRelation → PII not visible → placeholder.

    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-21',
      odometerKm: 30000,
      title: null,
      description: 'Revisione freni',
      partsReplaced: [],
      status: 'active',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(generateInterventionPdfPresignedUrl).toHaveBeenCalledOnce();
    // BR-151: no CTR → PII not visible → placeholder text forwarded to PDF renderer.
    expect(vi.mocked(generateInterventionPdfPresignedUrl).mock.calls[0]![0].data.customerName).toBe(
      'Proprietario non in anagrafica',
    );
  });

  // -----------------------------------------------------------------------
  // Case 4 — 200 cancelled intervention exportable.
  // status='cancelled' must not block PDF generation.
  // Assert: 200; S3 called once.
  // -----------------------------------------------------------------------
  it('200 — cancelled intervention: PDF still exportable, S3 called once', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-cancel');
    const { interventionId } = await setupIntervention({
      tenantId,
      userId,
      status: 'cancelled',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(generateInterventionPdfPresignedUrl).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Case 5 — 200 vehicle with NO active ownership.
  // VehicleOwnership.endedAt is set (or no ownership row exists) → BR-040
  // resolves to null → customerName=null. Route must still return 200 + PDF.
  // Assert: 200; S3 called once.
  // -----------------------------------------------------------------------
  it('200 — no active ownership (endedAt set): customerName null, still generates PDF', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-no-own');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    // Ownership row exists but has endedAt set → not active by BR-040.
    await createOwnership({
      vehicleId,
      customerId,
      endedAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-22',
      odometerKm: 40000,
      title: 'Sostituzione gomme',
      description: 'Montaggio pneumatici invernali',
      partsReplaced: [],
      status: 'active',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(generateInterventionPdfPresignedUrl).toHaveBeenCalledOnce();
    // BR-040: no active ownership → no customer → customerName null in PDF data.
    expect(
      vi.mocked(generateInterventionPdfPresignedUrl).mock.calls[0]![0].data.customerName,
    ).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Case 6 — 200 logo key present but object missing → graceful degradation.
  // resolveTenantLogo swallows ALL errors internally (catch→null). The mock
  // returns null (its default), which is what the real impl returns on
  // NoSuchKey / IAM denied / any S3 failure. Assert: 200; S3 called once.
  // This exercises that the route does NOT fail over an absent logo.
  // -----------------------------------------------------------------------
  it('200 — logoUrl set but logo resolver returns null (missing object): graceful, PDF generated', async () => {
    const { tenantId: baseTenantId } = await createTenantWithLocation('pdf-logo-miss-base');
    // Patch the tenant's logo_url to a key that "exists" in intent but the
    // mock logo resolver returns null for (simulating NoSuchKey / IAM gap).
    // We use pgAdmin directly because createTenantWithLocation doesn't expose
    // a logoUrl param.
    await pgAdmin.query(`UPDATE tenants SET logo_url = 'logos/missing.png' WHERE id = $1`, [
      baseTenantId,
    ]);

    // Create user, vehicle, intervention under this patched tenant.
    const cognitoSub = 'pdf-logo-miss-sub';
    const { userId } = await createUser({ tenantId: baseTenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: baseTenantId,
      role: 'mechanic',
    });

    const { vehicleId } = await createVehicle({ createdByTenantId: baseTenantId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { interventionId } = await createIntervention({
      tenantId: baseTenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-23',
      odometerKm: 70000,
      title: 'Tagliando logo test',
      description: 'Verifica graceful degradation logo',
      partsReplaced: [],
      status: 'active',
    });

    // resolveTenantLogo already mocked to return null (see beforeEach default).
    // This null is the same value the real implementation returns on any S3 error.

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    // resolveTenantLogo was called (logo path exercised).
    expect(resolveTenantLogo).toHaveBeenCalledOnce();
    // PDF still generated despite null logo.
    expect(generateInterventionPdfPresignedUrl).toHaveBeenCalledOnce();
  });
});

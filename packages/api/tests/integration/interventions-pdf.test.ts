import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('GET /v1/interventions/:id/pdf (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
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
  // Assert: 200, binary PDF response.
  // -----------------------------------------------------------------------
  it('200 — owner with CustomerTenantRelation: PII visible, streams application/pdf', async () => {
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
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  // -----------------------------------------------------------------------
  // Case 2 — 404 cross-tenant: intervention belongs to tenant A; caller is
  // tenant B. Route scopes findFirst {id, tenantId} → invisible → 404.
  // -----------------------------------------------------------------------
  it('404 — cross-tenant: intervention.not_found', async () => {
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
  });

  // -----------------------------------------------------------------------
  // Case 3 — 200 owner WITHOUT CustomerTenantRelation (BR-151 placeholder).
  // Customer owns the vehicle (BR-040 endedAt=null) but has no CTR for this
  // tenant → PII not visible → route still generates PDF with redacted name.
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
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  // -----------------------------------------------------------------------
  // Case 4 — 200 cancelled intervention exportable.
  // status='cancelled' must not block PDF generation.
  // -----------------------------------------------------------------------
  it('200 — cancelled intervention: PDF still exportable', async () => {
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
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  // -----------------------------------------------------------------------
  // Case 5 — 200 vehicle with NO active ownership.
  // VehicleOwnership.endedAt is set (or no ownership row exists) → BR-040
  // resolves to null → customerName=null. Route must still return 200 + PDF.
  // -----------------------------------------------------------------------
  it('200 — no active ownership (endedAt set): still generates PDF', async () => {
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
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  // -----------------------------------------------------------------------
  // Case 6 — 200 tenant with a logo_url set is no longer relevant (logo was
  // dropped from the PDF pipeline in this slice) — kept as a regression check
  // that a populated logo_url column does not break the route.
  // -----------------------------------------------------------------------
  it('200 — tenant with logo_url set: still generates PDF (logo no longer used)', async () => {
    const { tenantId: baseTenantId } = await createTenantWithLocation('pdf-logo-miss-base');
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
      description: 'Verifica generazione senza logo',
      partsReplaced: [],
      status: 'active',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

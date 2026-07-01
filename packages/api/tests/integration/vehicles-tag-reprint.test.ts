import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
const TEST_IP = '10.20.31.61';

describe('POST /v1/vehicles/:id/tag-reprint (integration)', () => {
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
  // Helper: set up a caller (tenant + user + signed token).
  // -----------------------------------------------------------------------
  async function setupCaller(suffix: string, role: 'mechanic' | 'super_admin' = 'mechanic') {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `reprint-caller-${suffix.slice(0, 18)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, role });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role,
    });
    return { tenantId, userId, token, cognitoSub };
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
  // with reason='damaged' + documentVerified=true. Verify 200 application/pdf
  // bytes, 2 audit rows total (first + reprint), reprint row has correct fields.
  // -----------------------------------------------------------------------
  it('200 — reason=damaged: streams application/pdf, 2 audit rows total', async () => {
    const { tenantId, userId, token } = await setupCaller('rp-happy');
    const { vehicleId } = await createVehicle({
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
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

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
  });

  // -----------------------------------------------------------------------
  // Scenario 4: 409 vehicle.archived — archived vehicle with prior audit row.
  // Status guard fires before the never_printed check and before render.
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
  });

  // -----------------------------------------------------------------------
  // Scenario 5: 409 vehicle.not_certified — pending vehicle.
  // Status guard fires before render and before audit INSERT.
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
  });
});

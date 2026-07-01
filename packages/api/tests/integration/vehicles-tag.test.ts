import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
const TEST_IP = '10.20.31.60';

describe('GET /v1/vehicles/:id/tag (integration)', () => {
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
  // Verify 200 + application/pdf bytes + 1 audit row inserted with correct
  // fields.
  // -----------------------------------------------------------------------
  it('200 — certified vehicle: streams application/pdf bytes, inserts audit row', async () => {
    const { tenantId, token, cognitoSub } = await setupCaller('tag-happy');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

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
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Two consecutive prints for the same vehicle.
  // Both return 200 and 2 audit rows with kind='first' (every call renders
  // fresh — no cache — so both requests independently produce bytes).
  // -----------------------------------------------------------------------
  it('two prints on same vehicle → both 200, 2 audit rows kind=first', async () => {
    const { tenantId, token } = await setupCaller('tag-two');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      status: 'certified',
    });

    const res1 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/tag`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res2.statusCode).toBe(200);

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
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Pending vehicle → 409 vehicle.not_certified.
  // Status guard fires before render and before audit INSERT.
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
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Archived vehicle → 409 vehicle.archived.
  // Status guard fires before render and before audit INSERT.
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

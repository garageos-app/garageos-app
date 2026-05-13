import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
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

// POST /v1/vehicles/:id/interventions end-to-end.
//   - Happy path (201) inserts intervention + auto-relation + access_log
//   - BR-068 (km non-decreasing) — warning vs. force override
//   - BR-069 (no future-dated interventions)
//   - BR-070 (no interventions before vehicle.registration_date)
//   - BR-080 (deadline auto-create when createDeadline.enabled=true)
//   - BR-152 (customer_tenant_relation auto-create on first touch)
//   - BR-154 (access_log action='create')

function buildBody(
  interventionTypeId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    interventionTypeId,
    interventionDate: '2026-04-21',
    odometerKm: 45000,
    title: 'Tagliando completo',
    description: 'Sostituzione olio motore 5W30 + filtri (olio, aria, abitacolo)',
    partsReplaced: [
      { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30', quantity: 4, notes: 'Litri' },
      { name: 'Filtro olio', code: 'UFI-23145', quantity: 1 },
    ],
    ...overrides,
  };
}

describe('POST /v1/vehicles/:id/interventions (integration)', () => {
  let app: FastifyInstance;
  let taglianodoTypeId: string;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // resetDb() TRUNCATEs tenants CASCADE, which Postgres extends to
    // intervention_types as a whole — system-row tenant_id NULL doesn't
    // shield it. Re-seed TAGLIANDO per test so each scenario has a stable
    // type to FK against.
    const tagliando = await ensureSystemInterventionType('TAGLIANDO');
    taglianodoTypeId = tagliando.id;
  });

  it('creates intervention + customer_tenant_relation + access_log atomically (happy path)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('int-happy');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId, cognitoSub, locationId });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      intervention: {
        id: string;
        vehicleId: string;
        odometerKm: number;
        kmAnomaly: boolean;
        status: string;
        interventionType: { code: string };
      };
      deadline: { id: string } | null;
    };
    expect(json.intervention.vehicleId).toBe(vehicleId);
    expect(json.intervention.odometerKm).toBe(45000);
    expect(json.intervention.kmAnomaly).toBe(false);
    expect(json.intervention.status).toBe('active');
    expect(json.intervention.interventionType.code).toBe('TAGLIANDO');
    expect(json.deadline).toBeNull();

    // BR-152: relation auto-created.
    const { rows: relRows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customer_tenant_relations
        WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, customerId],
    );
    expect(Number(relRows[0]!.count)).toBe(1);

    // BR-154: access_log row written.
    const { rows: accRows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM access_logs
        WHERE vehicle_id = $1 AND action = 'create'`,
      [vehicleId],
    );
    expect(Number(accRows[0]!.count)).toBe(1);

    // Intervention row persisted with correct FKs.
    const { rows: interventionRows } = await pgAdmin.query<{
      tenant_id: string;
      location_id: string;
      user_id: string;
    }>(
      `SELECT tenant_id, location_id, user_id FROM interventions
        WHERE id = $1`,
      [json.intervention.id],
    );
    expect(interventionRows[0]).toMatchObject({
      tenant_id: tenantId,
      location_id: locationId,
    });
  });

  it('returns 409 odometer_decrease_warning without force, then 201 with kmAnomaly=true on retry (BR-068)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('int-km');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    // Pre-existing intervention at 50000 km (DB-side INSERT, bypasses route).
    await pgAdmin.query(
      `INSERT INTO interventions
         (id, tenant_id, location_id, user_id, vehicle_id, intervention_type_id,
          intervention_date, odometer_km, description, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
         '2026-03-01'::date, 50000, 'Previous intervention at 50000',
         'active'::"InterventionStatus", NOW(), NOW())`,
      [tenantId, locationId, userId, vehicleId, taglianodoTypeId],
    );
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    // Without force → 409.
    const resWarn = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId, { odometerKm: 42000 }),
    });
    expect(resWarn.statusCode).toBe(409);
    expect(resWarn.json()).toMatchObject({
      code: 'intervention.creation.odometer_decrease_warning',
    });

    // With forceKmDecrease=true → 201, kmAnomaly recorded.
    const resForce = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId, { odometerKm: 42000, forceKmDecrease: true }),
    });
    expect(resForce.statusCode).toBe(201);
    const json = resForce.json() as { intervention: { id: string; kmAnomaly: boolean } };
    expect(json.intervention.kmAnomaly).toBe(true);

    const { rows: anomalyRows } = await pgAdmin.query<{ km_anomaly: boolean }>(
      `SELECT km_anomaly FROM interventions WHERE id = $1`,
      [json.intervention.id],
    );
    expect(anomalyRows[0]!.km_anomaly).toBe(true);
  });

  it('returns 404 when the vehicle does not exist', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('int-no-vehicle');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub, locationId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const ghostVehicleId = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${ghostVehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the intervention type does not exist', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('int-no-type');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub, locationId });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const ghostTypeId = '00000000-0000-4000-8000-000000000001';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(ghostTypeId),
    });
    expect(res.statusCode).toBe(404);
  });

  it('auto-creates a Deadline with type defaults when createDeadline.enabled=true (BR-080)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('int-deadline');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub, locationId });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId, { createDeadline: { enabled: true } }),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      intervention: { id: string };
      deadline: { id: string; dueOdometerKm: number; status: string } | null;
    };
    expect(json.deadline).not.toBeNull();
    // TAGLIANDO defaults: 12 months / 15000 km. 45000 + 15000 = 60000.
    expect(json.deadline!.dueOdometerKm).toBe(60000);
    expect(json.deadline!.status).toBe('open');

    const { rows } = await pgAdmin.query<{
      source_intervention_id: string;
      due_odometer_km: number;
    }>(
      `SELECT source_intervention_id, due_odometer_km FROM deadlines
        WHERE id = $1`,
      [json.deadline!.id],
    );
    expect(rows[0]).toMatchObject({
      source_intervention_id: json.intervention.id,
      due_odometer_km: 60000,
    });
  });

  it('returns 422 user_no_location when authenticated user has no locationId', async () => {
    const { tenantId } = await createTenantWithLocation('int-noloc');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub, locationId: null });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.user_no_location' });
  });

  it('BR-083: a high-km private intervention does NOT block a lower-km officina create', async () => {
    // Setup: vehicle V has 1 officina intervention at 10_000 km AND 1
    // customer-side private intervention at 50_000 km. The customer's
    // self-declared 50k must NOT bind the workshop's future km per BR-083.
    const { tenantId, locationId } = await createTenantWithLocation('br083-noblock');
    const cognitoSub = '11111111-1111-4111-8111-111111111083';
    await createUser({ tenantId, cognitoSub, locationId });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });

    // Seed officina intervention at 10k via the same endpoint.
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const seedRes = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId, { odometerKm: 10_000, interventionDate: '2026-01-01' }),
    });
    expect(seedRes.statusCode).toBe(201);

    // Seed customer-side private intervention at 50k.
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-02-01',
      odometerKm: 50_000,
    });

    // Officina creates at 15k. Pre-BR-083: 409 odometer_decrease_warning because max(10k, 50k)=50k > 15k.
    // Post-BR-083: 201 because only officina (10k) counts; 15k > 10k OK.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/interventions`,
      headers: { authorization: `Bearer ${token}` },
      payload: buildBody(taglianodoTypeId, { odometerKm: 15_000, interventionDate: '2026-03-01' }),
    });
    expect(res.statusCode).toBe(201);
  });
});

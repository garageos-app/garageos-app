import { randomUUID } from 'node:crypto';

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
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
//     + checklist selections (BR-300/301/302/303)
//   - BR-068 (km non-decreasing) — warning vs. force override
//   - BR-069 (no future-dated interventions)
//   - BR-070 (no interventions before vehicle.registration_date)
//   - BR-080 (deadline auto-create when createDeadline.enabled=true)
//   - BR-152 (customer_tenant_relation auto-create on first touch)
//   - BR-154 (access_log action='create')
//   - BR-300..303 — checklist selection validation (Task 3)

function buildBody(
  interventionTypeId: string,
  checklistItemIds: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    interventionTypeId,
    interventionDate: '2026-04-21',
    odometerKm: 45000,
    checklistItemIds,
    description: 'Sostituzione olio motore 5W30 + filtri (olio, aria, abitacolo)',
    partsReplaced: [
      { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30', quantity: 4, notes: 'Litri' },
      { name: 'Filtro olio', code: 'UFI-23145', quantity: 1 },
    ],
    ...overrides,
  };
}

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Inserts a GLOBAL intervention type (tenant_id IS NULL) directly via
// pgAdmin — used for the BR-301 (wrong-type) case which needs a second
// type distinct from MECCANICO. Mirrors intervention-types.test.ts.
async function seedGlobalType(params: { nameIt?: string } = {}): Promise<{ id: string }> {
  const code = uniqueCode('ITYP');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2, true, NOW(), NOW())
     RETURNING id`,
    [code, params.nameIt ?? `Test type ${code}`],
  );
  return { id: rows[0]!.id };
}

// Direct pgAdmin insert for checklist item fixtures — bypasses RLS
// (fixture setup only). Mirrors intervention-types.test.ts. @updatedAt
// columns require an explicit updated_at = NOW() on raw INSERT.
async function seedChecklistItem(params: {
  interventionTypeId: string;
  nameIt?: string;
  sortOrder?: number;
  active?: boolean;
}): Promise<{ id: string; nameIt: string }> {
  const {
    interventionTypeId,
    nameIt = `Test item ${uniqueCode('IITM')}`,
    sortOrder = 0,
    active = true,
  } = params;
  const code = uniqueCode('IITM');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_items
       (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id`,
    [interventionTypeId, code, nameIt, sortOrder, active],
  );
  return { id: rows[0]!.id, nameIt };
}

async function seedTypeExclusion(tenantId: string, interventionTypeId: string): Promise<void> {
  await pgAdmin.query(
    `INSERT INTO tenant_intervention_type_exclusions (tenant_id, intervention_type_id, created_at)
     VALUES ($1, $2, NOW())`,
    [tenantId, interventionTypeId],
  );
}

async function seedItemExclusion(tenantId: string, checklistItemId: string): Promise<void> {
  await pgAdmin.query(
    `INSERT INTO tenant_checklist_item_exclusions (tenant_id, checklist_item_id, created_at)
     VALUES ($1, $2, NOW())`,
    [tenantId, checklistItemId],
  );
}

describe('POST /v1/vehicles/:id/interventions (integration)', () => {
  let app: FastifyInstance;
  let taglianodoTypeId: string;
  // Two active checklist items scoped to taglianodoTypeId, re-seeded every
  // test alongside the type (see comment below on the tenants CASCADE).
  // itemAId/itemBId are the "happy path" default pair most tests pass to
  // buildBody; individual BR-30x tests override with their own fixtures.
  let itemAId: string;
  let itemBId: string;

  // BR-157: every create on a vehicle with an active owner now dispatches a
  // post-commit notification. The SES mock is shared with the wider describe
  // so the pre-existing tests (many seed an ownership) stay network-free —
  // their dispatch resolves against the mock and is otherwise ignored.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const sesMock = mockClient(SESv2Client);

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'shared-mock' });
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    // resetDb() TRUNCATEs tenants CASCADE, which Postgres extends to
    // intervention_types as a whole — system-row tenant_id NULL doesn't
    // shield it. Re-seed MECCANICO per test so each scenario has a stable
    // type to FK against. intervention_checklist_items FKs to
    // intervention_types (onDelete: Cascade) so it is wiped the same way —
    // re-seed the default pair of checklist items too (BR-300 requires
    // >=1 selection on every create in this file).
    const tagliando = await ensureSystemInterventionType('MECCANICO');
    taglianodoTypeId = tagliando.id;
    const itemA = await seedChecklistItem({
      interventionTypeId: taglianodoTypeId,
      nameIt: 'Sostituzione olio motore',
      sortOrder: 1,
    });
    const itemB = await seedChecklistItem({
      interventionTypeId: taglianodoTypeId,
      nameIt: 'Controllo filtri',
      sortOrder: 0,
    });
    itemAId = itemA.id;
    itemBId = itemB.id;
  });

  it('creates intervention + customer_tenant_relation + access_log atomically (happy path)', async () => {
    const { tenantId } = await createTenantWithLocation('int-happy');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId, cognitoSub });
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
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
        checklistItems: { label: string }[];
        title?: string;
      };
      deadline: { id: string } | null;
    };
    expect(json.intervention.vehicleId).toBe(vehicleId);
    expect(json.intervention.odometerKm).toBe(45000);
    expect(json.intervention.kmAnomaly).toBe(false);
    expect(json.intervention.status).toBe('active');
    expect(json.intervention.interventionType.code).toBe('MECCANICO');
    expect(json.deadline).toBeNull();
    // BR-300/303: 2 selections, ordered by sortOrderSnapshot asc
    // (itemB has sortOrder 0, itemA has sortOrder 1) — this is the
    // catalog's own name, snapshotted at create time.
    expect(json.intervention.checklistItems).toEqual([
      { label: 'Controllo filtri' },
      { label: 'Sostituzione olio motore' },
    ]);
    // Task 3 removes `title` from the response entirely.
    expect(json.intervention.title).toBeUndefined();

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
      user_id: string;
    }>(
      `SELECT tenant_id, user_id FROM interventions
        WHERE id = $1`,
      [json.intervention.id],
    );
    expect(interventionRows[0]).toMatchObject({
      tenant_id: tenantId,
    });

    // BR-300/303: 2 rows in intervention_checklist_selections, snapshot
    // fields sourced from the catalog + scoped to this tenant.
    const { rows: selectionRows } = await pgAdmin.query<{
      label_snapshot: string;
      tenant_id: string;
      checklist_item_id: string;
    }>(
      `SELECT label_snapshot, tenant_id, checklist_item_id
         FROM intervention_checklist_selections
        WHERE intervention_id = $1
        ORDER BY sort_order_snapshot ASC`,
      [json.intervention.id],
    );
    expect(selectionRows).toHaveLength(2);
    expect(selectionRows.map((r) => r.label_snapshot)).toEqual([
      'Controllo filtri',
      'Sostituzione olio motore',
    ]);
    expect(selectionRows.every((r) => r.tenant_id === tenantId)).toBe(true);
  });

  it('returns 409 odometer_decrease_warning without force, then 201 with kmAnomaly=true on retry (BR-068)', async () => {
    const { tenantId } = await createTenantWithLocation('int-km');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    // Pre-existing intervention at 50000 km (DB-side INSERT, bypasses route).
    await pgAdmin.query(
      `INSERT INTO interventions
         (id, tenant_id, user_id, vehicle_id, intervention_type_id,
          intervention_date, odometer_km, description, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4,
         '2026-03-01'::date, 50000, 'Previous intervention at 50000',
         'active'::"InterventionStatus", NOW(), NOW())`,
      [tenantId, userId, vehicleId, taglianodoTypeId],
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId], { odometerKm: 42000 }),
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId], {
        odometerKm: 42000,
        forceKmDecrease: true,
      }),
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
    const { tenantId } = await createTenantWithLocation('int-no-vehicle');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
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
      payload: buildBody(taglianodoTypeId, []),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the intervention type does not exist', async () => {
    const { tenantId } = await createTenantWithLocation('int-no-type');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
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
      payload: buildBody(ghostTypeId, []),
    });
    expect(res.statusCode).toBe(404);
  });

  it('auto-creates a Deadline with type defaults when createDeadline.enabled=true (BR-080)', async () => {
    const { tenantId } = await createTenantWithLocation('int-deadline');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId], {
        createDeadline: { enabled: true },
      }),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      intervention: { id: string };
      deadline: { id: string; dueOdometerKm: number; status: string } | null;
    };
    expect(json.deadline).not.toBeNull();
    // MECCANICO defaults: 12 months / 15000 km. 45000 + 15000 = 60000.
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

  it('BR-083: a high-km private intervention does NOT block a lower-km officina create', async () => {
    // Setup: vehicle V has 1 officina intervention at 10_000 km AND 1
    // customer-side private intervention at 50_000 km. The customer's
    // self-declared 50k must NOT bind the workshop's future km per BR-083.
    const { tenantId } = await createTenantWithLocation('br083-noblock');
    const cognitoSub = '11111111-1111-4111-8111-111111111083';
    await createUser({ tenantId, cognitoSub });
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId], {
        odometerKm: 10_000,
        interventionDate: '2026-01-01',
      }),
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
      payload: buildBody(taglianodoTypeId, [itemAId, itemBId], {
        odometerKm: 15_000,
        interventionDate: '2026-03-01',
      }),
    });
    expect(res.statusCode).toBe(201);
  });

  describe('BR-157 — creation notification dispatch', () => {
    async function setupCreationScenario(
      opts: { customerPrefs?: object; withOwnership?: boolean } = {},
    ): Promise<{ token: string; vehicleId: string; plate: string }> {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${Math.random().toString(36).slice(2, 10)}`;
      await createUser({ tenantId, cognitoSub });
      const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantId });

      if (opts.withOwnership !== false) {
        const { customerId } = await createCustomer({
          email: 'owner@test.it',
          firstName: 'Mario',
          notificationPreferences: opts.customerPrefs ?? {},
        });
        await createOwnership({ vehicleId, customerId });
      }

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      return { token, vehicleId, plate };
    }

    it('BR-157 — sends creation email to current owner with vehicle and type details', async () => {
      const { token, vehicleId, plate } = await setupCreationScenario();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
      });

      expect(res.statusCode).toBe(201);
      const calls = sesMock.commandCalls(SendEmailCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input as {
        Destination?: { ToAddresses?: string[] };
        Content?: { Simple?: { Subject?: { Data?: string }; Body?: { Html?: { Data?: string } } } };
      };
      expect(input.Destination?.ToAddresses).toEqual(['owner@test.it']);
      expect(input.Content?.Simple?.Subject?.Data).toMatch(/nuovo intervento/i);
      // Proves route→event threading of vehicle and intervention-type fields.
      // BR-308: the intervention no longer has a title, so the email heading
      // is the intervention type name (`interventionType.nameIt`), not a
      // free-text title — assert on the MECCANICO system type name.
      const html = input.Content?.Simple?.Body?.Html?.Data ?? '';
      expect(html).toContain(plate);
      expect(html).toContain('Intervento Meccanico');
    });

    it('BR-157/BR-226 — intervention_updates off blocks email but create succeeds', async () => {
      const { token, vehicleId } = await setupCreationScenario({
        customerPrefs: { email: { intervention_updates: false } },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
      });

      expect(res.statusCode).toBe(201);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('BR-157 — no active owner: create succeeds, SES not invoked', async () => {
      const { token, vehicleId } = await setupCreationScenario({ withOwnership: false });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
      });

      expect(res.statusCode).toBe(201);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('BR-157 — SES throws: create still 201 and the row is committed (best-effort post-commit)', async () => {
      sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
      const { token, vehicleId } = await setupCreationScenario();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
      });

      expect(res.statusCode).toBe(201);
      const { intervention } = res.json() as { intervention: { id: string } };
      const { rows } = await pgAdmin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM interventions WHERE id = $1`,
        [intervention.id],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  describe('BR-300..303 — checklist selection validation', () => {
    async function setupTenantAndVehicle(
      suffix: string,
    ): Promise<{ tenantId: string; vehicleId: string; token: string }> {
      const { tenantId } = await createTenantWithLocation(suffix);
      const cognitoSub = randomUUID();
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });
      return { tenantId, vehicleId, token };
    }

    it('BR-300: returns 400 checklist_required for an empty checklistItemIds, no intervention created', async () => {
      const { vehicleId, token } = await setupTenantAndVehicle('br300-empty');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, []),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_required' });
      const { rows } = await pgAdmin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM interventions WHERE vehicle_id = $1`,
        [vehicleId],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('BR-301: returns 422 checklist_item_invalid for an item belonging to a different type', async () => {
      const { vehicleId, token } = await setupTenantAndVehicle('br301-wrongtype');
      const otherType = await seedGlobalType();
      const foreignItem = await seedChecklistItem({ interventionTypeId: otherType.id });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        // taglianodoTypeId is the chosen type, but the checklist item id
        // belongs to `otherType` — BR-301 (ownership) must reject it.
        payload: buildBody(taglianodoTypeId, [foreignItem.id]),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
      const { rows } = await pgAdmin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM interventions WHERE vehicle_id = $1`,
        [vehicleId],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('BR-302: returns 422 checklist_item_invalid for an inactive item', async () => {
      const { vehicleId, token } = await setupTenantAndVehicle('br302-inactive');
      const inactiveItem = await seedChecklistItem({
        interventionTypeId: taglianodoTypeId,
        active: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [inactiveItem.id]),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    });

    it('BR-302: returns 422 checklist_item_invalid for an item excluded for this tenant', async () => {
      const { tenantId, vehicleId, token } = await setupTenantAndVehicle('br302-excluded');
      await seedItemExclusion(tenantId, itemAId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId]),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    });

    it('returns 422 checklist_item_invalid when the intervention type itself is excluded for this tenant', async () => {
      const { tenantId, vehicleId, token } = await setupTenantAndVehicle('br-type-excluded');
      await seedTypeExclusion(tenantId, taglianodoTypeId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemBId]),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    });

    it('BR-303: a checklist item rename after creation does not change the persisted label_snapshot', async () => {
      const { vehicleId, token } = await setupTenantAndVehicle('br303-snapshot');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId]),
      });
      expect(res.statusCode).toBe(201);
      const { intervention } = res.json() as { intervention: { id: string } };

      // Rename the catalog item AFTER the intervention was created.
      await pgAdmin.query(`UPDATE intervention_checklist_items SET name_it = $1 WHERE id = $2`, [
        'Nome completamente diverso',
        itemAId,
      ]);

      const { rows } = await pgAdmin.query<{ label_snapshot: string }>(
        `SELECT label_snapshot FROM intervention_checklist_selections WHERE intervention_id = $1`,
        [intervention.id],
      );
      expect(rows).toHaveLength(1);
      // Snapshot must still read the ORIGINAL name, proving it is frozen
      // at save time and not re-derived from the current catalog row.
      expect(rows[0]!.label_snapshot).toBe('Sostituzione olio motore');
      expect(rows[0]!.label_snapshot).not.toBe('Nome completamente diverso');
    });

    it('dedups a repeated checklistItemId into a single selection row (unique constraint not violated)', async () => {
      const { vehicleId, token } = await setupTenantAndVehicle('br300-dedup');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/vehicles/${vehicleId}/interventions`,
        headers: { authorization: `Bearer ${token}` },
        payload: buildBody(taglianodoTypeId, [itemAId, itemAId]),
      });

      expect(res.statusCode).toBe(201);
      const { intervention } = res.json() as {
        intervention: { id: string; checklistItems: { label: string }[] };
      };
      expect(intervention.checklistItems).toEqual([{ label: 'Sostituzione olio motore' }]);

      const { rows } = await pgAdmin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM intervention_checklist_selections
          WHERE intervention_id = $1`,
        [intervention.id],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });
});

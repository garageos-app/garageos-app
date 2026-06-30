import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createDispute,
  createIntervention,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

async function seed(suffix: string, interventionStatus?: 'active' | 'disputed' | 'cancelled') {
  const { tenantId } = await createTenantWithLocation(suffix);
  const { userId } = await createUser({ tenantId, cognitoSub: `mech-${suffix}` });
  const { customerId } = await createCustomer({ cognitoSub: `cust-${suffix}` });
  const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
  await createOwnership({ vehicleId, customerId });
  const tagliando = await ensureSystemInterventionType('TAGLIANDO');
  const { interventionId } = await createIntervention({
    tenantId,
    userId,
    vehicleId,
    interventionTypeId: tagliando.id,
    interventionDate: '2026-04-21',
    odometerKm: 45000,
    description: 'Tagliando con sostituzione olio',
    // BR-127: a disputed intervention carries status='disputed'; the route
    // derives isDisputed from it. Seed the precondition directly.
    ...(interventionStatus ? { status: interventionStatus } : {}),
  });
  return {
    tenantId,
    customerId,
    vehicleId,
    interventionId,
    cognitoSub: `cust-${suffix}`,
  };
}

// Insert a shop deadline linked to an intervention as its source (BR-067).
async function createSourceDeadline(params: {
  tenantId: string;
  vehicleId: string;
  interventionTypeId: string;
  sourceInterventionId: string;
  dueDate?: string | null;
  dueOdometerKm?: number | null;
  description?: string | null;
  status?: 'open' | 'overdue' | 'completed' | 'cancelled';
}): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    vehicleId,
    interventionTypeId,
    sourceInterventionId,
    dueDate = null,
    dueOdometerKm = null,
    description = null,
    status = 'open',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines
       (id, tenant_id, vehicle_id, intervention_type_id,
        source_intervention_id, due_date, due_odometer_km, description,
        is_recurring, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::date, $6, $7, false,
        $8::"DeadlineStatus", NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      vehicleId,
      interventionTypeId,
      sourceInterventionId,
      dueDate,
      dueOdometerKm,
      description,
      status,
    ],
  );
  return { deadlineId: rows[0]!.id };
}

describe('GET /v1/me/interventions/:id (integration)', () => {
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

  it('returns the intervention and an empty dispute thread for the owner', async () => {
    const s = await seed('me-int-happy');
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { id: string; interventionDate: string; status: string; isDisputed: boolean };
      disputes: unknown[];
    };
    expect(body.intervention.id).toBe(s.interventionId);
    expect(body.intervention.interventionDate).toBe('2026-04-21');
    expect(body.intervention.isDisputed).toBe(false);
    expect(body.disputes).toEqual([]);
  });

  it('includes the tenant response once the officina has replied', async () => {
    const s = await seed('me-int-resp', 'disputed');
    await createDispute({
      interventionId: s.interventionId,
      customerId: s.customerId,
      reasonCategory: 'wrong_data',
      customerDescription: 'I km sono errati e voglio una verifica',
      status: 'responded',
      tenantResponse: 'Abbiamo ricontrollato il tagliando',
      tenantResponseAt: new Date(),
    });
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { isDisputed: boolean };
      disputes: Array<{ status: string; tenantResponse: string | null }>;
    };
    expect(body.intervention.isDisputed).toBe(true);
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]).toMatchObject({
      status: 'responded',
      tenantResponse: 'Abbiamo ricontrollato il tagliando',
    });
  });

  it('returns the parts list and the generated deadline, excluding cancelled ones', async () => {
    const s = await seed('me-int-parts');
    const revisione = await ensureSystemInterventionType('REVISIONE');
    await createSourceDeadline({
      tenantId: s.tenantId,

      vehicleId: s.vehicleId,
      interventionTypeId: revisione.id,
      sourceInterventionId: s.interventionId,
      dueDate: '2027-05-15',
      dueOdometerKm: 120000,
      description: 'Prossima revisione',
      status: 'open',
    });
    // A cancelled deadline from the same intervention must NOT surface.
    await createSourceDeadline({
      tenantId: s.tenantId,

      vehicleId: s.vehicleId,
      interventionTypeId: revisione.id,
      sourceInterventionId: s.interventionId,
      dueDate: '2027-06-01',
      status: 'cancelled',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: {
        partsReplaced: Array<{ name: string; quantity: number }>;
        partsReplacedCount: number;
        generatedDeadlines: Array<{
          type: { code: string };
          dueDate: string | null;
          dueOdometerKm: number | null;
          status: string;
        }>;
      };
    };
    // createIntervention seeds 2 default parts (Olio, Filtro).
    expect(body.intervention.partsReplacedCount).toBe(2);
    expect(body.intervention.partsReplaced.map((p) => p.name)).toEqual(['Olio', 'Filtro']);
    expect(body.intervention.generatedDeadlines).toHaveLength(1);
    expect(body.intervention.generatedDeadlines[0]).toMatchObject({
      type: { code: 'REVISIONE' },
      dueDate: '2027-05-15',
      dueOdometerKm: 120000,
      status: 'open',
    });
  });

  it('returns 404 for a customer who does not own the vehicle (RLS + app gate)', async () => {
    const s = await seed('me-int-iso');
    const { customerId: otherCustomerId } = await createCustomer({
      cognitoSub: 'cust-me-int-other',
    });
    const token = await signTestToken({
      pool: 'clienti',
      sub: 'cust-me-int-other',
      customerId: otherCustomerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
  });

  it('rejects an officine-pool token (wrong pool)', async () => {
    const s = await seed('me-int-pool');
    const token = await signTestToken({ pool: 'officine', tenantId: s.tenantId, role: 'mechanic' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

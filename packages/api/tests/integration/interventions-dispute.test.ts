import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
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

// POST /v1/interventions/:id/dispute end-to-end.
//   - Happy path (201) inserts dispute row + flips intervention.status
//   - BR-120 (only current owner)         → 403 not_owner
//   - BR-122 (one active dispute)         → 409 already_exists
//   - BR-130 implication (cancelled)      → 422 intervention_cancelled
//   - Pool guard (officine token)         → 403
//   - Idempotent re-dispute after closed dispute (resolved_by_cancellation)

async function seedScenario(suffix: string): Promise<{
  tenantId: string;
  userId: string;
  vehicleId: string;
  customerId: string;
  cognitoSub: string;
  interventionId: string;
  interventionTypeId: string;
}> {
  const { tenantId } = await createTenantWithLocation(suffix);
  const userCognitoSub = `mech-${suffix}`;
  const { userId } = await createUser({ tenantId, cognitoSub: userCognitoSub });
  const cognitoSub = `cust-${suffix}`;
  const { customerId } = await createCustomer({ cognitoSub });
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
  });
  return {
    tenantId,
    userId,
    vehicleId,
    customerId,
    cognitoSub,
    interventionId,
    interventionTypeId: tagliando.id,
  };
}

const goodDescription =
  'Ho portato il veicolo per il cambio olio ma non ho mai richiesto la sostituzione del filtro aria.';

describe('POST /v1/interventions/:id/dispute (integration)', () => {
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

  it('happy path: creates dispute row and flips intervention.status to disputed (BR-127)', async () => {
    const s = await seedScenario('disp-happy');
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        reasonCategory: 'not_performed',
        description: goodDescription,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      dispute: { id: string; interventionId: string; customerId: string; status: string };
      interventionStatus: string;
    };
    expect(body.dispute.interventionId).toBe(s.interventionId);
    expect(body.dispute.customerId).toBe(s.customerId);
    expect(body.dispute.status).toBe('open');
    expect(body.interventionStatus).toBe('disputed');

    const { rows: disputeRows } = await pgAdmin.query<{
      reason_category: string;
      customer_description: string;
      status: string;
    }>(
      `SELECT reason_category, customer_description, status FROM intervention_disputes
        WHERE id = $1`,
      [body.dispute.id],
    );
    expect(disputeRows[0]).toMatchObject({
      reason_category: 'not_performed',
      customer_description: goodDescription,
      status: 'open',
    });

    const { rows: intRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM interventions WHERE id = $1`,
      [s.interventionId],
    );
    expect(intRows[0]!.status).toBe('disputed');
  });

  it('returns 403 not_owner when the customer no longer owns the vehicle (BR-120)', async () => {
    const s = await seedScenario('disp-notowner');
    // End the active ownership: customer is now a past owner.
    await pgAdmin.query(`UPDATE vehicle_ownerships SET ended_at = NOW() WHERE vehicle_id = $1`, [
      s.vehicleId,
    ]);
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'not_performed', description: goodDescription },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'intervention.dispute.not_owner' });

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM intervention_disputes WHERE intervention_id = $1`,
      [s.interventionId],
    );
    expect(Number(rows[0]!.count)).toBe(0);

    const { rows: intRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM interventions WHERE id = $1`,
      [s.interventionId],
    );
    expect(intRows[0]!.status).toBe('active');
  });

  it('returns 409 already_exists for a second open dispute by the same customer (BR-122)', async () => {
    const s = await seedScenario('disp-dup');
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    // First dispute via API.
    const first = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'wrong_data', description: goodDescription },
    });
    expect(first.statusCode).toBe(201);

    // Second attempt → 409.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'not_authorized', description: goodDescription },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'intervention.dispute.already_exists' });
  });

  it('allows a NEW dispute after the previous one was closed (BR-122 closed states do not block)', async () => {
    const s = await seedScenario('disp-reopen');
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    // Seed a closed dispute via pgAdmin (bypasses RLS) — represents a
    // historical contestation already resolved.
    await pgAdmin.query(
      `INSERT INTO intervention_disputes
         (id, intervention_id, customer_id, reason_category, customer_description,
          status, created_at, updated_at, resolved_at)
       VALUES (gen_random_uuid(), $1, $2,
          'wrong_data'::"DisputeReasonCategory", $3,
          'closed_by_admin'::"DisputeStatus", NOW() - INTERVAL '30 days',
          NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')`,
      [s.interventionId, s.customerId, 'Una vecchia contestazione già chiusa, lunga abbastanza.'],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'other', description: goodDescription },
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM intervention_disputes WHERE intervention_id = $1`,
      [s.interventionId],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('returns 422 intervention_cancelled when the intervention has been cancelled (BR-130)', async () => {
    const s = await seedScenario('disp-cancelled');
    await pgAdmin.query(
      `UPDATE interventions SET status = 'cancelled'::"InterventionStatus" WHERE id = $1`,
      [s.interventionId],
    );
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'not_performed', description: goodDescription },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.dispute.intervention_cancelled' });
  });

  it('returns 404 when the intervention id does not exist', async () => {
    const s = await seedScenario('disp-ghost');
    const token = await signTestToken({
      pool: 'clienti',
      sub: s.cognitoSub,
      customerId: s.customerId,
    });
    const ghostId = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${ghostId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'not_performed', description: goodDescription },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for an officine-pool token', async () => {
    const s = await seedScenario('disp-pool');
    const token = await signTestToken({
      pool: 'officine',
      sub: `mech-${Math.random().toString(36).slice(2, 10)}`,
      tenantId: s.tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${s.interventionId}/dispute`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reasonCategory: 'not_performed', description: goodDescription },
    });
    expect(res.statusCode).toBe(403);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM intervention_disputes WHERE intervention_id = $1`,
      [s.interventionId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

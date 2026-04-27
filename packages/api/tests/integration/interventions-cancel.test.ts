import { randomUUID } from 'node:crypto';

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

const VALID_REASON =
  'Annullamento per errore di trascrizione VIN — la riga è stata reinserita correttamente in seguito.';

describe('POST /v1/interventions/:id/cancel (F-OFF-307)', () => {
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

  it('200 happy path: super_admin cancels an active intervention with no disputes', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      description: 'Tagliando con sostituzione olio',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: {
        id: string;
        status: string;
        cancelledReason: string;
        cancelledByUserId: string;
        cancelledAt: string;
      };
      resolvedDisputes: Array<{ id: string; status: string; resolvedAt: string }>;
    };
    expect(body.intervention.id).toBe(interventionId);
    expect(body.intervention.status).toBe('cancelled');
    expect(body.intervention.cancelledReason).toBe(VALID_REASON);
    expect(body.intervention.cancelledByUserId).toBe(userId);
    expect(body.intervention.cancelledAt).toBeTruthy();
    expect(body.resolvedDisputes).toEqual([]);

    const { rows } = await pgAdmin.query<{
      status: string;
      cancelled_reason: string;
      cancelled_by_user_id: string;
      cancelled_at: string | null;
    }>(
      `SELECT status, cancelled_reason, cancelled_by_user_id, cancelled_at
         FROM interventions WHERE id = $1`,
      [interventionId],
    );
    expect(rows[0]).toMatchObject({
      status: 'cancelled',
      cancelled_reason: VALID_REASON,
      cancelled_by_user_id: userId,
    });
    expect(rows[0]!.cancelled_at).not.toBeNull();
  });

  it('403 permission_denied: mechanic role cannot cancel', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'mechanic',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.permission_denied');

    // Intervention untouched
    const { rows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(rows[0]!.status).toBe('active');
  });

  it('400 reason_too_short: rejects 19-char reason', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'a'.repeat(19) },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.reason_too_short');
  });

  it('409 already_cancelled: re-cancel returns conflict', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'cancelled',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.already_cancelled');
  });

  it('404 unknown intervention id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${randomUUID()}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(404);
  });

  it('404 cross-tenant: super_admin from another tenant cannot cancel (RLS-as-404)', async () => {
    // Tenant A owns the intervention.
    const a = await createTenantWithLocation('rls-a');
    const aSub = `office-a-${randomUUID().slice(0, 8)}`;
    const { userId: aUserId } = await createUser({
      tenantId: a.tenantId,
      cognitoSub: aSub,
      role: 'super_admin',
      locationId: a.locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: a.tenantId,
      locationId: a.locationId,
      userId: aUserId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    // Tenant B super_admin attempts the cancel.
    const b = await createTenantWithLocation('rls-b');
    const bSub = `office-b-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: b.tenantId,
      cognitoSub: bSub,
      role: 'super_admin',
      locationId: b.locationId,
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: bSub,
      tenantId: b.tenantId,
      role: 'super_admin',
      locationId: b.locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(404);

    // Sanity: tenant A's row untouched
    const { rows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(rows[0]!.status).toBe('active');
  });

  it('200 BR-130: cancel of a disputed intervention flips a single open dispute to resolved_by_cancellation', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId } = await createDispute({
      interventionId,
      customerId,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { status: string; cancelledAt: string };
      resolvedDisputes: Array<{ id: string; status: string; resolvedAt: string }>;
    };
    expect(body.intervention.status).toBe('cancelled');
    expect(body.resolvedDisputes).toHaveLength(1);
    expect(body.resolvedDisputes[0]!.id).toBe(disputeId);
    expect(body.resolvedDisputes[0]!.status).toBe('resolved_by_cancellation');
    // BR-130: cancelledAt and resolvedAt share the same TX timestamp
    expect(body.resolvedDisputes[0]!.resolvedAt).toBe(body.intervention.cancelledAt);

    const { rows } = await pgAdmin.query<{ status: string; resolved_at: string }>(
      'SELECT status, resolved_at FROM intervention_disputes WHERE id = $1',
      [disputeId],
    );
    expect(rows[0]!.status).toBe('resolved_by_cancellation');
    expect(rows[0]!.resolved_at).not.toBeNull();
  });

  it('200 BR-130: flips multiple active disputes (open + responded), leaves already-resolved untouched', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId: c1 } = await createCustomer({});
    const { customerId: c2 } = await createCustomer({});
    const { customerId: c3 } = await createCustomer({});
    await createOwnership({ vehicleId, customerId: c1 });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId: d1 } = await createDispute({
      interventionId,
      customerId: c1,
      status: 'open',
    });
    const { disputeId: d2 } = await createDispute({
      interventionId,
      customerId: c2,
      status: 'responded',
    });
    const priorResolvedAt = new Date('2026-03-01T10:00:00.000Z');
    const { disputeId: d3 } = await createDispute({
      interventionId,
      customerId: c3,
      status: 'resolved_by_cancellation',
      resolvedAt: priorResolvedAt,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolvedDisputes: Array<{ id: string; status: string; resolvedAt: string }>;
    };
    const resolvedIds = body.resolvedDisputes.map((d) => d.id).sort();
    expect(resolvedIds).toEqual([d1, d2].sort());

    // d3 (already resolved) preserved with its original resolvedAt
    const { rows } = await pgAdmin.query<{ status: string; resolved_at: string }>(
      'SELECT status, resolved_at FROM intervention_disputes WHERE id = $1',
      [d3],
    );
    expect(rows[0]!.status).toBe('resolved_by_cancellation');
    expect(new Date(rows[0]!.resolved_at).toISOString()).toBe(priorResolvedAt.toISOString());
  });

  it('200 BR-130: cancel scoped to interventionId — unrelated intervention disputes untouched', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId: targetId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });
    const { interventionId: noiseId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-22',
      odometerKm: 49500,
      status: 'disputed',
    });
    await createDispute({ interventionId: noiseId, customerId, status: 'open' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${targetId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolvedDisputes: Array<{ id: string }>;
    };
    expect(body.resolvedDisputes).toEqual([]);

    // The unrelated intervention's dispute is untouched.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM intervention_disputes WHERE intervention_id = $1`,
      [noiseId],
    );
    expect(rows[0]!.status).toBe('open');
  });

  it('BR-154 access_log: writes a row with action=cancel on success', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM access_logs
        WHERE vehicle_id = $1 AND action = 'cancel'`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userId);
  });

  it('BR-154 dedup: a view within 30 min after cancel does not duplicate the cancel row', async () => {
    // The 30-min dedup helper finds the latest log for (vehicle, user)
    // and skips inserts when one exists. Cancel writes action=cancel;
    // a subsequent GET /vehicles/:id by the same user should NOT add a
    // 'view' row because dedup is keyed on (vehicleId, userId), not on
    // (vehicleId, userId, action).
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON },
    });
    expect(cancelRes.statusCode).toBe(200);

    const viewRes = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viewRes.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{ action: string }>(
      `SELECT action FROM access_logs WHERE vehicle_id = $1 AND user_id = $2`,
      [vehicleId, userId],
    );
    // Only the cancel row should be present (view skipped by dedup).
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['cancel']);
  });

  it('401 unauthenticated: missing Bearer is rejected', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const { userId } = await createUser({
      tenantId,
      cognitoSub: `office-${randomUUID().slice(0, 8)}`,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 clienti-pool token is rejected by requireOfficinaPool', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    const { customerId } = await createCustomer({
      cognitoSub: `cust-${randomUUID().slice(0, 8)}`,
    });
    const clientToken = await signTestToken({
      pool: 'clienti',
      sub: `cust-${randomUUID().slice(0, 8)}`,
      customerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${clientToken}` },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 validation.error: missing reason field', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 validation.error: extra field rejected by .strict()', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: VALID_REASON, cancelledByUserId: userId },
    });
    expect(res.statusCode).toBe(400);
  });
});

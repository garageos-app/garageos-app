import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createIntervention,
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
});

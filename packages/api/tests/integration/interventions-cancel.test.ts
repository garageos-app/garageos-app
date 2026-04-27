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
});

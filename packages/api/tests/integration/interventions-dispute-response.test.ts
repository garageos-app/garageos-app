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

const VALID_RESPONSE =
  "L'intervento è stato eseguito come da preventivo firmato il 2026-04-20; foglio di lavoro disponibile.";

describe('POST /v1/interventions/:id/dispute-response (F-OFF-602)', () => {
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

  it('200 happy path single dispute: persists tenant_response, flips intervention.status to active, writes access_log row', async () => {
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
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{
        id: string;
        status: string;
        tenantResponse: string;
        tenantResponseUserId: string;
      }>;
      interventionStatus: string;
    };
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]!.id).toBe(disputeId);
    expect(body.disputes[0]!.status).toBe('responded');
    expect(body.disputes[0]!.tenantResponse).toBe(VALID_RESPONSE);
    expect(body.disputes[0]!.tenantResponseUserId).toBe(userId);
    expect(body.interventionStatus).toBe('active');

    // DB persistence
    const { rows: disputeRows } = await pgAdmin.query<{
      status: string;
      tenant_response: string;
      tenant_response_at: string | null;
      tenant_response_user_id: string;
    }>(
      `SELECT status, tenant_response, tenant_response_at, tenant_response_user_id
         FROM intervention_disputes WHERE id = $1`,
      [disputeId],
    );
    expect(disputeRows[0]).toMatchObject({
      status: 'responded',
      tenant_response: VALID_RESPONSE,
      tenant_response_user_id: userId,
    });
    expect(disputeRows[0]!.tenant_response_at).not.toBeNull();

    const { rows: interventionRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(interventionRows[0]!.status).toBe('active');

    // BR-154 audit
    const { rows: logRows } = await pgAdmin.query<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM access_logs
        WHERE vehicle_id = $1 AND action = 'respond'`,
      [vehicleId],
    );
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.user_id).toBe(userId);
  });

  it('200 multi-dispute fanout: 2 customers, both flipped to responded, intervention active', async () => {
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
    const { customerId: c1 } = await createCustomer({});
    const { customerId: c2 } = await createCustomer({});
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
      status: 'open',
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
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{ id: string; status: string }>;
      interventionStatus: string;
    };
    expect(body.disputes.map((d) => d.id).sort()).toEqual([d1, d2].sort());
    expect(body.disputes.every((d) => d.status === 'responded')).toBe(true);
    expect(body.interventionStatus).toBe('active');

    const { rows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM intervention_disputes WHERE intervention_id = $1 ORDER BY id',
      [interventionId],
    );
    expect(rows.map((r) => r.status)).toEqual(['responded', 'responded']);
  });

  it('200 residual open dispute (third customer) keeps intervention disputed', async () => {
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
    const { disputeId: target } = await createDispute({
      interventionId,
      customerId: c1,
      status: 'open',
    });
    const { disputeId: residual } = await createDispute({
      interventionId,
      customerId: c2,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // Target only the first dispute via disputeId
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: target },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionStatus: string };
    expect(body.interventionStatus).toBe('disputed');

    const { rows: residualRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM intervention_disputes WHERE id = $1',
      [residual],
    );
    expect(residualRows[0]!.status).toBe('open');

    const { rows: interventionRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(interventionRows[0]!.status).toBe('disputed');
  });

  it('access_log dedup: response to a second dispute within 30 min does NOT add another row', async () => {
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
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // First response targets d1
    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: d1 },
    });
    expect(res1.statusCode).toBe(200);

    // Second response targets d2 (within 30 min)
    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: d2 },
    });
    expect(res2.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{ action: string }>(
      `SELECT action FROM access_logs
        WHERE vehicle_id = $1 AND user_id = $2`,
      [vehicleId, userId],
    );
    // The 30-min dedup key is (vehicleId, userId) — only 1 row total.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('respond');
  });
});

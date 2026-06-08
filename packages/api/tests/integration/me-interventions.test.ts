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
import { signTestToken } from '../helpers/jwt.js';

async function seed(suffix: string) {
  const { tenantId, locationId } = await createTenantWithLocation(suffix);
  const { userId } = await createUser({ tenantId, cognitoSub: `mech-${suffix}`, locationId });
  const { customerId } = await createCustomer({ cognitoSub: `cust-${suffix}` });
  const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
  await createOwnership({ vehicleId, customerId });
  const tagliando = await ensureSystemInterventionType('TAGLIANDO');
  const { interventionId } = await createIntervention({
    tenantId,
    locationId,
    userId,
    vehicleId,
    interventionTypeId: tagliando.id,
    interventionDate: '2026-04-21',
    odometerKm: 45000,
    description: 'Tagliando con sostituzione olio',
  });
  return { tenantId, customerId, vehicleId, interventionId, cognitoSub: `cust-${suffix}` };
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
    const s = await seed('me-int-resp');
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

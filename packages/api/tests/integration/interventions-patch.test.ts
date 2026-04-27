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
import { signTestToken } from '../helpers/jwt.js';

describe('PATCH /v1/interventions/:id (F-OFF-304)', () => {
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

  it('200 wiki window: edits description without creating a revision', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
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
      description: 'Originale',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Aggiornata' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { id: string; description: string };
      revision: unknown;
    };
    expect(body.intervention.id).toBe(interventionId);
    expect(body.intervention.description).toBe('Aggiornata');
    expect(body.revision).toBeNull();
  });

  it('422 intervention.modification.cancelled when status is cancelled', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
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
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Tentativo' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'intervention.modification.cancelled',
      status: 422,
    });
  });

  it('422 intervention.modification.disputed when status is disputed', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
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
      status: 'disputed',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Tentativo' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'intervention.modification.disputed',
      status: 422,
    });
  });
});

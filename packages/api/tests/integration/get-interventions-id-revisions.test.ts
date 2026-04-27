import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createIntervention,
  createRevision,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('GET /v1/interventions/:id/revisions (integration)', () => {
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

  it('404 when intervention id does not exist', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-404');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const bogus = randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${bogus}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('401 when no token is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${randomUUID()}/revisions`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 when id is not a UUID', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-400');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/not-a-uuid/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 officina happy path: 3 revisions with full user shape, descending order', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-off-happy');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      locationId,
      firstName: 'Mario',
      lastName: 'Rossi',
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

    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T10:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
      reason: 'r1',
    });
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T11:00:00Z'),
      changes: { description: { from: 'D1', to: 'D2' } },
      reason: 'r2',
    });
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T12:00:00Z'),
      changes: { title: { from: 'B', to: 'C' } },
      reason: 'r3',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        revised_at: string;
        reason: string | null;
        changes: Record<string, unknown>;
        user: { id: string; first_name: string; last_name: string };
      }>;
      meta: { has_more: boolean };
    };
    expect(body.data).toHaveLength(3);
    expect(body.data[0]!.reason).toBe('r3');
    expect(body.data[1]!.reason).toBe('r2');
    expect(body.data[2]!.reason).toBe('r1');
    expect(body.data[0]!.user).toEqual({
      id: userId,
      first_name: 'Mario',
      last_name: 'Rossi',
    });
    expect(body.meta.has_more).toBe(false);
  });

  it('200 officina cross-tenant: tenant A reads revisions on intervention of tenant B (BR-150)', async () => {
    const { tenantId: tenantA, locationId: locA } = await createTenantWithLocation('rev-off-A');
    const { tenantId: tenantB, locationId: locB } = await createTenantWithLocation('rev-off-B');
    const subA = `office-${randomUUID().slice(0, 8)}`;
    const subB = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId: tenantA, cognitoSub: subA, locationId: locA });
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: subB,
      locationId: locB,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantB });
    const { interventionId } = await createIntervention({
      tenantId: tenantB,
      locationId: locB,
      userId: userB,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });
    await createRevision({
      interventionId,
      userId: userB,
      revisedAt: new Date('2026-04-26T10:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
      reason: 'cross-tenant visible',
    });

    const tokenA = await signTestToken({
      pool: 'officine',
      sub: subA,
      tenantId: tenantA,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ reason: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.reason).toBe('cross-tenant visible');
  });

  it('200 officina with no revisions: empty data array', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-off-empty');
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
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { has_more: boolean } };
    expect(body.data).toEqual([]);
    expect(body.meta.has_more).toBe(false);
  });
});

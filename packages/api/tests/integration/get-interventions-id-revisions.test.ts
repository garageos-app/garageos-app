import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createRevision,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
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

  it('200 cliente owner happy path: tenant shape, no user', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-happy');
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

    const customerCognitoSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: customerCognitoSub });
    await createOwnership({ vehicleId, customerId });

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
      reason: 'visible to customer',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerCognitoSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        reason: string | null;
        changes: Record<string, unknown>;
        tenant?: { business_name: string; location_city: string };
        user?: unknown;
      }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.reason).toBe('visible to customer');
    expect(body.data[0]!.tenant?.business_name).toContain('Test Tenant');
    expect(body.data[0]!.tenant?.location_city).toBe('Milano');
    expect(body.data[0]!.user).toBeUndefined();
  });

  it('403 cliente non-owner: never had any ownership on this vehicle', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-403');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const ownerSub = `cust-${randomUUID().slice(0, 8)}`;
    const intruderSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    const { customerId: intruderId } = await createCustomer({ cognitoSub: intruderSub });
    await createOwnership({ vehicleId, customerId: ownerId });

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
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: intruderSub,
      customerId: intruderId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { type?: string; code?: string };
    expect(body.code ?? body.type).toContain('intervention.revisions.not_owner');
  });

  it('403 cliente past-owner: ownership ended_at is set', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-past');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const pastSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId: pastOwnerId } = await createCustomer({ cognitoSub: pastSub });
    const { ownershipId } = await createOwnership({ vehicleId, customerId: pastOwnerId });
    await pgAdmin.query(`UPDATE vehicle_ownerships SET ended_at = NOW() WHERE id = $1`, [
      ownershipId,
    ]);

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
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: pastSub,
      customerId: pastOwnerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 cliente: revision with mixed changes → internalNotes stripped from response', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-strip');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const custSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: custSub });
    await createOwnership({ vehicleId, customerId });

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
      changes: {
        title: { from: 'Old', to: 'New' },
        internalNotes: { from: 'priv old', to: 'priv new' },
      },
      reason: 'mixed change',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: custSub,
      customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ changes: Record<string, unknown> }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.changes).toEqual({
      title: { from: 'Old', to: 'New' },
    });
    expect('internalNotes' in body.data[0]!.changes).toBe(false);
  });

  it('200 cliente: revision with only internalNotes → row dropped from data', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-drop');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const custSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: custSub });
    await createOwnership({ vehicleId, customerId });

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
      changes: { internalNotes: { from: 'X', to: 'Y' } },
      reason: 'internal-only',
    });
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T11:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
      reason: 'title-only',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: custSub,
      customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ reason: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.reason).toBe('title-only');
  });

  it('200 cliente: shrunk page can be smaller than limit, has_more reflects DB fetch', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cli-shrink');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const custSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: custSub });
    await createOwnership({ vehicleId, customerId });

    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });
    for (let i = 0; i < 5; i++) {
      await createRevision({
        interventionId,
        userId,
        revisedAt: new Date(`2026-04-26T1${i}:00:00Z`),
        changes:
          i % 2 === 0
            ? { internalNotes: { from: `n${i}`, to: `m${i}` } }
            : { title: { from: `t${i}`, to: `T${i}` } },
        reason: `rev-${i}`,
      });
    }

    const token = await signTestToken({
      pool: 'clienti',
      sub: custSub,
      customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions?limit=10`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ reason: string | null }>;
      meta: { has_more: boolean };
    };
    expect(body.data).toHaveLength(2);
    expect(body.meta.has_more).toBe(false);
  });

  it('200 cancelled intervention: revisions still visible (BR-066 audit)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-cancelled');
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
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T10:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
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
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it('200 disputed intervention: revisions still visible', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-disputed');
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
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T10:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
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
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it('200 bogus cursor: returns first page tolerantly', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-bogus-cur');
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
    await createRevision({
      interventionId,
      userId,
      revisedAt: new Date('2026-04-26T10:00:00Z'),
      changes: { title: { from: 'A', to: 'B' } },
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/revisions?cursor=garbage`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it('200 cursor pagination: 8 revisions with limit=3 traverses 3 pages correctly', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-pagi');
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
    for (let i = 0; i < 8; i++) {
      await createRevision({
        interventionId,
        userId,
        revisedAt: new Date(`2026-04-26T1${i}:00:00Z`),
        changes: { title: { from: `t${i}`, to: `T${i}` } },
        reason: `rev-${i}`,
      });
    }

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const collected: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    const limit = 3;

    do {
      const url = cursor
        ? `/v1/interventions/${interventionId}/revisions?limit=${limit}&cursor=${cursor}`
        : `/v1/interventions/${interventionId}/revisions?limit=${limit}`;
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: Array<{ reason: string | null }>;
        meta: { has_more: boolean; cursor?: string };
      };
      collected.push(...body.data.map((d) => d.reason ?? ''));
      cursor = body.meta.cursor;
      pageCount++;
      if (!body.meta.has_more) break;
      if (pageCount > 5) throw new Error('Pagination did not terminate');
    } while (cursor);

    expect(pageCount).toBe(3);
    expect(collected).toEqual([
      'rev-7',
      'rev-6',
      'rev-5',
      'rev-4',
      'rev-3',
      'rev-2',
      'rev-1',
      'rev-0',
    ]);
  });
});

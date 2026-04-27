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

  it('200 post-lock (>48h): creates a revision row with diff and reason', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      description: 'Originale',
      createdAt: fortyNineHoursAgo,
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
      payload: {
        description: 'Aggiornata post-lock',
        reason: 'Correzione errore di trascrizione',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { description: string };
      revision: { id: string; reason: string; changes: Record<string, unknown> } | null;
    };
    expect(body.intervention.description).toBe('Aggiornata post-lock');
    expect(body.revision).not.toBeNull();
    expect(body.revision!.reason).toBe('Correzione errore di trascrizione');
    expect(body.revision!.changes).toEqual({
      description: { from: 'Originale', to: 'Aggiornata post-lock' },
    });
  });

  it('200 post-lock (firstSeenByCustomerAt): creates a revision row', async () => {
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
      firstSeenByCustomerAt: new Date(Date.now() - 60 * 1000),
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
      payload: {
        description: 'Aggiornata',
        reason: 'Correzione richiesta dal cliente',
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { revision: unknown }).revision).not.toBeNull();
  });

  it('200 post-lock — diff includes only changed fields, no-op fields skipped', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      title: 'Tagliando',
      description: 'Originale',
      internalNotes: null,
      createdAt: fortyNineHoursAgo,
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
      payload: {
        title: 'Tagliando',
        description: 'Nuova',
        internalNotes: 'Nota officina',
        reason: 'Correzione + appunto interno',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { revision: { changes: Record<string, unknown> } };
    expect(body.revision.changes).toEqual({
      description: { from: 'Originale', to: 'Nuova' },
      internalNotes: { from: null, to: 'Nota officina' },
    });
  });

  it('400 intervention.modification.revision_reason_required when post-lock without reason', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      createdAt: fortyNineHoursAgo,
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

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'intervention.modification.revision_reason_required',
      status: 400,
    });
  });

  it('200 wiki window: reason is ignored if provided', async () => {
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
      payload: {
        description: 'Aggiornata',
        reason: 'Reason ignored in wiki window',
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { revision: unknown }).revision).toBeNull();
  });

  it('200 post-lock — persists wiki_locked_at when transitioning from wiki to locked', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub, locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      createdAt: fortyNineHoursAgo,
    });

    const before = await pgAdmin.query<{ wiki_locked_at: Date | null }>(
      `SELECT wiki_locked_at FROM interventions WHERE id = $1`,
      [interventionId],
    );
    expect(before.rows[0]!.wiki_locked_at).toBeNull();

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
      payload: { description: 'X', reason: 'Lock discovery test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { intervention: { wikiLockedAt: string | null } };
    expect(body.intervention.wikiLockedAt).not.toBeNull();

    const after = await pgAdmin.query<{ wiki_locked_at: Date | null }>(
      `SELECT wiki_locked_at FROM interventions WHERE id = $1`,
      [interventionId],
    );
    expect(after.rows[0]!.wiki_locked_at).not.toBeNull();
  });
});

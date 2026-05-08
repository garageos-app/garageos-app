import { randomUUID } from 'node:crypto';

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
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

describe('PATCH /v1/interventions/:id (F-OFF-304)', () => {
  let app: FastifyInstance;

  // BR-064 SES dispatch tests share this mock with the wider describe; the
  // pre-existing tests don't trigger SES (pre-lock edits skip the
  // recipient resolution + dispatcher entirely), so the mock is harmless
  // for them. The dedicated IP keeps the rate-limit bucket isolated from
  // other integration suites running concurrently.
  const TEST_IP_BR064 = '10.20.30.42';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const sesMock = mockClient(SESv2Client);

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    sesMock.reset();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
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

  it('404 NOT_FOUND when changing interventionTypeId to a non-existent id', async () => {
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
      payload: { interventionTypeId: randomUUID() },
    });

    expect(res.statusCode).toBe(404);
  });

  it('404 NOT_FOUND for cross-tenant write (RLS-as-404)', async () => {
    const tenantA = await createTenantWithLocation();
    const tenantB = await createTenantWithLocation();
    const cognitoSubA = `office-${randomUUID().slice(0, 8)}`;
    const cognitoSubB = `office-${randomUUID().slice(0, 8)}`;
    const userA = await createUser({
      tenantId: tenantA.tenantId,
      cognitoSub: cognitoSubA,
      locationId: tenantA.locationId,
    });
    await createUser({
      tenantId: tenantB.tenantId,
      cognitoSub: cognitoSubB,
      locationId: tenantB.locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: tenantA.tenantId,
      locationId: tenantA.locationId,
      userId: userA.userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
    });

    // tenantB's JWT trying to PATCH tenantA's intervention.
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSubB,
      tenantId: tenantB.tenantId,
      role: 'mechanic',
      locationId: tenantB.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Tentativo cross-tenant' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('404 NOT_FOUND for non-existent intervention id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'X' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('400 ZodError when body contains an immutable field (BR-061)', async () => {
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
      payload: { description: 'X', odometerKm: 99999 },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('400 ZodError when body is empty', async () => {
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
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('200 internalNotes only, post-lock — revision contains only that field', async () => {
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
      internalNotes: 'Originale',
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
        internalNotes: 'Aggiornata',
        reason: 'Aggiunta nota interna officina',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { revision: { changes: Record<string, unknown> } };
    expect(Object.keys(body.revision.changes)).toEqual(['internalNotes']);
  });

  it('200 wiki window — writes access_logs row action="update" on parent vehicle (BR-154)', async () => {
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

    const logs = await pgAdmin.query<{
      action: string;
      vehicle_id: string;
      tenant_id: string;
      user_id: string;
    }>(`SELECT action, vehicle_id, tenant_id, user_id FROM access_logs WHERE vehicle_id = $1`, [
      vehicleId,
    ]);
    expect(logs.rows.length).toBeGreaterThanOrEqual(1);
    expect(logs.rows.some((r) => r.action === 'update')).toBe(true);
  });

  describe('BR-064 — revision email dispatch', () => {
    async function setupWikiLockedScenario(
      opts: { customerPrefs?: object; withOwnership?: boolean } = {},
    ): Promise<{ token: string; interventionId: string }> {
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

      if (opts.withOwnership !== false) {
        const { customerId } = await createCustomer({
          email: 'owner@test.it',
          firstName: 'Mario',
          notificationPreferences: opts.customerPrefs ?? {},
        });
        await createOwnership({ vehicleId, customerId });
      }

      // Create intervention with createdAt 49h ago — wiki window already
      // closed by age (BR-062). The PATCH writes wiki_locked_at + a
      // revision row in the same transaction.
      const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000);
      const { interventionId } = await createIntervention({
        tenantId,
        locationId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
        description: 'Tagliando con sostituzione olio',
        createdAt: oldDate,
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'super_admin',
        locationId,
      });

      return { token, interventionId };
    }

    it('BR-064 — sends revision email to current owner when intervention_updates pref enabled', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'm1' });
      const { token, interventionId } = await setupWikiLockedScenario({
        customerPrefs: { email: { intervention_updates: true } },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_BR064 },
        payload: {
          description: 'Tagliando con sostituzione olio e filtro aria',
          reason: 'Aggiunta filtro aria sostituito',
        },
      });

      expect(res.statusCode).toBe(200);
      const calls = sesMock.commandCalls(SendEmailCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input as {
        Destination?: { ToAddresses?: string[] };
        Content?: { Simple?: { Subject?: { Data?: string } } };
      };
      expect(input.Destination?.ToAddresses).toEqual(['owner@test.it']);
      expect(input.Content?.Simple?.Subject?.Data).toMatch(/modificat/i);
    });

    it('BR-064 — pref off blocks email but PATCH succeeds', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'm1' });
      const { token, interventionId } = await setupWikiLockedScenario({
        customerPrefs: { email: { intervention_updates: false } },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_BR064 },
        payload: { description: 'modifica', reason: 'motivo abbastanza lungo per BR-064' },
      });

      expect(res.statusCode).toBe(200);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('BR-064 — no active owner: PATCH succeeds, SES not invoked', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'm1' });
      const { token, interventionId } = await setupWikiLockedScenario({ withOwnership: false });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_BR064 },
        payload: { description: 'modifica', reason: 'motivo abbastanza lungo per BR-064' },
      });

      expect(res.statusCode).toBe(200);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    });

    it('BR-064 — SES throws: PATCH still 200 (best-effort post-commit)', async () => {
      sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
      const { token, interventionId } = await setupWikiLockedScenario({
        customerPrefs: { email: { intervention_updates: true } },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP_BR064 },
        payload: { description: 'modifica', reason: 'motivo abbastanza lungo per BR-064' },
      });

      expect(res.statusCode).toBe(200);
      // intervention_revisions row still written despite SES failure
      const body = res.json() as { revision?: { id: string } | null };
      expect(body.revision?.id).toBeDefined();
    });
  });
});

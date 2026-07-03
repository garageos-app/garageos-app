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

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Inserts a GLOBAL intervention type (tenant_id IS NULL) directly via
// pgAdmin. Mirrors interventions-post.test.ts — used for the
// type-change scenarios (Deviation #6) which need a second type with
// its own checklist.
async function seedGlobalType(params: { nameIt?: string } = {}): Promise<{ id: string }> {
  const code = uniqueCode('ITYP');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2, true, NOW(), NOW())
     RETURNING id`,
    [code, params.nameIt ?? `Test type ${code}`],
  );
  return { id: rows[0]!.id };
}

// Direct pgAdmin insert for checklist item fixtures — bypasses RLS
// (fixture setup only). Mirrors interventions-post.test.ts.
async function seedChecklistItem(params: {
  interventionTypeId: string;
  nameIt?: string;
  sortOrder?: number;
  active?: boolean;
}): Promise<{ id: string; nameIt: string }> {
  const {
    interventionTypeId,
    nameIt = `Test item ${uniqueCode('IITM')}`,
    sortOrder = 0,
    active = true,
  } = params;
  const code = uniqueCode('IITM');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_items
       (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id`,
    [interventionTypeId, code, nameIt, sortOrder, active],
  );
  return { id: rows[0]!.id, nameIt };
}

async function seedItemExclusion(tenantId: string, checklistItemId: string): Promise<void> {
  await pgAdmin.query(
    `INSERT INTO tenant_checklist_item_exclusions (tenant_id, checklist_item_id, created_at)
     VALUES ($1, $2, NOW())`,
    [tenantId, checklistItemId],
  );
}

// Direct pgAdmin insert of an intervention_checklist_selections row —
// bypasses the route entirely so PATCH tests can seed a pre-existing
// selection with a controlled label_snapshot (independent of whatever
// the catalog item's CURRENT name_it happens to be). This is exactly
// the "already selected before this PATCH" state BR-303's replace
// algorithm operates against.
async function seedSelection(params: {
  interventionId: string;
  tenantId: string;
  checklistItemId: string;
  labelSnapshot: string;
  sortOrderSnapshot?: number | null;
}): Promise<{ id: string }> {
  const {
    interventionId,
    tenantId,
    checklistItemId,
    labelSnapshot,
    sortOrderSnapshot = 0,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_selections
       (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, sort_order_snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
     RETURNING id`,
    [interventionId, tenantId, checklistItemId, labelSnapshot, sortOrderSnapshot],
  );
  return { id: rows[0]!.id };
}

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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      description: 'Originale',
      internalNotes: null,
      createdAt: fortyNineHoursAgo,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        // interventionTypeId unchanged (same as existing) — the no-op
        // field this test proves gets skipped from the diff. `title` no
        // longer exists on UpdateInterventionSchema (Task 4).
        interventionTypeId: type.id,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
    });
    await createUser({
      tenantId: tenantB.tenantId,
      cognitoSub: cognitoSubB,
    });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: tenantA.tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'X', odometerKm: 99999 },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('400 ZodError when body is empty', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('200 internalNotes only, post-lock — revision contains only that field', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
    const { interventionId } = await createIntervention({
      tenantId,
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
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
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
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({
        tenantId,
        cognitoSub,
        role: 'super_admin',
      });
      const type = await ensureSystemInterventionType('MECCANICO');
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

  describe('BR-303/BR-308/Deviation #6-#7 — checklist replace on edit', () => {
    async function selectionRows(
      interventionId: string,
    ): Promise<{ checklist_item_id: string | null; label_snapshot: string; tenant_id: string }[]> {
      const { rows } = await pgAdmin.query<{
        checklist_item_id: string | null;
        label_snapshot: string;
        tenant_id: string;
      }>(
        `SELECT checklist_item_id, label_snapshot, tenant_id
           FROM intervention_checklist_selections
          WHERE intervention_id = $1
          ORDER BY sort_order_snapshot ASC, label_snapshot ASC`,
        [interventionId],
      );
      return rows;
    }

    // (a) replace happy path + BR-303 snapshot preservation. Retained
    // item B must keep its ORIGINAL label_snapshot even though its
    // catalog row was renamed BEFORE the PATCH — proving the replace
    // algorithm never re-derives a snapshot for a retained selection.
    // New item C gets a snapshot taken from the catalog's current name.
    it('replaces the selection set: retained item keeps its original snapshot, new item gets a fresh one (BR-303)', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const itemA = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce A' });
      const itemB = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce B' });
      const itemC = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce C' });

      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemA.id,
        labelSnapshot: 'Voce A',
        sortOrderSnapshot: 0,
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemB.id,
        labelSnapshot: 'Voce B originale',
        sortOrderSnapshot: 1,
      });

      // Catalog drift BEFORE the PATCH: B is renamed. A retained selection
      // must NOT pick this up.
      await pgAdmin.query(`UPDATE intervention_checklist_items SET name_it = $1 WHERE id = $2`, [
        'Voce B rinominata',
        itemB.id,
      ]);

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { checklistItemIds: [itemB.id, itemC.id] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { intervention: { checklistItems: { label: string }[] } };
      // B (retained) keeps its pre-PATCH snapshot; C (new) gets the
      // catalog's current name.
      expect(body.intervention.checklistItems).toEqual(
        expect.arrayContaining([{ label: 'Voce B originale' }, { label: 'Voce C' }]),
      );
      expect(body.intervention.checklistItems).not.toContainEqual({ label: 'Voce B rinominata' });

      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(2);
      // A was NOT in the desired set → deleted.
      expect(rows.some((r) => r.checklist_item_id === itemA.id)).toBe(false);
      const rowB = rows.find((r) => r.checklist_item_id === itemB.id);
      expect(rowB?.label_snapshot).toBe('Voce B originale');
      const rowC = rows.find((r) => r.checklist_item_id === itemC.id);
      expect(rowC?.label_snapshot).toBe('Voce C');
      expect(rows.every((r) => r.tenant_id === tenantId)).toBe(true);
    });

    // (b) BR-300 on edit: empty checklistItemIds → 400, full rollback
    // (the scalar description change in the same request must also NOT
    // persist — proves the checklist validation failure aborts the
    // whole transaction, not just the selections table).
    it('BR-300: returns 400 checklist_required for an empty checklistItemIds, rolls back the whole PATCH', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const itemA = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce A' });
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
        description: 'Originale',
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemA.id,
        labelSnapshot: 'Voce A',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'Tentativo', checklistItemIds: [] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_required' });

      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.checklist_item_id).toBe(itemA.id);
      const { rows: interventionRows } = await pgAdmin.query<{ description: string }>(
        `SELECT description FROM interventions WHERE id = $1`,
        [interventionId],
      );
      expect(interventionRows[0]!.description).toBe('Originale');
    });

    // (c) BR-301/302 on edit: an item belonging to a different type is
    // rejected with 422, full rollback (mirrors (b)).
    it('BR-301: returns 422 checklist_item_invalid for an item belonging to a different type, rolls back', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const otherType = await seedGlobalType();
      const foreignItem = await seedChecklistItem({ interventionTypeId: otherType.id });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
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
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'Tentativo', checklistItemIds: [foreignItem.id] },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(0);
      const { rows: interventionRows } = await pgAdmin.query<{ description: string }>(
        `SELECT description FROM interventions WHERE id = $1`,
        [interventionId],
      );
      expect(interventionRows[0]!.description).toBe('Originale');
    });

    // (c continued) BR-302: an item excluded for this tenant is rejected.
    it('BR-302: returns 422 checklist_item_invalid for an item excluded for this tenant', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const excludedItem = await seedChecklistItem({ interventionTypeId: type.id });
      await seedItemExclusion(tenantId, excludedItem.id);
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
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
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { checklistItemIds: [excludedItem.id] },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    });

    // (d) type change WITHOUT checklistItemIds → 400 (Deviation #6 guard).
    it('returns 400 checklist_required when changing interventionTypeId without resending checklistItemIds (Deviation #6)', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const otherType = await seedGlobalType();
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
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
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { interventionTypeId: otherType.id },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_required' });
      const { rows } = await pgAdmin.query<{ intervention_type_id: string }>(
        `SELECT intervention_type_id FROM interventions WHERE id = $1`,
        [interventionId],
      );
      expect(rows[0]!.intervention_type_id).toBe(type.id);
    });

    // (e) type change WITH valid checklistItemIds for the new type → 200,
    // selections fully replaced (scoped to the NEW type's catalog).
    it('200: changing interventionTypeId together with valid checklistItemIds replaces the selection set for the new type', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const oldItem = await seedChecklistItem({
        interventionTypeId: type.id,
        nameIt: 'Voce vecchia',
      });
      const otherType = await seedGlobalType();
      const newItem = await seedChecklistItem({
        interventionTypeId: otherType.id,
        nameIt: 'Voce nuovo tipo',
      });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: oldItem.id,
        labelSnapshot: 'Voce vecchia',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { interventionTypeId: otherType.id, checklistItemIds: [newItem.id] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { intervention: { checklistItems: { label: string }[] } };
      expect(body.intervention.checklistItems).toEqual([{ label: 'Voce nuovo tipo' }]);
      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.checklist_item_id).toBe(newItem.id);
    });

    // (f) PATCH without checklistItemIds (only description) → selections
    // intact, untouched.
    it('leaves selections intact when checklistItemIds is absent from the body', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const itemA = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce A' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
        description: 'Originale',
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemA.id,
        labelSnapshot: 'Voce A',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'Aggiornata' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { intervention: { checklistItems: { label: string }[] } };
      expect(body.intervention.checklistItems).toEqual([{ label: 'Voce A' }]);
      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.checklist_item_id).toBe(itemA.id);
    });

    // (g) response shape: no `title`, has `checklistItems`.
    it('response has no title field and includes checklistItems', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const itemA = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce A' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemA.id,
        labelSnapshot: 'Voce A',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: 'Aggiornata' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        intervention: { title?: string; checklistItems: { label: string }[] };
      };
      expect(body.intervention.title).toBeUndefined();
      expect(body.intervention.checklistItems).toEqual([{ label: 'Voce A' }]);
    });

    // (h) post-lock: a checklist-only edit without `reason` is still
    // gated by BR-062/064 — the reason requirement fires before any
    // checklist processing.
    it('400 revision_reason_required for a checklist-only edit post-lock without reason', async () => {
      const { tenantId } = await createTenantWithLocation();
      const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
      const { userId } = await createUser({ tenantId, cognitoSub });
      const type = await ensureSystemInterventionType('MECCANICO');
      const itemA = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce A' });
      const itemB = await seedChecklistItem({ interventionTypeId: type.id, nameIt: 'Voce B' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const fortyNineHoursAgo = new Date(Date.now() - 49 * 3600 * 1000);
      const { interventionId } = await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: type.id,
        interventionDate: '2026-04-25',
        odometerKm: 50000,
        createdAt: fortyNineHoursAgo,
      });
      await seedSelection({
        interventionId,
        tenantId,
        checklistItemId: itemA.id,
        labelSnapshot: 'Voce A',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/interventions/${interventionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { checklistItemIds: [itemB.id] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'intervention.modification.revision_reason_required',
      });
      // Rolled back: still item A, not item B.
      const rows = await selectionRows(interventionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.checklist_item_id).toBe(itemA.id);
    });
  });
});

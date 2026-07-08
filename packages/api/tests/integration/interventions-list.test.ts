import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createChecklistItem,
  createChecklistSelection,
  createIntervention,
  createTenant,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Integration coverage for GET /v1/interventions — "Registro Interventi"
// list endpoint, PR-1 (task 3 of 4). The route itself (task 2) is at
// packages/api/src/routes/v1/interventions-list.ts; the query schema
// (task 1) is interventions-list.schema.ts. This suite validates
// behavior end-to-end against real Postgres: tenant isolation (RLS),
// the default status filter, the checklist AND semantics + its
// exactly-one-typeId guard, every query filter, sort orders (incl. the
// id DESC tiebreaker), pagination, and pool auth.
//
// This route has no `config.rateLimit` (rate-limit plugin registered
// with global: false in server.ts — routes opt in explicitly), so no
// unique-IP-per-describe-block dance is needed here.

describe('GET /v1/interventions (integration)', () => {
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

  // Creates a tenant-user row and signs a matching officine token for it.
  // Returns userId so tests can attribute interventions to the caller
  // (e.g. to assert `operator` composition) or to a different operator
  // (for the operatorId filter test).
  async function officinaCaller(
    tenantId: string,
    cognitoSub: string = randomUUID(),
  ): Promise<{ userId: string; token: string }> {
    const { userId } = await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { userId, token };
  }

  // ── 200 shape + default status ──────────────────────────────────────────
  it('returns the wire-shaped item list and excludes cancelled by default', async () => {
    const { tenantId } = await createTenant('list-shape');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: activeId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      status: 'active',
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 51000,
      status: 'cancelled',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        interventionDate: string;
        odometerKm: number;
        status: string;
        type: { id: string; nameIt: string };
        vehicle: { id: string; plate: string; make: string; model: string };
        operator: { id: string; name: string };
      }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.id).toBe(activeId);
    // Exact YYYY-MM-DD string — no timezone drift from the @db.Date column.
    expect(item.interventionDate).toBe('2026-05-20');
    expect(item.odometerKm).toBe(50000);
    expect(item.status).toBe('active');
    expect(item.type).toEqual({ id: typeId, nameIt: 'Intervento Meccanico' });
    expect(item.vehicle).toEqual({ id: vehicleId, plate, make: 'Fiat', model: 'Panda' });
    // createUser default firstName/lastName is 'Test'/'User'.
    expect(item.operator).toEqual({ id: userId, name: 'Test User' });
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
  });

  // ── cancelled opt-in ─────────────────────────────────────────────────────
  it('status=active,cancelled opts back into cancelled rows', async () => {
    const { tenantId } = await createTenant('list-status-optin');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 50000,
      status: 'active',
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 51000,
      status: 'cancelled',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions?status=active,cancelled',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; items: Array<{ status: string }> };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.status).sort()).toEqual(['active', 'cancelled']);
  });

  // ── Tenant isolation (negative) ─────────────────────────────────────────
  it('never returns another tenant intervention (RLS isolation)', async () => {
    const { tenantId: tA } = await createTenant('list-iso-A');
    const { tenantId: tB } = await createTenant('list-iso-B');
    const { userId: uA, token } = await officinaCaller(tA);
    const { userId: uB } = await createUser({ tenantId: tB, cognitoSub: randomUUID() });
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId: vA } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });

    const { interventionId: iA } = await createIntervention({
      tenantId: tA,
      userId: uA,
      vehicleId: vA,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId: tB,
      userId: uB,
      vehicleId: vB,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 20000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items.map((i) => i.id)).toEqual([iA]);
  });

  // ── Checklist AND semantics ──────────────────────────────────────────────
  it('checklistItemIds filters by AND (has ALL requested items)', async () => {
    const { tenantId } = await createTenant('list-checklist-and');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { checklistItemId: olioId } = await createChecklistItem({
      interventionTypeId: typeId,
      code: 'OLIO',
      nameIt: 'Olio motore',
    });
    const { checklistItemId: filtroId } = await createChecklistItem({
      interventionTypeId: typeId,
      code: 'FILTRO',
      nameIt: 'Filtro olio',
    });

    // X has both olio + filtro; Y has olio only.
    const { interventionId: x } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
      description: 'X - olio+filtro',
    });
    const { interventionId: y } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 11000,
      description: 'Y - olio only',
    });
    await createChecklistSelection({
      interventionId: x,
      tenantId,
      checklistItemId: olioId,
      labelSnapshot: 'Olio motore',
    });
    await createChecklistSelection({
      interventionId: x,
      tenantId,
      checklistItemId: filtroId,
      labelSnapshot: 'Filtro olio',
    });
    await createChecklistSelection({
      interventionId: y,
      tenantId,
      checklistItemId: olioId,
      labelSnapshot: 'Olio motore',
    });

    // Requesting both items → only X (has both), not Y (missing filtro).
    const resBoth = await app.inject({
      method: 'GET',
      url: `/v1/interventions?typeId=${typeId}&checklistItemIds=${olioId},${filtroId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resBoth.statusCode).toBe(200);
    const bodyBoth = resBoth.json() as { items: Array<{ id: string }> };
    expect(bodyBoth.items.map((i) => i.id)).toEqual([x]);

    // Requesting only olio → both X and Y qualify.
    const resOne = await app.inject({
      method: 'GET',
      url: `/v1/interventions?typeId=${typeId}&checklistItemIds=${olioId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resOne.statusCode).toBe(200);
    const bodyOne = resOne.json() as { items: Array<{ id: string }> };
    expect(bodyOne.items.map((i) => i.id).sort()).toEqual([x, y].sort());
  });

  // ── Checklist guard (400) ────────────────────────────────────────────────
  it('checklistItemIds without exactly one typeId → 400 VALIDATION_ERROR', async () => {
    const { tenantId } = await createTenant('list-checklist-guard');
    const { token } = await officinaCaller(tenantId);
    const { id: typeMeccanico } = await ensureSystemInterventionType('MECCANICO');
    const { id: typeGomme } = await ensureSystemInterventionType('GOMME');
    const { checklistItemId: olioId } = await createChecklistItem({
      interventionTypeId: typeMeccanico,
      code: 'OLIO',
      nameIt: 'Olio motore',
    });

    // No typeId at all.
    const resNoType = await app.inject({
      method: 'GET',
      url: `/v1/interventions?checklistItemIds=${olioId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resNoType.statusCode).toBe(400);
    expect((resNoType.json() as { code: string }).code).toBe('VALIDATION_ERROR');

    // Two typeIds.
    const resTwoTypes = await app.inject({
      method: 'GET',
      url: `/v1/interventions?typeId=${typeMeccanico},${typeGomme}&checklistItemIds=${olioId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resTwoTypes.statusCode).toBe(400);
    expect((resTwoTypes.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  // ── Filters ──────────────────────────────────────────────────────────────
  it('q filters by vehicle plate case-insensitively', async () => {
    const { tenantId } = await createTenant('list-q');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId: vKeep, plate: plateKeep } = await createVehicle({
      createdByTenantId: tenantId,
    });
    const { vehicleId: vDrop } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: keep } = await createIntervention({
      tenantId,
      userId,
      vehicleId: vKeep,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId: vDrop,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 20000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?q=${plateKeep.toLowerCase()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([keep]);
  });

  it('typeId narrows results to the selected intervention type', async () => {
    const { tenantId } = await createTenant('list-typeid');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeMeccanico } = await ensureSystemInterventionType('MECCANICO');
    const { id: typeGomme } = await ensureSystemInterventionType('GOMME');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: keep } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeMeccanico,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeGomme,
      interventionDate: '2026-05-20',
      odometerKm: 20000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?typeId=${typeMeccanico}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([keep]);
  });

  it('operatorId narrows results to the selected operator', async () => {
    const { tenantId } = await createTenant('list-operator');
    const { userId: opA, token } = await officinaCaller(tenantId);
    const { userId: opB } = await createUser({ tenantId, cognitoSub: randomUUID() });
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: keep } = await createIntervention({
      tenantId,
      userId: opA,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId,
      userId: opB,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 20000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?operatorId=${opA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([keep]);
  });

  it('dateFrom/dateTo bounds are inclusive', async () => {
    const { tenantId } = await createTenant('list-daterange');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-09',
      odometerKm: 1,
    });
    const { interventionId: onFrom } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-10',
      odometerKm: 2,
    });
    const { interventionId: onTo } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-15',
      odometerKm: 3,
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-16',
      odometerKm: 4,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?dateFrom=2026-05-10&dateTo=2026-05-15`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id).sort()).toEqual([onFrom, onTo].sort());
  });

  // ── Sort ─────────────────────────────────────────────────────────────────
  it('sort=km&order=asc orders ascending by odometer', async () => {
    const { tenantId } = await createTenant('list-sort-km');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: low } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 10000,
    });
    const { interventionId: mid } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-21',
      odometerKm: 20000,
    });
    const { interventionId: high } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-22',
      odometerKm: 30000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?sort=km&order=asc`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([low, mid, high]);
  });

  it('defaults to sort=date&order=desc (newest first)', async () => {
    const { tenantId } = await createTenant('list-sort-date');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: oldest } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 1,
    });
    const { interventionId: newest } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-22',
      odometerKm: 2,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([newest, oldest]);
  });

  it('tie on equal interventionDate is broken by id DESC', async () => {
    const { tenantId } = await createTenant('list-sort-tiebreak');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const { interventionId: i1 } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 1,
    });
    const { interventionId: i2 } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: typeId,
      interventionDate: '2026-05-20',
      odometerKm: 2,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    // Same interventionDate → id DESC tiebreaker (lexicographic UUID compare).
    const expectedFirst = i1 > i2 ? i1 : i2;
    const expectedSecond = i1 > i2 ? i2 : i1;
    expect(body.items.map((i) => i.id)).toEqual([expectedFirst, expectedSecond]);
  });

  // ── Pagination ───────────────────────────────────────────────────────────
  it('paginates: pageSize=2 page=1 returns 2 items (total=3); page=2 returns the remainder', async () => {
    const { tenantId } = await createTenant('list-page');
    const { userId, token } = await officinaCaller(tenantId);
    const { id: typeId } = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    for (let i = 0; i < 3; i++) {
      await createIntervention({
        tenantId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: `2026-05-2${i}`,
        odometerKm: 1000 * i,
      });
    }

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/interventions?pageSize=2&page=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body1.items).toHaveLength(2);
    expect(body1.total).toBe(3);
    expect(body1.page).toBe(1);
    expect(body1.pageSize).toBe(2);

    const res2 = await app.inject({
      method: 'GET',
      url: '/v1/interventions?pageSize=2&page=2',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as { items: unknown[]; total: number; page: number };
    expect(body2.items).toHaveLength(1);
    expect(body2.total).toBe(3);
    expect(body2.page).toBe(2);
  });

  // ── Auth ─────────────────────────────────────────────────────────────────
  it('401 without an Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/interventions' });
    expect(res.statusCode).toBe(401);
  });

  it('403 FORBIDDEN when the caller is in the clienti pool', async () => {
    // requireOfficinaPool throws name='Forbidden' → error handler maps it
    // to code=FORBIDDEN (see require-officina-pool.ts).
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// GET /v1/vehicles/:id/timeline — APPENDICE_A §2.5 visibility, as of
// 2026-07-09: officine shop-only, scoped to its OWN tenant (BR-150/BR-153
// cross-tenant officina visibility deprecated); customer-owner shop + own
// private ACROSS ALL officine (unchanged, product value proposition);
// non-owner 403; past-owner privates always hidden.

describe('GET /v1/vehicles/:id/timeline (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // resetDb() truncates intervention_types as a CASCADE side-effect of
    // tenants — re-seed MECCANICO so each test has a stable type FK.
    await ensureSystemInterventionType('MECCANICO');
  });

  it('officina sees only its OWN shop_interventions (BR-150/BR-153 cross-tenant deprecated)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('tl-cross-A');
    const { tenantId: tenantB } = await createTenantWithLocation('tl-cross-B');

    const subA = '11111111-1111-4111-8111-aaaaaaaaaaaa';
    const subB = '22222222-2222-4222-8222-bbbbbbbbbbbb';
    const { userId: userA } = await createUser({
      tenantId: tenantA,
      cognitoSub: subA,
    });
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: subB,
    });

    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });
    await createOwnership({ vehicleId, customerId });

    const tagliando = await ensureSystemInterventionType('MECCANICO');

    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 45000,
    });
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-03-10',
      odometerKm: 42000,
    });

    // Tenant B token reads timeline → must see ONLY tenant B's own
    // shop_interventions (own-tenant scoping, none of tenant A's rows).
    const token = await signTestToken({
      pool: 'officine',
      sub: subB,
      tenantId: tenantB,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        kind: string;
        odometer_km: number;
        tenant?: { business_name: string };
        wiki_window_open?: boolean;
        type?: { id: string; code: string; name_it: string };
      }>;
      meta: { shop_count: number; private_count: number };
    };
    expect(body.meta.shop_count).toBe(1);
    expect(body.meta.private_count).toBe(0);
    expect(body.data.every((d) => d.kind === 'shop_intervention')).toBe(true);
    const oks = body.data.map((d) => d.odometer_km);
    expect(oks).toEqual([42000]); // tenant B's own row only, none of A's
    const row = body.data[0]!;
    expect(row.kind).toBe('shop_intervention');
    // Interventions created in this test are < 48h old, never seen,
    // and have no wikiLockedAt → wiki window must be open.
    expect(row.wiki_window_open).toBe(true);
    expect(row.type!.id).toBe(tagliando.id);
  });

  it('REGRESSION: cliente still sees shop interventions across ALL officine (cross-officina unchanged)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('tl-cli-cross-A');
    const { tenantId: tenantB } = await createTenantWithLocation('tl-cli-cross-B');

    const subA = '11111111-2222-4111-8111-aaaaaaaaaaaa';
    const subB = '22222222-3333-4222-8222-bbbbbbbbbbbb';
    const { userId: userA } = await createUser({ tenantId: tenantA, cognitoSub: subA });
    const { userId: userB } = await createUser({ tenantId: tenantB, cognitoSub: subB });

    const customerSub = '99999999-1111-4999-8999-eeeeeeeeeeee';
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });
    await createOwnership({ vehicleId, customerId });

    const tagliando = await ensureSystemInterventionType('MECCANICO');

    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 45000,
    });
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-03-10',
      odometerKm: 42000,
    });

    // Active-owner customer reads timeline → must see BOTH tenant A and B
    // shop_interventions (cross-officina history is the customer-facing
    // product value proposition; unaffected by the officina-side change).
    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string; odometer_km: number }>;
      meta: { shop_count: number; private_count: number };
    };
    expect(body.meta.shop_count).toBe(2);
    expect(body.meta.private_count).toBe(0);
    const oks = body.data.map((d) => d.odometer_km);
    expect(oks).toContain(45000);
    expect(oks).toContain(42000);
  });

  it('officina: tenant_ids query param is accepted but IGNORED — own-tenant scoping always wins', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('tl-filt-A');
    const { tenantId: tenantB } = await createTenantWithLocation('tl-filt-B');
    const subA = '41111111-1111-4111-8111-aaaaaaaaaaaa';
    const subB = '42222222-2222-4222-8222-bbbbbbbbbbbb';
    const { userId: userA } = await createUser({
      tenantId: tenantA,
      cognitoSub: subA,
    });
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: subB,
    });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 45000,
    });
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-03-10',
      odometerKm: 42000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: subA,
      tenantId: tenantA,
      role: 'mechanic',
    });
    // Caller is tenant A but asks to filter to tenant B — tenant_ids is
    // ignored for officina, so the result must still be tenant A's own row.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?tenant_ids=${tenantB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ odometer_km: number }>;
      meta: { shop_count: number };
    };
    expect(body.meta.shop_count).toBe(1);
    expect(body.data.map((d) => d.odometer_km)).toEqual([45000]);
  });

  it('REGRESSION: cliente tenant_ids filter still works unchanged (cross-officina "in" filter)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('tl-cli-filt-A');
    const { tenantId: tenantB } = await createTenantWithLocation('tl-cli-filt-B');
    const subA = '41111111-2222-4111-8111-aaaaaaaaaaaa';
    const subB = '42222222-3333-4222-8222-bbbbbbbbbbbb';
    const { userId: userA } = await createUser({ tenantId: tenantA, cognitoSub: subA });
    const { userId: userB } = await createUser({ tenantId: tenantB, cognitoSub: subB });
    const customerSub = '98888888-8888-4888-8888-cccccccccccc';
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 45000,
    });
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-03-10',
      odometerKm: 42000,
    });

    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?tenant_ids=${tenantB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ odometer_km: number }>;
      meta: { shop_count: number };
    };
    expect(body.meta.shop_count).toBe(1);
    expect(body.data.map((d) => d.odometer_km)).toEqual([42000]);
  });

  it('returns 400 for a malformed tenant_ids value', async () => {
    const { tenantId } = await createTenantWithLocation('tl-filt-bad');
    const cognitoSub = '43333333-3333-4333-8333-cccccccccccc';
    await createUser({ tenantId, cognitoSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?tenant_ids=not-a-uuid`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('computes wiki_window_open=false when wikiLockedAt is set', async () => {
    const { tenantId } = await createTenantWithLocation('tl-wiki-lock');
    const cognitoSub = 'eeeeeeee-5555-4555-8555-555555555555';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    const lockedAt = new Date('2026-05-01T10:00:00.000Z');
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-20',
      odometerKm: 48000,
      wikiLockedAt: lockedAt,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.30.41',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        wiki_window_open: boolean;
        type: { id: string; code: string; name_it: string };
      }>;
    };
    const found = body.data.find((r) => r.id === interventionId);
    expect(found).toBeDefined();
    expect(found!.wiki_window_open).toBe(false);
    expect(found!.type).toMatchObject({
      id: tagliando.id,
      code: 'MECCANICO',
      name_it: 'Intervento Meccanico',
    });
  });

  it('computes wiki_window_open=false when createdAt is older than 48h even if wikiLockedAt is null', async () => {
    const { tenantId } = await createTenantWithLocation('tl-wiki-aged');
    const cognitoSub = 'eeeeeeee-6666-4666-8666-666666666666';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-20',
      odometerKm: 48000,
    });

    // Force createdAt to 49h ago without touching wikiLockedAt (which
    // is what production looks like when nobody has triggered the
    // lock-persist via a PATCH or a customer-side first-seen yet).
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000);
    await pgAdmin.query('UPDATE interventions SET created_at = $1 WHERE id = $2', [
      fortyNineHoursAgo,
      interventionId,
    ]);

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.30.42',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; wiki_window_open: boolean }>;
    };
    const found = body.data.find((r) => r.id === interventionId);
    expect(found).toBeDefined();
    expect(found!.wiki_window_open).toBe(false);
  });

  it('officine pool never sees private_interventions in the timeline', async () => {
    const { tenantId } = await createTenantWithLocation('tl-no-priv');
    const cognitoSub = '33333333-3333-4333-8333-cccccccccccc';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 50000,
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-04-10',
      odometerKm: 49500,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string }>;
      meta: { shop_count: number; private_count: number };
    };
    expect(body.meta.private_count).toBe(0);
    expect(body.data.every((d) => d.kind === 'shop_intervention')).toBe(true);
  });

  it('clienti current owner sees merged shop + own private interventions', async () => {
    const { tenantId } = await createTenantWithLocation('tl-owner');
    const tenantSub = '44444444-4444-4444-8444-dddddddddddd';
    const { userId } = await createUser({
      tenantId,
      cognitoSub: tenantSub,
    });
    const customerSub = '55555555-5555-4555-8555-eeeeeeeeeeee';
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 50000,
    });
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-04-10',
      odometerKm: 49800,
      customType: 'Rabbocco liquidi',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string; intervention_date: string }>;
      meta: { shop_count: number; private_count: number; total_interventions: number };
    };
    expect(body.meta.shop_count).toBe(1);
    expect(body.meta.private_count).toBe(1);
    expect(body.meta.total_interventions).toBe(2);
    expect(body.data[0]!.kind).toBe('shop_intervention');
    expect(body.data[0]!.intervention_date).toBe('2026-04-15');
    expect(body.data[1]!.kind).toBe('private_intervention');
    expect(body.data[1]!.intervention_date).toBe('2026-04-10');
  });

  it('exposes the catalog type on private rows, and null type on free-text rows', async () => {
    const { tenantId } = await createTenantWithLocation('tl-priv-type');
    const customerSub = '55555555-5555-4555-8555-eeeeeeeeef01';
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const meccanico = await ensureSystemInterventionType('MECCANICO');

    // Structured private intervention (catalog type, no free-text label).
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-05-01',
      interventionTypeId: meccanico.id,
    });
    // Free-text ("Altro") private intervention.
    await createPrivateIntervention({
      customerId,
      vehicleId,
      interventionDate: '2026-04-01',
      customType: 'Lavaggio',
    });

    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        kind: string;
        type: { id: string; name_it: string } | null;
        custom_type: string | null;
      }>;
    };
    const structured = body.data.find((d) => d.type !== null);
    expect(structured!.type).toMatchObject({ id: meccanico.id, name_it: 'Intervento Meccanico' });
    expect(structured!.custom_type).toBeNull();
    const freeText = body.data.find((d) => d.kind === 'private_intervention' && d.type === null);
    expect(freeText!.type).toBeNull();
    expect(freeText!.custom_type).toBe('Lavaggio');
  });

  it('clienti non-owner gets 403 vehicle.timeline.not_owner', async () => {
    const { tenantId } = await createTenantWithLocation('tl-403');
    const ownerSub = '66666666-6666-4666-8666-ffffffffffff';
    const otherSub = '77777777-7777-4777-8777-aaaaaaaaaaaa';
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    const { customerId: otherId } = await createCustomer({
      email: `other-${Math.random().toString(36).slice(2, 10)}@test.it`,
      cognitoSub: otherSub,
    });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId: ownerId });

    const token = await signTestToken({
      pool: 'clienti',
      sub: otherSub,
      customerId: otherId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.timeline.not_owner',
      status: 403,
    });
  });

  it('private interventions of past owners stay hidden when ownership transfers', async () => {
    const { tenantId } = await createTenantWithLocation('tl-prev-owner');
    const formerSub = '88888888-8888-4888-8888-bbbbbbbbbbbb';
    const currentSub = '99999999-9999-4999-8999-cccccccccccc';
    const { customerId: formerId } = await createCustomer({
      email: `former-${Math.random().toString(36).slice(2, 10)}@test.it`,
      cognitoSub: formerSub,
    });
    const { customerId: currentId } = await createCustomer({
      email: `current-${Math.random().toString(36).slice(2, 10)}@test.it`,
      cognitoSub: currentSub,
    });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // Former owner had a private intervention that should remain hidden
    // for the new owner (spec §2.5 visibility "Interventi privati di
    // precedenti proprietari: sempre nascosti").
    await createPrivateIntervention({
      customerId: formerId,
      vehicleId,
      interventionDate: '2025-12-01',
      customType: 'Vecchio rabbocco',
    });

    // Ownership chain: former → current. Mark former's row ended.
    const { ownershipId: formerOwnership } = await createOwnership({
      vehicleId,
      customerId: formerId,
      startedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await pgAdmin.query(`UPDATE vehicle_ownerships SET ended_at = NOW() WHERE id = $1`, [
      formerOwnership,
    ]);
    await createOwnership({
      vehicleId,
      customerId: currentId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Current owner adds their own private intervention.
    await createPrivateIntervention({
      customerId: currentId,
      vehicleId,
      interventionDate: '2026-04-10',
      customType: 'Mio rabbocco',
    });

    const token = await signTestToken({
      pool: 'clienti',
      sub: currentSub,
      customerId: currentId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string; custom_type?: string }>;
      meta: { private_count: number };
    };
    expect(body.meta.private_count).toBe(1);
    const customTypes = body.data
      .filter((d) => d.kind === 'private_intervention')
      .map((d) => d.custom_type);
    expect(customTypes).toEqual(['Mio rabbocco']);
  });

  it('respects from_date / to_date filters', async () => {
    const { tenantId } = await createTenantWithLocation('tl-dates');
    const cognitoSub = 'aaaaaaaa-1111-4111-8111-111111111111';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-01-15',
      odometerKm: 30000,
    });
    await createIntervention({
      tenantId,
      userId,
      vehicleId,
      interventionTypeId: tagliando.id,
      interventionDate: '2026-04-15',
      odometerKm: 45000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?from_date=2026-03-01&to_date=2026-12-31`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ odometer_km: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.odometer_km).toBe(45000);
  });

  it('paginates with cursor across the merged set', async () => {
    const { tenantId } = await createTenantWithLocation('tl-paginate');
    const cognitoSub = 'bbbbbbbb-2222-4222-8222-222222222222';
    const { userId } = await createUser({ tenantId, cognitoSub });
    const customerSub = 'cccccccc-3333-4333-8333-333333333333';
    const { customerId } = await createCustomer({ cognitoSub: customerSub });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    const tagliando = await ensureSystemInterventionType('MECCANICO');

    // 3 shop + 2 private, dates spread to keep ordering deterministic.
    const dates = ['2026-04-20', '2026-04-15', '2026-04-10', '2026-04-05', '2026-04-01'];
    let km = 50000;
    for (const d of dates) {
      if (dates.indexOf(d) % 2 === 0) {
        await createIntervention({
          tenantId,
          userId,
          vehicleId,
          interventionTypeId: tagliando.id,
          interventionDate: d,
          odometerKm: km,
        });
      } else {
        await createPrivateIntervention({
          customerId,
          vehicleId,
          interventionDate: d,
          odometerKm: km,
        });
      }
      km -= 1000;
    }

    const token = await signTestToken({
      pool: 'clienti',
      sub: customerSub,
      customerId,
    });

    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as {
      data: Array<{ intervention_date: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.has_more).toBe(true);
    expect(body1.data[0]!.intervention_date).toBe('2026-04-20');
    expect(body1.data[1]!.intervention_date).toBe('2026-04-15');

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?limit=2&cursor=${body1.meta.cursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json() as {
      data: Array<{ intervention_date: string }>;
      meta: { has_more: boolean };
    };
    expect(body2.data).toHaveLength(2);
    expect(body2.data[0]!.intervention_date).toBe('2026-04-10');
    expect(body2.data[1]!.intervention_date).toBe('2026-04-05');

    const page3 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/timeline?limit=2&cursor=${(page2.json() as { meta: { cursor: string } }).meta.cursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body3 = page3.json() as {
      data: Array<{ intervention_date: string }>;
      meta: { has_more: boolean };
    };
    expect(body3.data).toHaveLength(1);
    expect(body3.data[0]!.intervention_date).toBe('2026-04-01');
    expect(body3.meta.has_more).toBe(false);
  });

  it('returns 404 when the vehicle does not exist', async () => {
    const cognitoSub = 'dddddddd-4444-4444-8444-444444444444';
    const { tenantId } = await createTenantWithLocation('tl-404');
    await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/ffffffff-ffff-4fff-8fff-ffffffffffff/timeline',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

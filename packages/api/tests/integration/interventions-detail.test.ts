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

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
const TEST_IP = '10.30.40.1';

describe('GET /v1/interventions/:id (officina)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // resetDb() truncates intervention_types as a CASCADE side-effect
    // of TRUNCATE tenants — re-seed so each test has a stable type FK.
    await ensureSystemInterventionType('TAGLIANDO');
  });

  // -----------------------------------------------------------------------
  // Shared setup helpers
  // -----------------------------------------------------------------------

  async function setupCaller(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `det-caller-${suffix.slice(0, 20)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      firstName: 'Giuseppe',
      lastName: 'Verdi',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, userId, token };
  }

  async function setupIntervention(args: {
    tenantId: string;
    userId: string;
    overrides?: Partial<Parameters<typeof createIntervention>[0]>;
  }) {
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: args.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-15',
      odometerKm: 50000,
      title: 'Tagliando completo',
      description: 'Cambio olio e filtri completi',
      internalNotes: 'Note interne di test',
      partsReplaced: [
        { name: 'Olio motore Selenia 5W40', code: 'OIL-5W40', quantity: 5, notes: null },
      ],
      ...(args.overrides ?? {}),
    });
    return { interventionId, vehicleId, typeId: type.id };
  }

  // -----------------------------------------------------------------------
  // Scenario 1: Happy path — full DTO with all top-level fields
  // -----------------------------------------------------------------------
  it('returns full DTO with all top-level fields and nested relations', async () => {
    const { tenantId, userId, token } = await setupCaller('det-happy');
    const { interventionId, vehicleId, typeId } = await setupIntervention({
      tenantId,
      userId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // Top-level scalar fields
    expect(body.id).toBe(interventionId);
    expect(body.status).toBe('active');
    expect(body.is_disputed).toBe(false);
    expect(typeof body.wiki_window_open).toBe('boolean');
    expect(body.intervention_date).toBe('2026-04-15');
    expect(body.odometer_km).toBe(50000);
    expect(typeof body.created_at).toBe('string');
    expect(body.cancelled_at).toBeNull();
    expect(body.cancelled_reason).toBeNull();
    expect(body.title).toBe('Tagliando completo');
    expect(body.description).toBe('Cambio olio e filtri completi');
    expect(body.internal_notes).toBe('Note interne di test');

    // parts_replaced
    const parts = body.parts_replaced as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      name: 'Olio motore Selenia 5W40',
      code: 'OIL-5W40',
      quantity: 5,
      notes: null,
    });

    // Nested relation: type
    const type = body.type as Record<string, unknown>;
    expect(type.id).toBe(typeId);
    expect(type.code).toBe('TAGLIANDO');
    expect(type.name_it).toBe('Tagliando');

    // Nested relation: tenant
    const tenant = body.tenant as Record<string, unknown>;
    expect(typeof tenant.id).toBe('string');
    expect(typeof tenant.business_name).toBe('string');

    // sede-unica: location relation removed from intervention DTO.

    // Nested relation: vehicle
    const vehicle = body.vehicle as Record<string, unknown>;
    expect(vehicle.id).toBe(vehicleId);
    expect(typeof vehicle.garage_code).toBe('string');
    expect(typeof vehicle.plate).toBe('string');
    expect(typeof vehicle.make).toBe('string');
    expect(typeof vehicle.model).toBe('string');

    // Nested relation: created_by
    const createdBy = body.created_by as Record<string, unknown>;
    expect(typeof createdBy.id).toBe('string');
    expect(createdBy.first_name).toBe('Giuseppe');
    expect(createdBy.last_name).toBe('Verdi');

    // The owning tenant is the viewer → full visibility flag
    expect(body.viewer_is_owner).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Scenario 2: cross-tenant read is permitted but redacted (BR-150/BR-153)
  //
  // A different officina may open another tenant's intervention in read-only
  // mode (shared maintenance logbook). Reserved fields are redacted:
  //   - internal_notes → null  (BR-153 "note riservate di altri tenant")
  //   - created_by     → null  (mechanic identity gated by BR-151)
  //   - viewer_is_owner → false (drives read-only UI on the client)
  // Public shop-record fields (title, description, parts, type, tenant,
  // vehicle) stay visible.
  // -----------------------------------------------------------------------
  it('allows cross-tenant read but redacts internal_notes and created_by (BR-153)', async () => {
    const { tenantId: tenantA, userId: userA } = await setupCaller('det-xA');
    const { interventionId } = await setupIntervention({
      tenantId: tenantA,
      userId: userA,
    });

    // Caller is tenantB
    const { token: tokenB } = await setupCaller('det-xB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // Redacted reserved fields
    expect(body.internal_notes).toBeNull();
    expect(body.created_by).toBeNull();
    expect(body.viewer_is_owner).toBe(false);

    // Public shop-record fields remain visible
    expect(body.id).toBe(interventionId);
    expect(body.title).toBe('Tagliando completo');
    expect(body.description).toBe('Cambio olio e filtri completi');
    expect(body.parts_replaced).toHaveLength(1);
    expect((body.tenant as Record<string, unknown>).id).toBe(tenantA);
    expect(typeof (body.vehicle as Record<string, unknown>).plate).toBe('string');
  });

  // -----------------------------------------------------------------------
  // Scenario 3: 404 not found
  // -----------------------------------------------------------------------
  it('returns 404 when intervention UUID does not exist', async () => {
    const { token } = await setupCaller('det-404');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('intervention.not_found');
  });

  // -----------------------------------------------------------------------
  // Scenario 4: 400 invalid UUID
  // -----------------------------------------------------------------------
  it('returns 400 when id param is not a valid UUID', async () => {
    const { token } = await setupCaller('det-400');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/not-a-uuid',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Scenario 5: 401 no auth
  // -----------------------------------------------------------------------
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Scenario 6: 403 clienti pool
  // -----------------------------------------------------------------------
  it('returns 403 when caller is in the clienti pool', async () => {
    const token = await signTestToken({
      pool: 'clienti',
      customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/ffffffff-ffff-4fff-8fff-ffffffffffff',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(403);
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Cancelled state
  // -----------------------------------------------------------------------
  it('surfaces cancelled_at and cancelled_reason for a cancelled intervention', async () => {
    const { tenantId, userId, token } = await setupCaller('det-cancel');
    const { interventionId } = await setupIntervention({
      tenantId,
      userId,
      overrides: { status: 'cancelled' },
    });

    const cancelledAt = new Date('2026-04-16T09:00:00.000Z');
    const cancelledReason = 'Cliente ha rinunciato alla riparazione.';
    await pgAdmin.query(
      `UPDATE interventions SET cancelled_at = $1, cancelled_reason = $2 WHERE id = $3`,
      [cancelledAt, cancelledReason, interventionId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe('cancelled');
    expect(body.cancelled_at).toBe('2026-04-16T09:00:00.000Z');
    expect(body.cancelled_reason).toBe(cancelledReason);
  });

  // -----------------------------------------------------------------------
  // Scenario 8: Disputed state
  // -----------------------------------------------------------------------
  it('sets is_disputed=true when intervention status is disputed', async () => {
    const { tenantId, userId, token } = await setupCaller('det-dispute');
    const { interventionId } = await setupIntervention({
      tenantId,
      userId,
      overrides: { status: 'disputed' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe('disputed');
    expect(body.is_disputed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Scenario 9: wiki_window_open=true (BR-062)
  // -----------------------------------------------------------------------
  it('wiki_window_open=true when createdAt is 47h ago, no wikiLockedAt, no firstSeenByCustomerAt', async () => {
    const { tenantId, userId, token } = await setupCaller('det-wiki-open');
    const { interventionId } = await setupIntervention({ tenantId, userId });

    const fortySevenHoursAgo = new Date(Date.now() - 47 * 60 * 60 * 1000);
    await pgAdmin.query(`UPDATE interventions SET created_at = $1 WHERE id = $2`, [
      fortySevenHoursAgo,
      interventionId,
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).wiki_window_open).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Scenario 10: wiki_window_open=false (time elapsed >48h) (BR-062)
  // -----------------------------------------------------------------------
  it('wiki_window_open=false when createdAt is 49h ago with no lock or first-seen', async () => {
    const { tenantId, userId, token } = await setupCaller('det-wiki-aged');
    const { interventionId } = await setupIntervention({ tenantId, userId });

    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000);
    await pgAdmin.query(`UPDATE interventions SET created_at = $1 WHERE id = $2`, [
      fortyNineHoursAgo,
      interventionId,
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).wiki_window_open).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Scenario 11: wiki_window_open=false (firstSeenByCustomerAt set) (BR-062)
  // -----------------------------------------------------------------------
  it('wiki_window_open=false when firstSeenByCustomerAt is set even if createdAt is recent', async () => {
    const { tenantId, userId, token } = await setupCaller('det-wiki-seen');
    const { interventionId } = await setupIntervention({
      tenantId,
      userId,
      overrides: { firstSeenByCustomerAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).wiki_window_open).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Scenario 12: parts_replaced empty vs populated
  // -----------------------------------------------------------------------
  it('normalizes parts_replaced correctly for empty and non-empty cases', async () => {
    const { tenantId, userId, token } = await setupCaller('det-parts');
    // beforeEach already calls ensureSystemInterventionType('TAGLIANDO'); look up
    // the existing row rather than re-creating it.
    const type = await pgAdmin
      .query<{ id: string }>(`SELECT id FROM intervention_types WHERE code = 'TAGLIANDO' LIMIT 1`)
      .then((r) => r.rows[0]!);

    // Intervention with empty partsReplaced
    const { vehicleId: vEmpty } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId: idEmpty } = await createIntervention({
      tenantId,
      userId,
      vehicleId: vEmpty,
      interventionTypeId: type.id,
      interventionDate: '2026-04-01',
      odometerKm: 10000,
      partsReplaced: [],
    });

    // Intervention with 2 parts
    const { vehicleId: vParts } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId: idParts } = await createIntervention({
      tenantId,
      userId,
      vehicleId: vParts,
      interventionTypeId: type.id,
      interventionDate: '2026-04-02',
      odometerKm: 20000,
      partsReplaced: [
        { name: 'Filtro olio', code: 'F026407123', quantity: 1, notes: null },
        {
          name: 'Guarnizione testata',
          code: null,
          quantity: 2,
          notes: 'Verificare coppia serraggio',
        },
      ],
    });

    const resEmpty = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${idEmpty}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(resEmpty.statusCode).toBe(200);
    const bodyEmpty = resEmpty.json() as Record<string, unknown>;
    expect(bodyEmpty.parts_replaced).toEqual([]);

    const resParts = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${idParts}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(resParts.statusCode).toBe(200);
    const bodyParts = resParts.json() as Record<string, unknown>;
    const parts = bodyParts.parts_replaced as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      name: 'Filtro olio',
      code: 'F026407123',
      quantity: 1,
      notes: null,
    });
    expect(parts[1]).toEqual({
      name: 'Guarnizione testata',
      code: null,
      quantity: 2,
      notes: 'Verificare coppia serraggio',
    });
  });

  // -----------------------------------------------------------------------
  // NOTE: Scenario "created_by=null when user reference is missing" is
  // intentionally omitted. The Intervention.userId column is non-nullable
  // in schema.prisma (@db.Uuid, no ?), so there is no clean way to insert
  // an intervention row with a missing user FK without violating the DB
  // constraint. Attempting to orphan the user after insertion would cascade
  // the FK violation. The null branch in the DTO is a defensive guard only.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Scenario 14: deletedAt filter coverage
  //
  // NOTE: The `interventions` table does NOT currently have a `deleted_at`
  // column in schema.prisma (as of 2026-05-11). This test is forward-looking
  // coverage that will fail at the $executeRawUnsafe step with a PG column-
  // not-found error until soft-delete is added to the schema.
  //
  // When soft-delete is implemented:
  //   1. Add `deletedAt DateTime? @map("deleted_at")` to Intervention model
  //   2. Add `deletedAt: null` to the findFirst where clause in
  //      packages/api/src/routes/v1/interventions-detail.ts
  //   3. Run migration + re-enable this test (remove the .skip below).
  //
  // Static analysis of interventions-detail.ts: the current findFirst uses
  //   where: { id, tenantId }
  // without a `deletedAt: null` filter — so when soft-delete lands, Outcome B
  // (route returns 200 for soft-deleted rows) is expected until the route is
  // patched.
  // -----------------------------------------------------------------------
  it.skip('scenario 14: returns 404 when intervention has deletedAt != null (soft-delete filter)', async () => {
    const { tenantId, userId, token } = await setupCaller('det-softdel');
    const { interventionId } = await setupIntervention({ tenantId, userId });

    // Soft-delete the intervention via raw SQL to simulate future
    // soft-delete behavior — backend route must filter even if the column
    // gets set out-of-band.
    await pgAdmin.query(`UPDATE interventions SET deleted_at = now() WHERE id = $1::uuid`, [
      interventionId,
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      code: 'intervention.not_found',
    });
  });
});

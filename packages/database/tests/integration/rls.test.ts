import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Smoke tests for tenant isolation via Row Level Security. Fixtures
// are inserted with the superuser pool (bypasses RLS); the actual
// isolation assertions run through the app_test role via
// `withContext` so the policies genuinely filter. The full BR-coverage
// suite (cross-tenant vehicle visibility, customer PII redaction,
// customer-scoped policies) lands in PR 4d.

describe('RLS — tenant isolation (smoke)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedTwoTenants(): Promise<{ tenantAId: string; tenantBId: string }> {
    const { rows: a } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina A', '11111111111', 'a@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const { rows: b } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina B', '22222222222', 'b@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantAId = a[0]!.id;
    const tenantBId = b[0]!.id;

    await pgAdmin.query(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede A', 'Via A 1', 'Milano', 'MI', '20100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())`,
      [tenantAId],
    );
    await pgAdmin.query(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede B', 'Via B 1', 'Roma', 'RM', '00100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())`,
      [tenantBId],
    );
    return { tenantAId, tenantBId };
  }

  it('tenants WRITE remains tenant-isolated (cross-tenant UPDATE returns 0 rows)', async () => {
    const { tenantAId, tenantBId } = await seedTwoTenants();

    // tenant B tries to rename tenant A. The USING clause of
    // tenants_write hides the row from tenant B → updateMany count: 0.
    const result = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.tenant.updateMany({
        where: { id: tenantAId },
        data: { businessName: 'Hijacked' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('admin role bypasses tenant filtering', async () => {
    await seedTwoTenants();

    const all = await withContext({ role: 'admin' }, (tx) => tx.tenant.findMany());
    expect(all.length).toBeGreaterThanOrEqual(2);

    const allLocations = await withContext({ role: 'admin' }, (tx) => tx.location.findMany());
    expect(allLocations.length).toBeGreaterThanOrEqual(2);
  });

  it('customers are readable cross-tenant (BR-150 + customers_read policy)', async () => {
    const { tenantAId } = await seedTwoTenants();
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'pii@test.it', 'Mario', 'Rossi', NOW(), NOW())
       RETURNING id`,
    );
    const customerId = rows[0]!.id;

    // tenantA sees the customer (BR-150 policy allows read).
    const seenByA = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.customer.findUnique({ where: { id: customerId } }),
    );
    expect(seenByA?.id).toBe(customerId);

    // An unrelated tenant also sees the row — PII redaction for
    // non-related tenants is an application-layer concern per BR-151
    // and lands alongside the vehicle detail service in a later PR.
    const seenByOther = await withContext(
      { tenantId: '00000000-0000-0000-0000-000000000001' },
      (tx) => tx.customer.findUnique({ where: { id: customerId } }),
    );
    expect(seenByOther?.id).toBe(customerId);
  });
});

// Migration 0003 splits SELECT/WRITE policies on interventions,
// attachments, tenants, locations, intervention_types so cross-tenant
// SELECT (BR-150 / BR-153 timeline view) is permissive while WRITE
// stays tenant/owner-scoped. These tests pin down the new contract:
// any future regression that re-tightens SELECT or relaxes WRITE will
// surface here.
describe('RLS — interventions/attachments split (post-migration 0003)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Seed enough rows to drive every assertion in this describe via
   * pgAdmin (bypasses RLS at fixture time so policies don't get in
   * the way of arrange-step). The actual checks run through
   * withContext() which goes through the app_test role so RLS
   * policies execute.
   */
  async function seedInterventionForTenantA(): Promise<{
    tenantAId: string;
    tenantBId: string;
    locationAId: string;
    userAId: string;
    customerId: string;
    vehicleId: string;
    interventionId: string;
    interventionTypeId: string;
  }> {
    const { rows: tA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina A', '11111111111', 'a@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const { rows: tB } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina B', '22222222222', 'b@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantAId = tA[0]!.id;
    const tenantBId = tB[0]!.id;

    const { rows: lA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede A', 'Via A 1', 'Milano', 'MI', '20100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId],
    );
    const locationAId = lA[0]!.id;

    const { rows: uA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO users
         (id, tenant_id, location_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'mech@a.it', 'Mech', 'A',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId, locationAId, `sub-rls-split-${Date.now()}`],
    );
    const userAId = uA[0]!.id;

    const { rows: cust } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Cust', 'Owner', NOW(), NOW())
       RETURNING id`,
      [`cust-rls-split-${Date.now()}@test.it`],
    );
    const customerId = cust[0]!.id;

    const { rows: veh } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicles
         (id, vin, plate, plate_country, make, model, year, vehicle_type, fuel_type,
          status, created_by_tenant_id, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'AA000BB', 'IT', 'Fiat', 'Panda', 2021,
          'car'::"VehicleType", 'petrol'::"FuelType",
          'pending'::"VehicleStatus", $2, NOW(), NOW())
       RETURNING id`,
      [`VIN${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 17), tenantAId],
    );
    const vehicleId = veh[0]!.id;

    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships
         (id, vehicle_id, customer_id, started_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
      [vehicleId, customerId],
    );

    const { rows: it } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM intervention_types WHERE tenant_id IS NULL AND code = 'TAGLIANDO' LIMIT 1`,
    );
    const interventionTypeId = it[0]!.id;

    const { rows: iv } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO interventions
         (id, tenant_id, location_id, user_id, vehicle_id, intervention_type_id,
          intervention_date, odometer_km, title, description, parts_replaced,
          status, km_anomaly, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-04-15'::date, 45000,
          'Tagliando A', 'Test', '[]'::jsonb, 'active'::"InterventionStatus",
          false, NOW(), NOW())
       RETURNING id`,
      [tenantAId, locationAId, userAId, vehicleId, interventionTypeId],
    );
    const interventionId = iv[0]!.id;

    return {
      tenantAId,
      tenantBId,
      locationAId,
      userAId,
      customerId,
      vehicleId,
      interventionId,
      interventionTypeId,
    };
  }

  it('cross-tenant SELECT on interventions is permissive (BR-150/BR-153)', async () => {
    const { tenantBId, interventionId } = await seedInterventionForTenantA();

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) => tx.intervention.findMany());
    expect(seenByB.map((i) => i.id)).toContain(interventionId);
  });

  it('customer-pool SELECT on intervention parent works without admin (dispute path)', async () => {
    const { customerId, interventionId } = await seedInterventionForTenantA();

    const seenByCustomer = await withContext({ customerId }, (tx) =>
      tx.intervention.findUnique({ where: { id: interventionId } }),
    );
    expect(seenByCustomer?.id).toBe(interventionId);
  });

  it('cross-tenant INSERT on interventions is blocked', async () => {
    const { tenantAId, tenantBId, locationAId, userAId, vehicleId, interventionTypeId } =
      await seedInterventionForTenantA();

    // tenant B tries to insert an intervention pretending to belong to
    // tenant A. The WITH CHECK on interventions_insert must reject.
    await expect(
      withContext({ tenantId: tenantBId }, (tx) =>
        tx.intervention.create({
          data: {
            tenantId: tenantAId,
            locationId: locationAId,
            userId: userAId,
            vehicleId,
            interventionTypeId,
            interventionDate: new Date('2026-04-20'),
            odometerKm: 50000,
            description: 'Cross-tenant attempt',
            partsReplaced: [],
            kmAnomaly: false,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('cross-tenant UPDATE on interventions returns 0 rows (USING filters row)', async () => {
    const { tenantBId, interventionId } = await seedInterventionForTenantA();

    // tenant B tries to flip status. The USING clause of
    // interventions_update hides the row from tenant B, so updateMany
    // matches 0 rows (no exception raised).
    const result = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.intervention.updateMany({
        where: { id: interventionId },
        data: { status: 'cancelled' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('cross-tenant SELECT on attachments is permissive', async () => {
    const { tenantAId, tenantBId, interventionId, userAId } = await seedInterventionForTenantA();

    await pgAdmin.query(
      `INSERT INTO attachments
         (id, owner_type, owner_id, tenant_id, customer_id, file_name,
          mime_type, size_bytes, s3_key, s3_bucket, uploaded_by_user_id,
          created_at)
       VALUES
         (gen_random_uuid(), 'intervention'::"AttachmentOwnerType", $1, $2, NULL,
          'test.jpg', 'image/jpeg', 1024, 's3://test/key', 'test-bucket', $3,
          NOW())`,
      [interventionId, tenantAId, userAId],
    );

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.attachment.findMany({ where: { ownerId: interventionId } }),
    );
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.tenantId).toBe(tenantAId);
  });

  it('cross-tenant INSERT on attachments is blocked', async () => {
    const { tenantAId, tenantBId, interventionId, userAId } = await seedInterventionForTenantA();

    await expect(
      withContext({ tenantId: tenantBId }, (tx) =>
        tx.attachment.create({
          data: {
            ownerType: 'intervention',
            ownerId: interventionId,
            tenantId: tenantAId, // claiming attachment for tenant A
            fileName: 'evil.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            s3Key: 's3://evil/key',
            s3Bucket: 'evil-bucket',
            uploadedByUserId: userAId,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('cross-tenant SELECT on tenants is permissive (timeline join needs businessName)', async () => {
    const { tenantAId, tenantBId } = await seedInterventionForTenantA();

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantAId },
        select: { id: true, businessName: true },
      }),
    );
    expect(seenByB?.id).toBe(tenantAId);
    expect(seenByB?.businessName).toBe('Officina A');
  });

  it('cross-tenant SELECT on locations is permissive (timeline join needs city)', async () => {
    const { tenantBId, locationAId } = await seedInterventionForTenantA();

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.location.findUnique({
        where: { id: locationAId },
        select: { id: true, city: true },
      }),
    );
    expect(seenByB?.id).toBe(locationAId);
    expect(seenByB?.city).toBe('Milano');
  });

  it('cross-tenant SELECT on intervention_types is permissive', async () => {
    const { tenantBId, interventionTypeId } = await seedInterventionForTenantA();

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.interventionType.findUnique({
        where: { id: interventionTypeId },
        select: { id: true, code: true, nameIt: true },
      }),
    );
    expect(seenByB?.code).toBe('TAGLIANDO');
  });
});

// Migration 0004 splits SELECT/WRITE on `users` so the audit-chain
// joins to users.firstName/lastName (timeline §2.5, revisions list
// §3.6) work cross-tenant without `role: 'admin'` short-lived. WRITE
// remains tenant-scoped. Mirror of the post-0003 pattern on the
// 5 already-split tables.
describe('RLS — users split (post-migration 0004)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedTwoTenantsWithUsers(): Promise<{
    tenantAId: string;
    tenantBId: string;
    userAId: string;
    userBId: string;
  }> {
    const { rows: tA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina A', '11111111111', 'a@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const { rows: tB } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina B', '22222222222', 'b@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantAId = tA[0]!.id;
    const tenantBId = tB[0]!.id;

    const { rows: uA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO users
         (id, tenant_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'a-split@test.it', 'A', 'A',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId, `sub-users-split-A-${Date.now()}`],
    );
    const { rows: uB } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO users
         (id, tenant_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'b-split@test.it', 'B', 'B',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantBId, `sub-users-split-B-${Date.now()}`],
    );

    return {
      tenantAId,
      tenantBId,
      userAId: uA[0]!.id,
      userBId: uB[0]!.id,
    };
  }

  it('cross-tenant SELECT on users is permissive (audit join visibility)', async () => {
    const { tenantAId, userBId } = await seedTwoTenantsWithUsers();

    // Tenant A reads tenant B's user via findUnique. Pre-0004 (single
    // _tenant_isolation policy) this returned null; post-0004
    // (_read FOR SELECT USING (true)) it returns the row.
    const seenByA = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.user.findUnique({
        where: { id: userBId },
        select: { id: true, firstName: true, lastName: true },
      }),
    );
    expect(seenByA?.id).toBe(userBId);
    expect(seenByA?.firstName).toBe('B');
  });

  it('cross-tenant INSERT on users is blocked', async () => {
    const { tenantAId, tenantBId } = await seedTwoTenantsWithUsers();

    // Tenant B tries to create a user pretending to belong to tenant A.
    // _write FOR ALL WITH CHECK rejects: tenant_id ≠ current_tenant_id().
    await expect(
      withContext({ tenantId: tenantBId }, (tx) =>
        tx.user.create({
          data: {
            tenantId: tenantAId,
            cognitoSub: `sub-cross-insert-${Date.now()}`,
            email: 'cross-insert@test.it',
            firstName: 'Cross',
            lastName: 'Insert',
            role: 'mechanic',
            status: 'active',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('cross-tenant UPDATE on users returns 0 rows (USING filters row)', async () => {
    const { tenantBId, userAId } = await seedTwoTenantsWithUsers();

    // Tenant B tries to rename tenant A's user. The USING clause of
    // _write hides the row from tenant B → updateMany count: 0.
    const result = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.user.updateMany({
        where: { id: userAId },
        data: { firstName: 'Hijacked' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('admin role bypasses users tenant filtering', async () => {
    await seedTwoTenantsWithUsers();

    const all = await withContext({ role: 'admin' }, (tx) => tx.user.findMany());
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

// Migration 0004 enables RLS on intervention_revisions (absent
// pre-0004): SELECT permissive (BR-150 audit chain), INSERT
// append-only enforced via EXISTS join to parent intervention,
// no UPDATE/DELETE policies → default deny. Cascade DELETE from
// the parent intervention bypasses RLS via FK CASCADE (mirrors
// intervention_disputes pattern from migration 0002).
describe('RLS — intervention_revisions defense-in-depth (post-migration 0004)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedInterventionWithRevision(): Promise<{
    tenantAId: string;
    tenantBId: string;
    locationAId: string;
    userAId: string;
    customerId: string;
    vehicleId: string;
    interventionId: string;
    revisionId: string;
  }> {
    const { rows: tA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina A', '11111111111', 'a@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const { rows: tB } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina B', '22222222222', 'b@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantAId = tA[0]!.id;
    const tenantBId = tB[0]!.id;

    const { rows: lA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede A', 'Via A 1', 'Milano', 'MI', '20100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId],
    );
    const locationAId = lA[0]!.id;

    const { rows: uA } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO users
         (id, tenant_id, location_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'mech-rev@a.it', 'Mech', 'A',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId, locationAId, `sub-rev-${Date.now()}`],
    );
    const userAId = uA[0]!.id;

    const { rows: cust } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Cust', 'Owner', NOW(), NOW())
       RETURNING id`,
      [`cust-rev-${Date.now()}@test.it`],
    );
    const customerId = cust[0]!.id;

    const { rows: veh } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicles
         (id, vin, plate, plate_country, make, model, year, vehicle_type, fuel_type,
          status, created_by_tenant_id, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'AA111BB', 'IT', 'Fiat', 'Panda', 2021,
          'car'::"VehicleType", 'petrol'::"FuelType",
          'pending'::"VehicleStatus", $2, NOW(), NOW())
       RETURNING id`,
      [`VIN${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 17), tenantAId],
    );
    const vehicleId = veh[0]!.id;

    await pgAdmin.query(
      `INSERT INTO vehicle_ownerships
         (id, vehicle_id, customer_id, started_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
      [vehicleId, customerId],
    );

    const { rows: it } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM intervention_types WHERE tenant_id IS NULL AND code = 'TAGLIANDO' LIMIT 1`,
    );
    const interventionTypeId = it[0]!.id;

    const { rows: iv } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO interventions
         (id, tenant_id, location_id, user_id, vehicle_id, intervention_type_id,
          intervention_date, odometer_km, title, description, parts_replaced,
          status, km_anomaly, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-04-15'::date, 45000,
          'Tagliando A', 'Test', '[]'::jsonb, 'active'::"InterventionStatus",
          false, NOW(), NOW())
       RETURNING id`,
      [tenantAId, locationAId, userAId, vehicleId, interventionTypeId],
    );
    const interventionId = iv[0]!.id;

    const { rows: rv } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO intervention_revisions
         (id, intervention_id, user_id, revised_at, changes, reason)
       VALUES
         (gen_random_uuid(), $1, $2, NOW(),
          '{"description":{"old":"Test","new":"Test v2"}}'::jsonb,
          'Updated description')
       RETURNING id`,
      [interventionId, userAId],
    );
    const revisionId = rv[0]!.id;

    return {
      tenantAId,
      tenantBId,
      locationAId,
      userAId,
      customerId,
      vehicleId,
      interventionId,
      revisionId,
    };
  }

  it('cross-tenant SELECT on intervention_revisions is permissive (audit chain)', async () => {
    const { tenantBId, revisionId } = await seedInterventionWithRevision();

    // Tenant B reads a revision belonging to tenant A's intervention.
    // _read FOR SELECT USING (true) → row visible cross-tenant.
    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.interventionRevision.findUnique({ where: { id: revisionId } }),
    );
    expect(seenByB?.id).toBe(revisionId);
  });

  it('customer-pool SELECT on intervention_revisions works (app-layer guards privacy)', async () => {
    const { customerId, revisionId } = await seedInterventionWithRevision();

    // Customer pool has current_customer_id set, no current_tenant_id.
    // _read FOR SELECT USING (true) is unconditional → row visible.
    // App-layer ownership pre-check is the actual privacy boundary.
    const seenByCustomer = await withContext({ customerId }, (tx) =>
      tx.interventionRevision.findUnique({ where: { id: revisionId } }),
    );
    expect(seenByCustomer?.id).toBe(revisionId);
  });

  it('cross-tenant INSERT on intervention_revisions is blocked', async () => {
    const { tenantBId, interventionId, userAId } = await seedInterventionWithRevision();

    // Tenant B tries to create a revision on tenant A's intervention.
    // _insert WITH CHECK EXISTS(parent.tenant_id = current_tenant_id())
    // returns false → INSERT rejected.
    await expect(
      withContext({ tenantId: tenantBId }, (tx) =>
        tx.interventionRevision.create({
          data: {
            interventionId,
            userId: userAId,
            revisedAt: new Date(),
            changes: { description: { old: 'A', new: 'B' } },
            reason: 'Cross-tenant attempt',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('same-tenant INSERT on intervention_revisions succeeds (PATCH path baseline)', async () => {
    const { tenantAId, interventionId, userAId } = await seedInterventionWithRevision();

    // Tenant A creates a revision on its own intervention.
    // _insert WITH CHECK EXISTS finds parent → INSERT allowed.
    const created = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.interventionRevision.create({
        data: {
          interventionId,
          userId: userAId,
          revisedAt: new Date(),
          changes: { description: { old: 'A', new: 'B' } },
          reason: 'Same-tenant baseline',
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeDefined();
  });

  it('UPDATE on intervention_revisions is blocked even within same tenant (append-only)', async () => {
    const { tenantAId, revisionId } = await seedInterventionWithRevision();

    // No _update policy → RLS default-denies UPDATE for non-admin.
    // updateMany returns count: 0 (USING-style behavior of default deny).
    const result = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.interventionRevision.updateMany({
        where: { id: revisionId },
        data: { reason: 'Modified' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('admin role bypasses intervention_revisions filtering', async () => {
    const { revisionId, interventionId, userAId } = await seedInterventionWithRevision();

    // Admin SELECT cross-tenant + admin INSERT cross-tenant both work.
    const seenByAdmin = await withContext({ role: 'admin' }, (tx) =>
      tx.interventionRevision.findUnique({ where: { id: revisionId } }),
    );
    expect(seenByAdmin?.id).toBe(revisionId);

    const created = await withContext({ role: 'admin' }, (tx) =>
      tx.interventionRevision.create({
        data: {
          interventionId,
          userId: userAId,
          revisedAt: new Date(),
          changes: { reason: { old: 'X', new: 'Y' } },
          reason: 'Admin write',
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeDefined();
  });
});

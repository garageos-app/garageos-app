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

  // Pre-migration 0003 these two smoke tests asserted that
  // `locations` and `tenants` were tenant-isolated for SELECT. The
  // migration intentionally made SELECT cross-tenant on both (BR-150
  // timeline join). Post-split SELECT permissive is now covered by
  // the second describe block below; here we keep one smoke test on
  // a table that DID retain `_tenant_isolation` (users), to preserve
  // a regression guard against accidental wide-open RLS rewrites.
  it('isolates users between tenants (still single-policy isolation)', async () => {
    const { tenantAId, tenantBId } = await seedTwoTenants();
    await pgAdmin.query(
      `INSERT INTO users
         (id, tenant_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'sub-iso-A', 'a-iso@test.it', 'A', 'A',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW()),
         (gen_random_uuid(), $2, 'sub-iso-B', 'b-iso@test.it', 'B', 'B',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())`,
      [tenantAId, tenantBId],
    );

    const seenByA = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.user.findMany({ select: { tenantId: true } }),
    );
    expect(seenByA.every((u) => u.tenantId === tenantAId)).toBe(true);

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.user.findMany({ select: { tenantId: true } }),
    );
    expect(seenByB.every((u) => u.tenantId === tenantBId)).toBe(true);
  });

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

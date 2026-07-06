import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { getSystemInterventionTypeId, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Migration 20260702130000_checklist_foundation adds 4 tables backing
// the checklist redesign arc (spec:
// docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md).
// RLS pattern mirrors 20260427120000_split_interventions_attachments_rls:
//   catalog (checklist items): SELECT USING(true), WRITE admin-only.
//   exclusions: SELECT tenant-scoped, WRITE admin-only.
//   selections: mirror interventions (SELECT USING(true), WRITE tenant-scoped).
// Fixtures go through pgAdmin (bypasses RLS); the assertions run
// through withContext() so the app_test role's policies actually
// execute, mirroring rls.test.ts.
describe('RLS — checklist foundation (post-migration checklist_foundation)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Seed two tenants, a full intervention chain for tenant A (user,
   * customer, vehicle, intervention) on the system MECCANICO type, and
   * one checklist item on that type. Mirrors seedInterventionForTenantA
   * in rls.test.ts with an extra checklist item fixture.
   */
  async function seedChecklistFoundation(): Promise<{
    tenantAId: string;
    tenantBId: string;
    userAId: string;
    vehicleId: string;
    interventionId: string;
    interventionTypeId: string;
    otherInterventionTypeId: string;
    checklistItemId: string;
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
         (gen_random_uuid(), $1, $2, 'mech@a.it', 'Mech', 'A',
          'mechanic'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantAId, `sub-checklist-${Date.now()}`],
    );
    const userAId = uA[0]!.id;

    const { rows: cust } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Cust', 'Owner', NOW(), NOW())
       RETURNING id`,
      [`cust-checklist-${Date.now()}@test.it`],
    );
    const customerId = cust[0]!.id;

    const { rows: veh } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicles
         (id, vin, plate, plate_country, make, model, year, vehicle_type, fuel_type,
          status, created_by_tenant_id, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'AA222BB', 'IT', 'Fiat', 'Panda', 2021,
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

    const interventionTypeId = await getSystemInterventionTypeId('MECCANICO');
    const otherInterventionTypeId = await getSystemInterventionTypeId('GOMME');

    const { rows: iv } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO interventions
         (id, tenant_id, user_id, vehicle_id, intervention_type_id,
          intervention_date, odometer_km, description, parts_replaced,
          status, km_anomaly, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, '2026-04-15'::date, 45000,
          'Test', '[]'::jsonb, 'active'::"InterventionStatus",
          false, NOW(), NOW())
       RETURNING id`,
      [tenantAId, userAId, vehicleId, interventionTypeId],
    );
    const interventionId = iv[0]!.id;

    const { rows: item } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO intervention_checklist_items
         (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'CAMBIO_OLIO', 'Cambio olio', 10, true, NOW(), NOW())
       RETURNING id`,
      [interventionTypeId],
    );
    const checklistItemId = item[0]!.id;

    return {
      tenantAId,
      tenantBId,
      userAId,
      vehicleId,
      interventionId,
      interventionTypeId,
      otherInterventionTypeId,
      checklistItemId,
    };
  }

  it('catalog read is permissive — any tenant sees a checklist item of a global type', async () => {
    const { tenantBId, checklistItemId } = await seedChecklistFoundation();

    // checklist_items_read: FOR SELECT USING (true) — tenant B (unrelated
    // to the fixture's tenant A) can still read the catalog row.
    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.interventionChecklistItem.findUnique({ where: { id: checklistItemId } }),
    );
    expect(seenByB?.id).toBe(checklistItemId);
  });

  it('catalog write is admin-only — tenant INSERT rejected, admin INSERT succeeds', async () => {
    const { tenantAId, interventionTypeId } = await seedChecklistFoundation();

    // checklist_items_write: FOR ALL USING/WITH CHECK (is_admin_role()).
    // A plain tenant context has no admin role → INSERT must reject.
    await expect(
      withContext({ tenantId: tenantAId }, (tx) =>
        tx.interventionChecklistItem.create({
          data: {
            interventionTypeId,
            code: 'TENANT_ATTEMPT',
            nameIt: 'Tentativo tenant',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);

    // Admin role bypasses the write policy.
    const created = await withContext({ role: 'admin' }, (tx) =>
      tx.interventionChecklistItem.create({
        data: {
          interventionTypeId,
          code: 'ADMIN_ATTEMPT',
          nameIt: 'Tentativo admin',
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeDefined();
  });

  it('intervention-type exclusions: SELECT is tenant-scoped (negative)', async () => {
    const { tenantAId, tenantBId, interventionTypeId } = await seedChecklistFoundation();

    // Fixture created via admin (write is admin-only per test below).
    await withContext({ role: 'admin' }, (tx) =>
      tx.tenantInterventionTypeExclusion.create({
        data: { tenantId: tenantAId, interventionTypeId },
      }),
    );

    // type_excl_read: FOR SELECT USING (is_admin_role() OR tenant_id =
    // current_tenant_id()) — tenant B must not see tenant A's exclusion.
    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.tenantInterventionTypeExclusion.findMany({
        where: { interventionTypeId },
      }),
    );
    expect(seenByB).toEqual([]);

    // Tenant A sees its own exclusion.
    const seenByA = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.tenantInterventionTypeExclusion.findMany({
        where: { interventionTypeId },
      }),
    );
    expect(seenByA.map((e) => e.tenantId)).toContain(tenantAId);
  });

  it('intervention-type exclusions: WRITE is admin-only (negative)', async () => {
    const { tenantAId, interventionTypeId } = await seedChecklistFoundation();

    // type_excl_write: FOR ALL USING/WITH CHECK (is_admin_role()).
    // Tenant A tries to insert an exclusion for itself — rejected.
    await expect(
      withContext({ tenantId: tenantAId }, (tx) =>
        tx.tenantInterventionTypeExclusion.create({
          data: { tenantId: tenantAId, interventionTypeId },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('selections: WRITE is tenant-scoped (negative)', async () => {
    const { tenantAId, tenantBId, interventionId, checklistItemId } =
      await seedChecklistFoundation();

    // selections_insert: WITH CHECK (is_admin_role() OR tenant_id =
    // current_tenant_id()). Tenant A inserting a selection with its own
    // tenantId succeeds.
    const created = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.interventionChecklistSelection.create({
        data: {
          interventionId,
          tenantId: tenantAId,
          checklistItemId,
          labelSnapshot: 'Cambio olio',
          sortOrderSnapshot: 10,
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeDefined();

    // Same tenant A session inserting a row that claims tenantId B is
    // rejected by the WITH CHECK clause. Use a second checklist item
    // (or null) so the failure is unambiguously the RLS check, not the
    // uq_selection_intervention_item unique index.
    await expect(
      withContext({ tenantId: tenantAId }, (tx) =>
        tx.interventionChecklistSelection.create({
          data: {
            interventionId,
            tenantId: tenantBId,
            checklistItemId: null,
            labelSnapshot: 'Cambio olio (spoofed)',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('selections: SELECT is permissive (cross-tenant timeline read)', async () => {
    const { tenantAId, tenantBId, interventionId, checklistItemId } =
      await seedChecklistFoundation();

    const { rows: sel } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO intervention_checklist_selections
         (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, sort_order_snapshot, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Cambio olio', 10, NOW())
       RETURNING id`,
      [interventionId, tenantAId, checklistItemId],
    );
    const selectionId = sel[0]!.id;

    // selections_read: FOR SELECT USING (true) — tenant B (unrelated)
    // can still read tenant A's selection for the shared timeline view.
    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.interventionChecklistSelection.findUnique({ where: { id: selectionId } }),
    );
    expect(seenByB?.id).toBe(selectionId);
  });

  it('snapshot survives catalog item deletion (onDelete SetNull)', async () => {
    const { tenantAId, interventionId, checklistItemId } = await seedChecklistFoundation();

    const { rows: sel } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO intervention_checklist_selections
         (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, sort_order_snapshot, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Cambio olio', 10, NOW())
       RETURNING id`,
      [interventionId, tenantAId, checklistItemId],
    );
    const selectionId = sel[0]!.id;

    // Admin deletes the catalog row. ics_item_fkey is ON DELETE SET NULL,
    // so the referencing selection survives with checklist_item_id
    // nulled out; label_snapshot (denormalized at selection time) is
    // untouched — that's the whole point of the snapshot.
    await withContext({ role: 'admin' }, (tx) =>
      tx.interventionChecklistItem.delete({ where: { id: checklistItemId } }),
    );

    const survivor = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.interventionChecklistSelection.findUnique({ where: { id: selectionId } }),
    );
    expect(survivor).not.toBeNull();
    expect(survivor?.checklistItemId).toBeNull();
    expect(survivor?.labelSnapshot).toBe('Cambio olio');
  });

  it('BR-307: checklist item code is unique per intervention type', async () => {
    const { interventionTypeId, otherInterventionTypeId } = await seedChecklistFoundation();

    // Same code, same type as the fixture's CAMBIO_OLIO item → violates
    // uq_checklist_item_code_type.
    await expect(
      withContext({ role: 'admin' }, (tx) =>
        tx.interventionChecklistItem.create({
          data: {
            interventionTypeId,
            code: 'CAMBIO_OLIO',
            nameIt: 'Cambio olio duplicato',
          },
        }),
      ),
    ).rejects.toThrow(/uq_checklist_item_code_type|unique constraint/i);

    // Same code, different type → allowed (uniqueness is scoped per type).
    const created = await withContext({ role: 'admin' }, (tx) =>
      tx.interventionChecklistItem.create({
        data: {
          interventionTypeId: otherInterventionTypeId,
          code: 'CAMBIO_OLIO',
          nameIt: 'Cambio olio (altro tipo)',
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeDefined();
  });
});

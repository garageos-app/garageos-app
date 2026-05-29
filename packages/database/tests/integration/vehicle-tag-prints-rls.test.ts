import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { createTenantWithLocation, createUser, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// RLS integration tests for vehicle_tag_prints (F-OFF-104 / BR-027).
//
// Policy contract (migration 20260529120000_vehicle_tag_prints):
//   - SELECT permissive:  tenant_id = current_tenant_id() OR is_admin_role()
//   - INSERT strict:      tenant_id = current_tenant_id()  (no admin bypass)
//   - UPDATE/DELETE:      default-deny (append-only audit log)
//
// Test strategy:
//   - Fixtures are inserted via pgAdmin (superuser, bypasses RLS).
//   - Assertions run via withContext() so policies execute against the
//     app_test role (garageos_app).

describe('RLS — vehicle_tag_prints (post-migration 20260529120000)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Seed two tenants, each with a location, a user, and a vehicle.
   * Returns enough context to drive all 7 test cases.
   */
  async function seedTwoTenantsWithVehicle(): Promise<{
    tenantAId: string;
    tenantBId: string;
    vehicleAId: string;
    userAId: string;
  }> {
    const { tenantId: tenantAId } = await createTenantWithLocation();
    const { tenantId: tenantBId } = await createTenantWithLocation();

    const { id: userAId } = await createUser({ tenantId: tenantAId });
    const { vehicleId: vehicleAId } = await createVehicle({ tenantId: tenantAId });

    return { tenantAId, tenantBId, vehicleAId, userAId };
  }

  /**
   * Insert a vehicle_tag_prints row directly via pgAdmin (bypasses
   * RLS). Used by tests that need a pre-existing row for SELECT/UPDATE/
   * DELETE assertions.
   */
  async function seedTagPrint(opts: {
    tenantId: string;
    vehicleId: string;
    printedByUserId: string;
    kind?: 'first' | 'reprint';
  }): Promise<{ printId: string }> {
    const kind = opts.kind ?? 'first';
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicle_tag_prints
         (id, vehicle_id, tenant_id, printed_by_user_id, kind, document_verified, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4::"TagPrintKind", false, NOW())
       RETURNING id`,
      [opts.vehicleId, opts.tenantId, opts.printedByUserId, kind],
    );
    return { printId: rows[0]!.id };
  }

  // --- Test 1 ---
  it('same-tenant INSERT succeeds (tenant role, own tenantId)', async () => {
    const { tenantAId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    // Tenant A inserts a print record for its own tenant. The INSERT
    // policy WITH CHECK (tenant_id = current_tenant_id()) allows this.
    const created = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.vehicleTagPrint.create({
        data: {
          vehicleId: vehicleAId,
          tenantId: tenantAId,
          printedByUserId: userAId,
          kind: 'first',
          documentVerified: false,
        },
        select: { id: true, tenantId: true },
      }),
    );
    expect(created.id).toBeDefined();
    expect(created.tenantId).toBe(tenantAId);
  });

  // --- Test 2 ---
  it('cross-tenant INSERT denied (tenant role claims foreign tenantId)', async () => {
    const { tenantAId, tenantBId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    // Tenant B tries to insert a print record claiming tenant A's id.
    // INSERT policy WITH CHECK (tenant_id = current_tenant_id()) rejects
    // because tenantAId ≠ current_tenant_id() (which is tenantBId).
    await expect(
      withContext({ tenantId: tenantBId }, (tx) =>
        tx.vehicleTagPrint.create({
          data: {
            vehicleId: vehicleAId,
            tenantId: tenantAId, // cross-tenant claim
            printedByUserId: userAId,
            kind: 'reprint',
            documentVerified: false,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  // --- Test 3 ---
  it('cross-tenant SELECT returns no rows (tenant role sees own rows only)', async () => {
    const { tenantAId, tenantBId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    // Pre-seed a print for tenant A via pgAdmin (bypasses RLS).
    await seedTagPrint({ tenantId: tenantAId, vehicleId: vehicleAId, printedByUserId: userAId });

    // Tenant B should not see tenant A's print: SELECT USING filters
    // to tenant_id = current_tenant_id() unless is_admin_role().
    const seenByB = await withContext({ tenantId: tenantBId }, (tx) =>
      tx.vehicleTagPrint.findMany(),
    );
    expect(seenByB).toHaveLength(0);
  });

  // --- Test 4 ---
  it('UPDATE denied in tenant role (append-only audit table)', async () => {
    const { tenantAId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    await seedTagPrint({ tenantId: tenantAId, vehicleId: vehicleAId, printedByUserId: userAId });

    // No UPDATE policy → default-deny. updateMany returns count 0 (the
    // USING clause of default-deny hides the row from the update target set).
    const result = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.vehicleTagPrint.updateMany({
        where: { tenantId: tenantAId },
        data: { documentVerified: true },
      }),
    );
    expect(result.count).toBe(0);
  });

  // --- Test 5 ---
  it('DELETE denied in tenant role (append-only audit table)', async () => {
    const { tenantAId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    const { printId } = await seedTagPrint({
      tenantId: tenantAId,
      vehicleId: vehicleAId,
      printedByUserId: userAId,
    });

    // No DELETE policy → default-deny. deleteMany returns count 0.
    const result = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.vehicleTagPrint.deleteMany({
        where: { id: printId },
      }),
    );
    expect(result.count).toBe(0);
  });

  // --- Test 6 ---
  it('admin role SELECT sees cross-tenant rows (admin bypass on SELECT)', async () => {
    const { tenantAId, vehicleAId, userAId } = await seedTwoTenantsWithVehicle();

    const { printId } = await seedTagPrint({
      tenantId: tenantAId,
      vehicleId: vehicleAId,
      printedByUserId: userAId,
      kind: 'first',
    });

    // Admin SELECT policy: is_admin_role() → row visible regardless of
    // which tenant context is active.
    const seenByAdmin = await withContext({ role: 'admin' }, (tx) =>
      tx.vehicleTagPrint.findUnique({ where: { id: printId } }),
    );
    expect(seenByAdmin?.id).toBe(printId);
    expect(seenByAdmin?.tenantId).toBe(tenantAId);
  });

  // --- Test 7 ---
  it('INSERT with non-existent vehicle_id raises FK violation (SQLSTATE 23503)', async () => {
    const { tenantAId, userAId } = await seedTwoTenantsWithVehicle();

    const nonExistentVehicleId = randomUUID();

    // vehicle_tag_prints.vehicle_id FK → vehicles.id with no ON DELETE
    // SET NULL → Postgres raises 23503 foreign_key_violation; Prisma
    // surfaces this as a PrismaClientKnownRequestError (P2003) or a
    // generic throw from the driver.
    await expect(
      withContext({ tenantId: tenantAId }, (tx) =>
        tx.vehicleTagPrint.create({
          data: {
            vehicleId: nonExistentVehicleId,
            tenantId: tenantAId,
            printedByUserId: userAId,
            kind: 'first',
            documentVerified: false,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

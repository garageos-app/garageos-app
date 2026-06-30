import { beforeEach, describe, expect, it } from 'vitest';

import { createTenant, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-001 — VIN è univoco globalmente. Enforcement: `@unique` in
// schema.prisma line 353 + `vehicles_vin_key` unique index in the init
// migration. This suite verifies the constraint fires in the cross-tenant
// scenarios we care about (different tenants, archived vehicles), beyond
// the Prisma-generated type check.

describe('BR-001 — VIN uniqueness (global)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const SHARED_VIN = 'ZFA16900000099991';

  async function insertVehicle(tenantId: string | null, vin: string): Promise<void> {
    await pgAdmin.query(
      `INSERT INTO vehicles
         (id, vin, plate, make, model, year, vehicle_type, fuel_type, status,
          created_by_tenant_id, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'AB123CD', 'Fiat', 'Panda', 2021,
          'car'::"VehicleType", 'petrol'::"FuelType", 'pending'::"VehicleStatus",
          $2, NOW(), NOW())`,
      [vin, tenantId],
    );
  }

  it('rejects duplicate VIN across different tenants', async () => {
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();

    await insertVehicle(tenantA, SHARED_VIN);

    await expect(insertVehicle(tenantB, SHARED_VIN)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects duplicate VIN within the same tenant', async () => {
    const { tenantId } = await createTenant();

    await insertVehicle(tenantId, SHARED_VIN);

    await expect(insertVehicle(tenantId, SHARED_VIN)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects a new vehicle with the same VIN as an archived one', async () => {
    // BR-008 (archive) does not free the VIN. Schema `@unique` has no
    // partial clause, so archived rows still occupy the slot.
    const { tenantId } = await createTenant();

    await pgAdmin.query(
      `INSERT INTO vehicles
         (id, vin, plate, make, model, year, vehicle_type, fuel_type, status,
          created_by_tenant_id, archived_at, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'AB123CD', 'Fiat', 'Panda', 2021,
          'car'::"VehicleType", 'petrol'::"FuelType",
          'archived'::"VehicleStatus", $2, NOW(), NOW(), NOW())`,
      [SHARED_VIN, tenantId],
    );

    await expect(insertVehicle(tenantId, SHARED_VIN)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('treats VIN as byte-exact — differs-only-by-case is accepted at DB level', async () => {
    // Case normalization is a service-layer concern (BR-001 spec says
    // uppercase VIN required at input). The DB does not enforce
    // casefold uniqueness, and this test documents that boundary so a
    // future reader understands why `abc…` and `ABC…` coexist.
    const { tenantId } = await createTenant();
    const lower = 'zfa16900000099992';
    const upper = 'ZFA16900000099992';

    await insertVehicle(tenantId, lower);
    await expect(insertVehicle(tenantId, upper)).resolves.not.toThrow();
  });
});

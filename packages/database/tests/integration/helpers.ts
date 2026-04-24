import { SYSTEM_INTERVENTION_TYPES } from '../../src/seed-data.js';

import { pgAdmin } from './setup.js';

// Tables wiped between tests. intervention_types is included because
// TRUNCATE CASCADE would cascade from tenants anyway (the tenant_id
// FK has ON DELETE CASCADE); we re-seed the system rows right after
// so subsequent tests can still reference them.
const TABLES_TO_WIPE = [
  'deadline_notifications',
  'deadlines',
  'intervention_disputes',
  'intervention_revisions',
  'interventions',
  'private_interventions',
  'attachments',
  'vehicle_transfers',
  'vehicle_ownerships',
  'vehicles',
  'customer_tenant_relations',
  'customers',
  'access_logs',
  'audit_logs',
  'invitations',
  'push_tokens',
  'users',
  'locations',
  'tenants',
  'intervention_types',
];

async function reseedInterventionTypes(): Promise<void> {
  for (const t of SYSTEM_INTERVENTION_TYPES) {
    await pgAdmin.query(
      `INSERT INTO intervention_types
         (id, tenant_id, code, name_it, description, icon, category,
          suggests_deadline, default_deadline_months, default_deadline_km,
          active, created_at, updated_at)
       VALUES
         (gen_random_uuid(), NULL, $1, $2, $3, $4, $5::"InterventionTypeCategory",
          $6, $7, $8, true, NOW(), NOW())`,
      [
        t.code,
        t.nameIt,
        t.description,
        t.icon,
        t.category,
        t.suggestsDeadline,
        t.defaultDeadlineMonths,
        t.defaultDeadlineKm,
      ],
    );
  }
}

/**
 * Wipe data between tests and re-seed system intervention types.
 * Uses pgAdmin (superuser) so TRUNCATE/INSERT aren't subject to RLS
 * or the BR-282 audit immutability trigger.
 */
export async function resetDb(): Promise<void> {
  const list = TABLES_TO_WIPE.map((t) => `"${t}"`).join(', ');
  await pgAdmin.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  await reseedInterventionTypes();
}

/**
 * Pick an intervention type re-seeded by resetDb. Used by fixtures
 * that need a valid interventionTypeId without setting up one
 * manually.
 */
export async function getSystemInterventionTypeId(code = 'TAGLIANDO'): Promise<string> {
  const { rows } = await pgAdmin.query<{ id: string }>(
    `SELECT id FROM intervention_types WHERE tenant_id IS NULL AND code = $1 LIMIT 1`,
    [code],
  );
  if (rows.length === 0) {
    throw new Error(`Seed did not create system intervention type ${code}; check prisma/seed.ts.`);
  }
  return rows[0]!.id;
}

/**
 * Create a vehicle via pgAdmin (bypasses RLS) with sane defaults.
 * Used by the BR coverage suite to shortcut "given a vehicle, …"
 * preambles — not a substitute for the fishery factories in
 * `src/factories` (which go through Prisma and exercise the RLS
 * write path).
 */
export async function createVehicle(opts: {
  tenantId?: string;
  status?: 'pending' | 'certified' | 'archived';
  vin?: string;
  garageCode?: string | null;
}): Promise<{ vehicleId: string; vin: string }> {
  const status = opts.status ?? 'pending';
  const vin =
    opts.vin ??
    `VIN${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 1e6)
      .toString()
      .padStart(6, '0')}`;
  const garageCode =
    status === 'certified'
      ? (opts.garageCode ??
        `GO-${randomDigit()}${randomDigit()}${randomDigit()}-${randomLetter()}${randomLetter()}${randomLetter()}${randomLetter()}`)
      : null;

  // certified vehicles must satisfy chk_certified_consistency; that
  // needs a certifying tenant, a certified_at, and a garage_code all
  // present together. Pending vehicles get created_by_tenant_id set
  // so RLS insert policy passes even if the caller wires the row up
  // later via raw SQL (superuser bypasses RLS here, but keeping the
  // shape faithful to production avoids surprises).
  const tenantId = opts.tenantId ?? null;

  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO vehicles
       (id, garage_code, vin, plate, make, model, year, vehicle_type, fuel_type,
        status, certified_by_tenant_id, certified_at, created_by_tenant_id,
        created_at, updated_at, archived_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, 'Fiat', 'Panda', 2021,
        'car'::"VehicleType", 'petrol'::"FuelType", $4::"VehicleStatus",
        $5, $6, $7, NOW(), NOW(), $8)
     RETURNING id`,
    [
      garageCode,
      vin,
      `AA${Math.floor(Math.random() * 900 + 100)}BB`,
      status,
      status === 'certified' ? tenantId : null,
      status === 'certified' ? new Date() : null,
      tenantId,
      status === 'archived' ? new Date() : null,
    ],
  );
  return { vehicleId: rows[0]!.id, vin };
}

function randomDigit(): string {
  // BR-020 allows 2-9 only.
  return String(Math.floor(Math.random() * 8) + 2);
}
function randomLetter(): string {
  // BR-020 allows A-H, J-N, P, R-T, V-Z (21 letters; excludes I/O/Q/S/U).
  // Schema regex is the authoritative definition — see common validators.
  const LETTERS = 'ABCDEFGHJKLMNPRTVWXYZ';
  return LETTERS[Math.floor(Math.random() * LETTERS.length)]!;
}

/**
 * Create a customer and attach it to `tenantId` via a
 * `customer_tenant_relation`. The relation is what opens the BR-151
 * write path in the `customers_write_by_related_tenant` RLS policy,
 * so tests that verify that policy need this setup.
 */
export async function createCustomerWithRelation(tenantId: string): Promise<{
  customerId: string;
  relationId: string;
}> {
  const { rows: cRows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'Mario', 'Rossi', NOW(), NOW())
     RETURNING id`,
    [`customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`],
  );
  const customerId = cRows[0]!.id;

  const { rows: rRows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customer_tenant_relations
       (id, tenant_id, customer_id, intervention_count, customer_deleted,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 0, false, NOW(), NOW())
     RETURNING id`,
    [tenantId, customerId],
  );
  return { customerId, relationId: rRows[0]!.id };
}

/**
 * Create a tenant + a primary location in one transaction so both
 * commit (or roll back) together.
 */
export async function createTenantWithLocation(): Promise<{
  tenantId: string;
  locationId: string;
}> {
  return pgAdmin.tx(async (client) => {
    const { rows: tenantRows } = await client.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test Tenant ${Date.now()}`, `${Math.floor(Math.random() * 1e11)}`, 'test@test.it'],
    );
    const tenantId = tenantRows[0]!.id;
    const { rows: locationRows } = await client.query<{ id: string }>(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code,
          country, is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede', 'Via Test 1', 'Milano', 'MI',
          '20100', 'IT', true, 'active'::"LocationStatus", NOW(), NOW())
       RETURNING id`,
      [tenantId],
    );
    return { tenantId, locationId: locationRows[0]!.id };
  });
}

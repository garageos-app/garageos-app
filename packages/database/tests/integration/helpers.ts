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

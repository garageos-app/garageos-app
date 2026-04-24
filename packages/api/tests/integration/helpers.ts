import { pgAdmin } from './setup.js';

// Subset of packages/database/tests/integration/helpers.ts — keeping
// only the helpers this package's integration suite actually uses.
// Duplication over import is intentional: integration-test helpers
// are test fixtures, not runtime code, so sharing them would couple
// two packages' test harnesses.

// Tables wiped between tests. Matches the superset in the database
// package minus intervention_types re-seeding (api tests so far do not
// need those rows).
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
];

export async function resetDb(): Promise<void> {
  const list = TABLES_TO_WIPE.map((t) => `"${t}"`).join(', ');
  await pgAdmin.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function createTenantWithLocation(
  suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ tenantId: string; locationId: string }> {
  return pgAdmin.tx(async (client) => {
    const { rows: tenantRows } = await client.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test Tenant ${suffix}`, `${Math.floor(Math.random() * 1e11)}`, `t-${suffix}@test.it`],
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

// Insert a users row via pgAdmin (superuser — bypasses RLS) for
// integration-test fixtures. The HTTP call under test goes through
// app_test (non-superuser) so RLS still runs at query time.
export async function createUser(params: {
  tenantId: string;
  cognitoSub: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: 'super_admin' | 'mechanic';
  locationId?: string | null;
}): Promise<{ userId: string }> {
  const {
    tenantId,
    cognitoSub,
    email = `user-${cognitoSub.slice(0, 8)}@test.it`,
    firstName = 'Test',
    lastName = 'User',
    role = 'mechanic',
    locationId = null,
  } = params;

  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO users (id, tenant_id, location_id, cognito_sub, email, first_name,
       last_name, role, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::"UserRole",
       'active'::"UserStatus", NOW(), NOW())
     RETURNING id`,
    [tenantId, locationId, cognitoSub, email, firstName, lastName, role],
  );
  return { userId: rows[0]!.id };
}

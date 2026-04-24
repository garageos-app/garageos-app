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

// Customer fixture: admin-session insert bypasses RLS so we can seed a
// row even when no customer_tenant_relation exists yet (the test file
// controls relation presence explicitly per scenario).
export async function createCustomer(params: {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
}): Promise<{ customerId: string; email: string }> {
  const {
    email = `cust-${Math.random().toString(36).slice(2, 10)}@test.it`,
    firstName = 'Mario',
    lastName = 'Rossi',
    phone = '+39 333 1234567',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customers (id, email, first_name, last_name, phone, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active'::"CustomerStatus", NOW(), NOW())
     RETURNING id`,
    [email, firstName, lastName, phone],
  );
  return { customerId: rows[0]!.id, email };
}

// BR-020 garage_code alphabet: digits 2-9 (no 0/1/1), letters minus
// I/O/Q/U. Mirrors the regex in chk_garage_code_format.
const GARAGE_CODE_DIGITS = '23456789';
const GARAGE_CODE_LETTERS = 'ABCDEFGHJKLMNPRTVWXYZ';

function pickChar(alphabet: string): string {
  return alphabet[Math.floor(Math.random() * alphabet.length)]!;
}

function generateGarageCode(): string {
  const digits = Array.from({ length: 3 }, () => pickChar(GARAGE_CODE_DIGITS)).join('');
  const letters = Array.from({ length: 4 }, () => pickChar(GARAGE_CODE_LETTERS)).join('');
  return `GO-${digits}-${letters}`;
}

// Vehicle fixture. created_by_tenant_id defaults to the certifying
// tenant so the vehicles_insert RLS policy is satisfied even when we
// later re-seed via a non-superuser session (not used by these tests
// but keeps the fixture future-proof).
export async function createVehicle(params: {
  createdByTenantId: string;
  certifiedByTenantId?: string | null;
  vin?: string;
  plate?: string;
  garageCode?: string;
  make?: string;
  model?: string;
  year?: number;
  status?: 'pending' | 'certified' | 'archived';
}): Promise<{ vehicleId: string; vin: string; plate: string; garageCode: string | null }> {
  const {
    createdByTenantId,
    certifiedByTenantId = createdByTenantId,
    vin = `ZFA${Math.floor(Math.random() * 1e14)
      .toString()
      .padStart(14, '0')}`,
    plate = `AB${Math.floor(Math.random() * 1e5)
      .toString()
      .padStart(5, '0')}`,
    make = 'Fiat',
    model = 'Panda',
    year = 2021,
    status = 'certified',
  } = params;
  // BR-003 chk_pending_consistency: pending vehicles MUST have
  // garage_code NULL. Override only when caller passes one explicitly.
  const garageCode = params.garageCode ?? (status === 'pending' ? null : generateGarageCode());
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO vehicles (id, garage_code, vin, plate, plate_country, make, model, year,
       vehicle_type, fuel_type, status, created_by_tenant_id, certified_by_tenant_id,
       certified_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'IT', $4, $5, $6,
       'car'::"VehicleType", 'petrol'::"FuelType", $7::"VehicleStatus", $8, $9,
       CASE WHEN $7 = 'certified' THEN NOW() ELSE NULL END, NOW(), NOW())
     RETURNING id`,
    [garageCode, vin, plate, make, model, year, status, createdByTenantId, certifiedByTenantId],
  );
  return { vehicleId: rows[0]!.id, vin, plate, garageCode };
}

export async function createOwnership(params: {
  vehicleId: string;
  customerId: string;
  startedAt?: Date;
}): Promise<{ ownershipId: string }> {
  const { vehicleId, customerId, startedAt = new Date() } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW())
     RETURNING id`,
    [vehicleId, customerId, startedAt],
  );
  return { ownershipId: rows[0]!.id };
}

export async function createCustomerTenantRelation(params: {
  tenantId: string;
  customerId: string;
}): Promise<{ relationId: string }> {
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customer_tenant_relations
       (id, tenant_id, customer_id, intervention_count, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 0, NOW(), NOW())
     RETURNING id`,
    [params.tenantId, params.customerId],
  );
  return { relationId: rows[0]!.id };
}

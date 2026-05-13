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
  // Set when the test needs a customer that authenticates via the
  // clienti pool. Mirrors the cognito_sub linkage flow at signup
  // (BR-130 — customer Cognito → Customer row mapping).
  cognitoSub?: string | null;
  // BR-226 channel × event toggles. Defaults to `{}` so the
  // application-side fallback (DEFAULT_NOTIFICATION_PREFERENCES) kicks
  // in — matches signup behavior.
  notificationPreferences?: object;
  // B2B optional fields exposed so the customers/search suite can
  // exercise businessName matching. Default false/null preserves the
  // existing B2C-shaped fixture.
  isBusiness?: boolean;
  businessName?: string | null;
  vatNumber?: string | null;
  // Allow seeding pending_verification / deleted rows to verify the
  // status='active' filter. Default 'active' preserves the previous
  // behavior of every existing call site.
  status?: 'active' | 'pending_verification' | 'deleted';
  // Anagrafica fields used by customer detail/edit suite (Task 3/4).
  // Default null preserves existing B2C fixture behavior at every prior
  // call site.
  taxCode?: string | null;
  addressLine?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
}): Promise<{ customerId: string; email: string }> {
  const {
    email = `cust-${Math.random().toString(36).slice(2, 10)}@test.it`,
    firstName = 'Mario',
    lastName = 'Rossi',
    phone = '+39 333 1234567',
    cognitoSub = null,
    notificationPreferences = {},
    isBusiness = false,
    businessName = null,
    vatNumber = null,
    status = 'active',
    taxCode = null,
    addressLine = null,
    city = null,
    province = null,
    postalCode = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customers
       (id, cognito_sub, email, first_name, last_name, phone,
        tax_code, is_business, business_name, vat_number,
        address_line, city, province, postal_code,
        status, notification_preferences, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14::"CustomerStatus", $15::jsonb, NOW(), NOW())
     RETURNING id`,
    [
      cognitoSub,
      email,
      firstName,
      lastName,
      phone,
      taxCode,
      isBusiness,
      businessName,
      vatNumber,
      addressLine,
      city,
      province,
      postalCode,
      status,
      JSON.stringify(notificationPreferences),
    ],
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
  endedAt?: Date;
}): Promise<{ ownershipId: string }> {
  const { vehicleId, customerId, startedAt = new Date(), endedAt = null } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, ended_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
     RETURNING id`,
    [vehicleId, customerId, startedAt, endedAt],
  );
  return { ownershipId: rows[0]!.id };
}

export async function createCustomerTenantRelation(params: {
  tenantId: string;
  customerId: string;
  customerDeleted?: boolean;
  // Fields used by customer detail/edit suite (Task 3/4) to verify CTR
  // data surfaced in the GET /customers/:id response. Defaults mirror
  // DB column defaults so existing call sites are unaffected.
  tenantNotes?: string | null;
  interventionCount?: number;
  firstInterventionAt?: Date | null;
  lastInterventionAt?: Date | null;
}): Promise<{ relationId: string }> {
  const {
    tenantId,
    customerId,
    customerDeleted = false,
    tenantNotes = null,
    interventionCount = 0,
    firstInterventionAt = null,
    lastInterventionAt = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customer_tenant_relations
       (id, tenant_id, customer_id, intervention_count,
        first_intervention_at, last_intervention_at,
        tenant_notes, customer_deleted, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3,
        $4, $5,
        $6, $7, NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      customerId,
      interventionCount,
      firstInterventionAt,
      lastInterventionAt,
      tenantNotes,
      customerDeleted,
    ],
  );
  return { relationId: rows[0]!.id };
}

// Direct pgAdmin insert (bypasses RLS) — cross-tenant fixtures don't
// need to drive the public POST. `partsReplaced` defaults to a 2-item
// array so timeline `parts_replaced_count` is non-zero.
export async function createIntervention(params: {
  tenantId: string;
  locationId: string;
  userId: string;
  vehicleId: string;
  interventionTypeId: string;
  interventionDate: string; // YYYY-MM-DD
  odometerKm: number;
  title?: string | null;
  description?: string;
  partsReplaced?: unknown[];
  status?: 'active' | 'disputed' | 'cancelled';
  internalNotes?: string | null;
  // BR-062 wiki-window time-travel for tests. createdAt backdate seeds
  // the >=48h elapsed condition; firstSeenByCustomerAt seeds the
  // customer-saw-it condition; wikiLockedAt seeds the persisted lock.
  // All three are applied via a follow-up UPDATE because Prisma cannot
  // override `default(now())` or `@updatedAt`.
  createdAt?: Date;
  firstSeenByCustomerAt?: Date | null;
  wikiLockedAt?: Date | null;
}): Promise<{ interventionId: string }> {
  const {
    tenantId,
    locationId,
    userId,
    vehicleId,
    interventionTypeId,
    interventionDate,
    odometerKm,
    title = null,
    description = 'Test intervention',
    partsReplaced = [{ name: 'Olio' }, { name: 'Filtro' }],
    status = 'active',
    internalNotes = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO interventions
       (id, tenant_id, location_id, user_id, vehicle_id, intervention_type_id,
        intervention_date, odometer_km, title, description, parts_replaced,
        internal_notes, status, km_anomaly, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::date, $7, $8, $9,
        $10::jsonb, $11, $12::"InterventionStatus", false, NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId,
      interventionDate,
      odometerKm,
      title,
      description,
      JSON.stringify(partsReplaced),
      internalNotes,
      status,
    ],
  );
  const interventionId = rows[0]!.id;

  if (
    params.createdAt !== undefined ||
    params.firstSeenByCustomerAt !== undefined ||
    params.wikiLockedAt !== undefined
  ) {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (params.createdAt !== undefined) {
      sets.push(`created_at = $${i++}`);
      values.push(params.createdAt);
    }
    if (params.firstSeenByCustomerAt !== undefined) {
      sets.push(`first_seen_by_customer_at = $${i++}`);
      values.push(params.firstSeenByCustomerAt);
    }
    if (params.wikiLockedAt !== undefined) {
      sets.push(`wiki_locked_at = $${i++}`);
      values.push(params.wikiLockedAt);
    }
    values.push(interventionId);
    await pgAdmin.query(`UPDATE interventions SET ${sets.join(', ')} WHERE id = $${i}`, values);
  }

  return { interventionId };
}

// Private intervention seed (customer-side). `deleted_at` stays NULL
// by default; tests that need the soft-delete branch set it.
export async function createPrivateIntervention(params: {
  customerId: string;
  vehicleId: string;
  interventionDate: string; // YYYY-MM-DD
  odometerKm?: number | null;
  customType?: string | null;
  description?: string;
  deletedAt?: Date | null;
}): Promise<{ privateInterventionId: string }> {
  const {
    customerId,
    vehicleId,
    interventionDate,
    odometerKm = null,
    customType = 'Manutenzione fai-da-te',
    description = 'Test private intervention',
    deletedAt = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO private_interventions
       (id, customer_id, vehicle_id, intervention_date, odometer_km,
        custom_type, description, deleted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3::date, $4, $5, $6, $7, NOW(), NOW())
     RETURNING id`,
    [customerId, vehicleId, interventionDate, odometerKm, customType, description, deletedAt],
  );
  return { privateInterventionId: rows[0]!.id };
}

// Attachment seed for integration tests. The `attachments` table has no
// `updated_at` column per Prisma schema model Attachment — only created_at.
// Owner-consistency CHECK (chk_attachment_owner_consistent):
//   intervention | intervention_dispute → tenant_id set, customer_id null
//   private_intervention → customer_id set, tenant_id null
//   dispute (clienti upload) can also carry customer_id alongside tenant_id
// Pass tenantId/customerId explicitly to match the owner shape under test.
export async function createAttachment(params: {
  ownerType: 'intervention' | 'private_intervention' | 'intervention_dispute';
  ownerId: string;
  tenantId?: string | null;
  customerId?: string | null;
  uploadedByUserId?: string | null;
  uploadedByCustomerId?: string | null;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  processed?: boolean;
  deletedAt?: Date | null;
}): Promise<{ attachmentId: string }> {
  const {
    ownerType,
    ownerId,
    tenantId = null,
    customerId = null,
    uploadedByUserId = null,
    uploadedByCustomerId = null,
    fileName = 'test.pdf',
    mimeType = 'application/pdf',
    sizeBytes = 12345,
    processed = true,
    deletedAt = null,
  } = params;
  // Build s3_key JS-side and pass as a separate param: using `$2` (uuid
  // column) inside SQL concat would force PG to deduce it as text AND
  // uuid simultaneously → "inconsistent types deduced" 42P08
  // (feedback_pg_param_type_inference_cast).
  const s3Key = `attachments/${ownerType}/${ownerId}/test.pdf`;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO attachments
       (id, owner_type, owner_id, tenant_id, customer_id,
        uploaded_by_user_id, uploaded_by_customer_id,
        file_name, mime_type, size_bytes, s3_key, s3_bucket,
        processed, deleted_at, created_at)
     VALUES (gen_random_uuid(), $1::"AttachmentOwnerType", $2, $3, $4,
        $5, $6, $7, $8, $9,
        $12, 'garageos-test',
        $10, $11, NOW())
     RETURNING id`,
    [
      ownerType,
      ownerId,
      tenantId,
      customerId,
      uploadedByUserId,
      uploadedByCustomerId,
      fileName,
      mimeType,
      sizeBytes,
      processed,
      deletedAt,
      s3Key,
    ],
  );
  return { attachmentId: rows[0]!.id };
}

// System intervention types catalogue used by integration helpers.
// Mirrors a subset of packages/database/src/seed-data.ts — the integration
// tests do not import that file because globalSetup runs `pnpm db:seed`
// against the container, but `resetDb` wipes intervention_types as a
// CASCADE side-effect of TRUNCATE tenants (Postgres truncates the entire
// referencing table, not just rows whose FK matches a deleted parent).
// Re-seeding per test is the simplest fix.
type SystemInterventionTypeSeed = {
  code: string;
  nameIt: string;
  category: 'maintenance' | 'repair' | 'tires' | 'body' | 'inspection' | 'other';
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
};

const SYSTEM_TYPE_FALLBACKS: Record<string, SystemInterventionTypeSeed> = {
  TAGLIANDO: {
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    category: 'maintenance',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  CAMBIO_OLIO: {
    code: 'CAMBIO_OLIO',
    nameIt: 'Cambio olio',
    category: 'maintenance',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  REVISIONE: {
    code: 'REVISIONE',
    nameIt: 'Revisione ministeriale',
    category: 'inspection',
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
  GOMME: {
    code: 'GOMME',
    nameIt: 'Cambio gomme',
    category: 'tires',
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
};

// Idempotent fetch: returns the seeded row if still present, otherwise
// re-inserts it from the inline catalogue. Callers can use this safely
// inside beforeEach without worrying whether resetDb() cascaded the row
// away.
export async function ensureSystemInterventionType(code: string): Promise<{
  id: string;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
}> {
  const existing = await pgAdmin.query<{
    id: string;
    suggests_deadline: boolean;
    default_deadline_months: number | null;
    default_deadline_km: number | null;
  }>(
    `SELECT id, suggests_deadline, default_deadline_months, default_deadline_km
       FROM intervention_types
      WHERE code = $1 AND tenant_id IS NULL
      LIMIT 1`,
    [code],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return {
      id: r.id,
      suggestsDeadline: r.suggests_deadline,
      defaultDeadlineMonths: r.default_deadline_months,
      defaultDeadlineKm: r.default_deadline_km,
    };
  }
  const seed = SYSTEM_TYPE_FALLBACKS[code];
  if (!seed) {
    throw new Error(
      `ensureSystemInterventionType: no inline fallback for code "${code}". Add it to SYSTEM_TYPE_FALLBACKS.`,
    );
  }
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types
       (id, tenant_id, code, name_it, category, suggests_deadline,
        default_deadline_months, default_deadline_km, active, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, $2,
        $3::"InterventionTypeCategory", $4, $5, $6, true, NOW(), NOW())
     RETURNING id`,
    [
      seed.code,
      seed.nameIt,
      seed.category,
      seed.suggestsDeadline,
      seed.defaultDeadlineMonths,
      seed.defaultDeadlineKm,
    ],
  );
  return {
    id: rows[0]!.id,
    suggestsDeadline: seed.suggestsDeadline,
    defaultDeadlineMonths: seed.defaultDeadlineMonths,
    defaultDeadlineKm: seed.defaultDeadlineKm,
  };
}

// Direct pgAdmin insert for dispute fixtures. Mirrors createIntervention:
// bypasses RLS so cross-tenant or already-resolved disputes can be seeded
// without driving the public POST /dispute path. status defaults to
// 'open'; resolvedAt defaults to null. Callers that seed
// 'resolved_by_cancellation' should set resolvedAt explicitly to mirror
// production rows. tenantResponse / tenantResponseAt / tenantResponseUserId
// are optional triplet for seeding `responded` (and later) state.
export async function createDispute(params: {
  interventionId: string;
  customerId: string;
  reasonCategory?: 'not_performed' | 'wrong_data' | 'not_authorized' | 'other';
  customerDescription?: string;
  status?: 'open' | 'responded' | 'resolved_by_cancellation' | 'escalated' | 'closed_by_admin';
  resolvedAt?: Date | null;
  tenantResponse?: string;
  tenantResponseAt?: Date;
  tenantResponseUserId?: string;
}): Promise<{ disputeId: string }> {
  const {
    interventionId,
    customerId,
    reasonCategory = 'not_performed',
    customerDescription = 'Contestazione di test della durata regolamentare.',
    status = 'open',
    resolvedAt = null,
    tenantResponse,
    tenantResponseAt,
    tenantResponseUserId,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_disputes
       (id, intervention_id, customer_id, reason_category, customer_description,
        status, resolved_at,
        tenant_response, tenant_response_at, tenant_response_user_id,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2,
        $3::"DisputeReasonCategory", $4,
        $5::"DisputeStatus", $6,
        $7, $8, $9,
        NOW(), NOW())
     RETURNING id`,
    [
      interventionId,
      customerId,
      reasonCategory,
      customerDescription,
      status,
      resolvedAt,
      tenantResponse ?? null,
      tenantResponseAt ?? null,
      tenantResponseUserId ?? null,
    ],
  );
  return { disputeId: rows[0]!.id };
}

// Direct pgAdmin insert for intervention_revisions seeding. Mirrors
// createDispute: bypasses RLS so cross-tenant fixtures or backdated
// revisedAt values can be seeded without driving the public PATCH path.
// `revisedAt` defaults to NOW(); supply an explicit Date when ordering
// matters across multiple revision rows in the same test.
export async function createRevision(params: {
  interventionId: string;
  userId: string;
  revisedAt?: Date;
  changes?: Record<string, unknown>;
  reason?: string | null;
}): Promise<{ revisionId: string }> {
  const {
    interventionId,
    userId,
    revisedAt = new Date(),
    changes = { title: { from: 'Old', to: 'New' } },
    reason = 'Revisione di test',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_revisions
       (id, intervention_id, user_id, revised_at, changes, reason)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [interventionId, userId, revisedAt, JSON.stringify(changes), reason],
  );
  return { revisionId: rows[0]!.id };
}

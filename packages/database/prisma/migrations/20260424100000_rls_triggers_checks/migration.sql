-- =====================================================
-- GarageOS — migration 0002
-- RLS policies, triggers, CHECK constraints, partial
-- unique indexes, and SQL functions used at runtime.
--
-- Source: docs/APPENDICE_B_DATABASE.md §3.1 (triggers),
-- §3.2 (RLS policies), §3.3 (functions).
--
-- Design note: APPENDICE_B originally prescribed separate
-- files (`sql/triggers.sql`, `sql/rls-policies.sql`,
-- `sql/functions.sql`) applied by a shell script. We
-- consolidate them in this single Prisma migration so:
--   - deployments are versioned and reversible,
--   - CI test containers get the full DB state from a
--     plain `prisma migrate deploy`,
--   - nothing depends on `psql` being installed.
-- APPENDICE_B v1.1 documents this consolidation.
-- =====================================================

-- =====================================================
-- 1. SQL FUNCTIONS (referenced by policies below)
-- =====================================================

-- Safe readers for current session context. Return NULL when
-- the GUC is not set, instead of raising — policies can then
-- treat "no context" as "deny".
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid AS $$
BEGIN
    RETURN current_setting('app.current_tenant', true)::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_customer_id()
RETURNS uuid AS $$
BEGIN
    RETURN current_setting('app.current_customer', true)::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION is_admin_role()
RETURNS boolean AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_role', true) = 'admin', false);
END;
$$ LANGUAGE plpgsql STABLE;

-- Convenience helper to set multiple session settings in one call.
CREATE OR REPLACE FUNCTION set_app_context(
    p_tenant_id UUID DEFAULT NULL,
    p_customer_id UUID DEFAULT NULL,
    p_role TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
    IF p_tenant_id IS NOT NULL THEN
        PERFORM set_config('app.current_tenant', p_tenant_id::text, true);
    END IF;
    IF p_customer_id IS NOT NULL THEN
        PERFORM set_config('app.current_customer', p_customer_id::text, true);
    END IF;
    IF p_role IS NOT NULL THEN
        PERFORM set_config('app.current_role', p_role, true);
    END IF;
END;
$$ LANGUAGE plpgsql;

-- BR-020 / BR-021 garage_code generation with reduced alphabets
-- (digits 2-9, letters minus I/O/Q/U). Called from the app during
-- vehicle certification.
CREATE OR REPLACE FUNCTION generate_garage_code()
RETURNS VARCHAR(12) AS $$
DECLARE
    digits TEXT := '23456789';
    letters TEXT := 'ABCDEFGHJKLMNPRSTVWXYZ';
    code TEXT;
    i INT;
BEGIN
    code := 'GO-';
    FOR i IN 1..3 LOOP
        code := code || substr(digits, (random() * length(digits))::INT + 1, 1);
    END LOOP;
    code := code || '-';
    FOR i IN 1..4 LOOP
        code := code || substr(letters, (random() * length(letters))::INT + 1, 1);
    END LOOP;
    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- BR-021 retry-on-collision atomic assignment. Returns the assigned code
-- or raises after 3 attempts (astronomically unlikely at our scale but
-- defensive).
CREATE OR REPLACE FUNCTION assign_garage_code(p_vehicle_id UUID)
RETURNS VARCHAR(12) AS $$
DECLARE
    new_code VARCHAR(12);
    attempt INT := 0;
    max_attempts INT := 3;
BEGIN
    LOOP
        attempt := attempt + 1;
        new_code := generate_garage_code();

        BEGIN
            UPDATE vehicles
            SET garage_code = new_code
            WHERE id = p_vehicle_id
            AND garage_code IS NULL;

            IF FOUND THEN
                RETURN new_code;
            ELSE
                RAISE EXCEPTION 'Vehicle not found or already has a garage_code';
            END IF;

        EXCEPTION WHEN unique_violation THEN
            IF attempt >= max_attempts THEN
                RAISE EXCEPTION 'Could not generate a unique garage_code after % attempts', max_attempts;
            END IF;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 2. TRIGGERS: updated_at auto-refresh
-- =====================================================

-- Prisma's @updatedAt updates the column on application writes. The
-- trigger guarantees coherence even for direct SQL writes or writes
-- that bypass the ORM layer.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'tenants', 'locations', 'users', 'customers', 'customer_tenant_relations',
        'vehicles', 'vehicle_transfers', 'intervention_types', 'interventions',
        'intervention_disputes', 'private_interventions', 'deadlines'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;
            CREATE TRIGGER trg_%I_updated_at
            BEFORE UPDATE ON %I
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        ', t, t, t, t);
    END LOOP;
END $$;

-- =====================================================
-- 3. TRIGGERS: audit log immutability (BR-282)
-- =====================================================

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Modification of audit_logs or access_logs is not allowed (BR-282)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_modify ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_modify
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

DROP TRIGGER IF EXISTS trg_access_logs_no_modify ON access_logs;
CREATE TRIGGER trg_access_logs_no_modify
BEFORE UPDATE OR DELETE ON access_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- =====================================================
-- 4. PARTIAL UNIQUE INDEXES (not expressible in Prisma)
-- =====================================================

-- BR-040: at most one active ownership per vehicle
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_vehicle_active
ON vehicle_ownerships (vehicle_id)
WHERE ended_at IS NULL;

-- BR-047: at most one active transfer per vehicle
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_vehicle_active
ON vehicle_transfers (vehicle_id)
WHERE status IN ('pending_recipient', 'pending_seller_confirmation', 'pending_validation');

-- BR-201: exactly one active primary location per tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_tenant_primary
ON locations (tenant_id)
WHERE is_primary = true AND status = 'active' AND deleted_at IS NULL;

-- Customer cognito_sub unique only when not NULL. Prisma already
-- emits a plain UNIQUE but that forbids multiple NULLs in some engines;
-- the partial index makes the intent explicit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_cognito_sub_notnull
ON customers (cognito_sub)
WHERE cognito_sub IS NOT NULL;

-- =====================================================
-- 5. CHECK CONSTRAINTS
-- =====================================================

-- BR-020: garage_code format GO-NNN-AAAA (digits 2-9, letters minus I/O/Q/U)
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_garage_code_format;
ALTER TABLE vehicles ADD CONSTRAINT chk_garage_code_format
CHECK (
    garage_code IS NULL OR
    garage_code ~ '^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$'
);

-- BR-003: certified implies garage_code, certified_at, certified_by_tenant_id
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_certified_consistency;
ALTER TABLE vehicles ADD CONSTRAINT chk_certified_consistency
CHECK (
    (status != 'certified') OR
    (garage_code IS NOT NULL AND certified_at IS NOT NULL AND certified_by_tenant_id IS NOT NULL)
);

-- BR-003: pending implies garage_code NULL
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_pending_consistency;
ALTER TABLE vehicles ADD CONSTRAINT chk_pending_consistency
CHECK (
    (status != 'pending') OR
    (garage_code IS NULL)
);

-- BR-007: year range (1900 .. current year + 1)
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_year_range;
ALTER TABLE vehicles ADD CONSTRAINT chk_year_range
CHECK (year >= 1900 AND year <= EXTRACT(YEAR FROM NOW())::INT + 1);

-- BR-100: a deadline must have at least one criterion (date or km)
ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS chk_deadline_has_criterion;
ALTER TABLE deadlines ADD CONSTRAINT chk_deadline_has_criterion
CHECK (due_date IS NOT NULL OR due_odometer_km IS NOT NULL);

-- Recurring deadlines must have at least one recurrence criterion
ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS chk_recurring_consistency;
ALTER TABLE deadlines ADD CONSTRAINT chk_recurring_consistency
CHECK (
    (is_recurring = false) OR
    (recurring_months IS NOT NULL OR recurring_km IS NOT NULL)
);

-- BR-180: attachment size between 1 byte and 10 MB
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_attachment_size;
ALTER TABLE attachments ADD CONSTRAINT chk_attachment_size
CHECK (size_bytes > 0 AND size_bytes <= 10485760);

-- Attachment owner XOR: intervention -> tenant_id set, customer_id NULL;
-- private_intervention -> customer_id set, tenant_id NULL.
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_attachment_owner_consistent;
ALTER TABLE attachments ADD CONSTRAINT chk_attachment_owner_consistent
CHECK (
    (owner_type = 'intervention' AND tenant_id IS NOT NULL AND customer_id IS NULL) OR
    (owner_type = 'private_intervention' AND customer_id IS NOT NULL AND tenant_id IS NULL)
);

-- =====================================================
-- 6. ROW LEVEL SECURITY — tenant-scoped tables
-- The app is expected to call set_app_context() (or set the
-- equivalent GUCs directly) at the start of each transaction.
-- Policies evaluate to TRUE when the admin role is active, so a
-- privileged background job can opt out of tenant filtering.
--
-- FORCE ROW LEVEL SECURITY is applied together with ENABLE so the
-- policies also run for table owners and the superuser role. Without
-- FORCE, RLS is skipped whenever the connection is the owner — which
-- in practice covers both the Supabase `postgres` role and the test
-- container's default user. Without FORCE the policies would be a
-- security nullity.
-- =====================================================

-- Tables that carry tenant_id directly get a simple isolation policy.
-- intervention_disputes and deadline_notifications are deliberately
-- excluded: neither table has a tenant_id column (schema v1.1 keeps
-- them child-scoped on interventions.id / deadlines.id), so their
-- policies join to the parent. This corrects an inconsistency in
-- APPENDICE_B v1.0 §3.2 where those two tables were listed here even
-- though the canonical schema never added the column.
DO $$
DECLARE
    t text;
    tenant_tables text[] := ARRAY[
        'locations', 'users', 'customer_tenant_relations',
        'interventions',
        'deadlines',
        'access_logs', 'invitations'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
        EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I;', t, t);
        EXECUTE format('
            CREATE POLICY %I_tenant_isolation ON %I
            USING (is_admin_role() OR tenant_id = current_tenant_id());
        ', t, t);
    END LOOP;
END $$;

-- intervention_disputes: visible to the tenant that owns the parent
-- intervention (via JOIN) and to the customer who filed the dispute.
ALTER TABLE intervention_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE intervention_disputes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intervention_disputes_access ON intervention_disputes;
CREATE POLICY intervention_disputes_access ON intervention_disputes
USING (
    is_admin_role()
    OR customer_id = current_customer_id()
    OR EXISTS (
        SELECT 1 FROM interventions i
        WHERE i.id = intervention_disputes.intervention_id
        AND i.tenant_id = current_tenant_id()
    )
);

-- deadline_notifications: visible to the tenant that owns the parent
-- deadline (via JOIN). No customer path: customers don't see the
-- EventBridge scheduling metadata.
ALTER TABLE deadline_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadline_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deadline_notifications_access ON deadline_notifications;
CREATE POLICY deadline_notifications_access ON deadline_notifications
USING (
    is_admin_role()
    OR EXISTS (
        SELECT 1 FROM deadlines d
        WHERE d.id = deadline_notifications.deadline_id
        AND d.tenant_id = current_tenant_id()
    )
);

-- Tenant table: row is visible to its own tenant session or to admin.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolation ON tenants;
CREATE POLICY tenants_isolation ON tenants
USING (is_admin_role() OR id = current_tenant_id());

-- intervention_types: system-wide (tenant_id NULL) visible to all,
-- tenant-owned types visible to their tenant.
ALTER TABLE intervention_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE intervention_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intervention_types_isolation ON intervention_types;
CREATE POLICY intervention_types_isolation ON intervention_types
USING (
    is_admin_role()
    OR tenant_id IS NULL
    OR tenant_id = current_tenant_id()
);

-- customers: data is accessible to any tenant (read side) to support
-- cross-tenant search (BR-150). PII redaction for non-related tenants
-- is enforced at the application layer per BR-151 — a pure DB policy
-- cannot express "redact these columns but not others".
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_read ON customers;
CREATE POLICY customers_read ON customers
FOR SELECT
USING (true);

DROP POLICY IF EXISTS customers_write_by_related_tenant ON customers;
CREATE POLICY customers_write_by_related_tenant ON customers
FOR UPDATE
USING (
    is_admin_role()
    OR EXISTS (
        SELECT 1 FROM customer_tenant_relations ctr
        WHERE ctr.customer_id = customers.id
        AND ctr.tenant_id = current_tenant_id()
    )
);

DROP POLICY IF EXISTS customers_insert ON customers;
CREATE POLICY customers_insert ON customers
FOR INSERT
WITH CHECK (true);

-- vehicles: readable by any tenant (BR-060, BR-150). Writes are
-- limited to tenants that either created or certified the vehicle.
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicles_read ON vehicles;
CREATE POLICY vehicles_read ON vehicles
FOR SELECT
USING (true);

DROP POLICY IF EXISTS vehicles_insert ON vehicles;
CREATE POLICY vehicles_insert ON vehicles
FOR INSERT
WITH CHECK (
    is_admin_role()
    OR created_by_tenant_id = current_tenant_id()
    OR created_by_customer_id IS NOT NULL
);

DROP POLICY IF EXISTS vehicles_update ON vehicles;
CREATE POLICY vehicles_update ON vehicles
FOR UPDATE
USING (
    is_admin_role()
    OR certified_by_tenant_id = current_tenant_id()
    OR created_by_tenant_id = current_tenant_id()
);

-- Ownership history and transfer records: read is open because the
-- chain-of-custody is a vehicle attribute; write is handled by the
-- application layer that orchestrates the multi-step transfer flow.
ALTER TABLE vehicle_ownerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_ownerships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ownerships_access ON vehicle_ownerships;
CREATE POLICY ownerships_access ON vehicle_ownerships
USING (true);

ALTER TABLE vehicle_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transfers_access ON vehicle_transfers;
CREATE POLICY transfers_access ON vehicle_transfers
USING (true);

-- Private interventions: only visible to their owning customer (or admin).
ALTER TABLE private_interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_interventions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS private_int_isolation ON private_interventions;
CREATE POLICY private_int_isolation ON private_interventions
USING (
    is_admin_role()
    OR customer_id = current_customer_id()
);

-- Push tokens: same customer isolation.
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_tokens_isolation ON push_tokens;
CREATE POLICY push_tokens_isolation ON push_tokens
USING (
    is_admin_role()
    OR customer_id = current_customer_id()
);

-- Audit logs: tenant-scoped read; any caller can append (app-level
-- actor check).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_read ON audit_logs;
CREATE POLICY audit_logs_read ON audit_logs
FOR SELECT
USING (
    is_admin_role()
    OR tenant_id = current_tenant_id()
);

DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs
FOR INSERT
WITH CHECK (true);

-- Admin must reach UPDATE/DELETE path so the BR-282 immutability
-- trigger can fire. Without an explicit admin policy for those
-- commands, RLS default-denies and the trigger never evaluates —
-- producing silent zero-row results instead of the required error.
DROP POLICY IF EXISTS audit_logs_admin_ops ON audit_logs;
CREATE POLICY audit_logs_admin_ops ON audit_logs
FOR ALL
USING (is_admin_role())
WITH CHECK (is_admin_role());

-- Attachments: intervention attachments are tenant-scoped, private
-- intervention attachments are customer-scoped. Cross-tenant read for
-- historical shop attachments is handled at the application layer.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attachments_access ON attachments;
CREATE POLICY attachments_access ON attachments
USING (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
);

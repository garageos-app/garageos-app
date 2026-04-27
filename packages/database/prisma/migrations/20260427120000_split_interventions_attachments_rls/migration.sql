-- =====================================================
-- GarageOS — migration 0003
-- Split SELECT/WRITE policies on interventions, attachments,
-- tenants, locations, intervention_types so cross-tenant SELECT
-- is permissive (BR-150 / BR-153 vehicle history visibility) while
-- WRITE remains tenant/owner-scoped.
--
-- Motivation: pre-migration the single-policy USING clauses on
-- these tables forced two route handlers to elevate the connection
-- to `role: 'admin'` to support the cross-pool timeline view and
-- the customer-side dispute. After this migration:
--   - vehicles-timeline.ts no longer needs `role: 'admin'` (SELECT
--     cross-tenant on interventions/attachments + cross-tenant
--     join to tenants/locations/intervention_types are permissive).
--   - interventions-dispute.ts keeps `role: 'admin'` only for the
--     BR-127 UPDATE on `interventions.status`; the SELECT side no
--     longer requires admin elevation.
-- Mirror of the existing pattern on `vehicles` and `customers`.
--
-- Expansive: no column changes, no long locks. The DROP POLICY
-- statements remove the old single policies; the CREATE POLICY
-- statements install the per-command split.
-- =====================================================

-- =====================================================
-- 1. INTERVENTIONS
-- =====================================================

DROP POLICY IF EXISTS interventions_tenant_isolation ON interventions;

CREATE POLICY interventions_read ON interventions
FOR SELECT USING (true);

CREATE POLICY interventions_insert ON interventions
FOR INSERT WITH CHECK (
    is_admin_role() OR tenant_id = current_tenant_id()
);

CREATE POLICY interventions_update ON interventions
FOR UPDATE
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- No DELETE policy: BR-130 prescribes status flip ('cancelled'),
-- not hard delete. Default deny mirrors `vehicles`.

-- =====================================================
-- 2. ATTACHMENTS
-- =====================================================

DROP POLICY IF EXISTS attachments_access ON attachments;

CREATE POLICY attachments_read ON attachments
FOR SELECT USING (true);

CREATE POLICY attachments_insert ON attachments
FOR INSERT WITH CHECK (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
);

CREATE POLICY attachments_update ON attachments
FOR UPDATE
USING (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
)
WITH CHECK (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
);

-- No DELETE policy: attachments are detached via parent cascade or
-- soft-deleted via deleted_at; no caller hard-deletes.

-- =====================================================
-- 3. TENANTS
-- Cross-tenant SELECT: timeline shop_intervention rows need
-- businessName from a foreign tenant. Read permissive; WRITE
-- restricted to the row's own tenant or admin.
-- =====================================================

DROP POLICY IF EXISTS tenants_isolation ON tenants;

CREATE POLICY tenants_read ON tenants
FOR SELECT USING (true);

CREATE POLICY tenants_write ON tenants
FOR ALL
USING (is_admin_role() OR id = current_tenant_id())
WITH CHECK (is_admin_role() OR id = current_tenant_id());

-- =====================================================
-- 4. LOCATIONS
-- Cross-tenant SELECT: timeline shop_intervention rows need city
-- from a foreign tenant's location. Read permissive; WRITE
-- tenant-scoped.
-- =====================================================

DROP POLICY IF EXISTS locations_tenant_isolation ON locations;

CREATE POLICY locations_read ON locations
FOR SELECT USING (true);

CREATE POLICY locations_write ON locations
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- 5. INTERVENTION_TYPES
-- Cross-tenant SELECT: timeline shop_intervention rows need
-- code/name_it of types that may belong to a foreign tenant. Read
-- permissive; WRITE tenant-scoped (system types tenant_id NULL are
-- writable only by admin paths — seed/migration).
-- =====================================================

DROP POLICY IF EXISTS intervention_types_isolation ON intervention_types;

CREATE POLICY intervention_types_read ON intervention_types
FOR SELECT USING (true);

CREATE POLICY intervention_types_write ON intervention_types
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

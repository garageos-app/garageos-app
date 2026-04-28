-- =====================================================
-- GarageOS — migration 0004
-- Split SELECT/WRITE su users e abilita RLS append-only su
-- intervention_revisions per supportare BR-150 (audit chain
-- cross-tenant) senza ricorrere a `role: 'admin'` short-lived.
--
-- Motivazione: pre-migration la single-policy USING su `users`
-- forzava interventions-revisions-list.ts (officina branch) a
-- elevare la transazione a `role: 'admin'` per join cross-tenant
-- a users.firstName/lastName. intervention_revisions inoltre non
-- aveva alcuna RLS, lasciando l'integrita tenant del write side
-- enforced solo via parent intervention indirettamente.
--
-- Dopo questa migration:
--   - users SELECT permissive cross-tenant (mirror tenants/locations
--     post-0003), WRITE tenant-scoped.
--   - intervention_revisions ENABLE+FORCE RLS, SELECT permissive
--     (audit chain BR-150), INSERT append-only enforced via EXISTS
--     join al parent intervention. Nessuna policy UPDATE/DELETE
--     -> default deny.
--   - interventions-revisions-list.ts droppa `role: 'admin'` dal
--     branch officina contestualmente (vedi Task 5).
--
-- Mirror del pattern di migration 0003 sui 5 tabelle gia splittate.
-- Espansiva: solo DROP/CREATE POLICY, no column changes.
-- =====================================================

-- =====================================================
-- 1. USERS
-- Split single _tenant_isolation in _read + _write.
-- =====================================================

DROP POLICY IF EXISTS users_tenant_isolation ON users;

CREATE POLICY users_read ON users
FOR SELECT USING (true);

CREATE POLICY users_write ON users
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- 2. INTERVENTION_REVISIONS
-- Abilita RLS (assente pre-0004) + due policy:
--   - _read FOR SELECT USING (true) per audit chain cross-tenant.
--   - _insert FOR INSERT WITH CHECK con EXISTS join al parent
--     intervention (tenant-scoped). Append-only: nessuna UPDATE/
--     DELETE policy -> default deny.
-- Cascade DELETE dal parent intervention bypassa RLS via FK CASCADE
-- (mirror intervention_disputes pattern pre-esistente).
-- =====================================================

ALTER TABLE intervention_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intervention_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intervention_revisions_read ON intervention_revisions;
CREATE POLICY intervention_revisions_read ON intervention_revisions
FOR SELECT USING (true);

DROP POLICY IF EXISTS intervention_revisions_insert ON intervention_revisions;
CREATE POLICY intervention_revisions_insert ON intervention_revisions
FOR INSERT WITH CHECK (
    is_admin_role()
    OR EXISTS (
        SELECT 1 FROM interventions i
        WHERE i.id = intervention_revisions.intervention_id
          AND i.tenant_id = current_tenant_id()
    )
);

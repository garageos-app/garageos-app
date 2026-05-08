-- H3 — admit customer SELECT on deadlines when customer owns the vehicle.
-- Mirrors the SELECT/WRITE split established in migration 20260427120000
-- for vehicles + interventions. This is permissive read only — INSERT/
-- UPDATE/DELETE remain tenant-only via the existing
-- deadlines_tenant_isolation policy. Customer write paths do not exist
-- (deadlines are an officina-managed concept; customers only observe).
--
-- See F-CLI-301 (GET /me/deadlines) for the consuming endpoint that
-- requires this policy.

CREATE POLICY deadlines_customer_select ON deadlines
FOR SELECT
USING (
    is_admin_role()
    OR EXISTS (
        SELECT 1
        FROM vehicle_ownerships vo
        WHERE vo.vehicle_id = deadlines.vehicle_id
          AND vo.customer_id = current_customer_id()
          AND vo.ended_at IS NULL
    )
);

-- deadline_notifications_access already covers transitive read via the
-- parent deadline. Customers do NOT need direct read on
-- deadline_notifications (they observe deadlines, not the EventBridge
-- scheduling metadata). No additional policy here.

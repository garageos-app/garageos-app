-- =====================================================
-- GarageOS — migration 0010
-- - Add attachments.dispute_id (nullable FK to intervention_disputes)
-- - Extend chk_attachment_owner_consistent for intervention_dispute
-- - Update RLS policies attachments_insert/attachments_update with the
--   new owner_type branch (with anti-impersonation: officina-uploaded
--   ⇒ customer_id IS NULL; customer-uploaded ⇒ customer_id set).
-- attachments_read remains USING (true) — visibility application-side.
-- =====================================================

-- 1. Add nullable dispute_id column + index
ALTER TABLE attachments
    ADD COLUMN dispute_id UUID REFERENCES intervention_disputes(id);

CREATE INDEX idx_attachments_dispute_id
    ON attachments(dispute_id)
    WHERE dispute_id IS NOT NULL;

-- 2. Extend CHECK constraint
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_attachment_owner_consistent;
ALTER TABLE attachments ADD CONSTRAINT chk_attachment_owner_consistent CHECK (
    (owner_type = 'intervention'
        AND tenant_id IS NOT NULL AND customer_id IS NULL AND dispute_id IS NULL)
    OR
    (owner_type = 'private_intervention'
        AND tenant_id IS NULL AND customer_id IS NOT NULL AND dispute_id IS NULL)
    OR
    (owner_type = 'intervention_dispute' AND tenant_id IS NOT NULL AND (
        -- Customer-uploaded: customer_id set, customer-uploader columns set
        (uploaded_by_customer_id IS NOT NULL AND uploaded_by_user_id IS NULL
            AND customer_id IS NOT NULL)
        OR
        -- Officina-uploaded: customer_id NULL (anti-impersonation), tenant uploader columns set
        (uploaded_by_user_id IS NOT NULL AND uploaded_by_customer_id IS NULL
            AND customer_id IS NULL)
    ))
);

-- 3. RLS policies — recreate insert + update with intervention_dispute branch
DROP POLICY IF EXISTS attachments_insert ON attachments;
CREATE POLICY attachments_insert ON attachments
FOR INSERT WITH CHECK (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
    OR (owner_type = 'intervention_dispute' AND (
        -- Customer-uploaded: row tied to current customer
        (customer_id IS NOT NULL AND customer_id = current_customer_id())
        OR
        -- Officina-uploaded: row tied to current tenant; customer_id NULL anti-impersonation
        (customer_id IS NULL AND tenant_id = current_tenant_id())
    ))
);

DROP POLICY IF EXISTS attachments_update ON attachments;
CREATE POLICY attachments_update ON attachments
FOR UPDATE
USING (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
    OR (owner_type = 'intervention_dispute' AND (
        (customer_id IS NOT NULL AND customer_id = current_customer_id())
        OR
        (customer_id IS NULL AND tenant_id = current_tenant_id())
    ))
)
WITH CHECK (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
    OR (owner_type = 'intervention_dispute' AND (
        (customer_id IS NOT NULL AND customer_id = current_customer_id())
        OR
        (customer_id IS NULL AND tenant_id = current_tenant_id())
    ))
);

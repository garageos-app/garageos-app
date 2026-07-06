-- Private intervention checklist selections (BR-086 → BR-300/301/303 parity
-- for customer-created private interventions). Customer-scoped, mirroring
-- private_int_isolation. Additive migration, no drops.
CREATE TABLE private_intervention_checklist_selections (
    id                      uuid NOT NULL DEFAULT gen_random_uuid(),
    private_intervention_id uuid NOT NULL,
    customer_id             uuid NOT NULL,
    checklist_item_id       uuid,
    label_snapshot          varchar(150) NOT NULL,
    sort_order_snapshot     smallint,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT private_intervention_checklist_selections_pkey PRIMARY KEY (id)
);

ALTER TABLE private_intervention_checklist_selections
    ADD CONSTRAINT priv_selection_intervention_fkey
    FOREIGN KEY (private_intervention_id)
    REFERENCES private_interventions(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE private_intervention_checklist_selections
    ADD CONSTRAINT priv_selection_item_fkey
    FOREIGN KEY (checklist_item_id)
    REFERENCES intervention_checklist_items(id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE private_intervention_checklist_selections
    ADD CONSTRAINT priv_selection_customer_fkey
    FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX uq_priv_selection_intervention_item
    ON private_intervention_checklist_selections (private_intervention_id, checklist_item_id);
CREATE INDEX idx_priv_selections_intervention
    ON private_intervention_checklist_selections (private_intervention_id);

ALTER TABLE private_intervention_checklist_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_intervention_checklist_selections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS private_int_checklist_isolation ON private_intervention_checklist_selections;
CREATE POLICY private_int_checklist_isolation
    ON private_intervention_checklist_selections
    USING (is_admin_role() OR customer_id = current_customer_id());

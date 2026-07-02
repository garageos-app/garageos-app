-- Checklist foundation — arc "ridisegno tipi + checklist".
-- Spec: docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md
-- Operator-driven (DIRECT_URL), NOT in deploy.yml. Portable: no ROLE/DB hardcoded.
--
-- RLS pattern mirrors 20260427120000_split_interventions_attachments_rls:
--   catalog (checklist items): SELECT USING(true), WRITE admin-only.
--   exclusions: SELECT tenant-scoped, WRITE admin-only.
--   selections: mirror interventions (SELECT USING(true), WRITE tenant-scoped).

-- CreateTable
CREATE TABLE "intervention_checklist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intervention_type_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name_it" VARCHAR(150) NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "intervention_checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_intervention_type_exclusions" (
    "tenant_id" UUID NOT NULL,
    "intervention_type_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "tenant_intervention_type_exclusions_pkey" PRIMARY KEY ("tenant_id", "intervention_type_id")
);

CREATE TABLE "tenant_checklist_item_exclusions" (
    "tenant_id" UUID NOT NULL,
    "checklist_item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "tenant_checklist_item_exclusions_pkey" PRIMARY KEY ("tenant_id", "checklist_item_id")
);

CREATE TABLE "intervention_checklist_selections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intervention_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "checklist_item_id" UUID,
    "label_snapshot" VARCHAR(150) NOT NULL,
    "sort_order_snapshot" SMALLINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "intervention_checklist_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_checklist_item_code_type" ON "intervention_checklist_items"("intervention_type_id", "code");
CREATE INDEX "idx_checklist_items_type" ON "intervention_checklist_items"("intervention_type_id");
CREATE INDEX "idx_type_excl_type" ON "tenant_intervention_type_exclusions"("intervention_type_id");
CREATE INDEX "idx_item_excl_item" ON "tenant_checklist_item_exclusions"("checklist_item_id");
CREATE UNIQUE INDEX "uq_selection_intervention_item" ON "intervention_checklist_selections"("intervention_id", "checklist_item_id");
CREATE INDEX "idx_selections_intervention" ON "intervention_checklist_selections"("intervention_id");

-- AddForeignKey
ALTER TABLE "intervention_checklist_items" ADD CONSTRAINT "ici_type_fkey"
  FOREIGN KEY ("intervention_type_id") REFERENCES "intervention_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_intervention_type_exclusions" ADD CONSTRAINT "titel_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_intervention_type_exclusions" ADD CONSTRAINT "titel_type_fkey"
  FOREIGN KEY ("intervention_type_id") REFERENCES "intervention_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_checklist_item_exclusions" ADD CONSTRAINT "tcie_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_checklist_item_exclusions" ADD CONSTRAINT "tcie_item_fkey"
  FOREIGN KEY ("checklist_item_id") REFERENCES "intervention_checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intervention_checklist_selections" ADD CONSTRAINT "ics_intervention_fkey"
  FOREIGN KEY ("intervention_id") REFERENCES "interventions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "intervention_checklist_selections" ADD CONSTRAINT "ics_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "intervention_checklist_selections" ADD CONSTRAINT "ics_item_fkey"
  FOREIGN KEY ("checklist_item_id") REFERENCES "intervention_checklist_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enable RLS
ALTER TABLE "intervention_checklist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intervention_checklist_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "checklist_items_read" ON "intervention_checklist_items" FOR SELECT USING (true);
CREATE POLICY "checklist_items_write" ON "intervention_checklist_items"
  FOR ALL USING (is_admin_role()) WITH CHECK (is_admin_role());

ALTER TABLE "tenant_intervention_type_exclusions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_intervention_type_exclusions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "type_excl_read" ON "tenant_intervention_type_exclusions"
  FOR SELECT USING (is_admin_role() OR tenant_id = current_tenant_id());
CREATE POLICY "type_excl_write" ON "tenant_intervention_type_exclusions"
  FOR ALL USING (is_admin_role()) WITH CHECK (is_admin_role());

ALTER TABLE "tenant_checklist_item_exclusions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_checklist_item_exclusions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "item_excl_read" ON "tenant_checklist_item_exclusions"
  FOR SELECT USING (is_admin_role() OR tenant_id = current_tenant_id());
CREATE POLICY "item_excl_write" ON "tenant_checklist_item_exclusions"
  FOR ALL USING (is_admin_role()) WITH CHECK (is_admin_role());

ALTER TABLE "intervention_checklist_selections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intervention_checklist_selections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "selections_read" ON "intervention_checklist_selections" FOR SELECT USING (true);
CREATE POLICY "selections_insert" ON "intervention_checklist_selections"
  FOR INSERT WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());
CREATE POLICY "selections_update" ON "intervention_checklist_selections"
  FOR UPDATE USING (is_admin_role() OR tenant_id = current_tenant_id())
  WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());
CREATE POLICY "selections_delete" ON "intervention_checklist_selections"
  FOR DELETE USING (is_admin_role() OR tenant_id = current_tenant_id());

-- updated_at trigger (intervention_checklist_items only; others have no updated_at)
DROP TRIGGER IF EXISTS trg_intervention_checklist_items_updated_at ON intervention_checklist_items;
CREATE TRIGGER trg_intervention_checklist_items_updated_at
  BEFORE UPDATE ON intervention_checklist_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grants (explicit; garageos_app is NOBYPASSRLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON "intervention_checklist_items" TO garageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_intervention_type_exclusions" TO garageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_checklist_item_exclusions" TO garageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "intervention_checklist_selections" TO garageos_app;

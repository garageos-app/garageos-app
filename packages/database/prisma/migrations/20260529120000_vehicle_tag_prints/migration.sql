-- CreateEnum
CREATE TYPE "TagPrintKind" AS ENUM ('first', 'reprint');

-- CreateTable
CREATE TABLE "vehicle_tag_prints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "printed_by_user_id" UUID NOT NULL,
    "kind" "TagPrintKind" NOT NULL,
    "reason" TEXT,
    "document_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "vehicle_tag_prints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_vehicle_tag_prints_vehicle" ON "vehicle_tag_prints"("vehicle_id", "created_at" DESC);
CREATE INDEX "idx_vehicle_tag_prints_tenant" ON "vehicle_tag_prints"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "vehicle_tag_prints" ADD CONSTRAINT "vehicle_tag_prints_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_tag_prints" ADD CONSTRAINT "vehicle_tag_prints_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "vehicle_tag_prints" ADD CONSTRAINT "vehicle_tag_prints_printed_by_user_id_fkey"
  FOREIGN KEY ("printed_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Enable RLS
ALTER TABLE "vehicle_tag_prints" ENABLE ROW LEVEL SECURITY;

-- SELECT permissive: tenant scope + admin bypass
CREATE POLICY "vehicle_tag_prints_select" ON "vehicle_tag_prints"
  FOR SELECT
  USING (
    is_admin_role()
    OR tenant_id = current_tenant_id()
  );

-- INSERT strict: tenant scope only (no admin write bypass)
CREATE POLICY "vehicle_tag_prints_insert" ON "vehicle_tag_prints"
  FOR INSERT
  WITH CHECK (
    tenant_id = current_tenant_id()
  );

-- UPDATE/DELETE: default-deny (append-only audit log, pattern intervention_revisions)
-- No policy = no permission for non-superuser.

-- Grant base privileges to garageos_app role
GRANT SELECT, INSERT ON "vehicle_tag_prints" TO garageos_app;

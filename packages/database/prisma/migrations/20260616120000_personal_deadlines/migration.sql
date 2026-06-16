-- F-CLI-306 / BR-290..298: customer-owned personal vehicle deadlines.
-- Spec: docs/superpowers/specs/2026-06-16-personal-vehicle-deadlines-design.md
-- Security pattern: RLS USING(true) + app-layer customerId filter (mirror
-- vehicle_transfers / transfers_access; lesson #154). Customers create,
-- read, update, delete their own rows; admin (scheduler) bypasses via
-- role=admin context in PR2.

-- CreateEnum
CREATE TYPE "PersonalDeadlineCategory" AS ENUM ('insurance', 'road_tax', 'inspection', 'service', 'tires', 'timing_belt', 'other');
CREATE TYPE "PersonalDeadlineStatus" AS ENUM ('open', 'completed', 'overdue', 'cancelled');
CREATE TYPE "PersonalDeadlineReminderKind" AS ENUM ('lead', 'tail');

-- CreateTable
CREATE TABLE "personal_deadlines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "category" "PersonalDeadlineCategory" NOT NULL,
    "custom_label" VARCHAR(80),
    "due_date" DATE NOT NULL,
    "recurrence_months" SMALLINT,
    "reminder_lead_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "reminder_daily_tail_days" SMALLINT,
    "notify_push" BOOLEAN NOT NULL DEFAULT true,
    "notify_email" BOOLEAN NOT NULL DEFAULT true,
    "status" "PersonalDeadlineStatus" NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "personal_deadlines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "personal_deadline_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "personal_deadline_id" UUID NOT NULL,
    "scheduled_for" DATE NOT NULL,
    "kind" "PersonalDeadlineReminderKind" NOT NULL,
    "delivery_status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "personal_deadline_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_personal_deadlines_customer" ON "personal_deadlines"("customer_id", "status", "due_date");
CREATE INDEX "idx_personal_deadlines_vehicle" ON "personal_deadlines"("vehicle_id");
CREATE INDEX "idx_pdr_deadline" ON "personal_deadline_reminders"("personal_deadline_id");
CREATE INDEX "idx_pdr_scheduled" ON "personal_deadline_reminders"("scheduled_for", "delivery_status");

-- AddForeignKey
ALTER TABLE "personal_deadlines" ADD CONSTRAINT "personal_deadlines_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "personal_deadlines" ADD CONSTRAINT "personal_deadlines_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "personal_deadline_reminders" ADD CONSTRAINT "personal_deadline_reminders_pd_id_fkey"
  FOREIGN KEY ("personal_deadline_id") REFERENCES "personal_deadlines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (mirror transfers_access: permissive, app-layer enforced)
ALTER TABLE "personal_deadlines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_deadlines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personal_deadlines_access" ON "personal_deadlines" USING (true);

ALTER TABLE "personal_deadline_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_deadline_reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personal_deadline_reminders_access" ON "personal_deadline_reminders" USING (true);

-- updated_at trigger (convention trg_<table>_updated_at; set_updated_at() exists).
-- personal_deadline_reminders has no updated_at -> no trigger.
DROP TRIGGER IF EXISTS trg_personal_deadlines_updated_at ON personal_deadlines;
CREATE TRIGGER trg_personal_deadlines_updated_at
  BEFORE UPDATE ON personal_deadlines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grants (explicit, not relying on default privileges)
GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_deadlines" TO garageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_deadline_reminders" TO garageos_app;

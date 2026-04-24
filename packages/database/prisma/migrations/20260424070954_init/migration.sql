-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'pending', 'cancelled');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('manual', 'stripe_active', 'stripe_past_due');

-- CreateEnum
CREATE TYPE "LocationStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('super_admin', 'mechanic');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive', 'invited');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('active', 'pending_verification', 'deleted');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('pending', 'certified', 'archived');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('car', 'motorcycle', 'van', 'truck', 'agricultural');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'methane', 'hydrogen', 'other');

-- CreateEnum
CREATE TYPE "TransferMethod" AS ENUM ('initiated_by_seller', 'claim_without_seller');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('pending_recipient', 'pending_seller_confirmation', 'pending_validation', 'completed', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "OwnershipTransferReason" AS ENUM ('purchase', 'inheritance', 'company_assignment', 'other');

-- CreateEnum
CREATE TYPE "InterventionTypeCategory" AS ENUM ('maintenance', 'repair', 'tires', 'body', 'inspection', 'other');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('active', 'disputed', 'cancelled');

-- CreateEnum
CREATE TYPE "DisputeReasonCategory" AS ENUM ('not_performed', 'wrong_data', 'not_authorized', 'other');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'responded', 'resolved_by_cancellation', 'escalated', 'closed_by_admin');

-- CreateEnum
CREATE TYPE "DeadlineStatus" AS ENUM ('open', 'completed', 'overdue', 'cancelled');

-- CreateEnum
CREATE TYPE "DeadlineReminderType" AS ENUM ('t_minus_30', 't_minus_7', 't_zero', 'km_reached');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AttachmentOwnerType" AS ENUM ('intervention', 'private_intervention');

-- CreateEnum
CREATE TYPE "AccessLogAction" AS ENUM ('view', 'create', 'update', 'search_match');

-- CreateEnum
CREATE TYPE "InvitationType" AS ENUM ('customer_app', 'internal_user');

-- CreateEnum
CREATE TYPE "PushTokenPlatform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'customer', 'system', 'admin');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_name" VARCHAR(200) NOT NULL,
    "vat_number" VARCHAR(20) NOT NULL,
    "tax_code" VARCHAR(20),
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(30),
    "address_line" VARCHAR(255),
    "city" VARCHAR(100),
    "province" VARCHAR(2),
    "postal_code" VARCHAR(10),
    "logo_url" VARCHAR(500),
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "billing_status" "BillingStatus" NOT NULL DEFAULT 'manual',
    "plan" VARCHAR(50) NOT NULL DEFAULT 'starter',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "address_line" VARCHAR(255) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "province" VARCHAR(2) NOT NULL,
    "postal_code" VARCHAR(10) NOT NULL,
    "country" VARCHAR(2) NOT NULL DEFAULT 'IT',
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "phone" VARCHAR(30),
    "email" VARCHAR(255),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" "LocationStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID,
    "cognito_sub" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "role" "UserRole" NOT NULL,
    "avatar_url" VARCHAR(500),
    "phone" VARCHAR(30),
    "last_login_at" TIMESTAMPTZ,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cognito_sub" VARCHAR(100),
    "email" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(30),
    "tax_code" VARCHAR(20),
    "is_business" BOOLEAN NOT NULL DEFAULT false,
    "business_name" VARCHAR(200),
    "vat_number" VARCHAR(20),
    "address_line" VARCHAR(255),
    "city" VARCHAR(100),
    "province" VARCHAR(2),
    "postal_code" VARCHAR(10),
    "app_installed" BOOLEAN NOT NULL DEFAULT false,
    "notification_preferences" JSONB NOT NULL DEFAULT '{}',
    "status" "CustomerStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tenant_relations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "first_intervention_at" TIMESTAMPTZ,
    "last_intervention_at" TIMESTAMPTZ,
    "intervention_count" INTEGER NOT NULL DEFAULT 0,
    "tenant_notes" TEXT,
    "customer_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_tenant_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "garage_code" VARCHAR(12),
    "vin" VARCHAR(17) NOT NULL,
    "plate" VARCHAR(10) NOT NULL,
    "plate_country" VARCHAR(2) NOT NULL DEFAULT 'IT',
    "make" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "version" VARCHAR(150),
    "year" SMALLINT NOT NULL,
    "registration_date" DATE,
    "vehicle_type" "VehicleType" NOT NULL,
    "fuel_type" "FuelType" NOT NULL,
    "engine_displacement" INTEGER,
    "power_kw" INTEGER,
    "color" VARCHAR(50),
    "status" "VehicleStatus" NOT NULL DEFAULT 'pending',
    "certified_by_tenant_id" UUID,
    "certified_at" TIMESTAMPTZ,
    "created_by_tenant_id" UUID,
    "created_by_customer_id" UUID,
    "pending_metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_ownerships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "transfer_reason" "OwnershipTransferReason",
    "transfer_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "from_customer_id" UUID,
    "to_customer_id" UUID,
    "transfer_code" VARCHAR(20),
    "invited_email" VARCHAR(255),
    "method" "TransferMethod" NOT NULL,
    "status" "TransferStatus" NOT NULL,
    "document_url" VARCHAR(500),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "rejected_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicle_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "name_it" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(50),
    "category" "InterventionTypeCategory" NOT NULL,
    "suggests_deadline" BOOLEAN NOT NULL DEFAULT false,
    "default_deadline_months" SMALLINT,
    "default_deadline_km" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intervention_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "intervention_type_id" UUID NOT NULL,
    "intervention_date" DATE NOT NULL,
    "odometer_km" INTEGER NOT NULL,
    "title" VARCHAR(200),
    "description" TEXT NOT NULL,
    "parts_replaced" JSONB NOT NULL DEFAULT '[]',
    "internal_notes" TEXT,
    "status" "InterventionStatus" NOT NULL DEFAULT 'active',
    "cancelled_reason" TEXT,
    "cancelled_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "first_seen_by_customer_at" TIMESTAMPTZ,
    "wiki_locked_at" TIMESTAMPTZ,
    "km_anomaly" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intervention_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "revised_at" TIMESTAMPTZ NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT,

    CONSTRAINT "intervention_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention_disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intervention_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "reason_category" "DisputeReasonCategory" NOT NULL,
    "customer_description" TEXT NOT NULL,
    "tenant_response" TEXT,
    "tenant_response_at" TIMESTAMPTZ,
    "tenant_response_user_id" UUID,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intervention_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_interventions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "intervention_type_id" UUID,
    "custom_type" VARCHAR(150),
    "intervention_date" DATE NOT NULL,
    "odometer_km" INTEGER,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "private_interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_type" "AttachmentOwnerType" NOT NULL,
    "owner_id" UUID NOT NULL,
    "tenant_id" UUID,
    "customer_id" UUID,
    "uploaded_by_user_id" UUID,
    "uploaded_by_customer_id" UUID,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "s3_key" VARCHAR(500) NOT NULL,
    "s3_bucket" VARCHAR(100) NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "thumbnail_s3_key" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deadlines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "intervention_type_id" UUID NOT NULL,
    "source_intervention_id" UUID,
    "due_date" DATE,
    "due_odometer_km" INTEGER,
    "description" TEXT,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurring_months" SMALLINT,
    "recurring_km" INTEGER,
    "status" "DeadlineStatus" NOT NULL DEFAULT 'open',
    "completed_by_intervention_id" UUID,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deadline_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deadline_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "reminder_type" "DeadlineReminderType" NOT NULL,
    "eventbridge_schedule_arn" VARCHAR(500),
    "sent_at" TIMESTAMPTZ,
    "delivery_status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deadline_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID,
    "user_id" UUID NOT NULL,
    "action" "AccessLogAction" NOT NULL,
    "ip_address" INET,
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" INET,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "invitation_type" "InvitationType" NOT NULL,
    "target_email" VARCHAR(255) NOT NULL,
    "target_phone" VARCHAR(30),
    "vehicle_id" UUID,
    "customer_id" UUID,
    "role" "UserRole",
    "location_id" UUID,
    "token" VARCHAR(100) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "expo_push_token" VARCHAR(200) NOT NULL,
    "platform" "PushTokenPlatform" NOT NULL,
    "device_name" VARCHAR(100),
    "app_version" VARCHAR(20),
    "last_used_at" TIMESTAMPTZ NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_vat_number_key" ON "tenants"("vat_number");

-- CreateIndex
CREATE INDEX "idx_tenants_vat_number" ON "tenants"("vat_number");

-- CreateIndex
CREATE INDEX "idx_tenants_status" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "idx_locations_tenant_id" ON "locations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_sub_key" ON "users"("cognito_sub");

-- CreateIndex
CREATE INDEX "idx_users_tenant_id" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_cognito_sub_key" ON "customers"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE INDEX "idx_customers_cognito_sub" ON "customers"("cognito_sub");

-- CreateIndex
CREATE INDEX "idx_customers_email" ON "customers"("email");

-- CreateIndex
CREATE INDEX "idx_customers_phone" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "idx_customer_tenant_customer" ON "customer_tenant_relations"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_tenant" ON "customer_tenant_relations"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_garage_code_key" ON "vehicles"("garage_code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- CreateIndex
CREATE INDEX "idx_vehicles_plate" ON "vehicles"("plate");

-- CreateIndex
CREATE INDEX "idx_vehicles_status" ON "vehicles"("status");

-- CreateIndex
CREATE INDEX "idx_ownership_vehicle_id" ON "vehicle_ownerships"("vehicle_id");

-- CreateIndex
CREATE INDEX "idx_ownership_customer_id" ON "vehicle_ownerships"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_transfers_transfer_code_key" ON "vehicle_transfers"("transfer_code");

-- CreateIndex
CREATE INDEX "idx_transfer_vehicle_id" ON "vehicle_transfers"("vehicle_id");

-- CreateIndex
CREATE INDEX "idx_transfer_status" ON "vehicle_transfers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_intervention_type_code_tenant" ON "intervention_types"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "idx_interventions_tenant_id" ON "interventions"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_interventions_vehicle_id" ON "interventions"("vehicle_id");

-- CreateIndex
CREATE INDEX "idx_interventions_vehicle_date" ON "interventions"("vehicle_id", "intervention_date" DESC);

-- CreateIndex
CREATE INDEX "idx_interventions_status" ON "interventions"("status");

-- CreateIndex
CREATE INDEX "idx_revisions_intervention" ON "intervention_revisions"("intervention_id");

-- CreateIndex
CREATE INDEX "idx_disputes_intervention" ON "intervention_disputes"("intervention_id");

-- CreateIndex
CREATE INDEX "idx_disputes_customer" ON "intervention_disputes"("customer_id");

-- CreateIndex
CREATE INDEX "idx_disputes_status" ON "intervention_disputes"("status");

-- CreateIndex
CREATE INDEX "idx_private_int_customer_vehicle" ON "private_interventions"("customer_id", "vehicle_id", "intervention_date" DESC);

-- CreateIndex
CREATE INDEX "idx_attachments_owner" ON "attachments"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "idx_attachments_tenant" ON "attachments"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_deadlines_vehicle" ON "deadlines"("vehicle_id");

-- CreateIndex
CREATE INDEX "idx_deadlines_tenant_status_date" ON "deadlines"("tenant_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "idx_deadlines_due_date_open" ON "deadlines"("due_date");

-- CreateIndex
CREATE INDEX "idx_dln_deadline" ON "deadline_notifications"("deadline_id");

-- CreateIndex
CREATE INDEX "idx_dln_scheduled_pending" ON "deadline_notifications"("scheduled_for");

-- CreateIndex
CREATE INDEX "idx_access_log_vehicle" ON "access_logs"("vehicle_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_access_log_tenant" ON "access_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_tenant_date" ON "audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_entity" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "idx_invitation_expires" ON "invitations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_expo_push_token_key" ON "push_tokens"("expo_push_token");

-- CreateIndex
CREATE INDEX "idx_push_customer_active" ON "push_tokens"("customer_id");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tenant_relations" ADD CONSTRAINT "customer_tenant_relations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tenant_relations" ADD CONSTRAINT "customer_tenant_relations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_certified_by_tenant_id_fkey" FOREIGN KEY ("certified_by_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_tenant_id_fkey" FOREIGN KEY ("created_by_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_customer_id_fkey" FOREIGN KEY ("created_by_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_ownerships" ADD CONSTRAINT "vehicle_ownerships_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_ownerships" ADD CONSTRAINT "vehicle_ownerships_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_from_customer_id_fkey" FOREIGN KEY ("from_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_transfers" ADD CONSTRAINT "vehicle_transfers_to_customer_id_fkey" FOREIGN KEY ("to_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_types" ADD CONSTRAINT "intervention_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_intervention_type_id_fkey" FOREIGN KEY ("intervention_type_id") REFERENCES "intervention_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_revisions" ADD CONSTRAINT "intervention_revisions_intervention_id_fkey" FOREIGN KEY ("intervention_id") REFERENCES "interventions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_revisions" ADD CONSTRAINT "intervention_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_disputes" ADD CONSTRAINT "intervention_disputes_intervention_id_fkey" FOREIGN KEY ("intervention_id") REFERENCES "interventions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_disputes" ADD CONSTRAINT "intervention_disputes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_disputes" ADD CONSTRAINT "intervention_disputes_tenant_response_user_id_fkey" FOREIGN KEY ("tenant_response_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_interventions" ADD CONSTRAINT "private_interventions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_interventions" ADD CONSTRAINT "private_interventions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_interventions" ADD CONSTRAINT "private_interventions_intervention_type_id_fkey" FOREIGN KEY ("intervention_type_id") REFERENCES "intervention_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_intervention_type_id_fkey" FOREIGN KEY ("intervention_type_id") REFERENCES "intervention_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_source_intervention_id_fkey" FOREIGN KEY ("source_intervention_id") REFERENCES "interventions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_completed_by_intervention_id_fkey" FOREIGN KEY ("completed_by_intervention_id") REFERENCES "interventions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_notifications" ADD CONSTRAINT "deadline_notifications_deadline_id_fkey" FOREIGN KEY ("deadline_id") REFERENCES "deadlines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

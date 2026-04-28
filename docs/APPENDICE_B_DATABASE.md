# Appendice B — Database

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Formalizza lo schema Prisma, le migration, i seed, i validator Zod e la configurazione RLS.
>
> **Versione:** v1.3 — allineata a `GarageOS-Specifiche.md` v1.1 e `APPENDICE_F_BUSINESS_LOGIC.md` v1.0. Migration 0004: split SELECT/WRITE su `users`, abilita RLS append-only su `intervention_revisions`.
> **Ultimo aggiornamento:** 24 aprile 2026
>
> **Nota Prisma 7.** I frammenti di codice in §1.3 e §2.1 sono il riferimento originale per Prisma 5/6. La codebase effettiva usa Prisma 7 con alcuni adattamenti:
> - `generator.provider = "prisma-client"` (nuovo ESM-native generator, sostituisce `prisma-client-js`)
> - `generator.output` obbligatorio (no default directory)
> - `datasource.url` / `directUrl` non vivono più in `schema.prisma`: sono in `prisma.config.ts`
> - `@prisma/adapter-pg` (`PrismaPg`) obbligatorio a runtime — niente più driver nativo built-in
>
> Le differenze sono documentate nel `README.md` di `packages/database` e nel codice di `src/client.ts` / `prisma.config.ts`.

---

## Scopo di questo documento

Questa appendice fornisce **tutto il materiale necessario** per portare Claude Code (o uno sviluppatore) a uno schema database funzionante e seed-ato in un'unica sessione. Include:

1. Schema Prisma completo ed eseguibile
2. Convenzioni e pattern architetturali del data layer
3. Script di migrazione SQL (RLS, trigger, function)
4. Seed script per dati iniziali
5. Validator Zod corrispondenti
6. Esempi di query Prisma comuni
7. Strategia di backup/restore

---

## Indice

1. [Setup iniziale](#1-setup-iniziale)
2. [Schema Prisma completo](#2-schema-prisma-completo)
3. [Migration SQL aggiuntive (RLS, trigger)](#3-migration-sql-aggiuntive-rls-trigger)
4. [Seed data](#4-seed-data)
5. [Validator Zod](#5-validator-zod)
6. [Pattern di query Prisma comuni](#6-pattern-di-query-prisma-comuni)
7. [Indici e performance](#7-indici-e-performance)
8. [Backup e restore](#8-backup-e-restore)
9. [Convenzioni e note implementative](#9-convenzioni-e-note-implementative)

---

## 1. Setup iniziale

### 1.1 Prerequisiti

- **Node.js** 20 LTS
- **npm** o **pnpm** (pnpm raccomandato per monorepo)
- **PostgreSQL** 15+ hostato su **Supabase** (DB-only mode, account con sottoscrizione Pro)
- **Prisma CLI** installato globalmente o via `npx`

> **Nota architetturale:** Supabase è usato in **modalità PostgreSQL-only**. Non usiamo Supabase Auth, Storage, Edge Functions o Realtime. Supabase è un provider PostgreSQL managed con dashboard admin, PITR, branching — nient'altro. Tutti gli altri servizi (auth, storage, scheduler) sono su AWS.

### 1.2 Struttura del package `database`

Nel monorepo, si crea un package dedicato `packages/database`:

```
packages/database/
├── prisma/
│   ├── schema.prisma         # Schema principale
│   ├── migrations/           # Migration auto-generate
│   │   └── 00000000000000_init/
│   │       └── migration.sql
│   └── seed.ts               # Script seed TypeScript
├── src/
│   ├── client.ts             # Prisma client singleton + RLS helper
│   ├── validators/           # Schemi Zod
│   └── queries/              # Query Prisma riutilizzabili
├── sql/
│   ├── rls-policies.sql      # RLS policies setup
│   ├── triggers.sql          # Trigger updated_at, audit
│   └── functions.sql         # Function PostgreSQL custom
├── package.json
└── tsconfig.json
```

### 1.3 Package.json del database

```json
{
  "name": "@garageos/database",
  "version": "0.1.0",
  "main": "./src/client.ts",
  "scripts": {
    "db:generate": "prisma generate",
    "db:migrate:dev": "prisma migrate dev",
    "db:migrate:deploy": "prisma migrate deploy",
    "db:migrate:reset": "prisma migrate reset",
    "db:seed": "tsx prisma/seed.ts",
    "db:studio": "prisma studio",
    "db:rls:apply": "psql $DATABASE_URL -f sql/rls-policies.sql",
    "db:triggers:apply": "psql $DATABASE_URL -f sql/triggers.sql",
    "db:setup": "pnpm db:migrate:deploy && pnpm db:rls:apply && pnpm db:triggers:apply && pnpm db:seed"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "prisma": "^5.22.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  },
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  }
}
```

### 1.4 Variabili ambiente

File `.env` (da NON committare):

```bash
# Supabase PostgreSQL connection strings
# DATABASE_URL usa il Transaction Pooler (porta 6543) per query runtime
# DIRECT_URL usa la connessione diretta (porta 5432) per migration

# Formato Supabase:
# postgres://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:6543/postgres
# postgres://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres

DATABASE_URL="postgres://postgres.abcdefghij:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgres://postgres.abcdefghij:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
```

**Come ottenere le connection string:**
1. Dashboard Supabase → Project Settings → Database
2. Sezione "Connection string" → scegliere "Transaction" per `DATABASE_URL` e "Session" per `DIRECT_URL`
3. Sostituire `[YOUR-PASSWORD]` con la password del database salvata in Secrets Manager

**Note Supabase:**
- La region consigliata è `eu-central-1` (Francoforte) per compliance GDPR e latenza con App Runner eu-central-1
- Il parametro `pgbouncer=true` nella DATABASE_URL abilita il prepared statement mode compatibile con il pooler Supabase
- Il pooler (porta 6543) **non supporta prepared statements**; per query che ne hanno bisogno (alcune Prisma raw queries) usare DIRECT_URL
- **Rotazione password**: la password DB è rotabile da dashboard Supabase senza downtime (entrambe le password restano valide per 60 secondi)

### 1.5 Comandi di inizializzazione

```bash
# Prima volta: dalla root del monorepo
pnpm --filter @garageos/database install
pnpm --filter @garageos/database db:migrate:dev --name init
pnpm --filter @garageos/database db:rls:apply
pnpm --filter @garageos/database db:triggers:apply
pnpm --filter @garageos/database db:seed

# Oppure tutto in uno:
pnpm --filter @garageos/database db:setup
```

---

## 2. Schema Prisma completo

### 2.1 File `prisma/schema.prisma`

```prisma
// =====================================================
// GarageOS Database Schema
// Generato da: GarageOS-Specifiche.md §6 + APPENDICE_F
// Versione: 1.0
// =====================================================

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["fullTextSearchPostgres"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ---------------------------------------------------
// ENUMS
// ---------------------------------------------------

enum TenantStatus {
  active
  suspended
  pending
  cancelled
}

enum BillingStatus {
  manual           // v1: bonifico manuale
  stripe_active    // v1.1+
  stripe_past_due
}

enum LocationStatus {
  active
  inactive
}

enum UserRole {
  super_admin
  mechanic
}

enum UserStatus {
  active
  inactive
  invited
}

enum CustomerStatus {
  active
  pending_verification
  deleted
}

enum VehicleStatus {
  pending
  certified
  archived
}

enum VehicleType {
  car
  motorcycle
  van
  truck
  agricultural
}

enum FuelType {
  petrol
  diesel
  electric
  hybrid
  lpg
  methane
  hydrogen
  other
}

enum TransferMethod {
  initiated_by_seller
  claim_without_seller
}

enum TransferStatus {
  pending_recipient
  pending_seller_confirmation
  pending_validation
  completed
  rejected
  expired
}

enum OwnershipTransferReason {
  purchase
  inheritance
  company_assignment
  other
}

enum InterventionTypeCategory {
  maintenance
  repair
  tires
  body
  inspection
  other
}

enum InterventionStatus {
  active
  disputed
  cancelled
}

enum DisputeReasonCategory {
  not_performed
  wrong_data
  not_authorized
  other
}

enum DisputeStatus {
  open
  responded
  resolved_by_cancellation
  escalated
  closed_by_admin
}

enum DeadlineStatus {
  open
  completed
  overdue
  cancelled
}

enum DeadlineReminderType {
  t_minus_30
  t_minus_7
  t_zero
  km_reached
}

enum NotificationDeliveryStatus {
  pending
  sent
  failed
  cancelled
}

enum AttachmentOwnerType {
  intervention
  private_intervention
}

enum AccessLogAction {
  view
  create
  update
  search_match
}

enum InvitationType {
  customer_app
  internal_user
}

enum PushTokenPlatform {
  ios
  android
}

enum AuditActorType {
  user
  customer
  system
  admin
}

// ---------------------------------------------------
// TENANT & ORGANIZATION
// ---------------------------------------------------

model Tenant {
  id              String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  businessName    String         @map("business_name") @db.VarChar(200)
  vatNumber       String         @unique @map("vat_number") @db.VarChar(20)
  taxCode         String?        @map("tax_code") @db.VarChar(20)
  email           String         @db.VarChar(255)
  phone           String?        @db.VarChar(30)
  addressLine     String?        @map("address_line") @db.VarChar(255)
  city            String?        @db.VarChar(100)
  province        String?        @db.VarChar(2)
  postalCode      String?        @map("postal_code") @db.VarChar(10)
  logoUrl         String?        @map("logo_url") @db.VarChar(500)
  status          TenantStatus   @default(active)
  billingStatus   BillingStatus  @default(manual) @map("billing_status")
  plan            String         @default("starter") @db.VarChar(50)
  settings        Json           @default("{}")
  createdAt       DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime       @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt       DateTime?      @map("deleted_at") @db.Timestamptz

  locations       Location[]
  users           User[]
  customerRelations CustomerTenantRelation[]
  interventions   Intervention[]
  deadlines       Deadline[]
  invitations     Invitation[]
  accessLogs      AccessLog[]
  interventionTypes InterventionType[]
  certifiedVehicles Vehicle[] @relation("CertifiedBy")
  createdVehicles Vehicle[] @relation("CreatedByTenant")

  @@index([vatNumber], map: "idx_tenants_vat_number")
  @@index([status], map: "idx_tenants_status")
  @@map("tenants")
}

model Location {
  id           String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId     String         @map("tenant_id") @db.Uuid
  name         String         @db.VarChar(150)
  addressLine  String         @map("address_line") @db.VarChar(255)
  city         String         @db.VarChar(100)
  province     String         @db.VarChar(2)
  postalCode   String         @map("postal_code") @db.VarChar(10)
  country      String         @default("IT") @db.VarChar(2)
  latitude     Decimal?       @db.Decimal(10, 7)
  longitude    Decimal?       @db.Decimal(10, 7)
  phone        String?        @db.VarChar(30)
  email        String?        @db.VarChar(255)
  isPrimary    Boolean        @default(false) @map("is_primary")
  status       LocationStatus @default(active)
  createdAt    DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime       @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt    DateTime?      @map("deleted_at") @db.Timestamptz

  tenant        Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  users         User[]
  interventions Intervention[]
  accessLogs    AccessLog[]
  deadlines     Deadline[]

  @@index([tenantId], map: "idx_locations_tenant_id")
  @@map("locations")
}

model User {
  id           String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId     String     @map("tenant_id") @db.Uuid
  locationId   String?    @map("location_id") @db.Uuid
  cognitoSub   String     @unique @map("cognito_sub") @db.VarChar(100)
  email        String     @db.VarChar(255)
  firstName    String     @map("first_name") @db.VarChar(100)
  lastName     String     @map("last_name") @db.VarChar(100)
  role         UserRole
  avatarUrl    String?    @map("avatar_url") @db.VarChar(500)
  phone        String?    @db.VarChar(30)
  lastLoginAt  DateTime?  @map("last_login_at") @db.Timestamptz
  status       UserStatus @default(active)
  createdAt    DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime   @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt    DateTime?  @map("deleted_at") @db.Timestamptz

  tenant              Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  location            Location?      @relation(fields: [locationId], references: [id], onDelete: SetNull)
  interventions       Intervention[] @relation("PerformedBy")
  cancelledInterventions Intervention[] @relation("CancelledBy")
  revisions           InterventionRevision[]
  disputeResponses    InterventionDispute[]
  accessLogs          AccessLog[]

  @@index([tenantId], map: "idx_users_tenant_id")
  @@index([email], map: "idx_users_email")
  @@map("users")
}

// ---------------------------------------------------
// CUSTOMER (B2C)
// ---------------------------------------------------

model Customer {
  id                     String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  cognitoSub             String?        @unique @map("cognito_sub") @db.VarChar(100)
  email                  String         @unique @db.VarChar(255)
  firstName              String         @map("first_name") @db.VarChar(100)
  lastName               String         @map("last_name") @db.VarChar(100)
  phone                  String?        @db.VarChar(30)
  taxCode                String?        @map("tax_code") @db.VarChar(20)
  isBusiness             Boolean        @default(false) @map("is_business")
  businessName           String?        @map("business_name") @db.VarChar(200)
  vatNumber              String?        @map("vat_number") @db.VarChar(20)
  addressLine            String?        @map("address_line") @db.VarChar(255)
  city                   String?        @db.VarChar(100)
  province               String?        @db.VarChar(2)
  postalCode             String?        @map("postal_code") @db.VarChar(10)
  appInstalled           Boolean        @default(false) @map("app_installed")
  notificationPreferences Json          @default("{}") @map("notification_preferences")
  status                 CustomerStatus @default(active)
  createdAt              DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt              DateTime       @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt              DateTime?      @map("deleted_at") @db.Timestamptz

  tenantRelations     CustomerTenantRelation[]
  ownerships          VehicleOwnership[]
  privateInterventions PrivateIntervention[]
  pushTokens          PushToken[]
  disputes            InterventionDispute[]
  transfersFrom       VehicleTransfer[] @relation("TransferFrom")
  transfersTo         VehicleTransfer[] @relation("TransferTo")
  createdVehicles     Vehicle[] @relation("CreatedByCustomer")

  @@index([cognitoSub], map: "idx_customers_cognito_sub")
  @@index([email], map: "idx_customers_email")
  @@index([phone], map: "idx_customers_phone")
  @@map("customers")
}

model CustomerTenantRelation {
  id                   String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId             String    @map("tenant_id") @db.Uuid
  customerId           String    @map("customer_id") @db.Uuid
  firstInterventionAt  DateTime? @map("first_intervention_at") @db.Timestamptz
  lastInterventionAt   DateTime? @map("last_intervention_at") @db.Timestamptz
  interventionCount    Int       @default(0) @map("intervention_count")
  tenantNotes          String?   @map("tenant_notes") @db.Text
  customerDeleted      Boolean   @default(false) @map("customer_deleted")
  createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@unique([tenantId, customerId], map: "uq_customer_tenant")
  @@index([customerId], map: "idx_customer_tenant_customer")
  @@map("customer_tenant_relations")
}

// ---------------------------------------------------
// VEHICLE (CROSS-TENANT CORE)
// ---------------------------------------------------

model Vehicle {
  id                     String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  garageCode             String?       @unique @map("garage_code") @db.VarChar(12)
  vin                    String        @unique @db.VarChar(17)
  plate                  String        @db.VarChar(10)
  plateCountry           String        @default("IT") @map("plate_country") @db.VarChar(2)
  make                   String        @db.VarChar(50)
  model                  String        @db.VarChar(100)
  version                String?       @db.VarChar(150)
  year                   Int           @db.SmallInt
  registrationDate       DateTime?     @map("registration_date") @db.Date
  vehicleType            VehicleType   @map("vehicle_type")
  fuelType               FuelType      @map("fuel_type")
  engineDisplacement     Int?          @map("engine_displacement")
  powerKw                Int?          @map("power_kw")
  color                  String?       @db.VarChar(50)
  status                 VehicleStatus @default(pending)
  certifiedByTenantId    String?       @map("certified_by_tenant_id") @db.Uuid
  certifiedAt            DateTime?     @map("certified_at") @db.Timestamptz
  createdByTenantId      String?       @map("created_by_tenant_id") @db.Uuid
  createdByCustomerId    String?       @map("created_by_customer_id") @db.Uuid
  pendingMetadata        Json?         @map("pending_metadata")
  createdAt              DateTime      @default(now()) @map("created_at") @db.Timestamptz
  updatedAt              DateTime      @updatedAt @map("updated_at") @db.Timestamptz
  archivedAt             DateTime?     @map("archived_at") @db.Timestamptz

  certifiedByTenant   Tenant?   @relation("CertifiedBy", fields: [certifiedByTenantId], references: [id], onDelete: SetNull)
  createdByTenant     Tenant?   @relation("CreatedByTenant", fields: [createdByTenantId], references: [id], onDelete: SetNull)
  createdByCustomer   Customer? @relation("CreatedByCustomer", fields: [createdByCustomerId], references: [id], onDelete: SetNull)
  ownerships          VehicleOwnership[]
  transfers           VehicleTransfer[]
  interventions       Intervention[]
  privateInterventions PrivateIntervention[]
  deadlines           Deadline[]
  accessLogs          AccessLog[]
  invitations         Invitation[]

  @@index([plate], map: "idx_vehicles_plate")
  @@index([status], map: "idx_vehicles_status")
  @@map("vehicles")
}

model VehicleOwnership {
  id              String                    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  vehicleId       String                    @map("vehicle_id") @db.Uuid
  customerId      String                    @map("customer_id") @db.Uuid
  startedAt       DateTime                  @map("started_at") @db.Timestamptz
  endedAt         DateTime?                 @map("ended_at") @db.Timestamptz
  transferReason  OwnershipTransferReason?  @map("transfer_reason")
  transferNotes   String?                   @map("transfer_notes") @db.Text
  createdAt       DateTime                  @default(now()) @map("created_at") @db.Timestamptz

  vehicle  Vehicle  @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([vehicleId], map: "idx_ownership_vehicle_id")
  @@index([customerId], map: "idx_ownership_customer_id")
  @@map("vehicle_ownerships")
}

model VehicleTransfer {
  id                     String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  vehicleId              String         @map("vehicle_id") @db.Uuid
  fromCustomerId         String?        @map("from_customer_id") @db.Uuid
  toCustomerId           String?        @map("to_customer_id") @db.Uuid
  transferCode           String?        @unique @map("transfer_code") @db.VarChar(20)
  invitedEmail           String?        @map("invited_email") @db.VarChar(255)
  method                 TransferMethod
  status                 TransferStatus
  documentUrl            String?        @map("document_url") @db.VarChar(500)
  expiresAt              DateTime       @map("expires_at") @db.Timestamptz
  completedAt            DateTime?      @map("completed_at") @db.Timestamptz
  rejectedReason         String?        @map("rejected_reason") @db.Text
  createdAt              DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt              DateTime       @updatedAt @map("updated_at") @db.Timestamptz

  vehicle      Vehicle   @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  fromCustomer Customer? @relation("TransferFrom", fields: [fromCustomerId], references: [id], onDelete: SetNull)
  toCustomer   Customer? @relation("TransferTo", fields: [toCustomerId], references: [id], onDelete: SetNull)

  @@index([vehicleId], map: "idx_transfer_vehicle_id")
  @@index([status], map: "idx_transfer_status")
  @@map("vehicle_transfers")
}

// ---------------------------------------------------
// INTERVENTIONS
// ---------------------------------------------------

model InterventionType {
  id                    String                   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId              String?                  @map("tenant_id") @db.Uuid
  code                  String                   @db.VarChar(50)
  nameIt                String                   @map("name_it") @db.VarChar(150)
  description           String?                  @db.Text
  icon                  String?                  @db.VarChar(50)
  category              InterventionTypeCategory
  suggestsDeadline      Boolean                  @default(false) @map("suggests_deadline")
  defaultDeadlineMonths Int?                     @map("default_deadline_months") @db.SmallInt
  defaultDeadlineKm     Int?                     @map("default_deadline_km")
  active                Boolean                  @default(true)
  createdAt             DateTime                 @default(now()) @map("created_at") @db.Timestamptz
  updatedAt             DateTime                 @updatedAt @map("updated_at") @db.Timestamptz

  tenant                    Tenant?               @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  interventions             Intervention[]
  privateInterventions      PrivateIntervention[]
  deadlines                 Deadline[]

  @@unique([tenantId, code], map: "uq_intervention_type_code_tenant")
  @@map("intervention_types")
}

model Intervention {
  id                      String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId                String              @map("tenant_id") @db.Uuid
  locationId              String              @map("location_id") @db.Uuid
  userId                  String              @map("user_id") @db.Uuid
  vehicleId               String              @map("vehicle_id") @db.Uuid
  interventionTypeId      String              @map("intervention_type_id") @db.Uuid
  interventionDate        DateTime            @map("intervention_date") @db.Date
  odometerKm              Int                 @map("odometer_km")
  title                   String?             @db.VarChar(200)
  description             String              @db.Text
  partsReplaced           Json                @default("[]") @map("parts_replaced")
  internalNotes           String?             @map("internal_notes") @db.Text
  status                  InterventionStatus  @default(active)
  cancelledReason         String?             @map("cancelled_reason") @db.Text
  cancelledByUserId       String?             @map("cancelled_by_user_id") @db.Uuid
  cancelledAt             DateTime?           @map("cancelled_at") @db.Timestamptz
  firstSeenByCustomerAt   DateTime?           @map("first_seen_by_customer_at") @db.Timestamptz
  wikiLockedAt            DateTime?           @map("wiki_locked_at") @db.Timestamptz
  kmAnomaly               Boolean             @default(false) @map("km_anomaly")
  createdAt               DateTime            @default(now()) @map("created_at") @db.Timestamptz
  updatedAt               DateTime            @updatedAt @map("updated_at") @db.Timestamptz

  tenant            Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  location          Location               @relation(fields: [locationId], references: [id], onDelete: Restrict)
  user              User                   @relation("PerformedBy", fields: [userId], references: [id], onDelete: Restrict)
  vehicle           Vehicle                @relation(fields: [vehicleId], references: [id], onDelete: Restrict)
  interventionType  InterventionType       @relation(fields: [interventionTypeId], references: [id], onDelete: Restrict)
  cancelledByUser   User?                  @relation("CancelledBy", fields: [cancelledByUserId], references: [id], onDelete: SetNull)
  revisions         InterventionRevision[]
  disputes          InterventionDispute[]
  completedDeadlines Deadline[]            @relation("CompletedByIntervention")
  sourceDeadlines   Deadline[]             @relation("SourceIntervention")

  @@index([tenantId], map: "idx_interventions_tenant_id")
  @@index([vehicleId], map: "idx_interventions_vehicle_id")
  @@index([vehicleId, interventionDate(sort: Desc)], map: "idx_interventions_vehicle_date")
  @@index([status], map: "idx_interventions_status")
  @@map("interventions")
}

model InterventionRevision {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  interventionId  String   @map("intervention_id") @db.Uuid
  userId          String   @map("user_id") @db.Uuid
  revisedAt       DateTime @map("revised_at") @db.Timestamptz
  changes         Json
  reason          String?  @db.Text

  intervention Intervention @relation(fields: [interventionId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([interventionId], map: "idx_revisions_intervention")
  @@map("intervention_revisions")
}

model InterventionDispute {
  id                    String                @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  interventionId        String                @map("intervention_id") @db.Uuid
  customerId            String                @map("customer_id") @db.Uuid
  reasonCategory        DisputeReasonCategory @map("reason_category")
  customerDescription   String                @map("customer_description") @db.Text
  tenantResponse        String?               @map("tenant_response") @db.Text
  tenantResponseAt      DateTime?             @map("tenant_response_at") @db.Timestamptz
  tenantResponseUserId  String?               @map("tenant_response_user_id") @db.Uuid
  status                DisputeStatus         @default(open)
  resolvedAt            DateTime?             @map("resolved_at") @db.Timestamptz
  createdAt             DateTime              @default(now()) @map("created_at") @db.Timestamptz
  updatedAt             DateTime              @updatedAt @map("updated_at") @db.Timestamptz

  intervention       Intervention @relation(fields: [interventionId], references: [id], onDelete: Cascade)
  customer           Customer     @relation(fields: [customerId], references: [id], onDelete: Cascade)
  tenantResponseUser User?        @relation(fields: [tenantResponseUserId], references: [id], onDelete: SetNull)

  @@index([interventionId], map: "idx_disputes_intervention")
  @@index([customerId], map: "idx_disputes_customer")
  @@index([status], map: "idx_disputes_status")
  @@map("intervention_disputes")
}

model PrivateIntervention {
  id                 String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  customerId         String    @map("customer_id") @db.Uuid
  vehicleId          String    @map("vehicle_id") @db.Uuid
  interventionTypeId String?   @map("intervention_type_id") @db.Uuid
  customType         String?   @map("custom_type") @db.VarChar(150)
  interventionDate   DateTime  @map("intervention_date") @db.Date
  odometerKm         Int?      @map("odometer_km")
  description        String    @db.Text
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt          DateTime? @map("deleted_at") @db.Timestamptz

  customer         Customer          @relation(fields: [customerId], references: [id], onDelete: Cascade)
  vehicle          Vehicle           @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  interventionType InterventionType? @relation(fields: [interventionTypeId], references: [id], onDelete: SetNull)

  @@index([customerId, vehicleId, interventionDate(sort: Desc)], map: "idx_private_int_customer_vehicle")
  @@map("private_interventions")
}

// ---------------------------------------------------
// ATTACHMENTS
// ---------------------------------------------------

model Attachment {
  id                       String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  ownerType                AttachmentOwnerType @map("owner_type")
  ownerId                  String              @map("owner_id") @db.Uuid
  tenantId                 String?             @map("tenant_id") @db.Uuid
  customerId               String?             @map("customer_id") @db.Uuid
  uploadedByUserId         String?             @map("uploaded_by_user_id") @db.Uuid
  uploadedByCustomerId     String?             @map("uploaded_by_customer_id") @db.Uuid
  fileName                 String              @map("file_name") @db.VarChar(255)
  mimeType                 String              @map("mime_type") @db.VarChar(100)
  sizeBytes                Int                 @map("size_bytes")
  s3Key                    String              @map("s3_key") @db.VarChar(500)
  s3Bucket                 String              @map("s3_bucket") @db.VarChar(100)
  processed                Boolean             @default(false)
  thumbnailS3Key           String?             @map("thumbnail_s3_key") @db.VarChar(500)
  createdAt                DateTime            @default(now()) @map("created_at") @db.Timestamptz
  deletedAt                DateTime?           @map("deleted_at") @db.Timestamptz

  @@index([ownerType, ownerId], map: "idx_attachments_owner")
  @@index([tenantId], map: "idx_attachments_tenant")
  @@map("attachments")
}

// ---------------------------------------------------
// DEADLINES & NOTIFICATIONS
// ---------------------------------------------------

model Deadline {
  id                         String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId                   String          @map("tenant_id") @db.Uuid
  locationId                 String          @map("location_id") @db.Uuid
  vehicleId                  String          @map("vehicle_id") @db.Uuid
  interventionTypeId         String          @map("intervention_type_id") @db.Uuid
  sourceInterventionId       String?         @map("source_intervention_id") @db.Uuid
  dueDate                    DateTime?       @map("due_date") @db.Date
  dueOdometerKm              Int?            @map("due_odometer_km")
  description                String?         @db.Text
  isRecurring                Boolean         @default(false) @map("is_recurring")
  recurringMonths            Int?            @map("recurring_months") @db.SmallInt
  recurringKm                Int?            @map("recurring_km")
  status                     DeadlineStatus  @default(open)
  completedByInterventionId  String?         @map("completed_by_intervention_id") @db.Uuid
  completedAt                DateTime?       @map("completed_at") @db.Timestamptz
  createdAt                  DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt                  DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  tenant                  Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  location                Location               @relation(fields: [locationId], references: [id], onDelete: Restrict)
  vehicle                 Vehicle                @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  interventionType        InterventionType       @relation(fields: [interventionTypeId], references: [id], onDelete: Restrict)
  sourceIntervention      Intervention?          @relation("SourceIntervention", fields: [sourceInterventionId], references: [id], onDelete: SetNull)
  completedByIntervention Intervention?          @relation("CompletedByIntervention", fields: [completedByInterventionId], references: [id], onDelete: SetNull)
  notifications           DeadlineNotification[]

  @@index([vehicleId], map: "idx_deadlines_vehicle")
  @@index([tenantId, status, dueDate], map: "idx_deadlines_tenant_status_date")
  @@index([dueDate], map: "idx_deadlines_due_date_open")
  @@map("deadlines")
}

model DeadlineNotification {
  id                        String                     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  deadlineId                String                     @map("deadline_id") @db.Uuid
  scheduledFor              DateTime                   @map("scheduled_for") @db.Timestamptz
  reminderType              DeadlineReminderType       @map("reminder_type")
  eventbridgeScheduleArn    String?                    @map("eventbridge_schedule_arn") @db.VarChar(500)
  sentAt                    DateTime?                  @map("sent_at") @db.Timestamptz
  deliveryStatus            NotificationDeliveryStatus @default(pending) @map("delivery_status")
  failureReason             String?                    @map("failure_reason") @db.Text
  createdAt                 DateTime                   @default(now()) @map("created_at") @db.Timestamptz

  deadline Deadline @relation(fields: [deadlineId], references: [id], onDelete: Cascade)

  @@index([deadlineId], map: "idx_dln_deadline")
  @@index([scheduledFor], map: "idx_dln_scheduled_pending")
  @@map("deadline_notifications")
}

// ---------------------------------------------------
// AUDIT & LOGGING
// ---------------------------------------------------

model AccessLog {
  id         String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  vehicleId  String          @map("vehicle_id") @db.Uuid
  tenantId   String          @map("tenant_id") @db.Uuid
  locationId String?         @map("location_id") @db.Uuid
  userId     String          @map("user_id") @db.Uuid
  action     AccessLogAction
  ipAddress  String?         @map("ip_address") @db.Inet
  userAgent  String?         @map("user_agent") @db.VarChar(500)
  createdAt  DateTime        @default(now()) @map("created_at") @db.Timestamptz

  vehicle  Vehicle   @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  location Location? @relation(fields: [locationId], references: [id], onDelete: SetNull)
  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([vehicleId, createdAt(sort: Desc)], map: "idx_access_log_vehicle")
  @@index([tenantId, createdAt(sort: Desc)], map: "idx_access_log_tenant")
  @@map("access_logs")
}

model AuditLog {
  id          String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId    String?        @map("tenant_id") @db.Uuid
  actorType   AuditActorType @map("actor_type")
  actorId     String?        @map("actor_id") @db.Uuid
  action      String         @db.VarChar(100)
  entityType  String         @map("entity_type") @db.VarChar(100)
  entityId    String         @map("entity_id") @db.Uuid
  metadata    Json           @default("{}")
  ipAddress   String?        @map("ip_address") @db.Inet
  createdAt   DateTime       @default(now()) @map("created_at") @db.Timestamptz

  @@index([tenantId, createdAt(sort: Desc)], map: "idx_audit_tenant_date")
  @@index([entityType, entityId], map: "idx_audit_entity")
  @@map("audit_logs")
}

// ---------------------------------------------------
// INVITATIONS & PUSH
// ---------------------------------------------------

model Invitation {
  id              String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String         @map("tenant_id") @db.Uuid
  invitationType  InvitationType @map("invitation_type")
  targetEmail     String         @map("target_email") @db.VarChar(255)
  targetPhone     String?        @map("target_phone") @db.VarChar(30)
  vehicleId       String?        @map("vehicle_id") @db.Uuid
  customerId      String?        @map("customer_id") @db.Uuid
  role            UserRole?
  locationId      String?        @map("location_id") @db.Uuid
  token           String         @unique @db.VarChar(100)
  expiresAt       DateTime       @map("expires_at") @db.Timestamptz
  acceptedAt      DateTime?      @map("accepted_at") @db.Timestamptz
  createdAt       DateTime       @default(now()) @map("created_at") @db.Timestamptz

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  vehicle Vehicle? @relation(fields: [vehicleId], references: [id], onDelete: Cascade)

  @@index([expiresAt], map: "idx_invitation_expires")
  @@map("invitations")
}

model PushToken {
  id            String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  customerId    String            @map("customer_id") @db.Uuid
  expoPushToken String            @unique @map("expo_push_token") @db.VarChar(200)
  platform      PushTokenPlatform
  deviceName    String?           @map("device_name") @db.VarChar(100)
  appVersion    String?           @map("app_version") @db.VarChar(20)
  lastUsedAt    DateTime          @map("last_used_at") @db.Timestamptz
  active        Boolean           @default(true)
  createdAt     DateTime          @default(now()) @map("created_at") @db.Timestamptz

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([customerId], map: "idx_push_customer_active")
  @@map("push_tokens")
}
```

### 2.2 Note sullo schema

**Prisma non supporta direttamente** alcuni costrutti che sono gestiti via SQL esplicito nelle migration aggiuntive (§3):

- **Partial unique indexes** (es. "un solo proprietario attivo") → via SQL raw
- **CHECK constraints** (es. formato `garage_code`) → via SQL raw
- **Row Level Security** → via SQL raw
- **Trigger per `updated_at`** → via SQL raw (alternativa: Prisma `@updatedAt` che gestisce lato applicativo)
- **Funzioni PostgreSQL custom** → via SQL raw

---

## 3. Migration SQL aggiuntive (RLS, trigger)

> **Nota di implementazione (PR 4b, 2026-04-24).** I tre file `sql/triggers.sql`, `sql/rls-policies.sql` e `sql/functions.sql` descritti qui di seguito sono stati **consolidati in un'unica migration Prisma** (`prisma/migrations/20260424100000_rls_triggers_checks/migration.sql`). Motivazione:
>
> - deployments versionati e reversibili (parte dello stream di migration Prisma)
> - i container di test ottengono lo stato DB completo da un semplice `prisma migrate deploy`, senza dipendere da `psql` installato
> - niente più script custom `db:rls:apply` / `db:triggers:apply` — il comando `pnpm db:migrate:deploy` applica tutto
>
> I contenuti SQL sono quelli mostrati nelle sottosezioni qui sotto, più i CHECK constraint e i partial unique index. Usa il file di migration come fonte autorevole per la forma esatta applicata in produzione.

> **Nota di implementazione (migration 0003, 2026-04-27).** Le RLS su `interventions`, `attachments`, `tenants`, `locations`, `intervention_types` sono passate da una single-policy `_isolation`/`_access` a coppie `_read FOR SELECT USING (true)` + `_write FOR ALL` tenant/owner-scoped — mirror di `vehicles`/`customers`. Motivazione: BR-150/BR-153 richiedono SELECT cross-tenant per la timeline veicolo (`shopRowSelect` joina tenant.business_name, location.city, intervention_type.code/name_it). Il pattern è espansivo (no drop di colonne). Riferimento: `prisma/migrations/20260427120000_split_interventions_attachments_rls/migration.sql`.

### 3.1 File `sql/triggers.sql`

```sql
-- =====================================================
-- TRIGGERS: updated_at auto-refresh, audit enforcement
-- =====================================================

-- Function per updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Applica trigger a tutte le tabelle con updated_at
-- (Prisma @updatedAt gestisce lato applicativo, ma i trigger garantiscono
-- coerenza anche per modifiche via SQL diretto)

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
-- AUDIT LOG: immutabilità (no UPDATE, no DELETE)
-- =====================================================

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Modifiche a audit_logs e access_logs non consentite (BR-282)';
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
-- PARTIAL UNIQUE INDEXES (non esprimibili in Prisma)
-- =====================================================

-- BR-040: Un solo proprietario attivo per veicolo
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_vehicle_active
ON vehicle_ownerships (vehicle_id)
WHERE ended_at IS NULL;

-- BR-047: Un solo transfer attivo per veicolo
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_vehicle_active
ON vehicle_transfers (vehicle_id)
WHERE status IN ('pending_recipient', 'pending_seller_confirmation', 'pending_validation');

-- BR-201: Una sola location primaria per tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_tenant_primary
ON locations (tenant_id)
WHERE is_primary = true AND status = 'active' AND deleted_at IS NULL;

-- Customer cognito_sub only when not null
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_cognito_sub_notnull
ON customers (cognito_sub)
WHERE cognito_sub IS NOT NULL;

-- =====================================================
-- CHECK CONSTRAINTS
-- =====================================================

-- BR-020: Formato garage_code GO-NNN-AAAA
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_garage_code_format;
ALTER TABLE vehicles ADD CONSTRAINT chk_garage_code_format
CHECK (
    garage_code IS NULL OR
    garage_code ~ '^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$'
);

-- BR-003: certified implica garage_code + certified_at presenti
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_certified_consistency;
ALTER TABLE vehicles ADD CONSTRAINT chk_certified_consistency
CHECK (
    (status != 'certified') OR
    (garage_code IS NOT NULL AND certified_at IS NOT NULL AND certified_by_tenant_id IS NOT NULL)
);

-- BR-003: pending implica garage_code NULL
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_pending_consistency;
ALTER TABLE vehicles ADD CONSTRAINT chk_pending_consistency
CHECK (
    (status != 'pending') OR
    (garage_code IS NULL)
);

-- BR-007: year range
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS chk_year_range;
ALTER TABLE vehicles ADD CONSTRAINT chk_year_range
CHECK (year >= 1900 AND year <= EXTRACT(YEAR FROM NOW())::INT + 1);

-- BR-100: Scadenza deve avere almeno un criterio
ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS chk_deadline_has_criterion;
ALTER TABLE deadlines ADD CONSTRAINT chk_deadline_has_criterion
CHECK (due_date IS NOT NULL OR due_odometer_km IS NOT NULL);

-- BR-180: Dimensione allegati
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_attachment_size;
ALTER TABLE attachments ADD CONSTRAINT chk_attachment_size
CHECK (size_bytes > 0 AND size_bytes <= 10485760);

-- Attachment owner consistency (XOR logic)
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_attachment_owner_consistent;
ALTER TABLE attachments ADD CONSTRAINT chk_attachment_owner_consistent
CHECK (
    (owner_type = 'intervention' AND tenant_id IS NOT NULL AND customer_id IS NULL) OR
    (owner_type = 'private_intervention' AND customer_id IS NOT NULL AND tenant_id IS NULL)
);

-- BR-203: Un tenant deve avere almeno un super_admin attivo
-- Questa è controllata a livello applicativo perché è cross-row
-- (non facilmente esprimibile con CHECK constraint)

-- Recurring deadline: se is_recurring=true, deve avere almeno un criterio ricorrente
ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS chk_recurring_consistency;
ALTER TABLE deadlines ADD CONSTRAINT chk_recurring_consistency
CHECK (
    (is_recurring = false) OR
    (recurring_months IS NOT NULL OR recurring_km IS NOT NULL)
);
```

### 3.2 File `sql/rls-policies.sql`

```sql
-- =====================================================
-- ROW LEVEL SECURITY: tenant isolation
-- Configurazione: l'app imposta SET LOCAL app.current_tenant
-- all'inizio di ogni transazione.
-- Per bypass (job scheduler, admin):
--   SET LOCAL app.current_role = 'admin';
-- =====================================================

-- Helper function per leggere setting corrente in modo sicuro
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid AS $$
BEGIN
    RETURN current_setting('app.current_tenant', true)::uuid;
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

-- =====================================================
-- TENANT-SCOPED TABLES
-- =====================================================

-- Tabelle strettamente tenant-scoped (tenant_id NOT NULL)
DO $$
DECLARE
    t text;
    tenant_tables text[] := ARRAY[
        -- 'locations', 'interventions' splittate in `_read FOR SELECT
        -- USING (true)` + `_write FOR ALL` dalla migration 0003;
        -- 'users' splittato con lo stesso pattern dalla migration 0004.
        -- Vedi i blocchi dedicati più sotto. Tutti per supportare
        -- BR-150/BR-153 (timeline + audit-chain cross-tenant).
        'customer_tenant_relations',
        'intervention_disputes',
        'deadlines', 'deadline_notifications',
        'access_logs', 'invitations'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);

        -- Drop policy se esistono
        EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I;', t, t);

        -- Policy: admin vede tutto; altrimenti solo proprio tenant
        EXECUTE format('
            CREATE POLICY %I_tenant_isolation ON %I
            USING (is_admin_role() OR tenant_id = current_tenant_id());
        ', t, t);
    END LOOP;
END $$;

-- =====================================================
-- TENANT TABLE (è root, policy diversa)
-- =====================================================

-- TENANTS (post migration 0003): SELECT permissive (BR-150 timeline
-- joins businessName cross-tenant), WRITE tenant-scoped.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_read ON tenants;
CREATE POLICY tenants_read ON tenants
FOR SELECT USING (true);

DROP POLICY IF EXISTS tenants_write ON tenants;
CREATE POLICY tenants_write ON tenants
FOR ALL
USING (is_admin_role() OR id = current_tenant_id())
WITH CHECK (is_admin_role() OR id = current_tenant_id());

-- =====================================================
-- INTERVENTION_TYPES (post migration 0003): SELECT permissive,
-- WRITE tenant-scoped. System types (tenant_id NULL) restano
-- scrivibili solo via admin paths (seed/migration).
-- =====================================================

ALTER TABLE intervention_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intervention_types_read ON intervention_types;
CREATE POLICY intervention_types_read ON intervention_types
FOR SELECT USING (true);

DROP POLICY IF EXISTS intervention_types_write ON intervention_types;
CREATE POLICY intervention_types_write ON intervention_types
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- USERS (post migration 0004): SELECT permissive (BR-150 audit
-- chain join a users.firstName/lastName cross-tenant), WRITE
-- tenant-scoped. Mirror del pattern tenants/locations post-0003.
-- (ENABLE+FORCE RLS già applicati dall'init migration via DO loop.)
-- =====================================================
DROP POLICY IF EXISTS users_tenant_isolation ON users;

CREATE POLICY users_read ON users
FOR SELECT USING (true);

CREATE POLICY users_write ON users
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- INTERVENTION_REVISIONS (post migration 0004): RLS abilitata
-- ex-novo. SELECT permissive (audit chain BR-150 cross-tenant),
-- INSERT append-only enforced via EXISTS join al parent
-- intervention. Nessuna policy UPDATE/DELETE -> default deny.
-- Cascade DELETE dal parent intervention bypassa RLS via FK
-- CASCADE (mirror intervention_disputes pre-esistente).
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

-- =====================================================
-- CUSTOMERS: accessibili a tutti i tenant (dati tecnici),
-- filtro PII a livello applicativo via customer_tenant_relations
-- =====================================================

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_read ON customers;
CREATE POLICY customers_read ON customers
FOR SELECT
USING (true);  -- Accessibile a tutti; filtro PII a livello app

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
WITH CHECK (true);  -- Qualsiasi tenant può creare un customer

-- =====================================================
-- VEHICLES: cross-tenant per lettura, scrittura solo tenant-related
-- =====================================================

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicles_read ON vehicles;
CREATE POLICY vehicles_read ON vehicles
FOR SELECT
USING (true);  -- Veicoli visibili a tutti i tenant (BR-060, BR-150)

DROP POLICY IF EXISTS vehicles_insert ON vehicles;
CREATE POLICY vehicles_insert ON vehicles
FOR INSERT
WITH CHECK (
    is_admin_role()
    OR created_by_tenant_id = current_tenant_id()
    OR created_by_customer_id IS NOT NULL  -- Customer può creare pending
);

DROP POLICY IF EXISTS vehicles_update ON vehicles;
CREATE POLICY vehicles_update ON vehicles
FOR UPDATE
USING (
    is_admin_role()
    OR certified_by_tenant_id = current_tenant_id()
    OR created_by_tenant_id = current_tenant_id()
);

-- =====================================================
-- VEHICLE_OWNERSHIPS, VEHICLE_TRANSFERS
-- Visibili a: customer coinvolti + admin
-- =====================================================

ALTER TABLE vehicle_ownerships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ownerships_access ON vehicle_ownerships;
CREATE POLICY ownerships_access ON vehicle_ownerships
USING (true);  -- Storicizza la catena di proprietà, leggibile

ALTER TABLE vehicle_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transfers_access ON vehicle_transfers;
CREATE POLICY transfers_access ON vehicle_transfers
USING (true);  -- Gestito a livello applicativo

-- =====================================================
-- INTERVENTIONS (post migration 0003): SELECT cross-pool, WRITE
-- tenant-scoped. Customer-side UPDATE per il flip BR-127 status
-- è concesso via app-layer `role: 'admin'` short-lived (vedi
-- packages/api/src/routes/v1/interventions-dispute.ts).
-- =====================================================

ALTER TABLE interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interventions_read ON interventions;
CREATE POLICY interventions_read ON interventions
FOR SELECT USING (true);

DROP POLICY IF EXISTS interventions_insert ON interventions;
CREATE POLICY interventions_insert ON interventions
FOR INSERT WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS interventions_update ON interventions;
CREATE POLICY interventions_update ON interventions
FOR UPDATE
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- LOCATIONS (post migration 0003): SELECT cross-pool, WRITE
-- tenant-scoped (BR-150 timeline joina city cross-tenant).
-- =====================================================

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS locations_read ON locations;
CREATE POLICY locations_read ON locations
FOR SELECT USING (true);

DROP POLICY IF EXISTS locations_write ON locations;
CREATE POLICY locations_write ON locations
FOR ALL
USING (is_admin_role() OR tenant_id = current_tenant_id())
WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id());

-- =====================================================
-- PRIVATE_INTERVENTIONS: solo il customer proprietario
-- (+ admin)
-- L'app imposta SET LOCAL app.current_customer per customer sessions
-- =====================================================

CREATE OR REPLACE FUNCTION current_customer_id()
RETURNS uuid AS $$
BEGIN
    RETURN current_setting('app.current_customer', true)::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

ALTER TABLE private_interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS private_int_isolation ON private_interventions;
CREATE POLICY private_int_isolation ON private_interventions
USING (
    is_admin_role()
    OR customer_id = current_customer_id()
);

-- =====================================================
-- PUSH_TOKENS, AUDIT_LOGS
-- =====================================================

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_tokens_isolation ON push_tokens;
CREATE POLICY push_tokens_isolation ON push_tokens
USING (
    is_admin_role()
    OR customer_id = current_customer_id()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
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
WITH CHECK (true);  -- Write-only per utenti non admin

-- =====================================================
-- ATTACHMENTS (post migration 0003): SELECT cross-pool, WRITE
-- owner-scoped (intervention attachments → tenant; private →
-- customer).
-- =====================================================

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attachments_read ON attachments;
CREATE POLICY attachments_read ON attachments
FOR SELECT USING (true);

DROP POLICY IF EXISTS attachments_insert ON attachments;
CREATE POLICY attachments_insert ON attachments
FOR INSERT WITH CHECK (
    is_admin_role()
    OR (owner_type = 'intervention' AND tenant_id = current_tenant_id())
    OR (owner_type = 'private_intervention' AND customer_id = current_customer_id())
);

DROP POLICY IF EXISTS attachments_update ON attachments;
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
```

### 3.3 File `sql/functions.sql`

```sql
-- =====================================================
-- FUNZIONI DI UTILITÀ
-- =====================================================

-- Generazione garage_code con alfabeti ridotti (BR-020, BR-021)
--
-- Alfabeto: 8 cifre (2-9, escluse 0 e 1) + 21 lettere (escluse I, O, Q, S, U).
-- Esclusioni scelte per ambiguità visiva in pattern human-readable
-- (I↔1, O↔0, Q↔O, S↔5, U↔V), allineato a stile RFC 4648.
-- Combinazioni totali pattern GO-NNN-AAAA: 8^3 · 21^4 = 99.606.528.
-- NOTA: alfabeto e regex CHECK in §3.2 (`[A-HJ-NPRTV-Z]{4}`) DEVONO
-- restare allineati — un mismatch farebbe fallire il constraint al primo INSERT.
CREATE OR REPLACE FUNCTION generate_garage_code()
RETURNS VARCHAR(12) AS $$
DECLARE
    digits TEXT := '23456789';
    letters TEXT := 'ABCDEFGHJKLMNPRTVWXYZ';  -- 21 lettere, escluse I, O, Q, S, U
    code TEXT;
    i INT;
BEGIN
    code := 'GO-';

    -- 3 cifre
    FOR i IN 1..3 LOOP
        code := code || substr(digits, (random() * length(digits))::INT + 1, 1);
    END LOOP;

    code := code || '-';

    -- 4 lettere
    FOR i IN 1..4 LOOP
        code := code || substr(letters, (random() * length(letters))::INT + 1, 1);
    END LOOP;

    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Funzione helper: inserisce garage_code univoco con retry
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
                RAISE EXCEPTION 'Vehicle non trovato o già con garage_code';
            END IF;

        EXCEPTION WHEN unique_violation THEN
            IF attempt >= max_attempts THEN
                RAISE EXCEPTION 'Impossibile generare garage_code univoco dopo % tentativi', max_attempts;
            END IF;
            -- Retry con nuovo codice
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Funzione helper per impostare tenant context (chiamata da app)
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
```

---

## 4. Seed data

### 4.1 File `prisma/seed.ts`

```typescript
import { PrismaClient } from '@prisma/client';
import { InterventionTypeCategory } from '@prisma/client';

const prisma = new PrismaClient();

const systemInterventionTypes = [
  {
    code: 'TAGLIANDO',
    nameIt: 'Tagliando',
    description: 'Tagliando periodico completo secondo piano manutenzione',
    icon: 'wrench',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'CAMBIO_OLIO',
    nameIt: 'Cambio olio',
    description: 'Sostituzione olio motore e filtro',
    icon: 'droplet',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'CAMBIO_GOMME_STAGIONE',
    nameIt: 'Cambio gomme stagionale',
    description: 'Inversione pneumatici estivi/invernali',
    icon: 'circle',
    category: InterventionTypeCategory.tires,
    suggestsDeadline: true,
    defaultDeadlineMonths: 6,
    defaultDeadlineKm: null,
  },
  {
    code: 'CAMBIO_GOMME_USURA',
    nameIt: 'Cambio gomme per usura',
    description: 'Sostituzione pneumatici per usura o danneggiamento',
    icon: 'circle',
    category: InterventionTypeCategory.tires,
    suggestsDeadline: false,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: null,
  },
  {
    code: 'DISTRIBUZIONE',
    nameIt: 'Sostituzione cinghia distribuzione',
    description: 'Sostituzione cinghia/catena distribuzione e accessori',
    icon: 'settings',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: null,
    defaultDeadlineKm: 120000,
  },
  {
    code: 'FRENI',
    nameIt: 'Intervento sistema frenante',
    description: 'Pastiglie, dischi, pinze, tubi freno',
    icon: 'disc',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
  },
  {
    code: 'REVISIONE',
    nameIt: 'Revisione ministeriale',
    description: 'Revisione periodica obbligatoria per legge',
    icon: 'clipboard-check',
    category: InterventionTypeCategory.inspection,
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
  {
    code: 'CARROZZERIA',
    nameIt: 'Intervento carrozzeria',
    description: 'Riparazioni, verniciature, lattoneria',
    icon: 'paintbrush',
    category: InterventionTypeCategory.body,
    suggestsDeadline: false,
  },
  {
    code: 'DIAGNOSI',
    nameIt: 'Diagnosi elettronica',
    description: 'Diagnosi centraline, lettura errori, riparazioni elettroniche',
    icon: 'activity',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
  },
  {
    code: 'CLIMATIZZATORE',
    nameIt: 'Manutenzione climatizzatore',
    description: 'Ricarica gas, sanificazione, sostituzione filtri',
    icon: 'wind',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
  },
  {
    code: 'BATTERIA',
    nameIt: 'Sostituzione batteria',
    description: 'Sostituzione batteria di avviamento o di servizio',
    icon: 'battery',
    category: InterventionTypeCategory.repair,
    suggestsDeadline: false,
  },
  {
    code: 'ALTRO',
    nameIt: 'Altro intervento',
    description: 'Intervento non classificato',
    icon: 'more-horizontal',
    category: InterventionTypeCategory.other,
    suggestsDeadline: false,
  },
];

async function seedInterventionTypes() {
  console.log('🌱 Seeding intervention_types (system)...');

  for (const type of systemInterventionTypes) {
    await prisma.interventionType.upsert({
      where: {
        tenantId_code: { tenantId: null as any, code: type.code },
      },
      update: type,
      create: {
        ...type,
        tenantId: null,
      },
    });
  }

  console.log(`✅ Seeded ${systemInterventionTypes.length} system intervention types`);
}

async function main() {
  console.log('🚀 Starting seed...');

  await seedInterventionTypes();

  console.log('✅ Seed completed successfully');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

### 4.2 Seed ambiente di sviluppo (opzionale)

```typescript
// prisma/seed-dev.ts — solo per ambiente dev, dati di test
// Non eseguito in production

async function seedDevData() {
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  Skipping dev seed in production');
    return;
  }

  // Tenant demo
  const tenant = await prisma.tenant.create({
    data: {
      businessName: 'Officina Demo',
      vatNumber: '12345678901',
      email: 'demo@officina.test',
      status: 'active',
      locations: {
        create: {
          name: 'Sede Principale',
          addressLine: 'Via Roma 1',
          city: 'Milano',
          province: 'MI',
          postalCode: '20100',
          isPrimary: true,
        },
      },
    },
    include: { locations: true },
  });

  // Super Admin demo
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      cognitoSub: 'demo-cognito-sub-admin',
      email: 'admin@officina.test',
      firstName: 'Giuseppe',
      lastName: 'Rossi',
      role: 'super_admin',
      status: 'active',
    },
  });

  console.log('✅ Dev seed data created');
}
```

---

## 5. Validator Zod

> **Nota Zod 4.** v1 adotta Zod 4.x. Tutti gli schemi usano la top-level API di
> Zod 4 (`z.email()`, `z.uuid()`, `z.url()`, `z.ipv4()`/`z.ipv6()`, ecc.) al
> posto della chain-syntax di Zod 3 (`z.string().email()`, ecc.). Per oggetti
> con modalità "loose" o "strict" usa `z.looseObject({...})` e
> `z.strictObject({...})` anziché `.passthrough()` / `.strict()`.
> Migration guide: https://zod.dev/v4/changelog

### 5.1 File `src/validators/common.ts`

```typescript
import { z } from 'zod';

// Garage code pattern (BR-020)
export const GarageCodeSchema = z
  .string()
  .regex(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/, {
    message: 'Formato codice GarageOS non valido. Atteso: GO-NNN-AAAA',
  });

// VIN: 17 caratteri alfanumerici, esclusi I/O/Q
export const VinSchema = z
  .string()
  .length(17, { message: 'Il VIN deve essere di 17 caratteri' })
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, {
    message: 'VIN contiene caratteri non validi',
  });

// Targa italiana (formato standard corrente)
export const ItalianPlateSchema = z
  .string()
  .min(6)
  .max(10)
  .regex(/^[A-Z]{2}[0-9]{3}[A-Z]{2}$/, {
    message: 'Formato targa italiana non valido (esempio: AB123CD)',
  });

// Email con validazione standard
export const EmailSchema = z.email({ message: 'Email non valida' });

// Codice fiscale italiano persona (16 char) o azienda (11 char numerici)
export const TaxCodeSchema = z.string().regex(
  /^([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]|[0-9]{11})$/,
  { message: 'Codice fiscale non valido' }
);

// P.IVA italiana (11 cifre)
export const VatNumberSchema = z
  .string()
  .regex(/^[0-9]{11}$/, { message: 'P.IVA deve essere di 11 cifre' });

// Telefono formato libero (preferibilmente E.164)
export const PhoneSchema = z.string().min(6).max(30);

// UUID
export const UuidSchema = z.uuid();

// Timestamps
export const IsoTimestampSchema = z.iso.datetime();
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Pagination
export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});
```

### 5.2 File `src/validators/vehicle.ts`

```typescript
import { z } from 'zod';
import { VinSchema, ItalianPlateSchema, GarageCodeSchema } from './common';

export const VehicleTypeEnum = z.enum(['car', 'motorcycle', 'van', 'truck', 'agricultural']);
export const FuelTypeEnum = z.enum([
  'petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'methane', 'hydrogen', 'other',
]);

export const CreateVehicleSchema = z.object({
  vehicle: z.object({
    vin: VinSchema,
    plate: ItalianPlateSchema,
    plateCountry: z.string().length(2).default('IT'),
    make: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    version: z.string().max(150).optional(),
    year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
    registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    engineDisplacement: z.number().int().positive().optional(),
    powerKw: z.number().int().positive().optional(),
    color: z.string().max(50).optional(),
    odometerKm: z.number().int().min(0),
  }),
  customer: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('existing'),
      customerId: z.uuid(),
    }),
    z.object({
      mode: z.literal('create_new'),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      email: z.email(),
      phone: z.string().max(30).optional(),
      taxCode: z.string().max(20).optional(),
      isBusiness: z.boolean().default(false),
      businessName: z.string().max(200).optional(),
      vatNumber: z.string().max(20).optional(),
    }).refine(
      (data) => !data.isBusiness || (data.businessName && data.vatNumber),
      { message: 'businessName e vatNumber obbligatori per clienti aziendali' }
    ),
  ]),
  locationId: z.uuid(),
  sendInvitationEmail: z.boolean().default(true),
  forceNonstandardVin: z.boolean().default(false), // BR-001 eccezione
});

export const ClaimVehicleSchema = z.object({
  garageCode: GarageCodeSchema.transform((s) => s.toUpperCase()),
});

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;
export type ClaimVehicleInput = z.infer<typeof ClaimVehicleSchema>;
```

### 5.3 File `src/validators/intervention.ts`

```typescript
import { z } from 'zod';

export const PartReplacedSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  quantity: z.number().positive(),
  notes: z.string().max(200).optional(),
});

export const CreateInterventionSchema = z.object({
  interventionTypeId: z.uuid(),
  interventionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  odometerKm: z.number().int().min(0),
  title: z.string().max(200).optional(),
  description: z.string().min(1).max(5000),
  partsReplaced: z.array(PartReplacedSchema).default([]),
  internalNotes: z.string().max(5000).optional(),
  createDeadline: z.object({
    enabled: z.boolean(),
    monthsFromNow: z.number().int().positive().optional(),
    kmIncrement: z.number().int().positive().optional(),
  }).optional(),
  forceKmDecrease: z.boolean().default(false), // BR-068
});

export const CreateDisputeSchema = z.object({
  reasonCategory: z.enum(['not_performed', 'wrong_data', 'not_authorized', 'other']),
  description: z.string().min(20).max(2000),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});

export type CreateInterventionInput = z.infer<typeof CreateInterventionSchema>;
export type CreateDisputeInput = z.infer<typeof CreateDisputeSchema>;
```

---

## 6. Pattern di query Prisma comuni

### 6.1 Client singleton con RLS helper

File `src/client.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Esegue un'operazione con contesto tenant/customer impostato in PostgreSQL.
 * Le policy RLS useranno questi setting per filtrare le righe.
 */
export async function withContext<T>(
  ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (ctx.tenantId) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
    }
    if (ctx.customerId) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_customer', $1, true)`, ctx.customerId);
    }
    if (ctx.role === 'admin') {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_role', 'admin', true)`);
    }
    return fn(tx as PrismaClient);
  });
}
```

### 6.2 Esempio: creazione intervento con creazione scadenza

```typescript
import { prisma, withContext } from '@garageos/database';

export async function createInterventionService(
  ctx: { tenantId: string; userId: string; locationId: string },
  input: CreateInterventionInput & { vehicleId: string }
) {
  return withContext({ tenantId: ctx.tenantId }, async (tx) => {
    // 1. Validate km non-decreasing (BR-068)
    const lastIntervention = await tx.intervention.findFirst({
      where: { vehicleId: input.vehicleId, status: { not: 'cancelled' } },
      orderBy: { interventionDate: 'desc' },
    });

    if (
      lastIntervention &&
      input.odometerKm < lastIntervention.odometerKm &&
      !input.forceKmDecrease
    ) {
      throw new BusinessError('km_anomaly_warning', {
        lastKm: lastIntervention.odometerKm,
      });
    }

    // 2. Create intervention
    const intervention = await tx.intervention.create({
      data: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        userId: ctx.userId,
        vehicleId: input.vehicleId,
        interventionTypeId: input.interventionTypeId,
        interventionDate: new Date(input.interventionDate),
        odometerKm: input.odometerKm,
        title: input.title,
        description: input.description,
        partsReplaced: input.partsReplaced,
        internalNotes: input.internalNotes,
        kmAnomaly: lastIntervention ? input.odometerKm < lastIntervention.odometerKm : false,
      },
    });

    // 3. Update customer_tenant_relation stats (BR-152)
    const ownership = await tx.vehicleOwnership.findFirst({
      where: { vehicleId: input.vehicleId, endedAt: null },
    });

    if (ownership) {
      await tx.customerTenantRelation.upsert({
        where: { tenantId_customerId: { tenantId: ctx.tenantId, customerId: ownership.customerId } },
        update: {
          lastInterventionAt: new Date(),
          interventionCount: { increment: 1 },
        },
        create: {
          tenantId: ctx.tenantId,
          customerId: ownership.customerId,
          firstInterventionAt: new Date(),
          lastInterventionAt: new Date(),
          interventionCount: 1,
        },
      });
    }

    // 4. Optional: create deadline (BR-102, BR-109)
    let deadline = null;
    if (input.createDeadline?.enabled) {
      // ... logica creazione deadline + schedulazione EventBridge
    }

    return { intervention, deadline };
  });
}
```

### 6.3 Esempio: ricerca veicolo con visibilità PII

```typescript
export async function getVehicleDetail(
  ctx: { tenantId: string; userId: string },
  vehicleId: string
) {
  return withContext({ tenantId: ctx.tenantId }, async (tx) => {
    const vehicle = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      include: {
        ownerships: {
          where: { endedAt: null },
          include: { customer: true },
        },
      },
    });

    if (!vehicle) throw new NotFoundError('vehicle');

    const activeOwnership = vehicle.ownerships[0];

    // BR-151: PII visibile solo se customer_tenant_relation esiste
    if (activeOwnership) {
      const relation = await tx.customerTenantRelation.findUnique({
        where: {
          tenantId_customerId: {
            tenantId: ctx.tenantId,
            customerId: activeOwnership.customerId,
          },
        },
      });

      if (!relation) {
        // Redact PII
        activeOwnership.customer = {
          ...activeOwnership.customer,
          firstName: 'Proprietario',
          lastName: 'non in anagrafica',
          email: '',
          phone: null,
          addressLine: null,
          // ... altri campi redacted
        } as any;
      }
    }

    // Log access (BR-154)
    await tx.accessLog.create({
      data: {
        vehicleId: vehicle.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'view',
      },
    });

    return vehicle;
  });
}
```

### 6.4 Esempio: timeline veicolo con deduplica

```typescript
export async function getVehicleTimeline(
  ctx: { tenantId?: string; customerId?: string },
  vehicleId: string,
  params: { limit: number; cursor?: string; type: 'all' | 'shop_only' | 'private_only' }
) {
  // Shop interventions (sempre visibili se ctx ha accesso al veicolo)
  const interventions = ctx.tenantId
    ? await prisma.intervention.findMany({
        where: {
          vehicleId,
          status: { not: 'cancelled' },
        },
        include: {
          interventionType: true,
          tenant: { select: { businessName: true } },
          location: { select: { city: true } },
          disputes: { where: { status: { in: ['open', 'responded'] } } },
        },
        orderBy: { interventionDate: 'desc' },
        take: params.limit,
      })
    : [];

  // Private interventions (solo se customer)
  const privateInterventions =
    ctx.customerId && params.type !== 'shop_only'
      ? await prisma.privateIntervention.findMany({
          where: { vehicleId, customerId: ctx.customerId, deletedAt: null },
          include: { interventionType: true },
          orderBy: { interventionDate: 'desc' },
          take: params.limit,
        })
      : [];

  // Merge & sort
  const timeline = [
    ...interventions.map((i) => ({ kind: 'shop_intervention' as const, ...i })),
    ...privateInterventions.map((pi) => ({ kind: 'private_intervention' as const, ...pi })),
  ].sort((a, b) => b.interventionDate.getTime() - a.interventionDate.getTime());

  return timeline.slice(0, params.limit);
}
```

---

## 7. Indici e performance

### 7.1 Indici già in schema

Lo schema Prisma include gli indici essenziali per le query più frequenti. Riepilogo:

**Ricerca veicoli:**
- `idx_vehicles_plate` — ricerca per targa
- `uq_vehicles_vin` (da unique) — ricerca per VIN
- `uq_vehicles_garage_code` (da unique) — ricerca per codice

**Timeline veicolo:**
- `idx_interventions_vehicle_date` — interventi veicolo ordinati per data
- `idx_private_int_customer_vehicle` — interventi privati ordinati

**Dashboard tenant:**
- `idx_deadlines_tenant_status_date` — scadenze in arrivo
- `idx_interventions_tenant_id` + `idx_interventions_status` — interventi attivi

**Audit:**
- `idx_access_log_vehicle` — log accessi al veicolo (customer view)
- `idx_audit_tenant_date` — audit log per tenant

### 7.2 Indici aggiuntivi consigliati (SQL raw)

File `sql/performance-indexes.sql`:

```sql
-- Full-text search su vehicles (per ricerca flessibile marca/modello)
CREATE INDEX IF NOT EXISTS idx_vehicles_fulltext
ON vehicles USING GIN (
    to_tsvector('italian', coalesce(make, '') || ' ' || coalesce(model, '') || ' ' || coalesce(version, ''))
);

-- Trigram per ricerca fuzzy su plate e vin
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_vehicles_plate_trgm
ON vehicles USING GIN (plate gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_vehicles_vin_trgm
ON vehicles USING GIN (vin gin_trgm_ops);

-- Ricerca customer cross-tenant per email/phone
CREATE INDEX IF NOT EXISTS idx_customers_email_lower
ON customers (LOWER(email));

-- Filter scadenze open per promemoria scheduler
CREATE INDEX IF NOT EXISTS idx_deadlines_pending_reminders
ON deadlines (due_date)
WHERE status = 'open';

-- Interventi contestati (dashboard tenant)
CREATE INDEX IF NOT EXISTS idx_interventions_disputed
ON interventions (tenant_id, created_at DESC)
WHERE status = 'disputed';
```

### 7.3 Partitioning (v2+)

Quando le tabelle crescono, valutare partitioning per:

- **`access_logs`**: partition per mese su `created_at` (milioni di righe/anno a scale)
- **`audit_logs`**: stesso pattern
- **`intervention_revisions`**: meno urgente, ma partizionabile per anno

### 7.4 Query analysis

Durante lo sviluppo, per identificare query lente:

```sql
-- Abilita pg_stat_statements (se non già attivo)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 20 query per tempo totale
SELECT
    substring(query, 1, 100) as query_short,
    calls,
    total_exec_time,
    mean_exec_time,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

---

## 8. Backup e restore

### 8.1 Backup Supabase (managed)

Supabase offre backup automatici su tutti i piani a pagamento:

- **Plan Pro**: **PITR (Point-in-Time Recovery) 7 giorni** + backup giornalieri
- **Plan Team**: PITR 14 giorni
- **Plan Enterprise**: PITR personalizzabile

Gli snapshot e il PITR sono gestiti automaticamente da Supabase. Nessuna configurazione richiesta.

**Come accedere:**
- Dashboard Supabase → Database → Backups
- Da qui è possibile fare restore o creare una nuova project clone da un punto temporale specifico

### 8.2 Backup custom addizionale

Per backup da conservare oltre PITR Supabase (es. retention legale 5 anni), script settimanale che esporta su S3 AWS:

File `scripts/backup-weekly.sh`:

```bash
#!/bin/bash
# Eseguito via cron o GitHub Action schedulata settimanalmente
# Richiede pg_dump installato e credenziali AWS configurate

set -e

BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="garageos_backup_${BACKUP_DATE}.sql.gz"
S3_BUCKET="garageos-prod-backups"

echo "📦 Creating backup from Supabase..."
pg_dump "$DIRECT_URL" \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    | gzip > "/tmp/${BACKUP_FILE}"

echo "☁️  Uploading to S3..."
aws s3 cp "/tmp/${BACKUP_FILE}" "s3://${S3_BUCKET}/weekly/${BACKUP_FILE}" \
    --storage-class GLACIER_IR

echo "🧹 Cleaning local file..."
rm "/tmp/${BACKUP_FILE}"

echo "✅ Backup completed: ${BACKUP_FILE}"
```

**Perché backup custom oltre PITR Supabase:**
- PITR Supabase copre 7 giorni — insufficiente per requirement GDPR/fiscali (10 anni retention su tenant cancellati)
- I backup settimanali su S3 Glacier IR sono economici (~0,005€/GB/mese)
- Backup indipendente dal provider DB — protezione contro scenari catastrofici (account Supabase sospeso, ecc.)

### 8.3 Restore procedure

**Scenario 1 — PITR Supabase (entro 7 giorni):**

```
1. Dashboard Supabase → Database → Backups
2. Selezionare il timestamp di restore desiderato
3. Opzione A: Restore in-place (sovrascrive il DB corrente, irreversibile)
4. Opzione B: Create new project from this point (più sicuro, crea clone)
5. Se opzione B: aggiornare DATABASE_URL dell'app per puntare al nuovo progetto
```

**Scenario 2 — Restore da dump settimanale su S3:**

```bash
# Assumendo ambiente di restore isolato
aws s3 cp s3://garageos-prod-backups/weekly/garageos_backup_YYYYMMDD.sql.gz /tmp/
gunzip /tmp/garageos_backup_*.sql.gz

# Restore su nuovo progetto Supabase oppure RDS
psql "$RESTORE_DATABASE_URL" -f /tmp/garageos_backup_*.sql

# Verificare integrità
psql "$RESTORE_DATABASE_URL" -c "SELECT COUNT(*) FROM tenants;"
```

### 8.4 Test di restore

**Procedura trimestrale (roadmap v1.1):**
1. Creare un branch Supabase (feature nativa, istantanea) dal production
2. Eseguire smoke test su DB (count tabelle, query base)
3. Documentare tempo impiegato (tracking RTO)
4. Distruggere il branch

**Vantaggio Supabase Branching:** creare ambienti di test/restore è gratis e richiede secondi, non minuti. Utile per DR drill periodici.

### 8.5 Migrazione da Supabase a RDS (scenario futuro)

Se in futuro si volesse migrare a AWS RDS (per unificare su AWS), la procedura è standard PostgreSQL:

```bash
# 1. Snapshot da Supabase
pg_dump "$SUPABASE_DIRECT_URL" --no-owner --no-privileges > snapshot.sql

# 2. Creare RDS PostgreSQL tramite CDK/Console
# (Vedi Appendice C — Infrastructure)

# 3. Restore su RDS
psql "$RDS_URL" < snapshot.sql

# 4. Riapplicare RLS policies, triggers, functions
psql "$RDS_URL" -f sql/rls-policies.sql
psql "$RDS_URL" -f sql/triggers.sql
psql "$RDS_URL" -f sql/functions.sql

# 5. Switch dell'applicazione verso RDS (aggiornare DATABASE_URL)
```

**Downtime stimato**: 15-30 minuti per DB di 5 GB. Fattibile in finestra notturna programmata.

---

## 9. Convenzioni e note implementative

### 9.1 Naming convention

- **Tabelle**: snake_case plurale (`interventions`, `vehicle_ownerships`)
- **Colonne DB**: snake_case (`created_at`, `tenant_id`)
- **Modelli Prisma**: PascalCase singolare (`Intervention`, `VehicleOwnership`)
- **Campi Prisma**: camelCase (`createdAt`, `tenantId`)
- **Enum values**: snake_case (`super_admin`, `pending_recipient`)
- **Indici**: `idx_<table>_<purpose>` (es. `idx_vehicles_plate`)
- **Unique constraints**: `uq_<table>_<purpose>`
- **Check constraints**: `chk_<table>_<purpose>`
- **Foreign keys**: gestiti da Prisma

### 9.2 UUID generation

- Tutti gli ID sono **UUID v7** generati lato database con `gen_random_uuid()` (PostgreSQL 13+)
- Non si generano UUID lato applicativo in Prisma (scelta: lasciare al DB per consistency)
- **Nota:** `gen_random_uuid()` genera UUIDv4, non v7. Per UUIDv7 time-ordered si può usare extension custom o generare lato app. Per v1 accettiamo UUIDv4 (performance adeguata).

### 9.3 Timestamps

- Tutti i timestamp con timezone: `TIMESTAMPTZ`
- Sempre in **UTC** nel DB
- Conversione a timezone utente solo in presentation layer

### 9.4 Soft delete

- Tabelle con `deletedAt`: cancellazione logica
- Prisma query helper per filtrare automaticamente soft-deleted:

```typescript
// Esempio middleware Prisma (opzionale)
prisma.$use(async (params, next) => {
  if (params.action === 'findMany' || params.action === 'findFirst') {
    if (['Tenant', 'Location', 'User', 'Customer', 'PrivateIntervention'].includes(params.model || '')) {
      params.args.where = {
        ...params.args.where,
        deletedAt: null,
      };
    }
  }
  return next(params);
});
```

### 9.5 Transazioni

- Operazioni che modificano più tabelle **sempre in transazione** via `prisma.$transaction` o `withContext`
- Timeout transazioni default: 5 secondi (configurabile)

### 9.6 JSON columns

- Usate per `settings`, `metadata`, `parts_replaced`, `changes`, `notification_preferences`
- Schema JSON validato lato applicativo via Zod prima di scrittura
- Indici GIN se si fanno query sui contenuti (al momento non necessari in v1)

### 9.7 Migration workflow

```bash
# 1. Modificare schema.prisma
# 2. Generare migration
pnpm db:migrate:dev --name descriptive_name

# 3. Verificare file SQL generato in prisma/migrations/
# 4. Aggiungere eventuali comandi SQL custom nel file generato
# 5. Re-applicare
pnpm db:migrate:dev

# Per production:
pnpm db:migrate:deploy
```

**Regole:**
- Mai modificare migration già deployate
- Breaking changes via expand → migrate → contract pattern
- Test sempre migration su copia di production prima del deploy

### 9.8 Considerazioni sui dati sensibili

- **Nessun dato in chiaro lato log**: mai `console.log(customer)` completo
- **Redaction utility** per log strutturati:

```typescript
export function redactCustomer(c: Customer) {
  return { id: c.id, emailDomain: c.email.split('@')[1], status: c.status };
}
```

- **Encryption at rest**: gestito da Supabase/S3 (trasparente)
- **Secrets**: mai in schema.prisma o codice, sempre in env vars

---

## 10. Checklist per Claude Code

Prima di iniziare lo sviluppo, verificare:

- [ ] Setup monorepo con package `@garageos/database`
- [ ] Variabili `DATABASE_URL` e `DIRECT_URL` configurate
- [ ] `schema.prisma` copiato dalla §2
- [ ] File SQL in `sql/` copiati da §3
- [ ] `prisma/seed.ts` implementato
- [ ] Prima migration generata: `pnpm db:migrate:dev --name init`
- [ ] RLS policies applicate: `pnpm db:rls:apply`
- [ ] Trigger applicati: `pnpm db:triggers:apply`
- [ ] Seed eseguito: `pnpm db:seed`
- [ ] Client singleton (`src/client.ts`) implementato
- [ ] Validatori Zod base copiati
- [ ] Test di query base funzionanti (es. `prisma.interventionType.findMany()` restituisce i 12 tipi di sistema)

---

## 11. Changelog

- **v1.2 (2026-04-24)** — Allineamento post PR 4c/4d:
  - §3.3 BR-020: corretto alfabeto `letters` nella funzione `generate_garage_code()` da 22 lettere (`ABCDEFGHJKLMNPRSTVWXYZ`, commento "Escluse I, O, Q, U") a 21 lettere (`ABCDEFGHJKLMNPRTVWXYZ`, commento "Escluse I, O, Q, S, U") per coerenza con il CHECK constraint `^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$` (§3.2). Regex e comportamento runtime della produzione invariati. Aggiunta nota esplicativa sulle esclusioni per ambiguità visiva (stile RFC 4648).
  - §5 Zod: aggiornata sintassi da Zod 3 legacy (chain `z.string().email()`, `z.string().uuid()`) a Zod 4 top-level API (`z.email()`, `z.uuid()`) per coerenza con l'implementazione di PR 4c. Aggiunta nota Zod 4 in testa alla sezione. Nessun cambio semantico.
  - §5 Zod iso.datetime: migrato `z.string().datetime()` → `z.iso.datetime()` (Zod 4 ISO namespace).
- **v1.1 (2026-04-24)** — PR 4b: adeguamento a Prisma 7 (generator `prisma-client`, output obbligatorio, adapter `@prisma/adapter-pg` runtime, datasource URL in `prisma.config.ts`). Consolidamento di `sql/triggers.sql` + `sql/rls-policies.sql` + `sql/functions.sql` in una singola migration Prisma versioned (`20260424100000_rls_triggers_checks`). Seed reale con 12 `intervention_types` di sistema (`prisma/seed.ts`). Setup Vitest + Testcontainers (postgres:15-alpine) + 3 smoke suite (RLS tenant isolation, trigger `updated_at` + BR-282 audit immutability, CHECK constraints BR-020/007/100/180 + partial unique index BR-040). I validator Zod manuali (§5) restano la scelta canonica del progetto: `prisma-zod-generator` non è stato adottato perché non documentato come compatibile col nuovo generator `prisma-client` di Prisma 7.
- **v1.0 (2026-04-22)** — baseline originale allineata a `GarageOS-Specifiche.md` v1.1 e `APPENDICE_F_BUSINESS_LOGIC.md` v1.0.

---

*Fine Appendice B — Database*

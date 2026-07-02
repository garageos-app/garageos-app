# PR-DB — Fondazione checklist interventi (schema + RLS + seed) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introdurre lo schema DB del nuovo modello "tipo coarse + checklist" — 4 tabelle nuove (voci checklist, esclusioni tipo/voce per-tenant, selezioni su intervento con snapshot), RLS/grant/trigger coerenti coi pattern esistenti, e il cutover del seed dai 12 tipi granulari ai 3 tipi coarse con le rispettive checklist. Nessuna modifica alle rotte API in questo PR.

**Architecture:** Mirror dei pattern RLS split esistenti (`intervention_types_read`/`_write`, `interventions_read`/`_insert`/`_update` in `migrations/20260427120000_split_interventions_attachments_rls/migration.sql`). Catalogo (voci) globale con SELECT permissivo + WRITE admin-only; esclusioni tenant-scoped in lettura, admin-only in scrittura; selezioni mirror di `interventions` (SELECT permissivo, WRITE tenant-scoped) con colonna `tenant_id` denormalizzata per semplificare la policy. Snapshot `label_snapshot` sulle selezioni per stabilità storica.

**Spec:** `docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md`

**Tech Stack:** Prisma 7 (adapter obbligatorio), PostgreSQL (Supabase), migration SQL manuale, Vitest + Testcontainers per integration/RLS.

**LOC budget:** ~450 net atteso, hard limit 1500. Controller verifica LOC cumulativa dopo ogni task; halt+ask all'80%.

## Deviations from spec (verified against actual code — the code wins)

1. **`title` NON viene rimosso in questo PR.** Lo spec (§Decomposizione PR-DB) prevedeva il drop di `Intervention.title` qui. Rimuovere il campo Prisma rigenera il client e rompe subito il typecheck di `packages/api` (interventions.ts, interventions-update.ts, interventions-detail.ts, …), web e mobile che ancora leggono/scrivono `title`. Ordine contract corretto: rimuovere prima tutti i lettori (PR-OFFICINA-API, PR-WEB, PR-PDF, PR-MOBILE) e poi, come **ultimo** contract step, togliere il campo Prisma + `ALTER TABLE interventions DROP COLUMN title`. Aggiungere quel micro-step in coda all'ultimo PR dell'arco (o PR dedicato). `title` resta intatto qui.

2. **Cutover invece di coesistenza per i tipi.** Il code `REVISIONE` è già presente nei 12 tipi di sistema (`seed-data.ts:80`, "Revisione ministeriale") e `@@unique([tenantId, code])` con `tenant_id NULL` impedisce un secondo `REVISIONE`. Quindi non è possibile seminare i 3 nuovi tipi accanto ai 12 vecchi. Questo PR sostituisce integralmente il seed dei tipi di sistema (i dati intervento sono di test — D5 dello spec) e rimappa i test helper che usano i vecchi code (`TAGLIANDO`, `CAMBIO_OLIO`) al nuovo `MECCANICO`.

3. **`intervention_checklist_selections` include `tenant_id`.** Lo sketch dello spec (§Modello dati) non lo elencava; lo aggiungo (denormalizzato, FK a `tenants`) per allineare la policy RLS di scrittura a `interventions_insert`/`_update` senza subquery sul padre.

## Gotchas the implementer MUST respect (from project memory)

- **Migration operator-driven** (`[[feedback_prisma_migrate_deploy_operator_driven]]`): la migration NON entra in `deploy.yml`; si applica manualmente con `DIRECT_URL`. Portabile: niente ROLE/DATABASE hardcoded, usa `session_user`/nomi standard.
- **Grant espliciti** a `garageos_app` su ogni tabella (`[[feedback_least_privilege_db_role]]`): il ruolo runtime è `NOBYPASSRLS`. Grant a livello tabella + RLS che gatea.
- **Prisma 7** (`[[project_prisma7_breaking_changes]]`): compound `@@unique` usa composizione per **nome campo**, non `map:`. Adapter obbligatorio.
- **`@updatedAt`** (`[[feedback_prisma_updatedat_raw_sql]]`): ogni raw SQL INSERT su tabelle con `updated_at` deve settarlo (`NOW()`); trigger `set_updated_at()` esiste per gli UPDATE.
- **RLS validation** (`[[feedback_supabase_sql_editor_bypassrls]]`): validare le policy via integration test (Testcontainers), NON da SQL Editor Supabase (BYPASSRLS).
- **CHECK/RLS solo CI** (`[[feedback_db_check_constraint_only_ci]]`): violazioni visibili solo su Postgres reale (CI).
- **TRUNCATE CASCADE** (`[[feedback_truncate_cascade_postgres]]`): re-seed idempotente in `beforeEach`.
- **Non eseguire integration in locale** (`[[feedback_skip_local_integration_tests]]`): gate locale = solo `pnpm -r typecheck`; il resto su CI.

## Branch

`feat/checklist-db-foundation`

---

## File Structure

- `packages/database/prisma/schema.prisma` — 4 nuovi model + relazioni inverse su `InterventionType`, `Intervention`, `Tenant`.
- `packages/database/prisma/migrations/20260702130000_checklist_foundation/migration.sql` — DDL + RLS + grant + trigger + indici.
- `packages/database/src/seed-data.ts` — sostituzione `SYSTEM_INTERVENTION_TYPES` (3 tipi) + nuova costante `SYSTEM_CHECKLIST_ITEMS`.
- `packages/database/prisma/seed.ts` — wiring seeding voci checklist (upsert idempotente).
- `packages/database/prisma/generated/prisma/**` — rigenerato (`prisma generate`), committato.
- `packages/api/tests/integration/helpers.ts` — remap `SYSTEM_TYPE_FALLBACKS`/default a `MECCANICO`.
- `packages/database/tests/integration/helpers.ts` — `reseedInterventionTypes`/`getSystemInterventionTypeId` default a `MECCANICO`.
- `packages/database/tests/integration/checklist-foundation.test.ts` — nuovo: RLS + struttura + snapshot FK behavior.
- `docs/APPENDICE_B_DATABASE.md` — sezione tabelle nuove + nota RLS.

## Global Constraints

- TypeScript strict, no `any` senza commento.
- Commenti in inglese; stringhe user-facing (nameIt voci) in italiano.
- Conventional Commits, summary ≤ 72 char.
- Nessuna nuova dipendenza npm.

---

### Task 1: Schema Prisma — 4 nuovi model

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (InterventionType L448-470, Intervention L472-509, Tenant ~L200-244)
- (Test: coperto dai task RLS successivi + `pnpm --filter @garageos/database prisma:validate`)

**Interfaces — Produces (nomi esatti che i PR successivi consumano):**
- `model InterventionChecklistItem` → tabella `intervention_checklist_items`; campi Prisma: `id`, `interventionTypeId`, `code`, `nameIt`, `sortOrder`, `active`, `createdAt`, `updatedAt`; relazione `interventionType`.
- `model TenantInterventionTypeExclusion` → `tenant_intervention_type_exclusions`; campi: `tenantId`, `interventionTypeId`, `createdAt`; PK composta.
- `model TenantChecklistItemExclusion` → `tenant_checklist_item_exclusions`; campi: `tenantId`, `checklistItemId`, `createdAt`; PK composta.
- `model InterventionChecklistSelection` → `intervention_checklist_selections`; campi: `id`, `interventionId`, `tenantId`, `checklistItemId` (nullable), `labelSnapshot`, `sortOrderSnapshot` (nullable), `createdAt`; relazioni `intervention`, `checklistItem?`.

- [ ] **Step 1: Aggiungere i model a `schema.prisma`** (dopo `InterventionType`, prima di `Intervention` o in coda alla sezione INTERVENTIONS)

```prisma
model InterventionChecklistItem {
  id                 String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  interventionTypeId String   @map("intervention_type_id") @db.Uuid
  code               String   @db.VarChar(50)
  nameIt             String   @map("name_it") @db.VarChar(150)
  sortOrder          Int      @default(0) @map("sort_order") @db.SmallInt
  active             Boolean  @default(true)
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime @updatedAt @map("updated_at") @db.Timestamptz

  interventionType InterventionType                 @relation(fields: [interventionTypeId], references: [id], onDelete: Cascade)
  selections       InterventionChecklistSelection[]
  tenantExclusions TenantChecklistItemExclusion[]

  @@unique([interventionTypeId, code], map: "uq_checklist_item_code_type")
  @@index([interventionTypeId], map: "idx_checklist_items_type")
  @@map("intervention_checklist_items")
}

model TenantInterventionTypeExclusion {
  tenantId           String   @map("tenant_id") @db.Uuid
  interventionTypeId String   @map("intervention_type_id") @db.Uuid
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant           Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  interventionType InterventionType @relation(fields: [interventionTypeId], references: [id], onDelete: Cascade)

  @@id([tenantId, interventionTypeId])
  @@index([interventionTypeId], map: "idx_type_excl_type")
  @@map("tenant_intervention_type_exclusions")
}

model TenantChecklistItemExclusion {
  tenantId        String   @map("tenant_id") @db.Uuid
  checklistItemId String   @map("checklist_item_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant        Tenant                    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  checklistItem InterventionChecklistItem @relation(fields: [checklistItemId], references: [id], onDelete: Cascade)

  @@id([tenantId, checklistItemId])
  @@index([checklistItemId], map: "idx_item_excl_item")
  @@map("tenant_checklist_item_exclusions")
}

model InterventionChecklistSelection {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  interventionId    String   @map("intervention_id") @db.Uuid
  tenantId          String   @map("tenant_id") @db.Uuid
  checklistItemId   String?  @map("checklist_item_id") @db.Uuid
  labelSnapshot     String   @map("label_snapshot") @db.VarChar(150)
  sortOrderSnapshot Int?     @map("sort_order_snapshot") @db.SmallInt
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  intervention  Intervention               @relation(fields: [interventionId], references: [id], onDelete: Cascade)
  checklistItem InterventionChecklistItem? @relation(fields: [checklistItemId], references: [id], onDelete: SetNull)

  @@unique([interventionId, checklistItemId], map: "uq_selection_intervention_item")
  @@index([interventionId], map: "idx_selections_intervention")
  @@map("intervention_checklist_selections")
}
```

- [ ] **Step 2: Aggiungere le relazioni inverse** nei model esistenti:
  - `InterventionType`: aggiungere `checklistItems InterventionChecklistItem[]` e `tenantExclusions TenantInterventionTypeExclusion[]`.
  - `Intervention`: aggiungere `checklistSelections InterventionChecklistSelection[]`.
  - `Tenant`: aggiungere `interventionTypeExclusions TenantInterventionTypeExclusion[]` e `checklistItemExclusions TenantChecklistItemExclusion[]`.

- [ ] **Step 3: Validare lo schema**

Run: `pnpm --filter @garageos/database exec prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Rigenerare il client**

Run: `pnpm --filter @garageos/database exec prisma generate`
Expected: generazione OK; nuovi tipi in `prisma/generated`.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/generated
git commit -m "feat(database): add checklist items, exclusions, selections models"
```

---

### Task 2: Migration SQL — tabelle, RLS, grant, trigger

**Files:**
- Create: `packages/database/prisma/migrations/20260702130000_checklist_foundation/migration.sql`

**Interfaces — Consumes:** funzioni RLS esistenti `current_tenant_id()`, `is_admin_role()`, `set_updated_at()` (definite in `20260424100000_rls_triggers_checks`).

- [ ] **Step 1: Scrivere la migration** (DDL + RLS + grant + trigger + indici)

```sql
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
```

- [ ] **Step 2: Marcare la migration come applicata in locale/CI** — la migration è operator-driven; per far girare gli integration test su CI il runner esegue `prisma migrate deploy` sul container. Verificare che il nome cartella/`migration.sql` sia coerente con `migration_lock.toml` (provider `postgresql`).

Run (solo per riprodurre CI, NON di routine): `pnpm --filter @garageos/database test:integration -t "checklist"` — vedi Task 6.

- [ ] **Step 3: Commit**

```bash
git add packages/database/prisma/migrations/20260702130000_checklist_foundation
git commit -m "feat(database): checklist foundation migration (tables, RLS, grants)"
```

---

### Task 3: Seed data — 3 tipi coarse + voci checklist

**Files:**
- Modify: `packages/database/src/seed-data.ts` (sostituzione `SYSTEM_INTERVENTION_TYPES`, nuova `SYSTEM_CHECKLIST_ITEMS`)

**Interfaces — Produces:**
- `SYSTEM_INTERVENTION_TYPES: SystemInterventionType[]` con 3 elementi (`MECCANICO`, `GOMME`, `REVISIONE`).
- `SYSTEM_CHECKLIST_ITEMS: SystemChecklistItem[]` — `{ typeCode: string; code: string; nameIt: string; sortOrder: number }[]`.

- [ ] **Step 1: Sostituire `SYSTEM_INTERVENTION_TYPES`** con i 3 tipi coarse:

```ts
export const SYSTEM_INTERVENTION_TYPES: SystemInterventionType[] = [
  {
    code: 'MECCANICO',
    nameIt: 'Intervento Meccanico',
    description: 'Interventi di manutenzione e riparazione meccanica',
    icon: 'wrench',
    category: InterventionTypeCategory.maintenance,
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
  },
  {
    code: 'GOMME',
    nameIt: 'Cambio Gomme',
    description: 'Pneumatici e servizi correlati',
    icon: 'circle',
    category: InterventionTypeCategory.tires,
    suggestsDeadline: true,
    defaultDeadlineMonths: 6,
    defaultDeadlineKm: null,
  },
  {
    code: 'REVISIONE',
    nameIt: 'Revisione',
    description: 'Revisione periodica e controlli',
    icon: 'clipboard-check',
    category: InterventionTypeCategory.inspection,
    suggestsDeadline: true,
    defaultDeadlineMonths: 24,
    defaultDeadlineKm: null,
  },
];
```

- [ ] **Step 2: Aggiungere il tipo e la costante voci** (elenco iniziale — confermato editabile da admin; valori da rivedere con l'owner):

```ts
export type SystemChecklistItem = {
  typeCode: string;
  code: string;
  nameIt: string;
  sortOrder: number;
};

export const SYSTEM_CHECKLIST_ITEMS: SystemChecklistItem[] = [
  // Intervento Meccanico
  { typeCode: 'MECCANICO', code: 'CAMBIO_OLIO', nameIt: 'Cambio olio', sortOrder: 10 },
  { typeCode: 'MECCANICO', code: 'FILTRO_OLIO', nameIt: 'Cambio filtro olio', sortOrder: 20 },
  { typeCode: 'MECCANICO', code: 'FILTRO_ARIA', nameIt: 'Cambio filtro aria', sortOrder: 30 },
  { typeCode: 'MECCANICO', code: 'FILTRO_ABITACOLO', nameIt: 'Cambio filtro abitacolo', sortOrder: 40 },
  { typeCode: 'MECCANICO', code: 'BATTERIA', nameIt: 'Sostituzione batteria', sortOrder: 50 },
  { typeCode: 'MECCANICO', code: 'DISTRIBUZIONE', nameIt: 'Sostituzione cinghia di distribuzione', sortOrder: 60 },
  { typeCode: 'MECCANICO', code: 'FRENI', nameIt: 'Intervento impianto frenante', sortOrder: 70 },
  { typeCode: 'MECCANICO', code: 'CLIMA', nameIt: 'Manutenzione climatizzatore', sortOrder: 80 },
  { typeCode: 'MECCANICO', code: 'DIAGNOSI', nameIt: 'Diagnosi elettronica', sortOrder: 90 },
  // Cambio Gomme
  { typeCode: 'GOMME', code: 'PNEUMATICI', nameIt: 'Sostituzione pneumatici', sortOrder: 10 },
  { typeCode: 'GOMME', code: 'STAGIONALE', nameIt: 'Cambio gomme stagionale', sortOrder: 20 },
  { typeCode: 'GOMME', code: 'CONVERGENZA', nameIt: 'Convergenza', sortOrder: 30 },
  { typeCode: 'GOMME', code: 'EQUILIBRATURA', nameIt: 'Equilibratura', sortOrder: 40 },
  { typeCode: 'GOMME', code: 'RIPARAZIONE', nameIt: 'Riparazione foratura', sortOrder: 50 },
  // Revisione
  { typeCode: 'REVISIONE', code: 'MINISTERIALE', nameIt: 'Revisione ministeriale', sortOrder: 10 },
  { typeCode: 'REVISIONE', code: 'PRE_REVISIONE', nameIt: 'Pre-revisione / controllo', sortOrder: 20 },
];
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/database typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/seed-data.ts
git commit -m "feat(database): seed 3 coarse types and checklist items"
```

---

### Task 4: Wiring seed — upsert voci checklist

**Files:**
- Modify: `packages/database/prisma/seed.ts` (dopo il loop `SYSTEM_INTERVENTION_TYPES`, L24-40)

**Interfaces — Consumes:** `SYSTEM_INTERVENTION_TYPES`, `SYSTEM_CHECKLIST_ITEMS` (Task 3).

- [ ] **Step 1: Aggiungere il seeding idempotente delle voci** dopo l'upsert dei tipi:

```ts
import { SYSTEM_INTERVENTION_TYPES, SYSTEM_CHECKLIST_ITEMS } from '../src/seed-data.js';

// ...dopo aver seminato i tipi...
for (const item of SYSTEM_CHECKLIST_ITEMS) {
  const type = await prisma.interventionType.findFirst({
    where: { tenantId: null, code: item.typeCode },
    select: { id: true },
  });
  if (!type) throw new Error(`seed: intervention type ${item.typeCode} not found`);

  const existing = await prisma.interventionChecklistItem.findFirst({
    where: { interventionTypeId: type.id, code: item.code },
    select: { id: true },
  });
  if (existing) {
    await prisma.interventionChecklistItem.update({
      where: { id: existing.id },
      data: { nameIt: item.nameIt, sortOrder: item.sortOrder, active: true },
    });
  } else {
    await prisma.interventionChecklistItem.create({
      data: {
        interventionTypeId: type.id,
        code: item.code,
        nameIt: item.nameIt,
        sortOrder: item.sortOrder,
      },
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @garageos/database typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/database/prisma/seed.ts
git commit -m "feat(database): wire checklist item seeding"
```

---

### Task 5: Remap test helper ai nuovi code

**Files:**
- Modify: `packages/api/tests/integration/helpers.ts` (`SYSTEM_TYPE_FALLBACKS` L561-, `ensureSystemInterventionType` default)
- Modify: `packages/database/tests/integration/helpers.ts` (`reseedInterventionTypes` L33-, `getSystemInterventionTypeId` default L73)

**Contract:** i vecchi code `TAGLIANDO`/`CAMBIO_OLIO` non esistono più; i test che chiamano `getSystemInterventionTypeId()` o `ensureSystemInterventionType('TAGLIANDO')` devono ottenere un tipo valido. Rimappare i default a `'MECCANICO'` e riallineare `reseedInterventionTypes` a `SYSTEM_INTERVENTION_TYPES` (che ora ha 3 elementi).

- [ ] **Step 1: Grep di tutti i call site dei vecchi code** per non lasciarne indietro:

Run:
```bash
grep -rn "TAGLIANDO\|CAMBIO_OLIO\|CAMBIO_GOMME\|'DISTRIBUZIONE'\|'FRENI'\|'BATTERIA'\|'DIAGNOSI'\|'CARROZZERIA'\|'CLIMATIZZATORE'\|'ALTRO'" packages --include=*.ts | grep -i test
```
Expected: elenco finito di call site. Ognuno va rimappato a `'MECCANICO'` (o al code voce appropriato nei PR successivi).

- [ ] **Step 2: Aggiornare i default helper** a `'MECCANICO'` e allineare `SYSTEM_TYPE_FALLBACKS` ai 3 tipi (MECCANICO/GOMME/REVISIONE). Aggiornare `reseedInterventionTypes` per iterare la nuova `SYSTEM_INTERVENTION_TYPES`.

- [ ] **Step 3: Aggiornare i call site** trovati allo Step 1 a `'MECCANICO'` (i test di selezione checklist arrivano nei PR successivi; qui serve solo un tipo valido).

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (il typecheck non cattura i code stringa, ma cattura firme rotte degli helper).

- [ ] **Step 5: Commit**

```bash
git add packages/api/tests/integration/helpers.ts packages/database/tests/integration/helpers.ts packages
git commit -m "test(database): remap intervention type helpers to coarse types"
```

---

### Task 6: Integration test — RLS, struttura, snapshot

**Files:**
- Create: `packages/database/tests/integration/checklist-foundation.test.ts`

**Contract:** verificare (Tier 1) i confini di sicurezza e i comportamenti FK. Ogni test usa `withContext` con `tenantId` o `role:'admin'`. Mirror di `rls.test.ts` esistente.

- [ ] **Step 1: Scrivere i test (red)** — casi:
  1. **Catalog read permissivo**: un tenant A legge una voce checklist di un tipo globale (SELECT USING true) → visibile.
  2. **Catalog write admin-only (negative)**: `withContext({ tenantId: A })` che tenta `interventionChecklistItem.create` → **fallisce** (RLS write admin-only). `withContext({ role: 'admin' })` → riesce.
  3. **Esclusioni: isolamento tenant (negative)**: tenant A crea (via admin) un'esclusione per A; tenant B in SELECT non vede la riga di A (tenant-scoped read).
  4. **Esclusioni write admin-only (negative)**: tenant A tenta insert su `tenant_intervention_type_exclusions` per sé → fallisce (write admin-only).
  5. **Selezioni: write tenant-scoped (negative)**: `withContext({ tenantId: A })` inserisce una selection con `tenantId: A` → OK; con `tenantId: B` → fallisce (WITH CHECK).
  6. **Selezioni: read permissivo**: tenant B legge la selection di A (SELECT USING true, per timeline cross-tenant) → visibile.
  7. **Snapshot su delete voce**: creata selection con `checklistItemId` valorizzato e `labelSnapshot`; eliminata la voce catalogo (via admin) → la selection sopravvive con `checklistItemId = NULL` e `labelSnapshot` invariato (onDelete SetNull).
  8. **Unicità voce per tipo (BR-307)**: due voci stesso `code` sullo stesso tipo → viola `uq_checklist_item_code_type`; stesso `code` su tipo diverso → OK.

Setup: creare 2 tenant + 1 tipo globale + 1 voce via seed/helper in `beforeEach` (re-seed idempotente dopo eventuale TRUNCATE CASCADE).

- [ ] **Step 2: Verificare che falliscano** (tabelle/policy assenti prima della migration nel container, oppure asserzioni non ancora soddisfatte).

Run: `pnpm --filter @garageos/database test:integration -t "checklist-foundation"`
Expected: FAIL inizialmente.

- [ ] **Step 3: Rendere verdi** applicando la migration (Task 2) nel container di test e correggendo il setup finché tutti i casi passano.

Run: `pnpm --filter @garageos/database test:integration -t "checklist-foundation"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/database/tests/integration/checklist-foundation.test.ts
git commit -m "test(database): RLS and snapshot tests for checklist foundation"
```

---

### Task 7: Documentazione APPENDICE_B

**Files:**
- Modify: `docs/APPENDICE_B_DATABASE.md` (sezione tabelle interventi)

- [ ] **Step 1: Documentare** le 4 tabelle nuove (colonne, FK, indici, policy RLS) e la nota sul modello opt-out + snapshot, coerente con lo stile della sezione esistente. Citare BR-303/307 dove pertinente.

- [ ] **Step 2: Commit**

```bash
git add docs/APPENDICE_B_DATABASE.md
git commit -m "docs: document checklist foundation tables and RLS"
```

---

## Self-Review

**Spec coverage:** Tabelle nuove (§Modello dati) → Task 1-2. Seed 3 tipi + voci (§Modello dati, D5 parziale) → Task 3-4. RLS + negative test (§Testing, §RLS) → Task 6. Snapshot D8/BR-303 → Task 6 caso 7. Unicità BR-307 → Task 6 caso 8. Doc → Task 7. **Fuori da questo PR (per design):** endpoint admin/officina, UI, PDF, mobile, validazioni BR-300/301/302/305, rimozione title, cleanup dati test prod (runbook operator nel PR finale). Coperti dai PR successivi dell'arco.

**Placeholder scan:** nessun TODO/TBD residuo. L'elenco voci checklist è concreto (marcato "da rivedere con owner" — modificabile via admin, non un placeholder di implementazione).

**Type consistency:** nomi campo Prisma (`checklistItemId`, `labelSnapshot`, `sortOrderSnapshot`, `interventionTypeId`) coerenti tra Task 1 (schema), Task 4 (seed), Task 6 (test). Colonne SQL (`snake_case`) coerenti col `@map`. Funzioni RLS (`is_admin_role`, `current_tenant_id`, `set_updated_at`) verificate esistenti.

**Note per l'esecuzione:** il cleanup dei dati intervento di test in **produzione** (D5) NON è in questo plan: è uno step operator-driven da eseguire con conferma owner quando l'officina passerà al nuovo flusso (candidato: runbook nel PR-OFFICINA-API o nel contract finale). In sviluppo/CI il DB parte già dal nuovo seed.

# F-CLI-306 PR1 — Scadenze personali: DB + API CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabelle customer-owned per le scadenze personali + API CRUD `/v1/me/personal-deadlines` (create/list/get/patch/delete/complete) con materializzazione dei reminder. Nessun dispatch notifiche né cron (PR2), nessuna UI (PR3).

**Architecture:** Due tabelle nuove (`personal_deadlines`, `personal_deadline_reminders`), RLS `USING(true)` + filtro app-layer su `customerId` (mirror `vehicle_transfers`/`me-transfers.ts`, lezione #154). I reminder sono righe materializzate alla create/patch da una lib pura (`build-reminders.ts`) che riusa la matematica DST/skew di `compute-reminders.ts` (BR-103) tramite un helper estratto. Validator condivisi nel package `@garageos/database`. Niente EventBridge.

**Tech Stack:** Fastify + Prisma 7 (adapter), Zod v4, Postgres RLS, Vitest (unit + integration testcontainer).

**Spec:** `docs/superpowers/specs/2026-06-16-personal-vehicle-deadlines-design.md`

**LOC budget:** target ~1100 net (code+test), hard PR limit 1500. Controller verifica LOC cumulativa dopo ogni task; halt+ask a ~1200.

---

## Deviations from spec (verified against actual code — the code wins)

1. **`NotificationDeliveryStatus` riusato** per `personal_deadline_reminders.deliveryStatus` invece di un enum nuovo: l'enum esistente (`pending|sent|failed|cancelled`, schema.prisma:156) ha già i valori giusti. La spec §3.2 lo prevedeva ("riuso").
2. **Grant a `garageos_app`**: la migration `20260430120000_create_garageos_app_role` concede già `SELECT,INSERT,UPDATE,DELETE ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`. Aggiungiamo **comunque** grant espliciti sulle due tabelle (le default-privileges si applicano solo a oggetti creati dallo stesso `session_user` — è stato un punto fragile in passato; esplicito = sicuro).
3. **Validator condivisi** vivono in `packages/database/src/validators/` ed escono via `@garageos/database` (index.ts re-export), NON in `packages/api`. Confermato: `me-vehicles-pending.ts:1` importa `CreatePendingVehicleSchema` da `@garageos/database`.
4. **Helper DST `romeLocalToUtc`/`shiftCalendarDays` sono module-private** in `compute-reminders.ts`. Per riusarli senza duplicare la matematica fragile, il Task 3 li espone tramite un nuovo `romeDayAtHourUtc()` esportato e rifattorizza `computeReminderSchedule` per usarlo (i test esistenti `compute-reminders.test.ts` fanno da rete di regressione — zero cambio di comportamento).

## Gotchas the implementer MUST respect (from project memory)

- **RLS mai da sola** (#154): ogni query filtra `customerId = request.customerId` a livello app, anche con `USING(true)`.
- **RLS-as-404** (`feedback_rls_split_changes_endpoint_semantics`): GET `/:id` usa `findFirst({ id, customerId })` + null-check → 404, mai `findUniqueOrThrow`. Integration test cross-customer 404 obbligatorio.
- **Zod `.default()` nel PATCH** (`feedback_zod_default_under_partial_defeats_empty_body`, #140): i `.default()` stanno SOLO nello schema CREATE. Lo schema UPDATE è tutto-opzionale, niente default, `.strict()`; body `{}` → 400 empty/no-op gestito a route.
- **`exactOptionalPropertyTypes`** (`feedback_exact_optional_property_types_prisma_in_body`): per i campi opzionali in `create`/`update` usa il pattern `'key' in parsed` su una lista di chiavi editabili, niente `as any`.
- **`@updatedAt` client-only** (`feedback_prisma_updatedat_raw_sql`): la migration ha `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; nessun INSERT raw nei test senza `updated_at`.
- **Prisma data XOR / excess-property non catturato da tsc** (#116): dopo aver scritto i `create({data})`/`select`, grep `schema.prisma` campo per campo.
- **FakePrisma unit mocks** (`feedback_handler_change_breaks_unit_mock`): dopo i route handler, gira `pnpm --filter @garageos/api test:unit` mirato — typecheck non vede i mock rotti.
- **Date-only `@db.Date` serializzata ISO** (#156): `dueDate` torna come `YYYY-MM-DD`; l'integration test asserisce la stringa esatta.
- **Migration operator-applied**: `db:migrate:deploy` con DIRECT_URL; deploy.yml spedisce solo CDK. Annotare nel header del runbook a fine arco (PR3).
- **Pre-flight error code** (#180): famiglia `personal_deadline.*` verificata ASSENTE in APPENDICE_G → la registriamo (Task 6).
- **BR collision** (#118): BR-290…298 verificate libere il 2026-06-16 (`grep -E 'BR-(29[0-9]|3[0-9][0-9])' APPENDICE_F` → 0 match). Ri-grep prima di scrivere il Task 6.

## Branch

`feat/personal-deadlines-pr1` (già creato; la spec è committata in `2effd5a`).

---

## Task 1 — Schema Prisma + migration (tabelle, enum, RLS, grant)

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (3 enum nuovi, 2 model nuovi, back-relation su `Customer` e `Vehicle`)
- Create: `packages/database/prisma/migrations/20260616120000_personal_deadlines/migration.sql`
- Test: `packages/database/tests/integration/migrations/personal-deadlines-rls.test.ts`

### Contract

Enum (Prisma → DB type):
- `PersonalDeadlineCategory`: `insurance road_tax inspection service tires timing_belt other`
- `PersonalDeadlineStatus`: `open completed overdue cancelled`
- `PersonalDeadlineReminderKind`: `lead tail`
- `deliveryStatus` riusa `NotificationDeliveryStatus` (esistente).

Model `PersonalDeadline` (mirror struttura di `Deadline` schema.prisma:630, ma customer-owned):
campi da §3.1 della spec — `id, customerId, vehicleId, category, customLabel?, dueDate @db.Date, recurrenceMonths? @db.SmallInt, reminderLeadDays Int[], reminderDailyTailDays? @db.SmallInt, notifyPush, notifyEmail, status @default(open), notes? @db.Text, completedAt? @db.Timestamptz, createdAt, updatedAt @updatedAt`. Relazioni: `customer` (onDelete Cascade), `vehicle` (onDelete Cascade), `reminders PersonalDeadlineReminder[]`. Indici: `@@index([customerId, status, dueDate])`, `@@index([vehicleId])`. `@@map("personal_deadlines")`.

Model `PersonalDeadlineReminder` (§3.2): `id, personalDeadlineId, scheduledFor @db.Date, kind, deliveryStatus NotificationDeliveryStatus @default(pending), sentAt? @db.Timestamptz, failureReason? @db.Text, createdAt`. Relazione `personalDeadline` (onDelete Cascade). Indici: `@@index([personalDeadlineId])`, `@@index([scheduledFor, deliveryStatus])`. `@@map("personal_deadline_reminders")`.

Back-relation: aggiungi `personalDeadlines PersonalDeadline[]` a `Customer` (dopo `emailVerifications`, schema.prisma:333) e a `Vehicle` (nella lista relazioni del model Vehicle).

### Migration SQL (target verbatim — dopo `prisma migrate dev --create-only --name personal_deadlines`, sostituisci/integra con questo)

```sql
-- F-CLI-306 / BR-290..298: customer-owned personal vehicle deadlines.
-- Spec: docs/superpowers/specs/2026-06-16-personal-vehicle-deadlines-design.md
-- Security pattern: RLS USING(true) + app-layer customerId filter (mirror
-- vehicle_transfers / transfers_access; lezione #154). Customers create,
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

-- updated_at trigger (mirror other mutable tables; set_updated_at() exists)
CREATE TRIGGER "personal_deadlines_set_updated_at"
  BEFORE UPDATE ON "personal_deadlines"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grants (explicit, not relying on default privileges)
GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_deadlines" TO garageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_deadline_reminders" TO garageos_app;
```

> Verifica `set_updated_at` esista come funzione: `grep -n "FUNCTION set_updated_at" packages/database/prisma/migrations/*/*.sql`. Se il nome reale differisce (es. `set_updated_at_column`), usa quello. Se le altre tabelle NON usano un trigger ma si affidano a Prisma `@updatedAt`, **rimuovi il blocco trigger** (Prisma gestisce `updated_at` lato client) e tieni solo il `DEFAULT NOW()`.

### Steps

- [ ] **Step 1:** Edita `schema.prisma` (enum + model + back-relation come da contract). Esegui `pnpm --filter @garageos/database prisma format` e `prisma generate`. Verifica che il client generato esponga `prisma.personalDeadline` e `prisma.personalDeadlineReminder`.
- [ ] **Step 2:** `prisma migrate dev --create-only --name personal_deadlines` per scaffoldare, poi sostituisci il contenuto con l'SQL target sopra (aggiungendo RLS/grant/trigger che Prisma non genera). Applica con `db:migrate:deploy` su DB locale/test.
- [ ] **Step 3 (test, RED→GREEN):** integration test `personal-deadlines-rls.test.ts` che, sotto `withContext({ customerId: A })`, inserisce una `personal_deadline` e NON vede quella di `customerId: B` quando il codice applica il filtro app-layer; e che `FORCE ROW LEVEL SECURITY` è attivo (la riga esiste). Mirror di un test RLS esistente in `packages/database/tests/integration/migrations/`.
- [ ] **Step 4:** `pnpm --filter @garageos/database typecheck` + il test sopra (testcontainer) verde.
- [ ] **Step 5 — Commit:** `feat(database): personal deadlines tables, enums, RLS (F-CLI-306)`

---

## Task 2 — Validator condivisi

**Files:**
- Create: `packages/database/src/validators/personal-deadline.ts`
- Modify: `packages/database/src/validators/index.ts` (re-export)
- Test: `packages/api/tests/unit/validators/personal-deadline.test.ts` (oppure in `packages/database/tests` se lì vivono i test validator — grep `*.test.ts` accanto a `vehicle.ts`)

### Contract (verbatim Zod — i default SOLO nel CREATE, lezione #140)

```ts
import { z } from 'zod';

export const PersonalDeadlineCategoryEnum = z.enum([
  'insurance', 'road_tax', 'inspection', 'service', 'tires', 'timing_belt', 'other',
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// CREATE — defaults present (one-shot body, never an empty PATCH body).
export const CreatePersonalDeadlineSchema = z
  .object({
    vehicleId: z.uuid(),
    category: PersonalDeadlineCategoryEnum,
    customLabel: z.string().trim().min(1).max(80).optional(),
    dueDate: z.string().regex(DATE_ONLY),
    recurrenceMonths: z.number().int().min(1).max(120).optional(),
    reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).default([30, 7, 0]),
    reminderDailyTailDays: z.number().int().min(0).max(30).optional(),
    notifyPush: z.boolean().default(true),
    notifyEmail: z.boolean().default(true),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  // BR-294: customLabel obbligatoria sse category === 'other'.
  .refine((d) => d.category !== 'other' || (d.customLabel != null && d.customLabel.length > 0), {
    path: ['customLabel'],
    message: 'custom_label_required',
  });

// UPDATE — tutto opzionale, NIENTE default (#140), strict. Il check BR-294
// cross-field si fa a route-level (category può non essere nel body).
export const UpdatePersonalDeadlineSchema = z
  .object({
    category: PersonalDeadlineCategoryEnum.optional(),
    customLabel: z.string().trim().min(1).max(80).nullable().optional(),
    dueDate: z.string().regex(DATE_ONLY).optional(),
    recurrenceMonths: z.number().int().min(1).max(120).nullable().optional(),
    reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).optional(),
    reminderDailyTailDays: z.number().int().min(0).max(30).nullable().optional(),
    notifyPush: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
```

### Steps

- [ ] **Step 1 (test RED):** test che (a) CREATE con `category:'other'` senza `customLabel` fallisce su path `customLabel`; (b) CREATE senza `reminderLeadDays` applica default `[30,7,0]`; (c) UPDATE con body `{}` è valido ma vuoto (no default iniettati → la route lo tratta come no-op/400); (d) `reminderLeadDays` con 11 elementi fallisce.
- [ ] **Step 2:** implementa il file + re-export in `index.ts`.
- [ ] **Step 3 (GREEN):** test verdi.
- [ ] **Step 4:** `pnpm --filter @garageos/database typecheck`.
- [ ] **Step 5 — Commit:** `feat(database): personal deadline validators (F-CLI-306)`

---

## Task 3 — Lib `build-reminders` (riuso DST helper)

**Files:**
- Modify: `packages/api/src/lib/deadlines/compute-reminders.ts` (esporta `romeDayAtHourUtc`, rifattorizza `computeReminderSchedule` per usarlo)
- Create: `packages/api/src/lib/personal-deadlines/build-reminders.ts`
- Test: `packages/api/tests/unit/lib/personal-deadlines/build-reminders.test.ts`
- Regression: `packages/api/tests/unit/lib/deadlines/compute-reminders.test.ts` (deve restare verde invariato)

### Contract

In `compute-reminders.ts`, estrai e **esporta**:
```ts
// Rome-local 08:00 UTC instant for (Rome calendar date of baseDate) shifted by deltaDays.
export function romeDayAtHourUtc(baseDate: Date, deltaDays: number, hourLocal = REMINDER_HOUR_LOCAL): Date
```
Implementala con la `dateFmt` Rome-calendar di `computeReminderSchedule` + `shiftCalendarDays` + `romeLocalToUtc` (già nel file). Rifattorizza `computeReminderSchedule` così `tMinus30 = romeDayAtHourUtc(dueDate, -30)`, ecc. — **zero cambio di output** (i test esistenti lo garantiscono).

`build-reminders.ts`:
```ts
export type PersonalReminderKind = 'lead' | 'tail';
export interface PersonalReminderRow { scheduledFor: Date; kind: PersonalReminderKind; }

// dueDate: Date (mezzanotte UTC del giorno scadenza va bene — si usa solo la
// data calendario Rome). leadDays/tailDays come da validator. now per lo skew.
export function buildPersonalReminders(
  dueDate: Date,
  reminderLeadDays: number[],
  reminderDailyTailDays: number | null,
  now: Date = new Date(),
): PersonalReminderRow[]
```
Algoritmo:
1. Mappa offset→kind: per ogni `d` in `reminderLeadDays` → offset `d` kind `lead`; per ogni `k` in `[0 .. (tail-1)]` (se tail>0) → offset `k` kind `tail`. **Dedup per offset; `lead` vince** sulla collisione.
2. Per ogni offset unico: `scheduledFor = romeDayAtHourUtc(dueDate, -offset, 8)`.
3. Filtra `scheduledFor.getTime() > now.getTime() + 60_000` (skew BR-103, riusa `SKEW_BUFFER_MS`).
4. Ordina asc per `scheduledFor`. Cita BR-293 (cap) e BR-295 (timing) nei commenti.

### Steps

- [ ] **Step 1 (test RED):** casi: (a) `lead [30,7,0]`, tail null, dueDate +60g → 3 righe alle 08:00 Rome dei giorni -30/-7/0; (b) `lead [7]` + tail `7` → giorni -6..-0 (tail) ∪ -7 (lead) = 8 righe, il -7 è `lead`, gli altri `tail`, nessun duplicato a -6/-0; collisione lead/tail sullo stesso offset → kind `lead`; (c) skew: dueDate oggi, offset 0 con `now` alle 09:00 → scartato (08:00 già passato); (d) DST: dueDate a cavallo dell'ora legale, l'istante è ancora 08:00 Rome.
- [ ] **Step 2 (regression):** gira `compute-reminders.test.ts`, deve passare PRIMA di toccare comportamento (poi dopo il refactor resta verde).
- [ ] **Step 3:** esporta `romeDayAtHourUtc`, rifattorizza, implementa `build-reminders.ts`.
- [ ] **Step 4 (GREEN):** entrambi i test verdi; `pnpm --filter @garageos/api typecheck`.
- [ ] **Step 5 — Commit:** `feat(api): personal deadline reminder builder (F-CLI-306)`

---

## Task 4 — DTO serializer

**Files:**
- Create: `packages/api/src/lib/dtos/personal-deadline.ts`
- Test: `packages/api/tests/unit/lib/dtos/personal-deadline.test.ts`

### Contract (mirror `dtos/transfer.ts`)

`PERSONAL_DEADLINE_SELECT` (`satisfies Prisma.PersonalDeadlineSelect`) con: `id, vehicleId, category, customLabel, dueDate, recurrenceMonths, reminderLeadDays, reminderDailyTailDays, notifyPush, notifyEmail, status, notes, completedAt, createdAt, updatedAt` + `vehicle: { select: { plate, make, model } }`. (NON includere `customerId` nel DTO: è il caller; nessuna PII di terzi.)

`serializePersonalDeadline(row)` → DTO:
- `dueDate`: **stringa `YYYY-MM-DD`** (il campo è `@db.Date`; Prisma lo restituisce come `Date` a mezzanotte UTC → `row.dueDate.toISOString().slice(0,10)`). Lezione #156.
- `completedAt`/`createdAt`/`updatedAt`: `.toISOString()`; campi opzionali aggiunti solo se non-null (pattern transfer.ts).
- gli altri campi pass-through.

### Steps

- [ ] **Step 1 (test RED):** un row finto → DTO con `dueDate` esattamente `"2026-07-10"` (no `T00:00:00`), niente `customerId`, `completedAt` assente quando null.
- [ ] **Step 2:** implementa.
- [ ] **Step 3 (GREEN):** verde + typecheck.
- [ ] **Step 4 — Commit:** `feat(api): personal deadline DTO serializer (F-CLI-306)`

---

## Task 5 — Route `/v1/me/personal-deadlines`

**Files:**
- Create: `packages/api/src/routes/v1/me-personal-deadlines.ts`
- Modify: `packages/api/src/server.ts` (import + `app.register(mePersonalDeadlinesRoutes)` accanto a `meTransfersRoutes`, ~:216)
- Test (unit): `packages/api/tests/unit/routes/v1/me-personal-deadlines.test.ts`
- Test (integration): `packages/api/tests/integration/me-personal-deadlines.test.ts`

### Contract

Tutte le route: `preHandler: [requireAuth, requireClientiPool, clientiContext]`, dentro `app.withContext({ customerId, role: 'user' }, async (tx) => …)`. `customerId = request.customerId!`. Mirror struttura `me-transfers.ts`.

**POST `/v1/me/personal-deadlines`** → 201
- `CreatePersonalDeadlineSchema.parse(body)`.
- Verifica ownership corrente (BR-290): `tx.vehicle.findFirst({ where: { id: vehicleId }, select: { id, ownerships: { where: { endedAt: null }, select: { customerId } } } })`; se non esiste o `ownerships[0]?.customerId !== customerId` → `businessError('personal_deadline.vehicle_not_owned', 403, 'Non sei il proprietario di questo veicolo.')`. (Mirror del check in `me-transfers.ts:55-78`.)
- Crea la `personalDeadline` (`data` esatti dai campi validati — grep schema), poi `buildPersonalReminders(new Date(dueDate+'T00:00:00Z'), reminderLeadDays, reminderDailyTailDays ?? null, now)` e `createMany` delle righe reminder (`personalDeadlineId`, `scheduledFor`, `kind`). Niente Promise.all su tx (warning pg) — usa `createMany`.
- Ritorna `serializePersonalDeadline(refetch con PERSONAL_DEADLINE_SELECT)`.

**GET `/v1/me/personal-deadlines`** → `{ data: [...] }`
- `findMany({ where: { customerId, ...statusFilter, ...vehicleFilter }, orderBy: [{ status }, { dueDate: 'asc' }], select: PERSONAL_DEADLINE_SELECT })`. Query opzionali `?status=` (enum) e `?vehicleId=` (uuid) via uno schema query zod. Ordinamento per urgenza: `dueDate asc` è il primario utile; raffinamenti di raggruppamento li fa la UI (PR3).

**GET `/v1/me/personal-deadlines/:id`** → `{ personalDeadline }`
- `findFirst({ where: { id, customerId }, select: PERSONAL_DEADLINE_SELECT })`; null → `businessError('personal_deadline.not_found', 404, 'Scadenza non trovata.')`. (RLS-as-404.)

**PATCH `/v1/me/personal-deadlines/:id`** → `{ personalDeadline }`
- `UpdatePersonalDeadlineSchema.parse(body)`. Carica la riga (`findFirst({ id, customerId }`); null → 404). 
- Body vuoto (`Object.keys(parsed).length === 0`) → `businessError('validation.empty_body', 400, …)` (riusa il codice empty-body esistente — grep APPENDICE_G/altri route per il codice reale; se non esiste, 400 ZodError-style). 
- Cross-field BR-294: categoria effettiva = `parsed.category ?? row.category`; label effettiva = `'customLabel' in parsed ? parsed.customLabel : row.customLabel`; se effettiva categoria `other` e label vuota/null → `businessError('personal_deadline.custom_label_required', 422, "Specifica un'etichetta per la categoria 'Altro'.")`.
- Costruisci `data` con il pattern `'key' in parsed` (exactOptionalPropertyTypes) per ogni chiave editabile.
- Se cambia `dueDate` **o** `reminderLeadDays` **o** `reminderDailyTailDays`: rigenera i reminder pending — `deleteMany({ personalDeadlineId: id, deliveryStatus: 'pending' })` poi `createMany` da `buildPersonalReminders(nuovaDueDate, nuoviLead, nuovoTail, now)`. I reminder `sent`/`failed`/`cancelled` restano (append-only). (In PR1 non c'è ancora sweep, ma la materializzazione dev'essere corretta.)
- `update` + refetch + serialize.

**DELETE `/v1/me/personal-deadlines/:id`** → 204
- `findFirst({ id, customerId })`; null → 404. `delete` (cascade sui reminder). `reply.code(204)`.

**POST `/v1/me/personal-deadlines/:id/complete`** → `{ personalDeadline, renewalSuggestion? }`
- `findFirst({ id, customerId })`; null → 404. Se `status !== 'open'` → `businessError('personal_deadline.not_open', 409, 'La scadenza non è in stato aperto.')`.
- `update` → `status:'completed', completedAt: now`. `deleteMany` reminder pending.
- Se `recurrenceMonths != null`: calcola `suggestedDueDate = dueDate + recurrenceMonths` (UTC calendar add, no DST drift — usa `Date.UTC` + setUTCMonth) come `YYYY-MM-DD` e includi `renewalSuggestion: { suggestedDueDate, category, customLabel, recurrenceMonths, reminderLeadDays, reminderDailyTailDays, notifyPush, notifyEmail }` (i dati per precompilare il form lato client — BR-296, nessuna creazione automatica).

### Error codes citati (Task 6 li registra): `personal_deadline.vehicle_not_owned` (403), `personal_deadline.not_found` (404), `personal_deadline.custom_label_required` (422), `personal_deadline.not_open` (409).

### Steps

- [ ] **Step 1 (unit RED, FakePrisma):** mock di `vehicle.findFirst`/`personalDeadline.*`/`personalDeadlineReminder.createMany` che threadano l'input via `mockImplementation` (lezione mock dinamici). Casi: POST happy (201 + reminder createMany chiamato con N righe attese), POST veicolo non posseduto → 403 `personal_deadline.vehicle_not_owned`, GET:id altrui → 404, PATCH `{}` → 400, PATCH cambia dueDate → deleteMany+createMany pending, complete non-open → 409, complete con recurrence → `renewalSuggestion` presente.
- [ ] **Step 2:** implementa la route + registra in `server.ts`.
- [ ] **Step 3 (unit GREEN):** `pnpm --filter @garageos/api test:unit` mirato (FakePrisma) verde.
- [ ] **Step 4 (integration):** `me-personal-deadlines.test.ts` su Postgres reale: create→reminder rows materializzate (conta righe, `scheduled_for` formato stringa esatto), cross-customer 404 su GET/PATCH/DELETE/complete, `dueDate` round-trip `YYYY-MM-DD` (#156), patch dueDate rigenera i pending lasciando i sent, complete con recurrence ritorna suggestion, DELETE cascade (i reminder spariscono). IP unico per describe se c'è rate-limit.
- [ ] **Step 5:** `pnpm -r typecheck`.
- [ ] **Step 6 — Commit:** `feat(api): personal deadlines CRUD endpoints (F-CLI-306)`

---

## Task 6 — Docs (BR, error codes, API, schema)

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (BR-290…298 — ri-grep `BR-(29[0-9]|3[0-9][0-9])` prima, deve dare 0 match)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (famiglia `personal_deadline.*`: tabella + indice)
- Modify: `docs/APPENDICE_A_API.md` (6 endpoint `/v1/me/personal-deadlines*` con request/response shape e codici)
- Modify: `docs/APPENDICE_B_DATABASE.md` (le 2 tabelle nuove + enum, §schema)
- Modify: `docs/GarageOS-Specifiche.md` (riga F-CLI-306 nella tabella §3.3.4; nota in §157 che la v2 self-service è in corso)

### Contract
- BR-290…298: testo da spec §8 (verbatim italiano), ognuna con feature-ref F-CLI-306 e PR.
- Error code: 4 leaf sotto `personal_deadline.*` con status e `detail` IT esatti del Task 5.
- API: per ogni endpoint, metodo/path/auth (clienti pool)/body/risposta/errori, formato RFC7807.
- Schema doc: colonne, tipi, indici, RLS note (`USING(true)` + app-layer).

### Steps
- [ ] **Step 1:** ri-grep BR/error-code per confermare assenza, poi scrivi le 5 modifiche docs.
- [ ] **Step 2:** verifica i commenti `// BR-29x` nel codice (Task 1/3/5) combacino coi numeri scritti qui.
- [ ] **Step 3 — Commit:** `docs: register F-CLI-306 BR-290..298, error codes, API, schema`

---

## Self-review (esiti)

- **Spec coverage:** §3.1/§3.2 → Task 1; validator/§6 → Task 2; §3.3 reminder build → Task 3; DTO → Task 4; §6 endpoint + BR-290/294/296 + privacy → Task 5; §8 BR + error-code + §APPENDICE → Task 6. **Fuori scope PR1 (→ PR2/PR3, per spec §9):** dispatch notifiche, chiave preferenza globale, cron/sweep, flip `overdue` (BR-298), cancellazione-su-transfer (BR-297), gating canali effettivi (BR-292), mobile. Annotato: i reminder vengono materializzati in PR1 ma restano `pending` finché PR2 non aggiunge lo sweep.
- **Placeholder scan:** nessun TBD; gli unici rimandi sono i "grep di conferma" (set_updated_at, empty-body code) che sono verifiche esplicite, non placeholder di contenuto.
- **Type consistency:** `buildPersonalReminders`, `PERSONAL_DEADLINE_SELECT`, `serializePersonalDeadline`, `CreatePersonalDeadlineSchema`/`UpdatePersonalDeadlineSchema`, codici `personal_deadline.*` usati coerentemente tra i task.

## Review gates
1. `pnpm -r typecheck` (pre-push, unico gate locale obbligatorio).
2. Unit mirato `@garageos/api test:unit` dopo Task 5 (FakePrisma).
3. **Final whole-branch `/code-review high`** sull'intero branch (gate load-bearing).
4. CI full matrix (`gh pr checks --watch`) — unico gate per RLS reale, CHECK, integration Postgres.
5. Niente smoke device in PR1 (nessuna UI); lo smoke è BLOCKER in PR3.

# Rimozione Sedi (officina = sede unica) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminare il concetto multi-sede da GarageOS. L'officina diventa un'entità con un solo indirizzo portato dal `Tenant`; si rimuovono CRUD sedi, filtro cross-sede (BR-205), assegnazione meccanico→sede (BR-204), e si **elimina la tabella `locations`** con tutte le FK `location_id`.

**Architecture:** Opzione B (indirizzo nel Tenant — campi già esistenti, serve solo backfill). Migration distruttiva fasata **expand → migrate → contract** in 1 PR / 2 file SQL + runbook operatore. In dev/CI entrambe le migration si applicano e `schema.prisma` riflette lo stato **finale** (Location assente, `location_id` assenti) → tutto il codice API deve girare contro lo schema finale. Il phasing serve solo al rollout prod (container Lambda warm col vecchio codice).

**Spec:** `docs/superpowers/specs/2026-06-30-sede-unica-design.md`

**Tech Stack:** Prisma 7 (adapter PrismaPg), Fastify, React+Vite (web/admin-web), Postgres+RLS (Supabase), migrazioni operator-driven con `DIRECT_URL`.

**LOC budget:** target prevalentemente **deletion**; hard PR limit 1500. Il controller controlla la LOC cumulativa dopo ogni task; **halt + ask all'~80%** (1200). Se la slice sfora → size-exception da approvare con l'utente (come Slice 2/3) oppure split expand-PR / contract-PR.

## Global Constraints

- **Mai droppare colonne/tabelle senza approvazione** (CLAUDE.md #8) — **approvato dall'utente per questa slice il 2026-06-30**. Pattern expand→migrate→contract obbligatorio.
- **Migrazioni operator-driven**: `deploy.yml` ship solo CDK; le migration si eseguono a mano con `DIRECT_URL`. Il runbook va in APPENDICE_C.
- **Commenti in inglese**; stringhe user-facing in **italiano** (qui per lo più si rimuovono stringhe, non se ne aggiungono).
- **Conventional Commits**, summary ≤ 72 char; scope ∈ {api, web, admin-web, database, infra, shared, e2e, deps} oppure `docs:` senza scope (commitlint linta **tutti** i commit del PR).
- **Local gate** = `pnpm -r typecheck` (pre-push). Per task che toccano route handler: `pnpm --filter @garageos/api test:unit` mirato (typecheck non cattura FakePrisma rotti). Node 22 via fnm (il sistema ha Node 23 che Prisma rifiuta).
- **Final gate** = `/code-review ultra` (deciso dall'utente). **Smoke prod BLOCKER** (UI + esecuzione runbook migration).

## Deviations from spec (verified against actual code — the code wins)

1. **L'indirizzo è GIÀ sul `Tenant`.** `schema.prisma:223-241` — Tenant ha `addressLine, city, province, postalCode, phone, email` (tutti nullable) e `PATCH /v1/tenants/me` (`tenants-update.ts:25-58`) li modifica già. **Nessuna nuova colonna indirizzo da aggiungere** — la migration A fa solo backfill dove NULL. Lo spec lo nota; ribadito qui perché è il fatto che riduce di più lo scope.
2. **`Location.latitude/longitude/country/name` inutilizzati** — grep `packages/` conferma lat/long letti solo da schema + migration init (i match `avatarCanvas`/`AvatarCropDialog` sono crop immagine, non geo). Droppati senza backfill.
3. **Lista error code `location.*` più ampia dello spec.** Da `APPENDICE_G` (righe 221-239, 985-988, 1044-1048): `location.not_found`, `location.not_in_tenant`, `location.cannot_remove_primary`, `location.cannot_disable_last`, `tenants.me.locations.not_found`, `tenants.me.locations.update.empty_body`, `tenants.me.locations.update.unknown_field`, `tenants.me.locations.cannot_unset_primary`, `tenants.me.locations.cannot_delete_primary`, `tenants.me.locations.has_active_users`, `user.location_required_for_mechanic`, `user.location_invalid`, `user.invitation.location_invalid`. **Tutti da rimuovere** (Task 8). Anche le righe della tabella "endpoint → error codes" (427-428) per le route admin-tenant-users vanno ripulite dei codici location.

## Gotchas the implementer MUST respect (from project memory)

- **Field drift API vs DB / Prisma data XOR** — dopo aver rimosso `locationId` dagli oggetti `data:`/`select:` Prisma, `tsc` NON cattura tutti i casi; grep `locationId`/`location_id` su `packages/api/src` e `packages/api/tests` a fine task. ([[feedback_prisma_data_xor_defeats_excess_property]], [[feedback_field_name_drift_api_vs_db]])
- **Handler change breaks unit mock** — ogni task che tocca un route handler: `pnpm --filter @garageos/api test:unit` mirato (FakePrisma + `.mock.calls`). ([[feedback_handler_change_breaks_unit_mock]])
- **Middleware test cascade** — rimuovere `request.locationId` da `tenant-context.ts` rompe i test che lo asseriscono; enumerare la cascata prima. ([[feedback_t7_test_cascade]])
- **Per-task review misses production cascade** — i reviewer per-task vedono solo il diff del task; il final ultra è il gate olistico. ([[feedback_per_task_review_misses_production_cascade]])
- **TRUNCATE/cascade & RLS** — `DROP TABLE locations CASCADE` rimuove FK, indici, policy RLS e trigger `updated_at` in un colpo; verificare che non resti riferimento a `locations` in altre policy (la mappa conferma: nessuna). ([[feedback_truncate_cascade_postgres]])
- **Migrate deploy operator-driven** — note esplicite nel runbook; `migrate:deploy` con `DIRECT_URL`. ([[feedback_prisma_migrate_deploy_operator_driven]])
- **PG void/param cast** — se la migration usa funzioni, attenzione ai cast (non previsto qui, SQL DDL puro). ([[feedback_pg_void_return_prisma_adapter]])
- **Cognito fuori tx** — non rilevante (rimuoviamo scritture custom:location_id, non ne aggiungiamo). ([[feedback_cognito_call_outside_postgres_tx]])
- **Grep old method/field callsites** — dopo ogni rimozione, grep tests/ per il simbolo rimosso. ([[feedback_plan_grep_old_method_callsites]])

## Pre-flight checklist (ESEGUITA — risultati)

- [x] **Schema grep**: Location model `schema.prisma:260-287`; `location_id` FK su `interventions` (NOT NULL Restrict, 520/541), `deadlines` (NOT NULL Restrict, 657/674), `users` (nullable SetNull, 292/307), `access_logs` (nullable SetNull, 761/770), `invitations` (nullable, colonna semplice 808). `Tenant.locations` relation 243. Enum `LocationStatus` 38-41.
- [x] **RLS**: `locations_read FOR SELECT USING(true)` + `locations_write` da `20260427120000_split_interventions_attachments_rls`. Indice `uq_locations_tenant_primary` + trigger updated_at da `20260424100000_rls_triggers_checks`. **Nessun'altra policy referenzia `location_id`** (visibilità BR-205 è app-layer).
- [x] **APPENDICE_G** error code location.*: enumerati sopra (Deviation 3).
- [x] **APPENDICE_F** BR: BR-200/201/204/205 (§10, righe 822-862). BR-202/203 (super_admin) **NON** toccati.
- [x] **Endpoint da rimuovere** (APPENDICE_A): `GET/POST/PATCH/DELETE /v1/tenants/me/locations`.
- [x] **Integration tests** girano contro DB con TUTTE le migration → schema finale; il codice API deve già matchare il post-contract.

## Branch

`feat/sede-unica` (già creato; spec già committato `c3a731e`/`bb73bd9`).

---

### Task 1: Schema + migrations (expand + contract)

**Files:**
- Modify: `packages/database/prisma/schema.prisma` — rimuovi: `model Location` (260-287), enum `LocationStatus` (38-41), `Tenant.locations Location[]` (243), e i campi `locationId` + relation `location` da `User` (292,307), `Intervention` (520,541), `Deadline` (657,674), `AccessLog` (761,770), `Invitation` (808). Rimuovi le reverse-relation `locations/interventions/accessLogs/deadlines/users` dichiarate su `Location`.
- Create: `packages/database/prisma/migrations/<ts>_sede_unica_expand/migration.sql`
- Create: `packages/database/prisma/migrations/<ts>_sede_unica_contract/migration.sql`
- Test: `packages/database/tests/integration/sede-unica-backfill.test.ts` (nuovo)

**Interfaces:**
- Produces: schema Prisma finale **senza** Location/`location_id`. Tutti i task successivi assumono `prisma` client senza `location`/`locationId`.

**Contract — Migration A (expand):**
```sql
-- Backfill tenant address from the primary active location, only where the
-- tenant column is NULL (do not overwrite an address the officina already set).
UPDATE tenants t SET
  address_line = COALESCE(t.address_line, l.address_line),
  city         = COALESCE(t.city, l.city),
  province     = COALESCE(t.province, l.province),
  postal_code  = COALESCE(t.postal_code, l.postal_code),
  phone        = COALESCE(t.phone, l.phone)
FROM locations l
WHERE l.tenant_id = t.id
  AND l.deleted_at IS NULL
  AND l.is_primary = true
  AND l.status = 'active';

-- Fallback: tenants without a primary-active location, take any live location.
UPDATE tenants t SET
  address_line = COALESCE(t.address_line, l.address_line),
  city         = COALESCE(t.city, l.city),
  province     = COALESCE(t.province, l.province),
  postal_code  = COALESCE(t.postal_code, l.postal_code),
  phone        = COALESCE(t.phone, l.phone)
FROM locations l
WHERE l.tenant_id = t.id
  AND l.deleted_at IS NULL
  AND t.address_line IS NULL;

-- Drop NOT NULL so the new code can insert interventions/deadlines without it.
ALTER TABLE interventions ALTER COLUMN location_id DROP NOT NULL;
ALTER TABLE deadlines     ALTER COLUMN location_id DROP NOT NULL;
```

**Contract — Migration B (contract):**
```sql
ALTER TABLE interventions DROP COLUMN location_id;
ALTER TABLE deadlines     DROP COLUMN location_id;
ALTER TABLE users         DROP COLUMN location_id;
ALTER TABLE access_logs   DROP COLUMN location_id;
ALTER TABLE invitations   DROP COLUMN location_id;

DROP TABLE locations CASCADE;  -- removes FKs, indexes, RLS policies, updated_at trigger
DROP TYPE "LocationStatus";
```

**Test cases (integration, real Postgres — TDD):**
1. **Backfill da primary**: seed un tenant con address NULL + una location `is_primary=true, status=active` con indirizzo X → dopo migration, `tenant.addressLine == X` ecc. *(Nota: l'integration test gira contro lo schema **finale**; per testare il backfill serve un test che applichi solo migration A o che esegua l'UPDATE come funzione estratta. Strategia: estrarre l'SQL di backfill in uno script riusabile e testarlo su un fixture, oppure verificare il backfill con un test che inserisce via SQL grezzo prima del DROP. Decidere in implementazione; se non praticabile a basso costo, coprire il backfill nel **runbook smoke prod** e lasciare un test strutturale sul fatto che `locations` non esiste più.)*
2. **Non-overwrite**: tenant con address già valorizzato (Y) + location con address X → resta Y.
3. **Schema finale**: `SELECT to_regclass('public.locations')` IS NULL; `location_id` assente da interventions/deadlines (query information_schema).

**Pre-flight per questo task:**
- Grep `schema.prisma` per ogni `location`/`locationId` residuo dopo l'edit.
- Confermare che nessun `@@index`/`@@unique` residuo referenzi `location_id`.

**Commit:** `feat(database): drop locations table, merge address into tenant`

> **Per-task review: SÌ** (migration distruttiva).

---

### Task 2: API — rimuovi filtro cross-sede (BR-205)

**Files:**
- Delete: `packages/api/src/lib/location-filter.ts`
- Modify: `packages/api/src/routes/v1/interventions-recent.ts` (56-65), `deadlines-list-tenant.ts` (40-49), `disputes-open.ts` (62-67) — rimuovi `resolveLocationFilter`, il param `location_id`, e lo spread `...(effectiveLocationId ? { locationId } : {})` dalle where Prisma.
- Test: i test di queste route che asseriscono il filtro per-sede.

**Interfaces:**
- Produces: query interventi/scadenze/dispute ritornano **tutti** i record del tenant (scope solo `tenantId` via RLS + app-layer).

**Behavioral contract:**
- Un meccanico ora vede **tutti** gli interventi/scadenze del tenant (rilassamento BR-205, intenzionale). Tenant isolation invariato.

**Test cases (TDD red→green, sostituiscono i vecchi BR-205):**
1. Meccanico autenticato → `GET /v1/interventions/recent` ritorna interventi di tutto il tenant (incluso uno "di un'altra sede" che prima non vedeva — ora la nozione di sede non esiste).
2. **Negativo tenant isolation**: un altro tenant non vede questi interventi (invariato).
3. Rimuovere/aggiornare i test che passavano `location_id` come query param.

**Pre-flight:** grep `location-filter`, `resolveLocationFilter`, `effectiveLocationId` su `packages/api`.

**Commit:** `refactor(api): remove cross-location visibility filter (BR-205)`

---

### Task 3: API — rimuovi endpoint CRUD sedi

**Files:**
- Delete: `packages/api/src/routes/v1/tenants-locations-write.ts`, `packages/api/src/routes/v1/tenants-locations-list.ts`
- Modify: il file di registrazione route (grep dove sono `app.register`-ati) per togliere la registrazione.
- Delete: i test di queste route (`packages/api/tests/**` che le coprono).

**Behavioral contract:** `GET/POST/PATCH/DELETE /v1/tenants/me/locations` non esistono più → 404 route.

**Test cases:**
1. Rimuovere le suite location-CRUD (non sostituire — feature eliminata).
2. (Opzionale) un test che `GET /v1/tenants/me/locations` → 404 per documentare la rimozione.

**Pre-flight:** grep `tenants/me/locations`, `tenants-locations` su `packages/api`.

**Commit:** `refactor(api): remove location CRUD endpoints (F-OFF-003)`

---

### Task 4: API — rimuovi `locationId` da user management, inviti, DTO

**Files:**
- Modify: `packages/api/src/lib/user-management/update-user.ts` (44-200) — rimuovi validazione/default/audit `locationId` e il default-meccanico→primary (BR-204).
- Modify: `packages/api/src/routes/v1/users-invitations-create.ts` (72,154-156), `admin-tenant-users.ts` (180-211), `admin-tenant-users-invitations.ts` (180-211), `users-admin-update.ts`, `users-admin-reactivate.ts` — rimuovi `locationId` dal body schema, il default-meccanico, le validazioni `user.location_*`.
- Modify: `packages/api/src/lib/invitation-creation.ts` (29,61), `routes/v1/invitations-public-accept.ts` (140,214) — niente `locationId` portato sull'utente creato.
- Modify: DTO `packages/api/src/lib/dtos/user-me.ts`, `user-admin.ts`, `invitation.ts` — rimuovi campo `locationId`.
- Test: suite user-management, inviti, accept — rimuovi gli scenari `user.location_required_for_mechanic` / `user.location_invalid` / `user.invitation.location_invalid` e i campi `locationId`.

**Behavioral contract:**
- Invito/aggiornamento meccanico **non richiede più una sede**. Il body con `locationId` → ora "unknown field" (422) oppure semplicemente ignorato — **decidere: rimuoverlo dallo schema `.strict()` fa scattare `unknown_field`**; preferito rimuoverlo dallo schema così i client che lo inviano ricevono l'errore di campo non riconosciuto (segnala il drift). Documentare la scelta nel commit.
- BR-204 non più applicata.

**Test cases:**
1. Invito meccanico **senza** `locationId` → 201/200 (prima richiedeva la sede).
2. PATCH utente meccanico senza `locationId` → ok.
3. Le risposte DTO non contengono più `locationId`.
4. (Se schema `.strict()`) body con `locationId` → 422 unknown_field.

**Pre-flight:** grep `locationId` su `packages/api/src/lib`, `routes/v1/users*`, `routes/v1/admin-tenant-users*`, `routes/v1/invitations*`, `lib/dtos`. Grep `tests/` per `location_required_for_mechanic`, `location_invalid`.

**Commit:** `refactor(api): drop location assignment from users and invitations (BR-204)`

> **Per-task review: opzionale** (tocca superficie utenti/inviti; coperto dal final ultra).

---

### Task 5: API — rimuovi stamping `locationId` da interventi/scadenze/access-log, middleware, Cognito, create-tenant

**Files:**
- Modify: `packages/api/src/routes/v1/interventions.ts` (88-299), `interventions-update.ts`, `interventions-cancel.ts`, `interventions-dispute-response.ts` — non timbrare/scopare più `location_id`; rimuovere il requisito `user.locationId` per creare un intervento.
- Modify: `packages/api/src/routes/v1/deadlines-create.ts` (57-116), `deadlines-complete.ts`, `lib/deadlines/recurrence.ts` (14-114) — niente `location_id`.
- Modify: `packages/api/src/lib/access-log.ts` (38-113) — rimuovi `locationId` opzionale.
- Modify: `packages/api/src/middleware/tenant-context.ts` (31-71) — non leggere `custom:location_id`; rimuovi `request.locationId` (e la sua dichiarazione di tipo Fastify).
- Modify: `packages/api/src/lib/cognito.ts` (170-258) — non scrivere/azzerare `custom:location_id`. **Lasciare l'attributo nel pool inerte** (nessuna pool migration).
- Modify: `packages/api/src/routes/v1/admin-tenants-create.ts` (146-162) — **non creare più la "Sede principale"**; il tenant nasce con indirizzo NULL sui propri campi (l'officina lo compila poi dal tab Officina).
- Test: suite interventi/scadenze/create-tenant/tenant-context.

**Interfaces:**
- Consumes: schema senza `location_id` (Task 1).
- Produces: create intervento/scadenza accettano payload **senza** location; `request.locationId` non esiste più.

**Behavioral contract:**
- `POST /v1/interventions` non richiede una sede dell'utente; status/RFC7807 invariati per il resto.
- `admin-tenants-create` crea solo Tenant + Invitation super_admin (niente row locations).
- `tenant-context` non popola `request.locationId`.

**Test cases:**
1. Create intervento da meccanico **senza** location → 201 (prima 422/500 se `user.locationId` mancante).
2. Create scadenza senza location → ok.
3. `admin-tenants-create`: il tenant creato non ha alcuna location associata (e la query non fallisce).
4. `tenant-context`: rimuovere/aggiornare i test che asserivano `request.locationId` (cascade — enumerare prima).

**Pre-flight:** grep `locationId`, `location_id`, `custom:location_id`, `request.locationId` su `packages/api/src` e `packages/api/tests`. Run `pnpm --filter @garageos/api test:unit`.

**Commit:** `refactor(api): stop stamping location on interventions/deadlines`

> **Per-task review: SÌ** (interventi + visibilità + Cognito, security-adjacent).

---

### Task 6: Web officine — rimuovi feature sedi

**Files:**
- Delete: `packages/web/src/pages/LocationManagement.tsx`, `components/locations/LocationFormDialog.tsx`, `queries/locations.ts`, `lib/validators/location.ts`, e **l'intera** `packages/web/src/location-filter/` (context, `LocationSelector`, hook, tipi).
- Modify: `pages/Settings.tsx` (104,106,153-157) — rimuovi tab "Sedi" + import + route.
- Modify: `App.tsx:58` — rimuovi la route `/settings/locations`.
- Modify: `components/layout/TopBar.tsx:123`, `components/layout/AppLayout.tsx:15-37` — rimuovi `LocationSelector` e il provider del filtro.
- Modify: `components/users/InviteUserDialog.tsx` (205-225), `EditUserDialog.tsx`, `ReactivateSection.tsx` — rimuovi il select "Sede" (meccanico non richiede più sede).
- Modify: query `queries/disputesOpen.ts`, `deadlinesList.ts`, `deadlinesUpcoming.ts`, `interventionsRecent.ts` — rimuovi il param `location_id`.
- Test: rimuovi i test delle feature eliminate; aggiungi/adatta 2-3 test Tier-2 su `TenantForm` (salva indirizzo) e assenza tab Sedi.

**Behavioral contract:**
- Indirizzo officina si modifica dal tab **"Officina"** esistente (`TenantForm`). Nessuna nuova schermata.
- Invito meccanico senza campo Sede.

**Test cases (Tier-2):**
1. `Settings` non mostra il tab "Sedi".
2. `InviteUserDialog` non mostra il select "Sede"; invito meccanico va a buon fine senza.
3. `TenantForm` salva i campi indirizzo (happy path) — già coperto se esiste; non aggiungere rendering puro.

**Pre-flight:** grep `location` (case-insensitive) su `packages/web/src` per residui (import morti, query key). Grep `LocationSelector`, `useLocationFilter`, `location_id`.

**Commit:** `refactor(web): remove multi-location UI (sedi tab, filter, assignment)`

> **Smoke-facing**: incluso nel runbook smoke finale.

---

### Task 7: admin-web — rimuovi riferimenti location

**Files:**
- Modify: `packages/admin-web/src/lib/tenant-detail-types.ts:30` — rimuovi `locationId` dal tipo utente.
- Modify: la UI `TenantDetail` (tabella utenti) — rimuovi ogni colonna/riferimento a sede.
- Test: adatta i test del detail se asseriscono `locationId`.

**Behavioral contract:** admin-web non mostra/usa più la sede degli utenti.

**Pre-flight:** grep `location` su `packages/admin-web/src`.

**Commit:** `refactor(admin-web): remove location references from tenant detail`

---

### Task 8: Docs + scripts + runbook

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` — annota **BR-200/201/204/205 come superseded** ("sede-unica, 2026-06-30"); documenta il rilassamento di visibilità (meccanico vede tutto il tenant). **Non** toccare BR-202/203.
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` — rimuovi tutte le righe `location.*` / `tenants.me.locations.*` / `user.location_*` / `user.invitation.location_invalid` (righe 221-239, 985-988, 1044-1048) e ripulisci le righe endpoint→codes (427-428).
- Modify: `docs/APPENDICE_A_API.md` — rimuovi gli endpoint `/v1/tenants/me/locations`.
- Modify: `docs/APPENDICE_B_DATABASE.md` — aggiorna lo schema (Location rimossa, `location_id` rimossi, indirizzo su Tenant come unica fonte).
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md` — **aggiungi il runbook operatore migration** (vedi sotto).
- Modify: gli spec `docs/superpowers/specs/2026-06-01-F-OFF-003-location-crud-design.md` e `2026-06-01-F-OFF-503-location-filter-design.md` — header "SUPERSEDED by sede-unica 2026-06-30".
- Modify: `scripts/rebuild-tenants.mjs` (27,37,77-118) — non creare la row `locations` né settare `users.location_id`; settare l'indirizzo sul Tenant.

**Runbook operatore (APPENDICE_C) — contenuto:**
```
1. Snapshot DB prod (backup point-in-time o pg_dump) — la migration B è irreversibile.
2. Applica migration A (expand):
   DIRECT_URL=... pnpm --filter @garageos/database exec prisma migrate deploy  # applica solo le pending
   (oppure psql del solo file A se si vuole controllo fine)
3. Deploy del codice (auto-deploy CDK su merge, oppure cold-start refresh:
   aws lambda update-function-configuration --function-name garageos-api --description "<bump>").
4. Smoke: /health = database:ok; crea un intervento senza sede; verifica indirizzo officina dal tab Officina.
5. Applica migration B (contract): prisma migrate deploy (la seconda pending).
6. Smoke finale: to_regclass('public.locations') IS NULL; app officine funzionante.
```
> Nota: in dev/CI entrambe le migration si applicano insieme (schema finale). Il phasing A→deploy→B è SOLO per il rollout prod.

**Pre-flight:** grep `BR-200`, `BR-201`, `BR-204`, `BR-205` su `docs/` e `packages/` per i commenti che le citano (aggiornare i comment header che restano). Grep `F-OFF-003`, `F-OFF-503`.

**Commit:** `docs: mark BR-200/201/204/205 superseded, remove location codes`

---

## Self-Review (eseguita)

**Spec coverage:** §3 modello dati → Task 1. §4 API → Task 2/3/4/5. §5 Web → Task 6/7. §6 BR/visibilità/error-code → Task 8 (+ test visibilità in Task 2/5). §7 Cognito → Task 5. §8 scripts → Task 8. §9 testing → distribuito. §10 processo → header + per-task review note. Runbook → Task 8. **Nessun gap.**

**Placeholder scan:** l'unico punto "decidere in implementazione" è la **strategia di test del backfill** (Task 1 test case 1) — esplicitato come scelta vincolata con fallback (runbook smoke), non un TODO aperto. Tutto il resto ha file:line e contratto.

**Type/symbol consistency:** simboli rimossi coerenti tra task (`resolveLocationFilter`/`location-filter` Task 2; `request.locationId` dichiarato e rimosso in Task 5; `locationId` DTO Task 4). Ordine: Task 1 (schema) precede tutti i task che assumono lo schema finale.

**Ordine di esecuzione:** 1 → (2,3,4,5 in qualsiasi ordine ma tutti dopo 1; 5 dopo 2 per coerenza visibilità) → 6 → 7 → 8. Consigliato sequenziale 1..8.

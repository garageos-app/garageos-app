# PR-4 (arco checklist) — API officina: tipi visibili + selezioni checklist + rimozione title (write/detail) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare il dominio "intervento officina" al nuovo modello a checklist. `GET /v1/intervention-types` restituisce solo i tipi **visibili** al tenant (esclusioni PR-3 applicate, tipi senza ≥1 voce visibile omessi — BR-305), ciascuno con l'array delle voci checklist visibili. `POST /v1/vehicles/:id/interventions` e `PATCH /v1/interventions/:id` accettano `checklistItemIds` (≥1, BR-300), validano appartenenza (BR-301) e visibilità/attività (BR-302), salvano le selezioni con `label_snapshot` (BR-303) e **rimuovono `title`** da input e persistenza (BR-308). `GET /v1/interventions/:id` (dettaglio officina) rimuove `title` ed espone le voci lette dallo snapshot. La colonna `title` **resta** nel DB (il DROP arriva dopo PR-7).

**Architecture:** Modifica in-place di 4 route esistenti + le 2 Zod condivise in `@garageos/database`. Le selezioni sono un record strutturato in `intervention_checklist_selections` (creato in PR-DB #244): `tenant_id` NOT NULL, `checklist_item_id` nullable con `onDelete SetNull`, `label_snapshot` congelato al salvataggio. RLS `selections_read = USING(true)` (permissivo, mirror `interventions`), `selections_insert/update/delete = tenant_id = current_tenant_id()` → le scritture avvengono dentro `app.withContext({ tenantId })` (già usato dalle route). Un serializer puro condiviso (`serializeChecklistItems`) in `lib/intervention-shared.ts` centralizza la lettura dallo snapshot per detail e patch-reload. La validazione BR-301/302 è una `findMany` con `where` composto (`interventionTypeId` + `active`) + un check esclusioni, dedotta dal Set degli id richiesti. Nessuna migration / schema change (le tabelle esistono).

**Spec:** `docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md` (§ "Officina web", § "Read", D1/D4/D8/D9, BR-300..303/305/308, error codes `intervention.creation.checklist_*`).

**LOC budget:** target ~1000 net (validators ~60, types GET+test ~230, create+test ~290, patch+test ~270, detail+test ~130, docs ~120), hard PR limit 1500. Il controller verifica la LOC cumulativa dopo ogni task; **halt+ask a ~80% (1200)**. Se sfora: Task 5 (detail) è il candidato più isolato da spostare in un follow-up. [[feedback_mid_execution_loc_checkpoint]]

---

## Deviations from spec (verified against actual code — the code wins)

1. **PR-4 NON droppa la colonna `title` e NON tocca PDF/mobile.** Scope confermato dall'owner (2026-07-03): PR-4 = `intervention-types` GET + create + patch + **detail officina** + Zod condivise. La rimozione `title` da PDF (PR-6), mobile-facing (`me-interventions`, `customer-intervention-detail`, `vehicles-timeline`, `me-vehicles-export-pdf`) e il DROP colonna restano DOPO PR-7 (spec §Rischi: "nessun consumatore rimane dopo i PR API/web/mobile/PDF"). Quei lettori continuano a `select` `title` dalla colonna ancora presente → restano verdi, nessun cascade. [[feedback_checkpoint_slice_vs_approved_spec_deferral]]
2. **La rotta POST è `POST /v1/vehicles/:id/interventions`** (non `/v1/interventions` come abbrevia la spec) — verificato `interventions.ts:69`. PATCH è `/v1/interventions/:id` (`interventions-update.ts:87`).
3. **`title: null` passato all'evento notifica, template invariati.** Il push `intervention.created` usa `vehicle.model` + `interventionTypeName` (non title); l'email usa un `titleBlock` condizionale (`intervention-created.ts:34,52`) che degrada a stringa vuota su null. Verificato: `push-templates.ts` non legge `event.intervention.title`. → NON tocchiamo `InterventionForEmail`, `intervention-created.ts`, `push-templates.ts`, né la route `interventions-cancel.ts` (che continua a passare il `title` reale dalla colonna esistente). Poiché la persistenza title viene rimossa, ogni nuovo intervento ha `title = NULL` a DB: passare `null` è semanticamente esatto, non un hack.
4. **`GET /v1/intervention-types` restituisce solo tipi GLOBALI attivi** (`tenantId: null, active: true`) con le voci attive, applicando esclusioni + BR-305. I tipi tenant-custom (`tenantId` valorizzato) **non hanno voci checklist** (le voci sono globali-only, D10) → 0 voci visibili → omessi da BR-305 senza codice speciale. Coerente con la migrazione a catalogo globale. Il campo `custom` resta nella response per retro-compat shape (sempre `false`).
5. **BR-300 (checklist obbligatoria) è validata handler-side, non con Zod `.min(1)`.** Motivo: serve il codice dedicato `intervention.creation.checklist_required` (400), non un generico `VALIDATION_ERROR`. Zod tiene `z.array(z.uuid())` (create: richiesto; patch: `.optional()`); l'handler dedup + controlla `length >= 1`. [[feedback_zod_default_under_partial_defeats_empty_body]]
6. **PATCH: cambiare `interventionTypeId` richiede `checklistItemIds` nella stessa richiesta.** Se il tipo cambia ma le voci non sono ripresentate, le selezioni ritenute apparterrebbero al vecchio tipo (BR-301 violata). Guardia: `interventionTypeId` presente e ≠ esistente **&&** `checklistItemIds === undefined` → `400 intervention.creation.checklist_required` ("Cambiando il tipo di intervento devi riselezionare le voci checklist."). Non è nella spec letterale ma è l'unico modo per non lasciare selezioni orfane del tipo.
7. **PATCH replace: le selezioni con `checklist_item_id = NULL`** (voce eliminata dal catalogo, snapshot sopravvissuto) **vengono rimosse** quando l'utente invia `checklistItemIds` (non sono re-selezionabili, non hanno id). Un edit senza `checklistItemIds` le lascia intatte. Documentato nel contratto Task 4.
8. **Transient web PR-4→PR-5 (accettato):** il dialog web (`EditInterventionDialog.tsx:97`) invia `title` nel body PATCH **solo se cambiato** dall'originale. Con `UpdateInterventionSchema` `.strict()` e `title` rimosso, un utente che modifica attivamente il campo Titolo nella finestra tra il deploy di PR-4 e PR-5 riceverebbe `400 VALIDATION_ERROR`. Accettabile: pre-launch, dati di test in via di azzeramento (D5), PR-5 rimuove il campo dal form subito dopo. Da NON smoke-testare (edit del titolo) tra i due deploy. Flag per il final review.

## Gotchas the implementer MUST respect (from project memory)

- **`withContext({ tenantId })`, mai `withContext({})`** — le scritture selezioni richiedono `tenant_id = current_tenant_id()`; context vuoto le bloccherebbe. [[feedback_withcontext_empty_blocks_rls_writes]]
- **Grep `schema.prisma` per OGNI campo `select`/`data`**: i nomi Prisma sono `labelSnapshot`, `sortOrderSnapshot`, `checklistItemId`, `interventionId`, `tenantId` (NON snake_case nel client). `InterventionChecklistSelection` PK è `id`, unique `(interventionId, checklistItemId)`. Il typecheck NON cattura campi inesistenti in `data`/`select` né chiavi `where` sconosciute (droppate silenziosamente → tutte le righe). [[feedback_prisma_loose_where_silently_drops_unknown_keys]] [[feedback_verify_plan_against_schema]]
- **`checklistItemIds` NON è una colonna**: gestirlo separatamente dalle `EDITABLE_KEYS`/`buildChangesJson` del PATCH (che pilotano `intervention.update({data})`). NON aggiungerlo al `data` scalare o Prisma XOR lo accetterebbe come relazione malformata. [[feedback_prisma_data_xor_defeats_excess_property]]
- **Field rename cascade → grep test**: rimuovendo `title` da `CreateInterventionSchema`/`UpdateInterventionSchema` e dai `select` create/patch/detail, aggiornare i test che asseriscono `title` **solo** nei file in scope (`interventions.test.ts` unit, `interventions-post/patch/detail.test.ts` integration, `helpers.ts` se costruisce interventi via route con title). NON toccare i test dei lettori fuori scope (me-interventions, timeline, pdf, cancel, recent) — la colonna resta, i loro test restano verdi. [[feedback_schema_rename_cascade_extends_to_production_code]] [[feedback_handler_change_breaks_unit_mock]]
- **RLS-as-404 sul detail**: `interventions_read` è permissivo (cross-tenant) → il detail usa `findFirst({ id })` + null check (già così, `interventions-detail.ts:64-70`). Le selezioni si leggono via relazione `checklistSelections` sulla stessa riga (nessun secondo scoping). [[feedback_rls_split_changes_endpoint_semantics]]
- **Integration helper deve rispecchiare il wire reale** (content-type json + body con `checklistItemIds`). Gli integration RLS/contract girano **solo su CI** (Docker freeza Windows) — scriverli, NON eseguirli in locale. Il gate locale è `pnpm -r typecheck`; per le route, opzionale `pnpm --filter @garageos/api test:unit` (typecheck non cattura i FakePrisma rotti). [[feedback_skip_local_integration_tests]] [[feedback_integration_test_mirror_frontend_wire]] [[feedback_route_handler_change_run_targeted_unit]]
- **Grep `APPENDICE_G` prima di inventare error code** — fatto: `intervention.creation.checklist_required` / `intervention.creation.checklist_item_invalid` NON esistono (la famiglia `intervention.creation.*` sì, righe 285-290). [[feedback_preflight_must_grep_appendice_g_codes]]
- **BR-300/301/302/303/305/308 hanno già header RISERVATI in `APPENDICE_F`** (righe 1198/1201/1204/1207/1227/1265) — compilare i corpi, NON introdurre nuovi numeri. BR-304/306/307 già compilate (PR-2/PR-3): non toccarle. [[feedback_br_number_collision_in_doc]]
- **`@updatedAt` / raw SQL**: qui usiamo il client Prisma (`createMany`/`deleteMany`), non raw SQL — nessun `updated_at` manuale richiesto (le selezioni non hanno `updated_at`).
- **Nessun `console.log`, commenti header in inglese, stringhe utente in italiano via messaggi business.** [[feedback_middleware_throw_fastifyerror_not_reply_send]]

## Branch

`feat/officina-intervention-checklist-api` (da `main` aggiornato).

---

## Task 1: Schema condivise — `checklistItemIds` in, `title` out

**Files:**
- Modify: `packages/database/src/validators/intervention.ts` (`CreateInterventionSchema`, `UpdateInterventionSchema`)
- Test: `packages/database/tests/unit/validators/intervention.test.ts`

**Interfaces:**
- Consumes: nulla (foundazione).
- Produces (per Task 3/4):
  - `CreateInterventionSchema`: rimosso `title`; aggiunto `checklistItemIds: z.array(z.uuid())` (**richiesto**, può essere vuoto a livello Zod — BR-300 handler-side). Restano `interventionTypeId, interventionDate, odometerKm, description, partsReplaced, internalNotes, createDeadline, forceKmDecrease`.
  - `UpdateInterventionSchema`: rimosso `title`; aggiunto `checklistItemIds: z.array(z.uuid()).optional()`. Il `.refine` "almeno un campo modificabile" include ora `checklistItemIds`. Campi: `interventionTypeId?, description?, partsReplaced?, internalNotes?, checklistItemIds?, reason?`. Resta `.strict()`.
  - Tipi inferiti `CreateInterventionInput` / `UpdateInterventionInput` si aggiornano automaticamente.

**Contratto:** puramente di forma. `CreateInterventionSchema` NON è `.strict()` (invariato) → un `title` residuo dal client viene silenziosamente ignorato (input rimosso). `UpdateInterventionSchema` È `.strict()` → un `title` residuo viene rifiutato (400) — vedi Deviation #8.

- [ ] **Step 1: Aggiorna i test (RED).** In `intervention.test.ts`: rimuovi/adatta i casi che asseriscono `title` accettato nei due schema; aggiungi: (a) create con `checklistItemIds: []` **parsa** (BR-300 è handler-side, non Zod); (b) create con `checklistItemIds: ['<uuid>']` parsa e il valore è presente; (c) create con `checklistItemIds` mancante → parse **fallisce** (campo richiesto); (d) update `.strict()` con `title` → parse fallisce; (e) update con solo `checklistItemIds` soddisfa il `.refine`; (f) update `{}` (nessun campo) → refine fallisce.

- [ ] **Step 2: Esegui → RED.** Run: `pnpm --filter @garageos/database test:unit -t "intervention"`. Atteso: FAIL.

- [ ] **Step 3: Implementa** la modifica dei due schema in `validators/intervention.ts` (rimuovi `title:` da entrambi; aggiungi `checklistItemIds`; estendi il `.refine` dell'update; aggiorna il commento header BR-065/BR-308).

- [ ] **Step 4: Esegui → GREEN.** `pnpm --filter @garageos/database test:unit -t "intervention"`. Atteso: PASS.

- [ ] **Step 5: `pnpm -r typecheck`** → verde (conferma che nessun consumatore in `packages/web` importa gli schema condivisi: il web ha schema locali).

- [ ] **Step 6: Commit.**
```bash
git add packages/database/src/validators/intervention.ts \
        packages/database/tests/unit/validators/intervention.test.ts
git commit -m "feat(database): checklistItemIds on intervention schemas, drop title"
```
*(Summary 61 char ✓ ≤72.)*

---

## Task 2: `GET /v1/intervention-types` — tipi visibili + voci checklist (BR-305)

**Files:**
- Modify: `packages/api/src/routes/v1/intervention-types.ts`
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (compila **BR-305**)
- Modify: `docs/APPENDICE_A_API.md` (aggiorna la shape di `GET /v1/intervention-types`)
- Test: `packages/api/tests/integration/intervention-types.test.ts` (crea se assente; grep prima)

**Interfaces:**
- Consumes: modelli `InterventionType`, `InterventionChecklistItem`, `TenantInterventionTypeExclusion`, `TenantChecklistItemExclusion` (PR-DB #244). Middleware `requireAuth, requireOfficinaPool, tenantContext`. `app.withContext({ tenantId })`.
- Produces (per PR-5 web — wire shape esatto):
  ```jsonc
  {
    "data": [
      {
        "id": "uuid", "code": "MECCANICO", "nameIt": "Intervento Meccanico",
        "description": "…|null", "icon": "…|null",
        "suggestsDeadline": true, "defaultDeadlineMonths": 12, "defaultDeadlineKm": 15000,
        "custom": false,
        "checklistItems": [
          { "id": "uuid", "code": "OLIO", "nameIt": "Cambio olio", "sortOrder": 0 }
        ]
      }
    ]
  }
  ```
  Tipi ordinati `nameIt asc`; voci `sortOrder asc, nameIt asc`. Solo tipi con `checklistItems.length >= 1` dopo le esclusioni.

**Contratto comportamentale (BR-305):**
- `preHandler: [requireAuth, requireOfficinaPool, tenantContext]` (invariato).
- In `withContext({ tenantId })`:
  1. Carica i tipi globali attivi con le voci attive:
     `interventionType.findMany({ where: { tenantId: null, active: true }, orderBy: [{ nameIt: 'asc' }], select: { id, code, nameIt, description, icon, suggestsDeadline, defaultDeadlineMonths, defaultDeadlineKm, checklistItems: { where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }], select: { id, code, nameIt, sortOrder } } } })`.
  2. Carica le esclusioni del tenant: `tenantInterventionTypeExclusion.findMany({ where: { tenantId }, select: { interventionTypeId: true } })` → `excludedTypeIds: Set`; `tenantChecklistItemExclusion.findMany({ where: { tenantId }, select: { checklistItemId: true } })` → `excludedItemIds: Set`.
  3. Per ciascun tipo: se `excludedTypeIds.has(type.id)` → **scarta** il tipo. Altrimenti filtra `checklistItems` togliendo quelle in `excludedItemIds`. Se le voci residue sono 0 → **scarta** il tipo (BR-305).
  4. Serializza i tipi superstiti con `custom: false` (retro-compat) e `checklistItems` filtrate.
- Header English: cita `// BR-305` (tipo offerto solo con ≥1 voce visibile) e `// BR-304` (modello opt-out: visibile salvo esclusione). Aggiorna il commento esistente sul perché RLS è permissiva.

- [ ] **Step 1: Scrivi i test integration (RED)** in `intervention-types.test.ts`. Scaffolding: mirror da un integration esistente della stessa area (`interventions-post.test.ts` per `buildTestServer`/`signTestToken`/`pgAdmin`/seed tipo+voci+tenant). Casi (Tier 1):
  1. **Happy path**: tenant + 1 tipo globale attivo con 2 voci attive, nessuna esclusione → `200`, `data.length === 1`, `checklistItems.length === 2`, ordinate per `sortOrder`, `custom === false`.
  2. **Esclusione voce**: inserisci via `pgAdmin` 1 riga `tenant_checklist_item_exclusions` (una delle 2 voci) → il tipo compare con 1 sola voce.
  3. **BR-305 — tipo con tutte le voci escluse**: escludi entrambe le voci del tipo → il tipo **NON compare** (`data.length === 0`).
  4. **BR-305 — tipo escluso a livello tipo**: 1 riga `tenant_intervention_type_exclusions` → il tipo non compare anche se ha voci.
  5. **Tipo inattivo / voce inattiva** non compaiono (seed `active: false`).
  6. **Isolamento tenant**: esclusioni seed su tenant B → GET tenant A le ignora (tipo/voci tutte visibili per A).

- [ ] **Step 2: Esegui → RED** (CI; locale sconsigliato). Run atteso su CI: `pnpm --filter @garageos/api test:integration -t "intervention-types"`. Annota se saltato in locale.

- [ ] **Step 3: Implementa** la rewrite di `intervention-types.ts` secondo il contratto.

- [ ] **Step 4: Docs.**
  - `APPENDICE_F` **BR-305**: compila — un tipo è offerto all'officina in `GET /v1/intervention-types` solo se, dopo l'applicazione delle esclusioni per-tenant (BR-304), ha ≥1 voce checklist attiva e non esclusa; garantisce che il vincolo BR-300 (≥1 voce) sia sempre soddisfacibile. Storage esclusioni: `tenant_intervention_type_exclusions` / `tenant_checklist_item_exclusions`.
  - `APPENDICE_A`: aggiorna la sezione `GET /v1/intervention-types` con la nuova response (aggiunta `checklistItems`, semantica "solo visibili", `custom` retained).

- [ ] **Step 5: `pnpm -r typecheck`** → verde.

- [ ] **Step 6: Esegui → GREEN** (CI o mirato). Atteso: PASS.

- [ ] **Step 7: Commit.**
```bash
git add packages/api/src/routes/v1/intervention-types.ts \
        packages/api/tests/integration/intervention-types.test.ts \
        docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md
git commit -m "feat(api): intervention-types with visible checklist items (BR-305)"
```
*(Summary 63 char ✓ ≤72.)*

---

## Task 3: `POST /v1/vehicles/:id/interventions` — selezioni checklist + rimozione title

**Files:**
- Modify: `packages/api/src/routes/v1/interventions.ts`
- Modify: `packages/api/src/lib/intervention-shared.ts` (aggiungi `serializeChecklistItems` + validator condiviso `validateChecklistSelection`)
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (compila **BR-300, BR-301, BR-302, BR-303**)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (registra 2 codici)
- Modify: `docs/APPENDICE_A_API.md` (aggiorna `POST` create body/response)
- Test: `packages/api/tests/integration/interventions-post.test.ts`, `packages/api/tests/unit/routes/v1/interventions.test.ts`

**Interfaces:**
- Consumes: `CreateInterventionSchema` aggiornato (Task 1). Modelli `InterventionChecklistItem`, `InterventionChecklistSelection`, `TenantChecklistItemExclusion`, `TenantInterventionTypeExclusion`.
- Produces (per Task 4/5 — helper condiviso in `intervention-shared.ts`):
  - `serializeChecklistItems(selections: { labelSnapshot: string; sortOrderSnapshot: number | null }[]): { label: string }[]` — ordina per `sortOrderSnapshot asc` (null in coda), poi `labelSnapshot asc`; ritorna `{ label }`.
  - `validateChecklistSelection(tx, { tenantId, interventionTypeId, checklistItemIds }): Promise<{ id: string; nameIt: string; sortOrder: number }[]>` — dedup ids; se `length === 0` → throw `businessError('intervention.creation.checklist_required', 400, 'Seleziona almeno una voce checklist.')`; se il tipo è escluso per il tenant (`tenantInterventionTypeExclusion.findFirst`) → throw `checklist_item_invalid` (422); carica `checklistItem.findMany({ where: { id: { in: ids }, interventionTypeId, active: true }, select: { id, nameIt, sortOrder } })`; se `found.length !== ids.length` → throw `checklist_item_invalid` (422); se qualche id è in `tenantChecklistItemExclusion` → throw `checklist_item_invalid` (422); ritorna `found`. Messaggio 422: "Una o più voci checklist non sono valide per questo tipo di intervento o non sono disponibili."
- Response create (camelCase, mirror shape esistente): l'oggetto `intervention` **perde** `title`; **acquista** `checklistItems: { label }[]` (da `serializeChecklistItems`, o costruito da `found` ordinato).

**Contratto comportamentale:**
- Il body ora è `CreateInterventionSchema` con `checklistItemIds`. All'interno della `withContext({ tenantId })` esistente, **prima** della `intervention.create`:
  - chiama `validateChecklistSelection(tx, { tenantId, interventionTypeId: body.interventionTypeId, checklistItemIds: body.checklistItemIds })` → `foundItems` (throw sui casi BR-300/301/302). Collocala **dopo** il `findUniqueOrThrow` sul tipo (che resta, 404 su id bogus) e prima/insieme alla logica km.
- `intervention.create`: rimuovi `...(body.title ? { title } : {})` dal `data` e `title: true` dal `select`. Il resto invariato.
- **Salva le selezioni** nella stessa tx, dopo la create:
  `tx.interventionChecklistSelection.createMany({ data: foundItems.map((it) => ({ interventionId: intervention.id, tenantId, checklistItemId: it.id, labelSnapshot: it.nameIt, sortOrderSnapshot: it.sortOrder })) })`. Cita `// BR-303` (snapshot congelato al salvataggio).
- Response: aggiungi `checklistItems: serializeChecklistItems(foundItems.map((it) => ({ labelSnapshot: it.nameIt, sortOrderSnapshot: it.sortOrder })))` all'oggetto `intervention` ritornato; **rimuovi** `title` dallo shape ritornato.
- **Notifica**: nel dispatch post-commit, sostituisci `title: created.title` con `title: null` (Deviation #3). Nessun'altra modifica al blocco notifica.
- Cita `// BR-300` (≥1 voce) e `// BR-308` (title rimosso da input/persistenza) nell'header.

- [ ] **Step 1: Scrivi i test (RED).**
  - Integration `interventions-post.test.ts`: (a) happy path — create con 2 `checklistItemIds` validi → `201`, `intervention.checklistItems.length === 2` ordinate, **nessun** `title` nella response; verifica via `pgAdmin` 2 righe in `intervention_checklist_selections` con `label_snapshot` = nomi voci e `tenant_id` = tenant; (b) BR-300 — `checklistItemIds: []` → `400 intervention.creation.checklist_required`, nessuna intervention creata (rollback); (c) BR-301 — id di una voce di **altro** tipo → `422 intervention.creation.checklist_item_invalid`; (d) BR-302 inattiva — voce `active:false` → `422`; (e) BR-302 esclusa — voce esclusa per il tenant (`pgAdmin` seed esclusione) → `422`; (f) BR-303 snapshot — dopo la create, rinomina la voce via `pgAdmin` (`name_it` diverso) → la selezione conserva il `label_snapshot` originale; (g) tipo escluso per tenant → `422`; (h) dedup — stesso id due volte in `checklistItemIds` → una sola selezione (unique `(intervention_id, checklist_item_id)` non viola).
  - Unit `interventions.test.ts`: adatta i casi che asseriscono `title` (rimosso dalla response); aggiungi un caso FakePrisma che verifica la `createMany` selezioni con `label_snapshot` derivato dal `nameIt` (mock `checklistItem.findMany` → thread dinamico via `mockImplementation`, non hardcoded). [[feedback_integration_test_mock_dynamic_input]]

- [ ] **Step 2: Esegui → RED.** Unit locale: `pnpm --filter @garageos/api test:unit -t "interventions"`. Integration su CI. Atteso: FAIL.

- [ ] **Step 3: Implementa** `serializeChecklistItems` + `validateChecklistSelection` in `intervention-shared.ts`, poi le modifiche a `interventions.ts`.

- [ ] **Step 4: Docs.**
  - `APPENDICE_F`: **BR-300** (≥1 voce obbligatoria, create ed edit; error `checklist_required` 400); **BR-301** (ogni voce selezionata appartiene al tipo scelto; error `checklist_item_invalid` 422); **BR-302** (voce non esclusa per il tenant e `active`; stesso 422); **BR-303** (`label_snapshot` congelato al salvataggio; l'edit ricalcola lo snapshot solo per le voci aggiunte — dettaglio in Task 4).
  - `APPENDICE_G`: aggiungi nella famiglia `intervention.creation.*` — `intervention.creation.checklist_required` | 400 | BR-300; `intervention.creation.checklist_item_invalid` | 422 | BR-301/302. Aggiorna anche l'appendice-elenco in fondo al file (righe ~914-919).
  - `APPENDICE_A`: `POST /v1/vehicles/:id/interventions` — body perde `title`, acquista `checklistItemIds: string[]`; response perde `title`, acquista `checklistItems: [{ label }]`.

- [ ] **Step 5: `pnpm -r typecheck`** → verde.

- [ ] **Step 6: Esegui → GREEN.** Unit locale PASS; integration su CI.

- [ ] **Step 7: Commit.**
```bash
git add packages/api/src/routes/v1/interventions.ts \
        packages/api/src/lib/intervention-shared.ts \
        packages/api/tests/integration/interventions-post.test.ts \
        packages/api/tests/unit/routes/v1/interventions.test.ts \
        docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_G_ERROR_CODES.md
git commit -m "feat(api): checklist selections on intervention create (BR-300..303)"
```
*(Summary 64 char ✓ ≤72.)*

---

## Task 4: `PATCH /v1/interventions/:id` — replace selezioni (BR-303) + rimozione title

**Files:**
- Modify: `packages/api/src/routes/v1/interventions-update.ts`
- Modify: `docs/APPENDICE_A_API.md` (aggiorna `PATCH` body/response)
- Test: `packages/api/tests/integration/interventions-patch.test.ts`

**Interfaces:**
- Consumes: `UpdateInterventionSchema` aggiornato (Task 1); `serializeChecklistItems` + `validateChecklistSelection` (Task 3). Modelli come Task 3.
- Produces: response `intervention` senza `title`, con `checklistItems: { label }[]`.

**Contratto comportamentale:**
- Rimuovi `'title'` da `EDITABLE_KEYS` (riga 23-29) e dall'array `fields` di `buildChangesJson` (riga 76). `title` sparisce dal `select` di `existing` (riga 116) e di `reloaded` (riga 248). Il `data` scalare NON contiene mai `checklistItemIds` (non è colonna).
- **Cambio tipo + guardia (Deviation #6):** calcola `effectiveTypeId = body.interventionTypeId ?? existing.interventionTypeId`. Se `body.interventionTypeId !== undefined && body.interventionTypeId !== existing.interventionTypeId && body.checklistItemIds === undefined` → `throw businessError('intervention.creation.checklist_required', 400, 'Cambiando il tipo di intervento devi riselezionare le voci checklist.')`. (Il `findUniqueOrThrow` esistente sul nuovo tipo resta, 404 su bogus.)
- **Replace selezioni (BR-303)** — solo se `body.checklistItemIds !== undefined`, dentro la tx, dopo l'`intervention.update` scalare:
  1. `foundItems = await validateChecklistSelection(tx, { tenantId, interventionTypeId: effectiveTypeId, checklistItemIds: body.checklistItemIds })` (throw BR-300/301/302 identici a create).
  2. `existingSel = tx.interventionChecklistSelection.findMany({ where: { interventionId: id }, select: { id: true, checklistItemId: true } })`.
  3. `desired = new Set(dedup(body.checklistItemIds))`. `toDelete = existingSel.filter(s => s.checklistItemId === null || !desired.has(s.checklistItemId)).map(s => s.id)` → `deleteMany({ where: { id: { in: toDelete } } })` (rimuove anche le selezioni orfane `checklist_item_id = NULL` — Deviation #7).
  4. `existingItemIds = new Set(existingSel.map(s => s.checklistItemId).filter(Boolean))`. `toAdd = foundItems.filter(it => !existingItemIds.has(it.id))` → `createMany({ data: toAdd.map(it => ({ interventionId: id, tenantId, checklistItemId: it.id, labelSnapshot: it.nameIt, sortOrderSnapshot: it.sortOrder })) })`. Le voci **ritenute** non vengono toccate → snapshot originale preservato (BR-303).
- **Wiki-lock (BR-062/064):** invariato — la gate `revision_reason_required` scatta già su qualunque edit valido a lock chiuso; un edit di sole `checklistItemIds` post-lock richiede quindi `reason` ≥ 10 e crea una revision (con `changes` scalare eventualmente vuoto — accettato, annota nel commento).
- **Reload + response:** aggiungi al `select` di `reloaded` `checklistSelections: { select: { labelSnapshot: true, sortOrderSnapshot: true }, orderBy: [{ sortOrderSnapshot: 'asc' }, { labelSnapshot: 'asc' }] }`. Nella response, mappa `checklistItems: serializeChecklistItems(reloaded.checklistSelections)` e **rimuovi** `title` dall'oggetto ritornato.
- **Notifica revised:** sostituisci `title: result.intervention.title` con `title: null`.
- Cita `// BR-303` (replace: snapshot solo per le voci aggiunte) e `// BR-308` nell'header.

- [ ] **Step 1: Scrivi i test (RED)** in `interventions-patch.test.ts`. Casi (Tier 1): (a) replace happy path — intervento con voci [A,B], PATCH `checklistItemIds:[B,C]` → `200`, selezioni finali {B,C}; verifica che la selezione **B** conserva il `label_snapshot` originale anche dopo rinomina di B via `pgAdmin` (BR-303: B ritenuta, snapshot invariato; C nuova → snapshot corrente); (b) BR-300 su edit — `checklistItemIds:[]` → `400 checklist_required`, selezioni invariate (rollback); (c) BR-301/302 su edit — voce di altro tipo/inattiva/esclusa → `422`, rollback; (d) cambio tipo senza `checklistItemIds` → `400 checklist_required` (Deviation #6); (e) cambio tipo **con** `checklistItemIds` validi per il nuovo tipo → `200`, selezioni sostituite; (f) PATCH senza `checklistItemIds` (solo `description`) → selezioni **intatte**; (g) response non contiene `title`, contiene `checklistItems`; (h) post-lock: edit `checklistItemIds` senza `reason` → `400 revision_reason_required`.

- [ ] **Step 2: Esegui → RED** (integration su CI). Annota se saltato in locale.

- [ ] **Step 3: Implementa** le modifiche a `interventions-update.ts`.

- [ ] **Step 4: Docs.** `APPENDICE_A`: `PATCH /v1/interventions/:id` — body perde `title`, acquista `checklistItemIds?: string[]` (replace del set, ≥1 se presente); response perde `title`, acquista `checklistItems`. Nota la semantica BR-303 (voci ritenute mantengono lo snapshot). (BR-303 già compilata in Task 3; qui solo la nota API + eventuale rimando.)

- [ ] **Step 5: `pnpm -r typecheck`** → verde. Poi `pnpm --filter @garageos/api test:unit -t "interventions"` (mock FakePrisma non rotti).

- [ ] **Step 6: Esegui → GREEN** (CI).

- [ ] **Step 7: Commit.**
```bash
git add packages/api/src/routes/v1/interventions-update.ts \
        packages/api/tests/integration/interventions-patch.test.ts \
        docs/APPENDICE_A_API.md
git commit -m "feat(api): replace checklist selections on intervention edit (BR-303)"
```
*(Summary 66 char ✓ ≤72.)*

---

## Task 5: `GET /v1/interventions/:id` — voci da snapshot, rimozione title

**Files:**
- Modify: `packages/api/src/routes/v1/interventions-detail.ts`
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (compila **BR-308**)
- Modify: `docs/APPENDICE_A_API.md` (aggiorna `GET /v1/interventions/:id`)
- Test: `packages/api/tests/integration/interventions-detail.test.ts`

**Interfaces:**
- Consumes: `serializeChecklistItems` (Task 3). Modello `InterventionChecklistSelection` via relazione `checklistSelections`.
- Produces: response detail (snake_case, mirror route esistente) **senza** `title`, **con** `checklist_items: [{ label }]`.

**Contratto comportamentale:**
- In `interventionDetailSelect` (riga 29-50): rimuovi `title: true`; aggiungi `checklistSelections: { select: { labelSnapshot: true, sortOrderSnapshot: true }, orderBy: [{ sortOrderSnapshot: 'asc' }, { labelSnapshot: 'asc' }] }`.
- Nel return (riga 77-121): rimuovi la riga `title: row.title`; aggiungi `checklist_items: serializeChecklistItems(row.checklistSelections)`. La redazione cross-tenant (BR-153 su `internal_notes`/`created_by`) resta invariata; le voci checklist sono visibili cross-tenant (fanno parte del logbook condiviso, come `parts_replaced`).
- Header: cita `// BR-308` (title rimosso dal DTO di lettura) e nota che le voci sono lette dallo snapshot (nessun join sul catalogo globale → sopravvivono a rinomina/eliminazione voce).

- [ ] **Step 1: Scrivi i test (RED)** in `interventions-detail.test.ts`. Casi (Tier 1): (a) detail di un intervento con 2 selezioni → response ha `checklist_items` (2, ordinate per `sortOrderSnapshot`), **nessun** `title`; (b) BR-303/D8 — elimina la voce dal catalogo via `pgAdmin` (SetNull su `checklist_item_id`) → il detail espone ancora la voce dal `label_snapshot`; (c) cross-tenant read (tenant non-owner) → `checklist_items` presenti (visibili), `internal_notes` e `created_by` ancora redatti (BR-153 invariato).

- [ ] **Step 2: Esegui → RED** (integration su CI).

- [ ] **Step 3: Implementa** le modifiche a `interventions-detail.ts`.

- [ ] **Step 4: Docs.** `APPENDICE_F` **BR-308**: compila — l'intervento non ha più `title`; nessun input, nessuna persistenza, nessuna esposizione nei DTO di scrittura e nel dettaglio officina; l'intestazione è il nome del tipo (`PrivateIntervention.customType` è un concetto diverso, intatto — D9). Nota: la colonna `title` resta a DB finché tutti i lettori (PDF PR-6, mobile PR-7) non la abbandonano; il DROP è un contract step successivo. `APPENDICE_A`: `GET /v1/interventions/:id` — response perde `title`, acquista `checklist_items: [{ label }]`.

- [ ] **Step 5: `pnpm -r typecheck`** → verde.

- [ ] **Step 6: Esegui → GREEN** (CI).

- [ ] **Step 7: Commit.**
```bash
git add packages/api/src/routes/v1/interventions-detail.ts \
        packages/api/tests/integration/interventions-detail.test.ts \
        docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md
git commit -m "feat(api): expose checklist items on intervention detail, drop title"
```
*(Summary 65 char ✓ ≤72.)*

---

## Pre-flight checklist (controller, PRIMA di dispatchare gli implementer)

### Schema & Prisma
- [x] Campi Prisma verificati contro `schema.prisma:442-568`: `InterventionChecklistSelection { id, interventionId, tenantId, checklistItemId?, labelSnapshot, sortOrderSnapshot?, createdAt }`; unique `(interventionId, checklistItemId)`; `InterventionChecklistItem { id, interventionTypeId, code, nameIt, sortOrder, active }`; esclusioni con PK composite. `Intervention.title` è `String?` (resta).
- [x] `createMany`/`deleteMany`/`findMany` — grep dei test per i vecchi nomi metodo non necessario (nuovi call site). FakePrisma unit (Task 3/4) da estendere per `interventionChecklistSelection` + `checklistItem.findMany` (mock via `mockImplementation`).
- [x] Nessun raw SQL → nessun `updated_at` manuale (le selezioni non hanno `updated_at`).

### Docs cross-reference
- [x] `APPENDICE_G` grep: famiglia `intervention.creation.*` presente (285-290); i 2 nuovi codici NON esistono → registrare.
- [x] `APPENDICE_F` grep: BR-300/301/302/303/305/308 hanno header RISERVATI (1198+); compilare i corpi. BR-304/306/307 già compilate → non toccare.
- [x] Grep target file: tutti i 4 route file esistono; `intervention-types.test.ts` integration — grep prima di "Create" (crea solo se assente).

### RLS & DB
- [x] `selections_read = USING(true)` (permissivo) → detail legge via relazione, nessun secondo scoping; `selections_insert/update/delete = tenant_id = current_tenant_id()` → scritture in `withContext({ tenantId })`. Verificato `migration.sql:98-107`.
- [x] `interventions_read` permissivo → detail resta `findFirst({ id })` + null check.
- [x] Cross-tenant 404 detail già coperto (test esistente); i nuovi test aggiungono cross-tenant read delle voci.

### Tests & refactor
- [x] `validateChecklistSelection`/`serializeChecklistItems` estratti in `intervention-shared.ts` (Task 3) e riusati da 4/5 — le guardie inline (BR-300/301/302) vivono nell'helper, non duplicate.
- [x] Mock unit con input dinamico (`mockImplementation`), mai hardcoded.
- [x] Route-handler change → `pnpm --filter @garageos/api test:unit` mirato dopo Task 3/4.

### Style & process
- [x] Commenti header in inglese; stringhe utente in italiano via `businessError`.
- [x] LOC checkpoint cumulativo dopo ogni task; halt+ask a 1200.

## Review gates (in order)
1. `pnpm -r typecheck` (pre-push hook) — unico gate locale obbligatorio; + `pnpm --filter @garageos/api test:unit` dopo Task 3/4.
2. **Final whole-branch `/code-review high`** — load-bearing: cross-referenzia `schema.prisma`, APPENDICE_F/G/A, coerenza cross-task (helper condiviso, shape create vs patch vs detail, BR-303 snapshot preservation). Applica Critical/Important; Minor → PR description. [[feedback_final_reviewer_catches_spec_drift]]
3. CI full matrix (`gh pr checks --watch`) — unico gate per RLS/integration reali (Postgres/Testcontainers).
4. **Smoke runbook** — questo PR è **API-only** (nessuna UI): lo smoke UI del flusso officina arriva con PR-5. Post-deploy, smoke via `curl`/console: `GET /v1/intervention-types` di un tenant con un'esclusione (PR-3) → il tipo/voce escluso non compare; create con `checklistItemIds` → 201 + selezioni; detail → `checklist_items` presenti, nessun `title`. NON testare l'edit del titolo dal web (Deviation #8).

## Self-review (fatto in fase di scrittura)
- **Spec coverage:** `GET /v1/intervention-types` con esclusioni + BR-305 ✓ (Task 2); `POST` con `checklistItemIds` + BR-300/301/302/303 + rimozione title ✓ (Task 3); `PATCH` replace set + BR-303 + rimozione title ✓ (Task 4); detail senza title + voci da snapshot + BR-308 ✓ (Task 5); Zod condivise ✓ (Task 1); error codes `checklist_required`/`checklist_item_invalid` ✓; BR-300/301/302/303/305/308 compilate ✓. **Fuori scope (confermato owner):** PDF (PR-6), mobile-facing reads (PR-7), DROP colonna title (post-PR-7).
- **Placeholder scan:** nessun TBD/TODO; wire shapes, error code, stringhe italiane, contratti Prisma e Zod espliciti.
- **Type consistency:** `serializeChecklistItems(selections: { labelSnapshot, sortOrderSnapshot }[]) → { label }[]` e `validateChecklistSelection(...) → { id, nameIt, sortOrder }[]` usati coerentemente da Task 3 (produce) e Task 4/5 (consuma). `checklistItems` (camelCase, create/patch) vs `checklist_items` (snake_case, detail) — divergenza **voluta**, mirror della convenzione per-route esistente, annotata in ogni task.

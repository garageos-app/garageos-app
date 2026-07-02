# PR-2 (PR-ADMIN-CATALOG) — Admin CRUD del catalogo interventi (tipi + voci checklist) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere gli endpoint platform-admin per il CRUD del **catalogo globale** — tipi di intervento (`intervention_types`, righe `tenant_id = NULL`) e relative voci checklist (`intervention_checklist_items`) — più la sezione "Catalogo interventi" nell'admin console (`packages/admin-web`). Questo è il secondo PR dell'arco "ridisegno tipi intervento + checklist"; la fondazione DB (tabelle, RLS, seed, BR riservate) è già in `main` (PR-DB #244).

**Architecture:** Endpoint admin che rispecchiano il pattern di `admin-tenants-create.ts` / `admin-tenant-detail.ts`: auth `requireAuth → requirePlatformAdminsPool` (niente `tenantContext`), tutte le query DB dentro `app.withContext({ role: 'admin' })` (imposta il GUC `app.current_role='admin'` → le RLS policy passano via `is_admin_role()`; il ruolo runtime `garageos_app` è NOBYPASSRLS ma ha i GRANT + le policy che consentono la scrittura admin — verificato in `20260702130000_checklist_foundation/migration.sql`). Body validati con Zod `.strict()` dentro l'handler. DTO serializer puri in `lib/dtos/`. Frontend: pagina lista `/catalogo` + pagina dettaglio `/catalogo/:id`, react-query inline (nessuna cartella `queries/` in admin-web), form react-hook-form + zod + shadcn Dialog, stringhe IT hardcoded (nessun i18n in admin-web).

**Spec:** `docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md` (§ "API surface → Admin console" e "Decomposizione in PR" item 2).

**LOC budget:** target ~1300–1600 net; **PR combinato API+web deliberatamente sopra il soft-target ~500** (deciso dall'owner 2026-07-02: un unico PR-2, giustificato in descrizione). Hard limit resta 1500 sul codice non-test; **il controller controlla la LOC cumulativa dopo ogni task e a ~1200 righe cumulate (post-task) fa halt e chiede** se spostare i task web in un follow-up (`[[mid-execution-loc-checkpoint]]`). Giustificare la dimensione nella descrizione del PR.

---

## Deviations from spec (verified against actual code — the code wins)

1. **Nuovo error code `admin.intervention_type.in_use` (409)** — non presente nella lista error-code della spec. Serve per `DELETE` di un tipo referenziato da interventi: `Intervention.interventionType` è `onDelete: Restrict` (`schema.prisma:565`), quindi la delete lancia P2003. Lo mappiamo a 409 con messaggio "disattivalo invece di eliminarlo". Aggiunta giustificata.
2. **Unicità `code` dei tipi globali è application-layer, NON DB.** La spec implica un catch P2002 per `admin.intervention_type.code_conflict`. Ma l'indice `uq_intervention_type_code_tenant` è su `(tenant_id, code)` con semantica **NULLS DISTINCT di default** (`20260424070954_init/migration.sql:535`): due righe con `tenant_id IS NULL` e stesso `code` **non** collidono (`NULL ≠ NULL` in Postgres). Quindi P2002 **non scatta** per i tipi globali. Il POST tipo fa un pre-check `findFirst({ where: { tenantId: null, code } })` → 409. (Race TOCTOU accettata: catalogo single-operator, bassa concorrenza — notarlo nel commento.) **L'unicità delle voci** (`uq_checklist_item_code_type` su `(intervention_type_id, code)`, entrambe NOT NULL) **usa invece P2002** in modo affidabile — BR-307.
3. **PR-2 esclude le esclusioni per-tenant (visibilità).** Gli endpoint `catalog-visibility` e le BR-304/305 sono PR-3 (spec § Decomposizione item 3). PR-2 riempie solo **BR-306** (governance/admin-only write) e **BR-307** (unicità code voce).
4. **PATCH tipo non modifica `code` né `category`** (campi identità immutabili). La spec elenca "nameIt, scadenze, active" per il PATCH → coerente.
5. **Rimozione colonna `title` NON è in PR-2.** È differita ai PR API/web/mobile. Verificato: `Intervention.title` è ora `String?` (`schema.prisma:548`), non ancora droppata. Nessun endpoint di PR-2 la tocca.
6. **Scope commit = `admin-web`, non `admin`.** `commitlint.config.mjs:17` enumera `['api','web','admin-web','mobile','database','infra','shared','e2e','deps']`. La spec scriveva `feat(api,admin)` che **fallirebbe** commitlint. La lista scope in `CLAUDE.md` è stale (manca `admin-web`).

## Gotchas the implementer MUST respect (from project memory)

- **RLS admin write** (`[[least-privilege-db-role]]`, `[[withcontext-empty-blocks-rls-writes]]`): usa **sempre** `app.withContext({ role: 'admin' as const }, …)`. Non passare context vuoto. Non aggiungere BYPASSRLS. Le policy `checklist_items_write`/`intervention_types_isolation` passano via `is_admin_role()`.
- **Audit log su catalogo globale:** `AuditLog.tenantId` è nullable (`schema.prisma:767`) e `audit_logs_insert` è `WITH CHECK (true)`. Usa `tenantId: null, actorType: 'system', actorId: null, metadata: { actorCognitoSub: request.jwt?.sub ?? null }, ipAddress: request.ip`, dentro la stessa tx admin (rollback atomico).
- **Fastify empty-body-under-json** (`[[fastify-empty-body-under-json-content-type]]`): l'api-client di admin-web setta sempre `Content-Type: application/json`. I nostri POST portano un payload → nessun problema; ma nei test `app.inject`/`apiFetch` invia sempre `payload`/`body`.
- **react-query offline guard** (`[[react-query-data-bang-offline-paused]]`): nelle pagine, `if (error) …` PRIMA, poi `if (isLoading || !data) …`.
- **shadcn Select CLI literal-alias bug** (`[[shadcn-cli-literal-alias-path]]`): per la dropdown `category` usa un `<select>` nativo stilizzato Tailwind (pattern `TenantDetail.tsx:691`), non shadcn Select.
- **Test integration CI-only** (`[[skip-local-integration-tests]]`): NON eseguire `test:integration` in locale. Pre-push = `pnpm -r typecheck`. Per handler modificati, opzionale `pnpm --filter @garageos/api test:unit`.
- **Prisma empty update no-op** (`[[prisma-empty-update-no-op]]`): i PATCH rifiutano il body vuoto via `.refine(Object.keys>0)`; non asserire cambi di `@updatedAt` su update vuote.
- **commitlint linta TUTTI i commit** (`[[ci-commitlint-all-commits-scope]]`): ogni commit del branch deve avere `type(scope)` valido, summary ≤72 char.
- **Prisma loose where droppa chiavi ignote** (`[[prisma-loose-where-silently-drops-unknown-keys]]`): usa solo campi esistenti nei `where`/`data`/`select`. Accessor confermati: `tx.interventionType`, `tx.interventionChecklistItem`, `tx.auditLog`.

## Branch

`feat/admin-intervention-catalog` (da `main` aggiornato).

---

## Pre-flight checklist — RISULTATI (già eseguita, per il controller)

- **Schema/Prisma:** modelli confermati `InterventionType` (`schema.prisma:451`), `InterventionChecklistItem` (:477). Accessor client: `interventionType`, `interventionChecklistItem`. `_count.checklistItems` disponibile (relazione `checklistItems` su InterventionType, :470). Enum `InterventionTypeCategory` = `maintenance|repair|tires|body|inspection|other` (:107-114). `Intervention.interventionType` = `onDelete: Restrict` (:565) → P2003 su delete tipo in uso. `InterventionChecklistSelection.checklistItem` = `onDelete: SetNull` (:533) → delete voce preserva snapshot. `TenantChecklistItemExclusion`/`InterventionChecklistItem` verso il tipo = `onDelete: Cascade`.
- **Docs BR:** BR-300..308 già presenti in `APPENDICE_F` come **RISERVATA** (:1198-1223). PR-2 riempie BR-306 (:1216) e BR-307 (:1219).
- **Docs error codes:** nessuno dei codici `admin.intervention_type.*` / `admin.checklist_item.*` esiste in `APPENDICE_G` §3.13 (:377-388). Vanno aggiunti.
- **RLS:** `intervention_types_isolation` `FOR ALL USING(is_admin_role() OR tenant_id IS NULL OR tenant_id=current_tenant_id())` (senza WITH CHECK esplicito → riusa USING per INSERT/UPDATE); `checklist_items_write` `FOR ALL USING/CHECK(is_admin_role())` (`20260702130000_checklist_foundation`). GRANT CRUD a `garageos_app` presenti. **Scrittura admin consentita, nessuna nuova migration richiesta.**
- **Unique index gotcha:** `uq_intervention_type_code_tenant` NULLS DISTINCT (vedi Deviation #2). Pre-check app-layer obbligatorio per code tipo globale.
- **Percorsi file:** `admin-intervention-types.ts` / `admin-checklist-items.ts` / `lib/dtos/intervention-type-admin.ts` NON esistono ancora (grep vuoto) → "Create" corretto. Pagine `CatalogoInterventi.tsx` / `CatalogoInterventoDetail.tsx` non esistono.
- **admin-web wiring:** route in `App.tsx:38-45` (statiche prima delle dinamiche), nav in `NavMain.tsx:12-23` (array + `isActiveFor`), titolo in `Topbar.tsx:7-14`.

---

## Task 1 — API: endpoint admin CRUD tipi di intervento

**Files:**
- Create: `packages/api/src/routes/v1/admin-intervention-types.ts`
- Create: `packages/api/src/lib/dtos/intervention-type-admin.ts` (serializer + select per **tipo E voce** — la voce è consumata da Task 2)
- Modify: `packages/api/src/server.ts` (import dopo :69, `await app.register(...)` dopo :188)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (§3.13, dopo :384), `docs/APPENDICE_F_BUSINESS_LOGIC.md` (BR-306, :1216), `docs/APPENDICE_A_API.md` (sezione admin)
- Test: `packages/api/tests/integration/admin-intervention-types.test.ts`

**Interfaces:**
- Produces (per Task 2 e Task 3):
  - `INTERVENTION_TYPE_ADMIN_SELECT` (`satisfies Prisma.InterventionTypeSelect`, include `_count: { select: { checklistItems: true } }`)
  - `serializeInterventionTypeAdmin(row)` → `{ id, code, nameIt, description, icon, category, suggestsDeadline, defaultDeadlineMonths, defaultDeadlineKm, active, checklistItemCount, createdAt, updatedAt }`
  - `CHECKLIST_ITEM_ADMIN_SELECT` + `serializeChecklistItemAdmin(row)` → `{ id, interventionTypeId, code, nameIt, sortOrder, active, createdAt, updatedAt }`
  - `CodeSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Codice non valido: usa lettere maiuscole, cifre e underscore')` (esportata, riusata in Task 2)

**Contratto endpoint:**

| Metodo | Path | Comportamento | Errori |
|---|---|---|---|
| GET | `/v1/admin/intervention-types` | Lista tipi globali (`where: { tenantId: null }`) **incl. inattivi**, `orderBy: [{ category:'asc' }, { nameIt:'asc' }]`, ciascuno con `checklistItemCount`. Risposta `{ data: InterventionTypeAdminDto[] }` (200). | 403 pool errato |
| POST | `/v1/admin/intervention-types` | Crea tipo globale. **Pre-check app-layer** `findFirst({ where: { tenantId: null, code } })` → se esiste, 409. Poi `create({ data: { ...body, tenantId: null } })`. Audit `intervention_type_created`. `{ interventionType }` (201). | 409 `admin.intervention_type.code_conflict`; 400 VALIDATION_ERROR |
| PATCH | `/v1/admin/intervention-types/:id` | Existence check (`findFirst({ where: { id, tenantId: null } })`) → 404. Update campi consentiti (mai `code`/`category`). Audit `intervention_type_updated`. `{ interventionType }` (200). | 404 `admin.intervention_type.not_found`; 400 VALIDATION_ERROR |
| DELETE | `/v1/admin/intervention-types/:id` | Existence check → 404. `delete({ where: { id } })` (cascade su checklist items + type exclusions). Catch P2003 → 409. Audit `intervention_type_deleted`. 204 no body. | 404 `admin.intervention_type.not_found`; 409 `admin.intervention_type.in_use` |

**Validazione (Zod `.strict()`):**
- `CreateTypeBody`: `code: CodeSchema`, `nameIt: string.trim.min(1).max(150)`, `description: string.trim.max(1000).optional()`, `icon: string.trim.max(50).optional()`, `category: z.enum([...6 valori])`, `suggestsDeadline: boolean.optional().default(false)`, `defaultDeadlineMonths: number.int.positive.max(600).nullable().optional()`, `defaultDeadlineKm: number.int.positive.max(2_000_000).nullable().optional()`, `active: boolean.optional().default(true)`.
- `UpdateTypeBody`: come sopra ma **senza `code`/`category`**, tutti `.optional()`, `.strict().refine(o => Object.keys(o).length>0, { message:'Almeno un campo da aggiornare' })`.
- `ParamsSchema = z.object({ id: z.string().uuid() })`; parse fallito → 404 `admin.intervention_type.not_found` (anti-enum, pattern `admin-tenant-detail.ts:79`).
- `if (!parsed.success) throw parsed.error` per il body (→ global handler 400 VALIDATION_ERROR con `errors[]`).

**BR da citare nei commenti:** `// BR-306: catalogo scrivibile solo dal platform admin (requirePlatformAdminsPool + RLS is_admin_role).`

**Passi (TDD):**
- [ ] **Step 1 — test rossi.** Scrivi `admin-intervention-types.test.ts` con i casi: (a) 403 con token `pool:'officine'` e `pool:'clienti'` su GET e POST; (b) GET 200 → lista include un tipo inattivo seeded + `checklistItemCount` corretto + ordine category→nameIt; (c) POST happy 201 → riletto via `pgAdmin`, riga con `tenant_id IS NULL`, + riga audit `intervention_type_created`; (d) POST code duplicato globale → 409 `admin.intervention_type.code_conflict` (**prova il pre-check app-layer**: seed un tipo globale con lo stesso code); (e) POST body invalido (category fuori enum) → 400 con `errors[]`; (f) PATCH happy 200 → campo aggiornato; (g) PATCH id inesistente → 404; (h) PATCH campo ignoto (`.strict`) → 400; (i) DELETE tipo inutilizzato → 204 + riga sparita + le sue checklist items cascade-eliminate; (j) DELETE tipo referenziato da un intervento (seed intervento via `pgAdmin`) → 409 `admin.intervention_type.in_use`; (k) DELETE id inesistente → 404. Asserisci envelope RFC7807 (`content-type` include `PROBLEM_JSON_CONTENT_TYPE`, campo `code`). Usa harness `buildTestServer`, `resetDb`, `signTestToken({ pool:'platform-admins' })`, `pgAdmin`.
- [ ] **Step 2 — verifica rosso.** `pnpm --filter @garageos/api test:integration -t "admin intervention-types"` (CI-only; in locale è sufficiente confermare che il file compila e le route non esistono → i test falliranno per 404 route).
- [ ] **Step 3 — DTO.** Crea `intervention-type-admin.ts` con i due select + due serializer + `CodeSchema` (contract sopra). `satisfies Prisma.InterventionTypeSelect` / `Prisma.InterventionChecklistItemSelect`.
- [ ] **Step 4 — route.** Crea `admin-intervention-types.ts` (`FastifyPluginAsync`), 4 handler, tutto in `app.withContext({ role:'admin' as const }, …)`. P2003 → `businessError('admin.intervention_type.in_use', 409, 'Tipo in uso da uno o più interventi: disattivalo invece di eliminarlo.')`. Audit dentro la tx.
- [ ] **Step 5 — registra.** Import + `await app.register(adminInterventionTypesRoutes)` in `server.ts`.
- [ ] **Step 6 — docs.** APPENDICE_G §3.13: aggiungi righe `admin.intervention_type.not_found|404|info`, `admin.intervention_type.code_conflict|409|info`, `admin.intervention_type.in_use|409|info`. APPENDICE_F BR-306: sostituisci "RISERVATA" con la regola (governance admin-only write, riferimento endpoint). APPENDICE_A: documenta i 4 endpoint (metodo, auth, body, risposte, error codes).
- [ ] **Step 7 — typecheck + verde.** `pnpm -r typecheck`. Su CI: integration verdi.
- [ ] **Step 8 — commit.** `feat(api): add platform-admin intervention-type catalog CRUD`

---

## Task 2 — API: endpoint admin CRUD voci checklist

**Files:**
- Create: `packages/api/src/routes/v1/admin-checklist-items.ts`
- Modify: `packages/api/src/server.ts` (import + register)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (§3.13), `docs/APPENDICE_F_BUSINESS_LOGIC.md` (BR-307, :1219), `docs/APPENDICE_A_API.md`
- Test: `packages/api/tests/integration/admin-checklist-items.test.ts`

**Interfaces:**
- Consumes (da Task 1): `CHECKLIST_ITEM_ADMIN_SELECT`, `serializeChecklistItemAdmin`, `CodeSchema` da `lib/dtos/intervention-type-admin.ts`.

**Contratto endpoint:**

| Metodo | Path | Comportamento | Errori |
|---|---|---|---|
| GET | `/v1/admin/intervention-types/:id/checklist-items` | Existence check tipo (`findFirst({ where:{ id, tenantId:null } })`) → 404. Lista voci del tipo **incl. inattive**, `orderBy:[{ sortOrder:'asc' },{ nameIt:'asc' }]`. `{ data: ChecklistItemAdminDto[] }` (200). | 404 `admin.intervention_type.not_found`; 403 |
| POST | `/v1/admin/intervention-types/:id/checklist-items` | Existence check tipo → 404. `create({ data:{ ...body, interventionTypeId: id } })`. Catch P2002 → 409 (BR-307). Audit `checklist_item_created`. `{ checklistItem }` (201). | 404 `admin.intervention_type.not_found`; 409 `admin.checklist_item.code_conflict`; 400 |
| PATCH | `/v1/admin/checklist-items/:id` | Existence check voce → 404. Update (`nameIt`, `sortOrder`, `active`; mai `code`/`interventionTypeId`). Audit `checklist_item_updated`. `{ checklistItem }` (200). | 404 `admin.checklist_item.not_found`; 400 |
| DELETE | `/v1/admin/checklist-items/:id` | Existence check → 404. `delete` (hard; `SetNull` preserva le selezioni storiche — BR-303/D8). Audit `checklist_item_deleted`. 204. | 404 `admin.checklist_item.not_found` |

**Validazione (Zod `.strict()`):**
- `CreateItemBody`: `code: CodeSchema`, `nameIt: string.trim.min(1).max(150)`, `sortOrder: number.int.min(0).max(32767).optional().default(0)`, `active: boolean.optional().default(true)`.
- `UpdateItemBody`: `nameIt?`, `sortOrder?`, `active?`, `.strict().refine(nonEmpty)`.
- Param `:id` uuid; parse fallito → 404 del codice pertinente (tipo per la route annidata, voce per `/checklist-items/:id`).

**BR da citare:** `// BR-307: code univoco per tipo (uq_checklist_item_code_type → P2002).` `// BR-306: admin-only write.`

**Passi (TDD):**
- [ ] **Step 1 — test rossi.** Casi: (a) 403 officine/clienti; (b) GET voci di un tipo (incl. inattive, ordine sortOrder→nameIt); (c) GET per tipo inesistente → 404 `admin.intervention_type.not_found`; (d) POST happy 201 → riletto via `pgAdmin`, + audit; (e) POST code duplicato **stesso tipo** → 409 `admin.checklist_item.code_conflict` (BR-307); (f) POST **stesso code su tipo DIVERSO** → 201 (prova lo scoping per tipo); (g) POST per tipo inesistente → 404; (h) PATCH happy 200; (i) PATCH id inesistente → 404 `admin.checklist_item.not_found`; (j) PATCH campo ignoto → 400; (k) DELETE → 204 + voce sparita; (l) **snapshot survival (BR-303/D8)**: seed via `pgAdmin` un intervento + una riga `intervention_checklist_selections` che referenzia la voce (con `label_snapshot`), poi DELETE della voce → asserisci che la selezione **sopravvive** con `checklist_item_id IS NULL` e `label_snapshot` intatto. Envelope RFC7807.
- [ ] **Step 2 — verifica rosso** (come Task 1).
- [ ] **Step 3 — route.** Crea `admin-checklist-items.ts`, 4 handler, `withContext({ role:'admin' })`. P2002 → `businessError('admin.checklist_item.code_conflict', 409, 'Esiste già una voce con questo codice per il tipo selezionato.')`. Audit dentro tx.
- [ ] **Step 4 — registra** in `server.ts`.
- [ ] **Step 5 — docs.** APPENDICE_G: `admin.checklist_item.not_found|404|info`, `admin.checklist_item.code_conflict|409|info`. APPENDICE_F BR-307. APPENDICE_A: 4 endpoint.
- [ ] **Step 6 — typecheck + verde.**
- [ ] **Step 7 — commit.** `feat(api): add platform-admin checklist-item catalog CRUD`

---

## Task 3 — Web: pagina "Catalogo interventi" (lista tipi + CRUD)

**Files:**
- Create: `packages/admin-web/src/pages/CatalogoInterventi.tsx`
- Create: `packages/admin-web/src/lib/validators/catalog-type.ts` (zod, messaggi IT)
- Create: `packages/admin-web/src/lib/catalog-types.ts` (tipi TS `InterventionTypeAdmin`, `ChecklistItemAdmin` + mappa error-code→IT `CATALOG_ERROR_MESSAGES` + `GENERIC_CATALOG_ERROR`)
- Modify: `packages/admin-web/src/App.tsx` (import + `<Route path="/catalogo" element={<CatalogoInterventi/>} />` dentro `<AppLayout>`, **prima** della route dinamica di Task 4)
- Modify: `packages/admin-web/src/components/layout/NavMain.tsx` (navItem `{ id:'catalogo', label:'Catalogo interventi', icon: ClipboardList, to:'/catalogo' }` in `:12`; branch `if (id==='catalogo') return pathname.startsWith('/catalogo')` in `isActiveFor` `:18`)
- Modify: `packages/admin-web/src/components/layout/Topbar.tsx` (`if (pathname.startsWith('/catalogo')) return 'Catalogo interventi'` in `titleForPath` `:7`)
- Test: `packages/admin-web/tests/catalogo-interventi.test.tsx`

**Behavior (contract):**
- Fetch: `useQuery({ queryKey:['admin-catalog-types'], queryFn: () => apiFetch<{ data: InterventionTypeAdmin[] }>('/v1/admin/intervention-types') })`.
- Guard: `if (error) return <ErrorState message="Errore nel caricamento del catalogo." />;` poi `if (isLoading || !data) return <TableSkeleton columns={6} />;`.
- Tabella (shadcn `Table`): colonne **Codice, Nome, Categoria (Badge), Voci (`checklistItemCount`), Stato (Badge attivo/inattivo), Azioni**. Riga cliccabile → `navigate(\`/catalogo/${type.id}\`)`. `EmptyState` (icon `ClipboardList`) se vuoto.
- Bottone "Nuovo tipo" → `<Dialog>` con form react-hook-form + `zodResolver(catalogTypeSchema)` (3 generici Values/unknown/Parsed). Campi: `code`, `nameIt`, `description`, `icon`, `category` (**`<select>` nativo** con i 6 valori, etichette IT), `suggestsDeadline` (checkbox), `defaultDeadlineMonths`, `defaultDeadlineKm`, `active` (checkbox, default on). `noValidate`. Mutation `POST /v1/admin/intervention-types` → `onSuccess`: `invalidateQueries(['admin-catalog-types'])`, toast "Tipo creato.", chiudi, `form.reset()`. `onError`: `handleMutationError` (mappa `CATALOG_ERROR_MESSAGES`).
- Edit Dialog (per riga) → `PATCH /v1/admin/intervention-types/:id` (stessi campi meno `code`/`category`), `values:` dal record così il form si popola.
- Delete → `<AlertDialog>`; conferma → `DELETE /v1/admin/intervention-types/:id`. Gestisci 409 `admin.intervention_type.in_use` con messaggio dedicato "Tipo in uso: disattivalo dalla modifica invece di eliminarlo."
- `catalog-type.ts` (zod): mirror del body API (code regex `^[A-Z][A-Z0-9_]{0,49}$` con messaggio IT, nameIt min1 max150, ecc.). `CATALOG_ERROR_MESSAGES`: `{ 'admin.intervention_type.code_conflict':'Codice tipo già esistente.', 'admin.intervention_type.in_use':'Tipo in uso: disattivalo invece di eliminarlo.', 'admin.intervention_type.not_found':'Tipo non trovato.' }`.

**Tests (Tier 2, 2-3 — no pure-render):** wrapper `QueryClient(retry:false)` + `MemoryRouter`, mock `@/lib/api-client` (`useApiFetch`→`vi.hoisted` fn) e `@/auth/useAuth`. Casi: (1) **happy** — `mockResolvedValueOnce({ data:[…] })` → i tipi appaiono in tabella; (2) **error state** — `mockRejectedValueOnce` → `ErrorState` (`role="alert"`); (3) **create** — apri dialog, compila, submit (`userEvent` importato dinamicamente) → `apiFetch` chiamato con `'/v1/admin/intervention-types'`, `method:'POST'`, payload atteso (usa `mockImplementation` per distinguere list-GET vs POST).

**Passi:** [ ] test rossi → [ ] `catalog-types.ts`+`catalog-type.ts` → [ ] pagina → [ ] wiring App/Nav/Topbar → [ ] typecheck + `pnpm --filter @garageos/admin-web test` verde → [ ] **commit** `feat(admin-web): add intervention catalog types page`.

---

## Task 4 — Web: dettaglio tipo — gestione voci checklist

**Files:**
- Create: `packages/admin-web/src/pages/CatalogoInterventoDetail.tsx`
- Create: `packages/admin-web/src/lib/validators/catalog-item.ts` (zod voce)
- Modify: `packages/admin-web/src/lib/catalog-types.ts` (aggiungi `CHECKLIST_ITEM_ERROR_MESSAGES` con `admin.checklist_item.code_conflict`/`not_found`)
- Modify: `packages/admin-web/src/App.tsx` (`<Route path="/catalogo/:id" element={<CatalogoInterventoDetail/>} />`, **dopo** `/catalogo`)
- Test: `packages/admin-web/tests/catalogo-intervento-detail.test.tsx`

*(Nav e Topbar già coperti: `isActiveFor` e `titleForPath` usano `startsWith('/catalogo')`.)*

**Behavior (contract):**
- `const { id } = useParams()`. Header tipo: deriva `nameIt`+`code` dalla lista cache — `useQuery(['admin-catalog-types'])` (rifetch se cold) e `find(t => t.id===id)`; se non trovato dopo il load → `ErrorState "Tipo non trovato."`.
- Voci: `useQuery({ queryKey:['admin-catalog-items', id], queryFn: () => apiFetch<{ data: ChecklistItemAdmin[] }>(\`/v1/admin/intervention-types/${id}/checklist-items\`), enabled:!!id })`. Guard error→loading come sopra.
- Tabella voci: **Codice, Nome, Ordine (`sortOrder`), Stato, Azioni**. `EmptyState` se nessuna voce.
- "Nuova voce" → Dialog form (`code`, `nameIt`, `sortOrder` number, `active`) → `POST /v1/admin/intervention-types/:id/checklist-items` → `invalidateQueries(['admin-catalog-items', id])`, toast "Voce creata.".
- Edit voce → `PATCH /v1/admin/checklist-items/:itemId` (`nameIt`,`sortOrder`,`active`). Delete voce → `AlertDialog` → `DELETE /v1/admin/checklist-items/:itemId`.
- Errori: `CHECKLIST_ITEM_ERROR_MESSAGES['admin.checklist_item.code_conflict'] = 'Codice voce già esistente per questo tipo.'`.
- Link "← Catalogo" torna a `/catalogo`.

**Tests (Tier 2, 2-3):** mock come Task 3, `MemoryRouter initialEntries={['/catalogo/<uuid>']}` + `<Routes>` con la route param, oppure mock `useParams`. Casi: (1) **happy** — voci renderizzate; (2) **error** — items fetch reject → `ErrorState`; (3) **create voce** — submit → `apiFetch` con endpoint annidato corretto + `method:'POST'` + payload.

**Passi:** [ ] test rossi → [ ] `catalog-item.ts` + estendi `catalog-types.ts` → [ ] pagina → [ ] route in App → [ ] typecheck + `pnpm --filter @garageos/admin-web test` verde → [ ] **commit** `feat(admin-web): add checklist items management page`.

---

## Self-review (spec coverage)

- Endpoint admin tipi (GET/POST/PATCH/DELETE) → Task 1. Endpoint admin voci (GET/POST/PATCH/DELETE) → Task 2. ✅ (gli 8 endpoint della spec § "Catalogo globale"; gli endpoint `catalog-visibility` sono PR-3, fuori scope — Deviation #3).
- UI admin "Catalogo interventi" → Task 3 (tipi) + Task 4 (voci). ✅
- BR-306 (governance) → Task 1/2 (auth+RLS, doc). BR-307 (code univoco voce) → Task 2 (P2002). ✅
- Snapshot BR-303/D8 (delete voce non altera interventi) → Task 2 test (l). ✅
- Contratti RFC7807 + error codes nuovi → Task 1/2 test + APPENDICE_G. ✅
- Tier 1 security (403 pool isolation, admin-only write) → Task 1/2 test (a). ✅
- Type consistency: `serializeChecklistItemAdmin`/`CHECKLIST_ITEM_ADMIN_SELECT`/`CodeSchema` definiti in Task 1, consumati in Task 2/3/4 con lo stesso nome. ✅

## Review gates (in order)

1. Per-task review sui task a rischio: **Task 1 e Task 2** (nuova superficie API pubblica + security/RLS + validazione BR) — per-task reviewer. Task 3/4 (UI) coperti dal gate finale.
2. `pnpm -r typecheck` (pre-push).
3. **Final whole-branch `/code-review high`** — load-bearing.
4. CI full matrix (`gh pr checks --watch`) — unico gate per RLS/CHECK/Postgres reale.
5. **Smoke runbook (BLOCKER, PR UI):** login admin console → Catalogo → crea tipo → drill-in → crea voce → modifica → elimina voce → verifica errori (code duplicato, delete tipo in uso). Documentare nel PR.

## PR description note (obbligatoria)

Giustificare l'eccezione LOC: "PR combinato API+web (~1600 LOC) per l'arco checklist; l'API deve precedere il web per gli integration test. Split rifiutato dall'owner 2026-07-02." Elencare i 5 nuovi error code e BR-306/307. Findings Minor del code-review vanno elencati qui, non fixati in un round dedicato (`[[right-size-process-to-task]]`).

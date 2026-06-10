# F-CLI-104 PR1 — Pre-registrazione veicolo pendente (API + mobile) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il cliente senza codice GO pre-registra il proprio veicolo dall'app
(`POST /v1/me/vehicles/pending`, status `pending`, ownership immediata) e lo
vede in lista/dettaglio con lo stato "In attesa di certificazione". PR1
dell'arco F-CLI-104→F-OFF-107; la promozione lato officina è PR2.

**Architecture:** route API nuova `me-vehicles-pending.ts` (mirror della
superficie `/me/*`: catena `requireAuth + requireClientiPool + clientiContext`,
`withContext({ customerId, role: 'user' })` — la RLS `vehicles_insert` ha già
il ramo `created_by_customer_id IS NOT NULL`; boundary app-layer, mai RLS sola).
Validator condiviso `CreatePendingVehicleSchema` in
`packages/database/src/validators/vehicle.ts` (sottoinsieme di
`CreateVehicleSchema`). Mobile: form a 7 campi su route top-level standalone
(pattern `claim-vehicle.tsx`), mutation che invalida `['me','vehicles']`,
badge pending in lista e banner in dettaglio.

**Spec:** `docs/superpowers/specs/2026-06-10-F-CLI-104-F-OFF-107-pending-vehicle-arc-design.md`
**LOC budget:** target ~1000 net (code+test), hard PR limit 1500. Checkpoint
cumulativo `git diff --stat` dopo ogni task; halt+ask a ~1200.

## Deviations from spec (verified against actual code — the code wins)

1. **`status` è GIÀ nel DTO lista/dettaglio cliente** (`meVehicleListSelect`
   in `me-vehicles.ts:54`, detail `:73`) → il task "aggiungere status al DTO
   API" previsto come rischio dalla spec NON serve. La cascade vera è sul
   **mobile**: `MeVehicleSummary.garageCode: string` e
   `MeVehicleDetail.vehicle.garageCode: string` (`src/lib/types/vehicle.ts:3,24`)
   diventano `string | null` (i pending hanno GO-code NULL) con 2 usi UI da
   sistemare (`app/(tabs)/vehicles/[id].tsx:82` header e `:234` TechTab).
2. **Error code checksum VIN:** la spec non lo nominava; il codice registrato
   e già usato dal create officina è `vehicle.creation.invalid_vin_checksum`
   (400, `vehicles.ts:383`) → si riusa con messaggio IT adatto al cliente
   (niente menzione di `forceNonstandardVin`, che resta solo officina).
3. **`VehicleTransferSection` resta montata anche su detail pending**
   (`[id].tsx:260`): avviare un transfer su pending dà già il 422
   `transfer.creation.vehicle_not_certified` mappato IT lato mobile
   ("Questo veicolo non può ancora essere trasferito."). La spec dice
   esplicitamente "nessun gating extra in PR1" → nessuna modifica.
4. **CHECK `chk_pending_consistency`** (migration `20260424100000`):
   `status='pending' ⇒ garage_code IS NULL` — il nostro insert è conforme
   (GO-code mai settato). Nessun impatto, citarlo nel commento route.

## Gotchas the implementer MUST respect (from project memory)

- **Route handler nuova → `pnpm --filter @garageos/api test:unit` locale**
  (typecheck non vede i mock FakePrisma rotti). MAI `pnpm test:integration`
  locale (Docker, freeze) — integration si verifica su CI.
- **Nuova route Expo → `rm packages/mobile/.expo/types/router.d.ts`** (file
  stale → falsi errori TS sui typed-route; è gitignored, si rigenera).
- **Zod v4**: `z.uuid()`/`z.email()` top-level; il fallimento `.regex()` ha
  code `invalid_format`. `exactOptionalPropertyTypes` → spread condizionali
  per i campi opzionali nei `data` Prisma.
- **jest.mock factory**: variabili out-of-scope referenziate solo se prefissate
  `mock*`. Screen test importati via path relativo `../../app/...`.
- **commitlint su TUTTI i commit del PR**: header ≤72 char, scope enum
  (`api|web|mobile|database|infra|shared|e2e|deps`).
- **Niente rate-limit IP isolation nei test**: le route `/me/*` non hanno
  rate limit.
- **Comment headers in inglese**; stringhe utente in italiano.
- **Integration fixtures**: usare gli helper esistenti
  (`tests/integration/helpers.ts` / `fixtures.ts`), non raw SQL (e se raw:
  `updated_at` esplicito).

## Pre-flight checklist — esiti (verificati 2026-06-10)

- Schema Prisma: `Vehicle` ha `vin @unique`, `garageCode String? @unique`,
  `status VehicleStatus @default(pending)`, `createdByCustomerId String?`,
  `vehicleType`/`fuelType` NOT NULL senza default; `VehicleOwnership` con
  indice parziale attivo `uq_ownership_vehicle_active` (BR-040). Tutti i campi
  usati nei `data`/`select` di questo piano esistono con questi nomi esatti.
- APPENDICE_G: `vehicle.pending.duplicate_vin_certified` (409) registrato,
  trigger "Pre-registrazione utente con VIN esistente";
  `vehicle.creation.invalid_vin_checksum` (400) registrato. **Zero codici nuovi.**
- APPENDICE_F: BR-001/002/003/006/007/040/042 verificate, testo conforme a
  quanto citato qui.
- File target: `me-vehicles-pending.ts`, `app/pending-vehicle.tsx`,
  `src/queries/pendingVehicle.ts`, `src/components/PendingVehicleForm.tsx`,
  `src/lib/validators/pendingVehicle.ts` — **nessuno esiste** (grep 2026-06-10).
- RLS: `vehicles_insert WITH CHECK (... OR created_by_customer_id IS NOT NULL)`;
  `ownerships_access USING (true)` — insert ownership sotto `role:'user'` ok
  (precedente: claim, `me-vehicles.ts:345`).
- Nessun CDK/infra/migration → niente check `resourceCountIs`/IAM/runbook deploy.

## Branch

`feat/me-vehicles-pending` da `main` aggiornata.
Primo commit: spec + questo piano (`docs: spec and plan for pending vehicle arc pr1`).

---

## Task 1 — `CreatePendingVehicleSchema` (database validators)

**Files:**
- Modify: `packages/database/src/validators/vehicle.ts`
- Modify: `packages/database/src/index.ts` SOLO se i validator non sono già
  re-esportati con `export *` (verificare: `CreateVehicleSchema` è importato
  da `@garageos/database` in `vehicles.ts:1`, quindi quasi certamente basta
  aggiungere lo schema al file validators).

**Contract:** schema Zod per il body della pre-registrazione, sottoinsieme di
`CreateVehicleSchema.shape.vehicle` (stessi validator riusati, NON ridefiniti):

```ts
export const CreatePendingVehicleSchema = z
  .object({
    vin: VinSchema,
    plate: ItalianPlateSchema,
    plateCountry: z.string().length(2).default('IT'),
    make: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    year: z.number().int().min(1900).max(CURRENT_YEAR + 1), // BR-007
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
  })
  .strict(); // respinge status/createdByCustomerId/garageCode iniettati dal client
export type CreatePendingVehicleInput = z.infer<typeof CreatePendingVehicleSchema>;
```

Commento header: BR-006 (campi obbligatori pending; vehicleType/fuelType extra
perché colonne NOT NULL), BR-001 (shape VIN; checksum a livello route).
Niente `forceNonstandardVin`: eccezione BR-001 riservata al meccanico (PR2).

**Test:** nessun test dedicato nel package database (i validator esistenti non
ne hanno di propri); la copertura arriva dai test route del Task 2.
Dopo la modifica: `pnpm --filter @garageos/database typecheck` verde.

**Commit:** `feat(database): add CreatePendingVehicleSchema validator`

---

## Task 2 — Route API `POST /v1/me/vehicles/pending` (TDD)

**Files:**
- Create: `packages/api/src/routes/v1/me-vehicles-pending.ts`
- Modify: `packages/api/src/server.ts` (registrazione accanto a
  `meVehicleRoutes` — grep `meVehicleRoutes` per il punto esatto)
- Test: `packages/api/tests/unit/routes/v1/me-vehicles-pending.test.ts`
  (FakePrisma, mirror di `me-vehicles.test.ts`)

**Contract route** (header con BR-003/BR-006/BR-040 + lezione #154):

- `preHandler: [requireAuth, requireClientiPool, clientiContext]`;
  `app.withContext({ customerId, role: 'user' }, ...)` — mirror del claim.
  `customerId` SEMPRE da `request.customerId!`, mai dal body (lo schema è
  `.strict()`).
- Flusso dentro la tx:
  1. Parse body con `CreatePendingVehicleSchema`.
  2. Checksum VIN: `validateVinIso3779(vin)` (riuso
     `lib/vin-checksum.ts`) → se falso, 400
     `vehicle.creation.invalid_vin_checksum`, messaggio IT:
     `'Il VIN non risulta valido. Controlla il libretto di circolazione; per veicoli storici o speciali rivolgiti a un\'officina.'`
  3. Pre-check duplicato VIN (`findFirst({ where: { vin }, select: { id: true } })`)
     → se esiste (certified O pending, BR-001 unique globale), 409
     `vehicle.pending.duplicate_vin_certified`, messaggio IT:
     `'Esiste già un veicolo registrato con questo telaio. Se è il tuo, chiedi il codice GarageOS alla tua officina.'`
  4. `vehicle.create` — data: i campi del body + `status: 'pending'` esplicito
     + `createdByCustomerId: customerId`. NIENTE garageCode/certifiedBy*
     (CHECK `chk_pending_consistency`: pending ⇒ garage_code NULL).
  5. `vehicleOwnership.create({ vehicleId, customerId, startedAt: new Date() })`
     (BR-040; il veicolo nasce nella stessa tx → nessuna race sull'indice
     parziale attivo).
  6. Catch `Prisma.PrismaClientKnownRequestError` P2002 sul create (race tra
     il pre-check e l'insert) → stesso 409 del punto 3.
- **Response 201** (wire shape verbatim — il punto è il contratto col mobile):

```jsonc
{
  "vehicle": {
    "id": "<uuid>",
    "garageCode": null,
    "vin": "ZFA31200003456789",
    "plate": "AB123CD",
    "plateCountry": "IT",
    "make": "Fiat",
    "model": "Panda",
    "year": 2015,
    "vehicleType": "car",
    "fuelType": "petrol",
    "status": "pending"
  },
  "ownership": { "id": "<uuid>", "startedAt": "<ISO>" }
}
```

(select del create = i campi sopra; `reply.code(201)`.)

**Test cases (rosso → verde, FakePrisma):**
1. 201 happy: `vehicle.create` chiamato con `createdByCustomerId` = customer
   autenticato e `status:'pending'`; ownership creata col medesimo customer;
   response shape esatta (garageCode null).
2. VIN con checksum errato → 400 `vehicle.creation.invalid_vin_checksum`,
   nessuna chiamata a `vehicle.create`.
3. VIN già esistente (findFirst risolve una riga) → 409
   `vehicle.pending.duplicate_vin_certified`, nessun create.
4. P2002 dal create (race) → 409 stesso codice.
5. Validazione: body senza `fuelType` → 400; `year: 1899` → 400; targa
   `XX99` → 400; chiave extra `status: 'certified'` nel body → 400 (strict).
6. Auth: senza token → 401 (mirror dei test esistenti della superficie /me).

**Step:**
- [ ] Scrivere i test unit (file nuovo, fixture mirror di `me-vehicles.test.ts`)
- [ ] `pnpm --filter @garageos/api test:unit -- me-vehicles-pending` → FAIL (route 404)
- [ ] Implementare route + registrazione in server.ts
- [ ] Stesso comando → PASS; poi suite unit api completa → PASS
- [ ] Commit

**Commit:** `feat(api): add POST /me/vehicles/pending pre-registration`

---

## Task 3 — Integration test API (CI-only)

**Files:**
- Create: `packages/api/tests/integration/me-vehicles-pending.test.ts`
  (helpers/fixtures esistenti: `helpers.ts`, `fixtures.ts`; mirror di
  `me-vehicles.test.ts` per setup customer+JWT clienti)

**Test cases (descritti per intent):**
1. 201 → riga `vehicles` con `status='pending'`, `garage_code IS NULL`,
   `created_by_customer_id` = customer; riga `vehicle_ownerships` attiva
   (`ended_at IS NULL`). Subito dopo, `GET /v1/me/vehicles` dello stesso
   customer include il veicolo con `status:'pending'` e `garageCode:null`
   (wire esatto, lezione mirror-frontend-wire).
2. Duplicato VIN vs veicolo **certified** esistente (fixture officina) → 409
   `vehicle.pending.duplicate_vin_certified`.
3. Duplicato VIN vs altro **pending** (seconda POST stesso VIN) → 409 stesso
   codice.
4. Isolamento: il pending di customer A NON appare in `GET /me/vehicles` di
   customer B (boundary ownership app-layer).
5. BR-042 coerenza: `POST /me/vehicles/claim` di customer B con... il pending
   non ha GO-code → non claimabile per costruzione; il caso "claim su pending"
   è già coperto da `me-vehicles.test.ts` (verificare con grep
   `me.vehicle.claim.pending` e NON duplicare il test se esiste).
6. CHECK constraint: l'insert della route passa `chk_pending_consistency`
   (implicito nel caso 1 — su CI con Postgres reale; nessun test dedicato).
7. RLS negative (dalla spec): insert diretto su `vehicles` sotto
   `withContext({ customerId, role: 'user' })` SENZA `createdByCustomerId`
   → respinto dalla policy `vehicles_insert` (usare l'handle DB del setup
   integration, stesso accesso usato dal seeding in `fixtures.ts`; aspettarsi
   l'errore di policy violation, non un P2025). Documenta il perché il ramo
   `created_by_customer_id IS NOT NULL` è il varco usato dalla route.

NON eseguire localmente: push e verifica su CI (`gh pr checks --watch`).

**Step:**
- [ ] Scrivere il file integration (riusare seed/auth helper esistenti)
- [ ] `pnpm --filter @garageos/api typecheck` verde (il run reale è su CI)
- [ ] Commit

**Commit:** `test(api): integration coverage for pending pre-registration`

---

## Task 4 — Mobile: tipi, mutation, error mapping (cascade garageCode)

**Files:**
- Modify: `packages/mobile/src/lib/types/vehicle.ts`
- Create: `packages/mobile/src/queries/pendingVehicle.ts`
- Modify: `packages/mobile/src/lib/error-messages.ts`
- Test: `packages/mobile/tests/queries/pendingVehicle.test.tsx`
  (mirror di `tests/queries/claimVehicle` se esiste, altrimenti del pattern
  `vehicleHistoryPdf.test.tsx`)

**Contract:**
- `MeVehicleSummary.garageCode` e `MeVehicleDetail.vehicle.garageCode` →
  `string | null` (deviazione #1). `ClaimVehicleResponse` INVARIATA (il claim
  tocca solo certified). Dopo il cambio: `pnpm --filter @garageos/mobile
  typecheck` rivela ogni uso non-null-safe — attesi SOLO `[id].tsx:82` e
  `:234` (fix nel Task 6); se ne emergono altri, enumerarli nel commit.
- Tipi nuovi (stesso file): `CreatePendingVehicleRequest` (7 campi, mirror
  wire Task 2) e `CreatePendingVehicleResponse` (envelope 201 verbatim).
- `useCreatePendingVehicle()` — `useMutation` POST
  `/v1/me/vehicles/pending`; `onSuccess`: invalida `['me','vehicles']`
  (chiave REALE della lista, `meVehicles.ts:19`). Mirror di
  `claimVehicle.ts`.
- `error-messages.ts`, nuove entry (IT verbatim):
  - `'vehicle.pending.duplicate_vin_certified': 'Esiste già un veicolo registrato con questo telaio. Se è il tuo, chiedi il codice GarageOS alla tua officina.'`
  - `'vehicle.creation.invalid_vin_checksum': 'Il VIN non risulta valido. Controlla il libretto di circolazione.'`

**Test cases:** mutation chiama il path giusto col body passato (threading via
mockImplementation, non hardcoded); 201 → invalidateQueries con chiave
`['me','vehicles']`; errore API → mutation rejects con ApiError (code
preservato).

**Step:**
- [ ] Test rosso → implementazione → verde (`pnpm --filter @garageos/mobile test -- pendingVehicle`)
- [ ] `pnpm --filter @garageos/mobile typecheck` — risolvere SOLO i due usi
      noti rimandando il fix UI al Task 6 è impossibile (typecheck rompe) →
      in questo task applicare il rendering null-safe minimo ai due punti
      (dettaglio UX completo nel Task 6): header `[id].tsx:82` → renderizzare
      la riga "Codice:" solo se `v.garageCode`; TechTab `:234` → valore
      `vehicle.garageCode ?? 'Non ancora assegnato'`.
- [ ] Commit

**Commit:** `feat(mobile): pending vehicle types, mutation, error mapping`

---

## Task 5 — Mobile: validator + `PendingVehicleForm` (TDD)

**Files:**
- Create: `packages/mobile/src/lib/validators/pendingVehicle.ts`
- Create: `packages/mobile/src/components/PendingVehicleForm.tsx`
- Test: `packages/mobile/tests/components/PendingVehicleForm.test.tsx`

**Contract validator** (mirror client-side dello Zod API; api/mobile non
condividono package — pattern `validators/claimVehicle.ts`):
- `VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/` (shape BR-001; il checksum ISO 3779 NON
  si replica client-side: server-authoritative, il 400 arriva mappato nel
  banner — stesso compromesso del form web F-OFF-102).
- `PLATE_RE = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/` (mirror `ItalianPlateSchema`).
- `validatePendingVehicleForm(values)` → `Record<campo, messaggio IT>` con
  messaggi: VIN `'Il telaio (VIN) deve essere di 17 caratteri (senza I, O, Q)'`,
  targa `'Formato targa non valido (esempio: AB123CD)'`, anno
  `'Anno non valido'` (1900..anno corrente+1, BR-007), obbligatorietà
  `'Campo obbligatorio'` per make/model/tipo/alimentazione.

**Contract form** (pattern `ClaimVehicleForm`: useState + validator, niente RHF):
- Props: `{ onSubmit: (body: CreatePendingVehicleRequest) => Promise<Result>, onCancel: () => void }`
  con `Result = { ok: true } | { ok: false; code: string }` (mirror
  `ClaimVehicleFormResult`).
- Campi testo: VIN (`autoCapitalize="characters"`, normalize trim+uppercase al
  submit), Targa (idem), Marca, Modello, Anno (`keyboardType="numeric"`).
- **Picker tipo/alimentazione: righe di chip `Pressable`** (pill selezionabile,
  stile coerente coi tab di `[id].tsx`; NESSUNA nuova dipendenza). Label IT
  verbatim, value = enum DB:
  - vehicleType: Auto=`car`, Moto=`motorcycle`, Furgone=`van`,
    Camion=`truck`, Mezzo agricolo=`agricultural`
  - fuelType: Benzina=`petrol`, Diesel=`diesel`, Elettrico=`electric`,
    Ibrido=`hybrid`, GPL=`lpg`, Metano=`methane`, Idrogeno=`hydrogen`,
    Altro=`other`
- Errori per-campo sotto l'input; banner errore server top (`accessibilityRole="alert"`,
  testo da `mapErrorToUserMessage`); submit "Pre-registra" con
  ActivityIndicator + disabled anti-doppio-tap; "Annulla" → onCancel.
- Hint sotto il titolo: `'Il veicolo resterà "in attesa di certificazione" finché un\'officina GarageOS non verificherà il libretto.'`

**Test cases:** render 7 campi; submit con campi vuoti → errori obbligatorietà
e onSubmit NON chiamato; VIN 16 char → errore campo; submit valido → onSubmit
chiamato col body normalizzato (uppercase, year numerico, enum value dei chip
selezionati); `ok:false` con code duplicate → banner col messaggio IT mappato;
pending state disabilita il bottone.

**Step:**
- [ ] Test rosso → validator+form → verde
- [ ] Commit

**Commit:** `feat(mobile): pending vehicle pre-registration form`

---

## Task 6 — Mobile: screen, entry point dal claim, stato pending in lista/dettaglio

**Files:**
- Create: `packages/mobile/app/pending-vehicle.tsx`
- Modify: `packages/mobile/app/claim-vehicle.tsx`
- Modify: `packages/mobile/src/components/VehicleListItem.tsx`
- Modify: `packages/mobile/app/(tabs)/vehicles/[id].tsx`
- Test: `packages/mobile/tests/screens/pending-vehicle.test.tsx` (+ update
  dei test esistenti di VehicleListItem / detail screen se asseriscono il
  vecchio rendering)

**Contract:**
- `app/pending-vehicle.tsx`: route top-level standalone (mirror
  `claim-vehicle.tsx`: `Stack.Screen` inline `title: 'Pre-registra veicolo'`,
  ScrollView + form). `onSubmit` → `useCreatePendingVehicle().mutateAsync` →
  success: `router.replace('/(tabs)/vehicles/' + res.vehicle.id)` (mirror
  claim); errore ApiError → `{ ok:false, code }`.
- `claim-vehicle.tsx`: sotto il form, link `Pressable` testo
  `'Non hai il codice? Pre-registra il veicolo'` →
  `router.push('/pending-vehicle')`. (Nel file screen, NON dentro
  `ClaimVehicleForm` — il form resta riusabile con la sua API attuale.)
- `VehicleListItem`: se `vehicle.status === 'pending'`, pill
  `'In attesa di certificazione'` sotto la targa — colori warning del theme
  (grep `colors.` per la variante; se non esiste un warning, riusare lo stile
  outline di `BadgeContestato`/`BadgeCertificato` variante `privato` come
  riferimento di forma, con label dedicata e `accessibilityLabel`).
- Dettaglio `[id].tsx`: se `v.status === 'pending'`, banner sotto l'header
  (stile `errorBanner` di ClaimVehicleForm ma neutro/info):
  `'Veicolo in attesa di certificazione. Portalo in un\'officina GarageOS per la verifica del libretto e il codice ufficiale.'`
  Header: riga "Codice:" già resa condizionale nel Task 4.
- **Dopo la creazione della route: `rm packages/mobile/.expo/types/router.d.ts`.**

**Test cases:** screen renderizza il form e naviga al dettaglio su success
(mock mutation, pattern screen test esistenti con path relativo); claim screen
mostra il link e naviga a `/pending-vehicle`; VehicleListItem con status
pending mostra il badge (e NON lo mostra per certified); detail con pending
mostra banner e nasconde la riga Codice.

**Step:**
- [ ] Test rosso → implementazione → verde (suite mobile completa:
      `pnpm --filter @garageos/mobile test`)
- [ ] Commit

**Commit:** `feat(mobile): pending state UI and pre-registration entry`

---

## Task 7 — Smoke runbook + chiusura

**Files:**
- Create: `docs/superpowers/runbooks/F-CLI-104-smoke.md`

**Runbook (BLOCKER, post-merge su device):** setup standard Expo Go sideloaded
(`adb reverse tcp:8081`, `npx expo start --offline`, `expo install --check`
prima). Step:
a. Claim screen → link "Non hai il codice?" → form si apre.
b. Submit vuoto → errori per-campo IT.
c. VIN malformato (16 char) → errore campo; VIN con checksum errato
   (17 char plausibili) → banner server "VIN non risulta valido".
d. Pre-registrazione reale (VIN checksum-valido inventato, es. generato con
   check-digit corretto) → redirect al dettaglio, banner "in attesa di
   certificazione", niente riga Codice.
e. Lista veicoli → badge "In attesa di certificazione".
f. Secondo tentativo stesso VIN → banner duplicato IT.
g. TechTab → "Codice GarageOS: Non ancora assegnato"; bottone export PDF
   funziona (storico vuoto); sezione trasferimento: avvio → errore IT
   "non può ancora essere trasferito" (degradazione accettata, spec).
h. Account B → la lista NON mostra il veicolo di A.
⚠️ Il veicolo pending creato resta in prod → annotare VIN/id nel runbook per
la pulizia o per riuso come fixture dello smoke PR2 (certify reale).

**Chiusura PR:**
- [ ] `pnpm -r typecheck` (gate pre-push) + suite unit api/mobile locali verdi
- [ ] Push, PR con template (What/Why/Tests/BR verificate: BR-001, BR-002,
      BR-003, BR-006, BR-007, BR-040; **segnalare le 2 deviazioni di spec
      decise dall'utente**: foto libretto differite, notifica BR-004 differita
      — e la deviazione VIN-checksum-error-code di questo piano)
- [ ] `gh pr checks <n> --watch` → tutto verde (fallback poll
      `gh api .../check-runs` se 401 GraphQL)
- [ ] **Final whole-branch review: `/code-review high`** (gate load-bearing)
- [ ] Self-merge `gh pr merge <n> --squash --delete-branch` SOLO con CI verde
      + review passata + zero questioni aperte; poi sync main
- [ ] `graphify update .` post-merge

**Commit (runbook):** `docs: add F-CLI-104 smoke runbook`

# F-OFF-102 — Form web "Censimento nuovo veicolo" (web officina)

**Data:** 2026-06-09
**Feature:** F-OFF-102 (master spec `docs/GarageOS-Specifiche.md` §3, riga ~425) — 🟢 MUST
**Slice:** web-only (API già pronta e testata), piccola/media
**Stato:** design approvato, pronto per writing-plans

## Sommario

Il web officina non ha alcuna route/form/bottone per creare un veicolo:
`POST /v1/vehicles` non viene mai chiamato dal web e i veicoli esistenti
nascono solo dal seed `packages/database/prisma/seeds/pilot-demo.ts`. Questa
slice aggiunge la UI mancante. **Nessuna modifica all'API.**

## Contesto API (già esistente, verificato)

`POST /v1/vehicles` (`packages/api/src/routes/v1/vehicles.ts:370`) crea in
un'unica transazione atomica:

- il veicolo (`status: pending` → `certified`),
- il **GO-code** (F-OFF-103, `certifyVehicleWithGarageCode`, retry su unique
  violation — BR-020/BR-021),
- la `vehicleOwnership` (BR-040, un solo proprietario attivo),
- la `customerTenantRelation` (BR-152, upsert atomico).

Il cliente è specificato **inline** via `resolveCustomer` con due modalità
(discriminated union `customer.mode`):

- `{ mode: 'existing', customerId }`
- `{ mode: 'create_new', firstName, lastName, email, phone?, taxCode?, isBusiness, businessName?, vatNumber? }`
  - `.refine`: se `isBusiness` allora `businessName` e `vatNumber` obbligatori.

Body completo (`CreateVehicleSchema`, `packages/database/src/validators/vehicle.ts:27`):

- `vehicle`: `vin`, `plate`, `plateCountry` (default `IT`), `make`, `model`,
  `version?`, `year`, `registrationDate?` (YYYY-MM-DD), `vehicleType` (enum),
  `fuelType` (enum), `engineDisplacement?`, `powerKw?`, `color?`,
  **`odometerKm` (REQUIRED, int ≥ 0)**.
- `customer`: discriminated union (sopra).
- `locationId` (REQUIRED, uuid) — deve appartenere al tenant.
- `sendInvitationEmail` (default `true`).
- `forceNonstandardVin` (default `false`).
- `force` (API-only, default `false`) — override warning targa duplicata.

Esiti speciali:

- `409 vehicle.creation.duplicate_vin` — VIN duplicato, **errore duro, nessun override** (BR-001).
- `409 vehicle.creation.duplicate_plate_warning` — targa duplicata, superabile con `force=true` (BR-002).
- `400 vehicle.creation.invalid_vin_checksum` — VIN non passa ISO 3779, superabile con `forceNonstandardVin=true` (veicoli storici/agricoli).
- `422 vehicle.creation.location_not_in_tenant` — location di un altro tenant.

## Decisione di flusso

Scenario reale dominante: **auto + cliente nuovi insieme**. L'endpoint veicolo
fa già esattamente questo, atomicamente, tramite `customer.mode: 'create_new'`.
Quindi la superficie primaria è **il form veicolo, con il cliente come
sotto-sezione** che espone lo stesso toggle esistente/nuovo dell'API
(approccio A, approvato). Il `CreateCustomerDialog` (F-OFF-201) resta separato
per il caso ristretto "creo solo un cliente, senza auto".

Approcci scartati:

- **B** (dialog cliente con sezione veicolo opzionale): responsabilità mista,
  rami tra due endpoint dalla forma diversa, non serve bene "cliente esistente
  + nuova auto".
- **C** (wizard a due step): non atomico (rischio cliente orfano), più click,
  butta via l'atomicità del backend.

## Architettura

- **Route:** `/vehicles/new` in `App.tsx`, registrata come **segmento statico
  prima di `/vehicles/:id`** (RR6 ranka comunque lo statico, ma esplicito =
  zero ambiguità).
- **Pagina:** `pages/VehicleCreate.tsx`, pattern page-form come
  `pages/InterventionCreate.tsx`.
- **Validazione:** `react-hook-form` + `zodResolver` su un **mirror locale**
  `lib/validators/createVehicle.ts` di `CreateVehicleSchema`. Convenzione del
  repo: il web NON importa `@garageos/database` a runtime (tiene il client
  Prisma fuori dal bundle Vite). Si aggiunge `createVehicle.parity.test.ts` sul
  modello di `lib/validators/parts-replaced.parity.test.ts` (import backend via
  path relativo profondo con `@ts-ignore TS6307`, confronto `Object.keys`
  ordinati + shape canonica accettata + shape drift rifiutata).
- **Mutation:** `queries/vehicleCreate.ts`, modello `queries/createIntervention.ts`
  → `POST /v1/vehicles`. Usa l'`apiFetch`/`ApiError` esistente.

## Layout della form

### Sezione Cliente (in cima)

Segmented toggle *Cliente esistente* ↔ *Nuovo cliente*:

- **Esistente:** `CustomerAutocomplete` (esistente) → `{ mode: 'existing', customerId }`.
- **Nuovo:** campi inline mirror di `CreateCustomerDialog` — nome, cognome,
  email, telefono?, codice fiscale?, `isBusiness` (→ businessName, vatNumber
  obbligatori se azienda) → `{ mode: 'create_new', … }`.

Default del mode dipende dall'ingresso (vedi Ingressi).

### Sezione Veicolo

- **Obbligatori:** VIN, targa, marca, modello, anno, `vehicleType` (Select
  enum), `fuelType` (Select enum), **km attuali** (`odometerKm`).
- **Opzionali:** `plateCountry` (default `IT`), versione, data immatricolazione,
  cilindrata (`engineDisplacement`), potenza kW (`powerKw`), colore.
- **Invito app:** toggle **visibile ma disabilitato** + tooltip "Disponibile a
  breve" → invia sempre `sendInvitationEmail=false`. (L'invio email è differito:
  SES sandbox; evitiamo righe `invitation` orfane e promesse non mantenute.
  Il toggle si abiliterà quando SES sarà attivo.)
- **Location:** `queries/locations.ts`. 1 sola location → auto-selezionata e
  read-only; >1 → Select obbligatorio.

## Gestione errori / override

- `409 duplicate_vin` → errore duro inline, nessun override.
- `409 duplicate_plate_warning` → dialog:
  - **[Apri veicolo esistente]** (primario): ricerca per targa via
    `queries/vehicleSearch.ts` → `navigate('/vehicles/:id')`.
  - *Censisci comunque (targa duplicata)* (secondario, de-enfatizzato, gated da
    conferma) → re-submit con `force=true`.
- `400 invalid_vin_checksum` → dialog conferma "VIN non standard
  (storico/agricolo)?" → re-submit con `forceNonstandardVin=true`. (Nessun
  "apri esistente": non è un duplicato.)
- `422 location_not_in_tenant` → non dovrebbe accadere (location dal nostro
  tenant); errore generico via toast.
- Altri errori → toast tramite parser `ApiError` esistente.

## Successo

`201` → toast `"Veicolo censito — codice GO {garageCode}"` +
`navigate('/vehicles/:id')` sul nuovo veicolo.

## Ingressi (una sola form, contesto d'ingresso diverso)

- **Globale** (`components/layout/TopBar.tsx`): "+ Nuovo veicolo" →
  `/vehicles/new`, default mode **Nuovo cliente** (scenario dominante).
- **Card "Veicoli" in `pages/CustomerDetail.tsx`** (empty-state "Nessun veicolo
  associato"): "+ Aggiungi veicolo" → `/vehicles/new?customerId=…`, mode
  **esistente bloccato** + cliente precompilato.
- **Empty-state ricerca (`pages/SearchResults.tsx`, F-OFF-101):** "+ Censisci
  questo veicolo" → `/vehicles/new`, precompila VIN o targa cercati se la
  ricerca era per VIN/targa.

## Business rules

I BR di dominio sono **già coperti dai test backend esistenti** e non vengono
re-implementati nel web:

- BR-001 — unicità VIN + checksum (backend, hard error / forceNonstandardVin).
- BR-002 — unicità targa per-country (backend warning / force).
- BR-020 / BR-021 — formato e unicità GO-code (backend, certify).
- BR-040 — un solo proprietario attivo (backend ownership).
- BR-152 — relazione customer-tenant (backend upsert).

Il web verifica il **comportamento UI e la gestione errori** che espongono
questi BR.

## Test (web)

- Validazione campi obbligatori + enum (`vehicleType`, `fuelType`).
- Toggle cliente esistente↔nuovo (con polyfill pointer per Radix Select in
  `tests/setup.ts`, per lezione nota su Radix+JSDOM); branch business
  (businessName/vatNumber obbligatori se azienda).
- Flusso dialog targa duplicata: "Apri esistente" naviga; "Censisci comunque"
  ri-invia con `force=true`.
- Dialog VIN-checksum: ri-invia con `forceNonstandardVin=true`.
- Successo: redirect a `/vehicles/:id` + toast con GO-code.
- Location: auto-select read-only con 1 location; Select con >1.
- Ingressi: `customerId` query param → mode esistente bloccato + precompilato;
  prefill VIN/targa da ricerca.
- Parity test mirror↔backend (`createVehicle.parity.test.ts`).

## Fuori scope (YAGNI)

- Nessun invio email reale (differito SES).
- Nessuna pagina elenco veicoli (la scoperta resta via ricerca).
- Nessuna modifica all'API o agli schemi backend.
- Nessun campo extra oltre il contratto `CreateVehicleSchema`.

## File toccati (atteso)

Nuovi:

- `packages/web/src/pages/VehicleCreate.tsx` (+ test)
- `packages/web/src/lib/validators/createVehicle.ts`
- `packages/web/src/lib/validators/createVehicle.parity.test.ts`
- `packages/web/src/queries/vehicleCreate.ts` (+ test)

Modificati:

- `packages/web/src/App.tsx` (route `/vehicles/new`)
- `packages/web/src/components/layout/TopBar.tsx` (azione "+ Nuovo veicolo")
- `packages/web/src/pages/CustomerDetail.tsx` (CTA card Veicoli)
- `packages/web/src/pages/SearchResults.tsx` (CTA empty-state)

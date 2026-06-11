# Arco veicolo pendente: F-CLI-104 pre-registrazione + F-OFF-107 certificazione — Design

**Data:** 2026-06-10
**Feature:** F-CLI-104 (Registrazione veicolo pendente, SHOULD) + F-OFF-107 (Aggancio veicolo pendente, SHOULD) — GarageOS-Specifiche.md §3.2.2 / §3.3.1
**BR coinvolte:** BR-001, BR-002, BR-003, BR-004, BR-005, BR-006, BR-007, BR-040, BR-042

## Contesto e motivazione

Chiude la modalità "utente-first": oggi un veicolo nasce solo in officina (F-OFF-102,
status `certified` immediato per BR-003). Con questo arco il cliente senza codice
GO pre-registra il proprio veicolo dall'app (status `pending`) e l'officina lo
promuove a `certified` alla prima visita, generando il GO-code.

Scelta della slice (2026-06-10, con utente): preferita a F-CLI-502 share-link
perché quest'ultima è **differita a v1.1 dalla spec** (GarageOS-Specifiche.md
§10.8 Fase 5) e richiederebbe migration + prima superficie pubblica non
autenticata. L'arco pending invece è in scope v1 e lo schema è già pronto.

**Stato pre-esistente verificato (pre-flight):**
- Schema: `VehicleStatus` ha già `pending`/`certified`; colonne `garageCode`
  nullable unique, `vin` unique globale, `createdByCustomerId`, `pendingMetadata`,
  `certifiedByTenantId`, `certifiedAt` già presenti → **zero migration**.
- Helper `certifyVehicleWithGarageCode(tx, vehicleId, tenantId)` già in
  `packages/api/src/lib/garage-code.ts:56` (genera GO-code + UPDATE, retry P2002).
- RLS `vehicles_insert` ha già il ramo `created_by_customer_id IS NOT NULL`
  (migration `20260424100000_rls_triggers_checks`); `vehicles_update` invece NON
  copre il tenant certificante su un pending customer-created (entrambe le
  colonne tenant NULL) → vedi §PR2.
- `GET /v1/vehicles/search` (vehicles.ts) cerca per VIN/targa senza filtrare per
  status → i pending sono già trovabili dall'officina senza modifiche query.
- Error code GIÀ registrati in APPENDICE_G (nessun nuovo codice):
  `vehicle.pending.duplicate_vin_certified` (409), `vehicle.certification.not_pending`
  (422), `vehicle.certification.libretto_required` (422).
- `odometer_km` a livello veicolo NON esiste nell'implementazione (i km vivono
  sugli interventi); il create F-OFF-102 implementato non lo chiede → neanche
  il certify lo chiede (BR-006 lettera vs implementazione consolidata).

## Decisioni di scope (utente, 2026-06-10)

1. **Foto libretto DIFFERITE.** F-CLI-104 da spec prevede l'upload foto libretto;
   BR-004 richiede comunque la visione FISICA in officina (checkbox), quindi le
   foto sono un ausilio non load-bearing. Pre-registrazione solo dati.
   `pendingMetadata Json` resta libero per quando si aggiungeranno (key S3).
   **Deviazione dalla descrizione F-CLI-104 — da segnalare nella PR.**
2. **Notifica certificazione DIFFERITA.** BR-004 post-condizione "notifica
   push+email al customer": email bloccata (SES/Resend), push richiederebbe
   nuova chiave evento+template. Marker `TODO(F-CLI-notifications)` nel punto di
   certificazione, coerente con transfer (#181) e dispute (#176).
   **Deviazione da BR-004 — da segnalare nella PR.**
3. **Split: 2 PR verticali per feature.** PR1 = F-CLI-104 (API + mobile),
   PR2 = F-OFF-107 (API + web). Ognuna taglia media, smoke-abile da sola.

---

## PR1 — F-CLI-104: API + mobile

### API: `POST /v1/me/vehicles/pending`

- **Catena:** `requireAuth + requireClientiPool + clientiContext`, poi
  `withContext({ customerId, role: 'user' })` (mirror del claim,
  me-vehicles.ts). L'INSERT passa la RLS via ramo `created_by_customer_id IS
  NOT NULL`; il boundary di sicurezza resta app-layer (lezione #154):
  `createdByCustomerId` e l'ownership sono SEMPRE pinnati al chiamante, mai
  presi dal body.
- **Body (Zod):**
  - `vin`: BR-001 standard, 17 char alfanumerici esclusi I/O/Q, checksum.
    **Niente `force_nonstandard_vin` lato cliente**: l'eccezione BR-001
    richiede conferma esplicita del meccanico; chi ha un telaio non standard
    (pre-1981, agricolo) passa dall'officina (F-OFF-102).
  - `plate`: obbligatoria, formato loose come F-OFF-102 (server-authoritative).
  - `make` (≤50), `model` (≤100): obbligatori.
  - `year`: int, 1900..anno corrente+1 (BR-007).
  - `vehicleType`, `fuelType`: obbligatori — extra rispetto a BR-006 (che per i
    pending chiede solo vin/plate/make/model/year) perché le colonne sono NOT
    NULL senza default nello schema; per l'utente sono due picker e la lista
    F-CLI-105 usa il tipo per l'icona. **Nessun altro campo** (version, colore
    ecc. arriveranno con le correzioni in certificazione o da F-CLI-107).
- **Effetti (una tx):**
  1. `vehicle.create` — status `pending` (default), `createdByCustomerId` =
     chiamante, `garageCode` null, `certifiedBy*` null.
  2. `vehicleOwnership.create` attiva (endedAt null) per il chiamante — il
     pending è suo da subito (BR-040); post-certificazione NON serve claim.
     BR-042 resta coerente: il claim continua a respingere i pending
     (`me.vehicle.claim.pending`), e qui non c'è race possibile sull'indice
     `uq_ownership_vehicle_active` (il veicolo nasce nella stessa tx).
- **Errori:**
  - VIN duplicato (vs certified O altro pending): P2002 su `vehicles_vin_key` →
    409 `vehicle.pending.duplicate_vin_certified` (codice già registrato, il
    trigger in APPENDICE_G è esattamente "Pre-registrazione utente con VIN
    esistente"). Messaggio IT che invita a usare il claim/officina.
  - Targa duplicata: NESSUN check (BR-002, non univoca).
  - Validazioni body: errori Zod standard RFC7807.
- **Response 201:** DTO veicolo (shape della lista `GET /me/vehicles`, con
  `garageCode: null`, `status: 'pending'`) + ownership `{id, startedAt}`.
- **Niente rate-limit dedicato** (le route `/me/*` non ne hanno; il danno max è
  riempire il proprio account di pending — accettato per il pilot).

### Mobile

- **Entry point:** schermata claim ("Aggiungi veicolo") → link sotto il form
  "Non hai il codice? Pre-registra il veicolo" → nuova route **top-level
  standalone** `app/pending-vehicle.tsx` (pattern `claim-vehicle.tsx`, evita la
  collisione segmenti in `(tabs)` — lezione #160).
- **Form:** 7 campi — vin, targa, marca, modello, anno (input), tipo veicolo e
  alimentazione (picker con label IT). Validazione client mirror dello Zod API
  (pattern mirror locale, api/mobile non condividono package). Submit →
  `useMutation` POST → on success invalida `['me','vehicles']` → `router.replace`
  al dettaglio o alla lista.
- **Lista veicoli:** badge **"In attesa di certificazione"** sulle card con
  `status === 'pending'` (il campo status è già nel DTO lista? verificare in
  plan; se assente, aggiungerlo alla select/DTO API è parte della PR).
- **Dettaglio veicolo pending:** banner informativo "Porta il veicolo in
  un'officina GarageOS per la certificazione e il codice ufficiale". Le sezioni
  esistenti degradano già bene (timeline vuota, niente GO-code da mostrare);
  nessun gating extra in PR1.
- **Errori IT:** mapping `vehicle.pending.duplicate_vin_certified` → "Esiste già
  un veicolo registrato con questo telaio..." + default generico.
- **Smoke runbook device:** BLOCKER (UI mobile) — `docs/superpowers/runbooks/`.

### Test PR1

- Unit route (FakePrisma): happy 201 con ownership pinnata al chiamante,
  duplicate VIN → 409 col codice giusto, validazioni (VIN checksum, year
  fuori range, campi mancanti), body non può forzare customerId altrui.
- Integration (Postgres reale): create → riga vehicles pending + ownership
  attiva; duplicate VIN vs certified E vs pending; RLS: insert sotto
  `role:'user'` con `createdByCustomerId` passa (negative test: senza, fallisce).
- Mobile: form (validazione, submit, error mapping), badge lista, banner detail.
- BR verificate con test citati nei commenti: BR-001, BR-002 (assenza check),
  BR-003, BR-006, BR-007, BR-040.

---

## PR2 — F-OFF-107: API + web

### API: `POST /v1/vehicles/:id/certify`

- **Catena:** `requireAuth + requireOfficinaPool + tenantContext`. BR-004
  autorizza super_admin E mechanic = tutti i tenant user → nessun gate ruolo.
- **Contesto RLS (punto delicato):** `vehicles_update` permette UPDATE solo a
  `is_admin_role()` o ai tenant creatori/certificatori. Un pending
  customer-created ha `created_by_tenant_id` e `certified_by_tenant_id`
  entrambi NULL → sotto contesto tenant l'UPDATE non matcherebbe nessuna riga
  (Prisma loose-where silent-drop, lezione #120). Quindi il route gira sotto
  **`withContext({ role: 'admin' })` con guardie app-layer esplicite** (pattern
  consolidato me-profile/push-tokens write-under-admin): mai RLS sola (#154),
  qui è l'app-layer l'intero boundary. NESSUNA modifica alla policy RLS.
- **Body (Zod):**
  - `librettoVisioned: literal(true)` — checkbox BR-004; assente/false → 422
    `vehicle.certification.libretto_required`.
  - `corrections` opzionale: `vin`, `plate`, `make`, `model`, `year`,
    `vehicleType`, `fuelType`, `version`, `registrationDate` — BR-004 "dati
    verificati e corretti, correggibili durante la promozione". Stesse
    validazioni di PR1/F-OFF-102; il VIN qui è ancora correggibile (il veicolo
    non è ancora certified, BR-005 scatta DOPO).
  - `forceNonstandardVin: true` opzionale — eccezione BR-001 (11-17 char senza
    checksum), prerogativa del meccanico, mirror di F-OFF-102.
- **Guardie (ordine):** 404 `vehicle.not_found`-family se id inesistente → 422
  `vehicle.certification.not_pending` se status `certified` → stesso 422 anche
  per `archived` (un archived non è pending; non serve codice dedicato —
  confermare in plan col grep dei codici `vehicle.archived` esistenti).
- **Effetti (una tx):**
  1. **CAS anti double-certify:** `updateMany({ where: { id, status: 'pending' },
     data: { ...corrections } })` → se 0 righe, re-read e mappa l'errore
     (compare-and-swap, mirror pattern transfer #181-182); un solo vincitore
     tra due meccanici concorrenti.
  2. `certifyVehicleWithGarageCode(tx, vehicleId, tenantId)` — riuso, già
     atomico con retry P2002 sul GO-code.
  3. `certifiedByTenantId` = tenant chiamante, `certifiedAt` = now (BR-004
     post-condizioni; l'helper certify già setta status/garage_code — verificare
     in plan cosa setta esattamente per non duplicare gli update).
  4. VIN corretto in collisione con altro veicolo → P2002 su vin → 409
     (riuso famiglia duplicate esistente, dettaglio in plan).
  5. Access log: registrare l'azione sul veicolo (action esistente più adatta,
     verifica enum in plan — la scheda veicolo già logga `view`).
  6. Notifica customer: **`TODO(F-CLI-notifications)`** (decisione §scope #2).
- **Response 200:** DTO veicolo certificato (con `garageCode` valorizzato).
- **NESSUNA creazione CTR** (customer_tenant_relation): BR-004 non la prevede;
  la relazione nasce col primo intervento. PII owner mascherata per BR-151 —
  comportamento esistente della scheda, invariato.

### Web

- **Risultati ricerca:** badge "Da certificare" (variante warning) sulle righe
  con `status === 'pending'` — la query trova già i pending per targa/VIN.
- **Scheda veicolo pending:** banner top con CTA **"Certifica veicolo"** →
  dialog: campi precompilati editabili (gli stessi del body corrections, layout
  riuso form F-OFF-102 dove possibile) + checkbox obbligatoria "Ho visionato il
  libretto di circolazione" (submit disabilitato senza) + eventuale flag VIN
  non standard col suo dialog di conferma (riuso pattern F-OFF-102) → POST →
  toast con GO-code generato → invalidate query scheda → la scheda mostra
  GO-code e abilita il tag PDF (BR-026, già gated su `certified`).
- **Errori IT:** mapping `not_pending` ("già certificato"), `libretto_required`,
  duplicate VIN.
- **Smoke runbook web:** BLOCKER (UI) — incl. ricerca pending per targa, certify
  reale, verifica GO-code + stampa tag post-certify.

### Test PR2

- Unit route: happy con corrections e senza, libretto mancante → 422, già
  certified → 422 not_pending, 404, CAS 0-righe → errore mappato, VIN collision
  → 409, forceNonstandardVin.
- Integration: certify reale end-to-end (pending seminato da insert customer) →
  status/GO-code/certifiedBy*/At; double-certify concorrente → un vincitore;
  RLS negative (UPDATE sotto contesto tenant su pending NON matcherebbe —
  documenta il perché del role admin).
- Web: dialog (checkbox gating, precompilazione, submit, toast GO-code), badge
  ricerca.
- BR verificate: BR-001 (+ eccezione force), BR-004 (tutte le pre/post tranne
  notifica differita), BR-005 (VIN immutabile DOPO — test che PATCH /vehicles
  esistente continui a rifiutare vin su certified, se già coperto basta il
  riferimento), BR-007, BR-026 (tag abilitato post-certify).

---

## Fuori scope (espliciti)

- Foto libretto upload/viewer (decisione §scope #1) — `pendingMetadata` riservato.
- Notifica push+email certificazione (decisione §scope #2) — TODO marker.
- OCR libretto / validazione automatica (v1.1, Specifiche §10.8).
- F-CLI-404 claim-senza-cedente (arco separato, sempre rinviato).
- Cancellazione/edit del pending da parte del cliente oltre quanto già permesso
  (F-CLI-107/108 esistenti si applicano invariati).
- Rate-limit dedicato alla pre-registrazione.

## Rischi e mitigazioni

- **Right-size:** entrambe le PR taglia media (2-5 task) → task-by-task,
  `/code-review high` finale whole-branch, smoke runbook BLOCKER per le UI.
- **DTO lista cliente senza `status`:** se il DTO `GET /me/vehicles` non espone
  status, PR1 lo aggiunge (campo additivo, nessun breaking).
- **Helper certify:** verificare in plan esattamente cosa aggiorna
  (`status`? solo `garage_code`?) per evitare update duplicati/divergenti.
- **Unit test mirati post-modifica route** (`pnpm --filter @garageos/api
  test:unit`) — lezione FakePrisma mock.

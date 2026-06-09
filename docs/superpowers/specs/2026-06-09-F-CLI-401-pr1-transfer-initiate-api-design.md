# F-CLI-401 PR1 — API avvio + lettura passaggio di proprietà (lato cliente)

**Data:** 2026-06-09
**Feature:** F-CLI-401 (parte di F-CLI-402 per la lettura)
**Tipo:** API-only, nessuna migration / dep / CDK / deploy
**Arco:** F-CLI-401→405 «passaggio di proprietà lato cliente». Questa è la **PR1 di 4** (vedi §1).

---

## 1. Contesto e posizione nell'arco

Oggi il passaggio di proprietà esiste **solo** in variante officina-mediata (F-OFF-110,
`POST /v1/vehicles/:id/ownership-transfer`, `lib/ownership-transfer.ts`): single-step
atomico eseguito dall'officina con il libretto alla mano. Lato cliente il transfer è **zero**:
un cliente che ha venduto l'auto non può cederla dall'app, e un acquirente non può acquisirla
se l'auto ha già un proprietario attivo (il claim F-CLI-101/102/103 risponde
`409 me.vehicle.claim.owned_by_other` e rimanda proprio a questo flusso).

L'arco completo è decomposto in 4 PR sequenziali:

| PR | Scope | Feature |
|---|---|---|
| **PR1 (questa)** | API: avvio (`physical_code`) + lettura | F-CLI-401, parte 402 |
| PR2 | API: accept → confirm → reject → swap atomico | F-CLI-402, 403, 405 |
| PR3 | API: scheduler scadenza (7gg → `expired`) | timeout BR-043 |
| PR4 | UI mobile (avvia, lista, dettaglio, accetta, conferma) | 401/402/403 |

**Fuori dall'intero arco (rinviato):** F-CLI-404 (claim-senza-cedente con upload libretto +
OCR + validazione manuale admin, 🟡 SHOULD) → arco futuro a sé.

**Solo `physical_code` in tutto l'arco core.** Il metodo `email_invitation` (BR-043) è rinviato
finché il canale email non è sbloccato (SES è in sandbox/DENIED, Resend differito — vedi
strategia email). Conseguenza: nessun invio email, nessun threading attraverso signup del
cessionario in questo arco.

### 1.1 Scope di PR1

**Dentro:**
- `POST /v1/me/transfers` — il proprietario attuale avvia un transfer `physical_code`: genera un
  `transfer_code`, crea la riga `vehicle_transfers` in stato `pending_recipient`. **La proprietà
  NON si sposta** (BR-043 passo 1).
- `GET /v1/me/transfers` — i transfer avviati dal cliente autenticato (cedente).
- `GET /v1/me/transfers/:id` — dettaglio di un transfer avviato dal cliente.

**Fuori da PR1 (PR2+):** accept, confirm, reject, lo swap di ownership, le notifiche, lo scheduler
di scadenza, qualunque UI.

---

## 2. Decisioni di design (confermate con l'utente)

1. **Path:** tutto sotto `/v1/me/transfers` (cedente-centrico), coerente con le PR cliente recenti
   (claim #159, export PDF #177) che hanno consolidato la superficie cliente sotto `/me/*`.
   La spec APPENDICE_A §3.10 elenca path misti (`POST /transfers`, `GET /transfers/:id`,
   `GET /me/transfers`) → **divergenza da annotare in APPENDICE_A** (come già fatto per §3.5b export).
2. **Validità del `transfer_code`:** **7 giorni** dal momento dell'avvio (stato `pending_recipient`),
   coerente con il timeout post-accettazione di BR-043 — un solo numero in tutto il flusso.
3. **Famiglia error code:** nuova famiglia dotted **`transfer.*`** (distinta da `vehicle.transfer.*`
   di F-OFF-110, che resta dedicata all'officina-mediated). La spec §2.3 cita codici flat
   (`not_current_owner`) → si adottano i dotted per la convenzione attuale (FastifyError con
   `name` dotted attraversa il global handler RFC7807).
4. **Mapping method API ↔ DB:** il param API è `physical_code`; il valore enum DB
   `TransferMethod` è **`initiated_by_seller`** (l'enum descrive *chi* avvia, non *come* si
   raggiunge il cessionario). PR1 accetta solo `physical_code`.

---

## 3. Architettura

### 3.1 Catena auth e contesto

Identica al claim (`me-vehicles.ts`): `preHandler: [requireAuth, requireClientiPool, clientiContext]`,
poi `app.withContext({ customerId, role: 'user' }, async (tx) => …)`.

`clientiContext` legge i claim JWT (`sub` + `custom:customer_id`) e popola `request.customerId`;
non fa probe Prisma. La RLS di `vehicle_transfers`, `vehicle_ownerships` e `vehicles` è
**`USING (true)`** → sotto `role:'user'` il cliente legge il veicolo/ownership e inserisce la riga
transfer senza elevazione.

### 3.2 Sicurezza app-layer (vincolo centrale)

> `transfers_access ON vehicle_transfers USING (true)` è **completamente permissiva**.
> Come per `/me/vehicles/:id/access-log` (lezione #154 `rls_only_endpoint_leaks_in_prod`), la
> frontiera di sicurezza è **interamente app-layer**. Ogni query DEVE filtrare esplicitamente su
> `fromCustomerId = request.customerId`. Mai affidarsi alla RLS per la visibilità dei transfer.

`GET /me/transfers/:id` su un id non posseduto (o appartenente ad altro cedente) → **404**
`me.transfer.not_found` (non 403: non si rivela l'esistenza di transfer fuori perimetro, mirror
del 404 di `me.vehicle.not_found`).

### 3.3 Generazione `transfer_code`

- Formato: **`TR-XXXX-XXXX`** con alfabeto senza caratteri ambigui, riusando lo stile del GO-code
  (cifre `2-9`, lettere `A-HJ-NPRTV-Z`, cioè senza `0 1 I O Q S U`). Regex di validazione:
  `^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$`. Entropia ≈ 32^8 ≈ 10^12.
- Univocità: colonna `transfer_code` è `@unique`. Generazione con **retry su collisione P2002**
  (loop con cap, es. 5 tentativi) dentro la stessa tx.
- Helper isolato e testabile in `lib/transfer-code.ts` (`generateTransferCode()` +
  `TRANSFER_CODE_RE`), così PR2 (accept by-code) riusa la regex di validazione.

### 3.4 Componenti

| File | Ruolo |
|---|---|
| `routes/v1/me-transfers.ts` (nuovo) | i 3 endpoint, registrato in `server.ts` accanto a `meVehicleRoutes` |
| `lib/transfer-code.ts` (nuovo) | generatore + regex codice (riuso PR2) |
| `lib/dtos/transfer.ts` (nuovo) | serializer puro camelCase `serializeTransfer(row)` |

---

## 4. Contratto degli endpoint

### 4.1 `POST /v1/me/transfers`

**Request body** (Zod, `.strict()`):
```json
{ "vehicleId": "<uuid>", "method": "physical_code" }
```
- `vehicleId`: `z.uuid()`.
- `method`: `z.literal('physical_code')` (in PR1 unico valore ammesso; `email_invitation` non è
  ancora accettato → un altro valore dà 400 ZodError).

**Logica** (dentro `withContext({ customerId, role:'user' })`):
1. Carica il veicolo + ownership attiva:
   `vehicle.findFirst({ where: { id: vehicleId }, select: { id, status, plate, make, model,
   ownerships: { where: { endedAt: null }, select: { id, customerId } } } })`.
   Veicolo inesistente → **404** `me.transfer.vehicle_not_found`.
2. **BR-040** — proprietario attuale: l'ownership attiva deve esistere e `customerId === me`.
   Altrimenti → **403** `transfer.not_current_owner`.
3. **BR-046** — `status` deve essere `certified`. `pending` o `archived` →
   **422** `transfer.vehicle_not_certified`.
4. **BR-047** — nessun transfer attivo per il veicolo
   (`status ∈ {pending_recipient, pending_seller_confirmation, pending_validation}`) →
   **409** `transfer.already_pending`.
5. Genera codice (§3.3); crea la riga:
   ```
   vehicleTransfer.create({ vehicleId, fromCustomerId: me, toCustomerId: null,
     transferCode: <code>, invitedEmail: null, method: 'initiated_by_seller',
     status: 'pending_recipient', expiresAt: now + 7d })
   ```
   `documentUrl`/`completedAt`/`rejectedReason` restano null.

**Response `201`** (serializer §4.4):
```json
{
  "id": "<uuid>",
  "vehicleId": "<uuid>",
  "vehicle": { "plate": "AB123CD", "make": "Fiat", "model": "Panda" },
  "method": "physical_code",
  "status": "pending_recipient",
  "transferCode": "TR-9K4M-7P2X",
  "expiresAt": "2026-06-16T14:32:05.000Z",
  "createdAt": "2026-06-09T14:32:05.000Z"
}
```

**Errori:** `404 me.transfer.vehicle_not_found` · `403 transfer.not_current_owner` ·
`422 transfer.vehicle_not_certified` · `409 transfer.already_pending`.

> Nota: NON c'è write su `access_logs` (richiede `user_id` → `users`, che i clienti non occupano —
> stesso motivo di `me-vehicles.ts`). L'audit del transfer vive nella riga `vehicle_transfers` stessa.

### 4.2 `GET /v1/me/transfers`

Ritorna i transfer dove `fromCustomerId === me`, ordinati `createdAt desc`. **Nessuna paginazione**
in PR1 (un cliente ne ha pochissimi — YAGNI; se servirà si aggiunge il cursor come negli altri `/me`).
Ogni elemento è il DTO §4.4. Risposta: `{ "data": [ … ] }`.

### 4.3 `GET /v1/me/transfers/:id`

`:id` = `z.uuid()`. `findFirst({ where: { id, fromCustomerId: me } })`. Non trovato (inesistente o
di altro cedente) → **404** `me.transfer.not_found`. Trovato → DTO §4.4 in `{ "transfer": … }`.

### 4.4 DTO `serializeTransfer(row)`

Puro, sincrono, camelCase. Campi: `id`, `vehicleId`, `vehicle {plate, make, model}`, `method`
(sempre rimappato `initiated_by_seller` → `"physical_code"` per il client), `status`,
`transferCode`, `expiresAt` (ISO), `createdAt` (ISO). **Mai PII del cessionario** (in `physical_code`
`toCustomerId` è null finché l'accept di PR2; e comunque BR-045/BR-151 non esporrebbero PII).
`transferCode` è mostrato al cedente (deve condividerlo). I campi `completedAt`/`rejectedReason`
sono inclusi solo quando valorizzati (forward-compat con PR2).

---

## 5. Business rules coperte

| BR | Dove |
|---|---|
| BR-040 (un solo proprietario attivo) | §4.1 passo 2 — solo il proprietario attivo avvia |
| BR-043 passo 1 (avvio crea `pending_recipient`, veicolo non spostato) | §4.1 passo 5 |
| BR-046 (no transfer veicoli pending) | §4.1 passo 3 |
| BR-047 (un solo transfer attivo per veicolo) | §4.1 passo 4 |

BR-045 (cosa trasferisce / cosa no) e F-CLI-405 (interventi privati nascosti) **non** riguardano
PR1: nessuna ownership si sposta qui. Saranno verificati in PR2 al completamento.

---

## 6. Error codes nuovi (APPENDICE_G)

Famiglia `transfer.*` (flusso cliente) + 2 `me.transfer.*` per i 404 di superficie cliente:

| Codice | Status | Scenario |
|---|---|---|
| `transfer.not_current_owner` | 403 | Il chiamante non è il proprietario attivo (BR-040) |
| `transfer.vehicle_not_certified` | 422 | Veicolo `pending`/`archived` non trasferibile (BR-046) |
| `transfer.already_pending` | 409 | Esiste già un transfer attivo per il veicolo (BR-047) |
| `me.transfer.vehicle_not_found` | 404 | `vehicleId` inesistente nel POST |
| `me.transfer.not_found` | 404 | `GET :id` su transfer inesistente o di altro cedente |

Da aggiungere alla tabella §2xx e all'indice alfabetico §7 di APPENDICE_G.

---

## 7. Testing (APPENDICE_E)

**Unit (`tests/unit/...`, FakePrisma + Vitest):**
- `lib/transfer-code.test.ts`: il codice match-a `TRANSFER_CODE_RE`, niente caratteri ambigui,
  formato `TR-XXXX-XXXX`.
- `lib/dtos/transfer.test.ts`: mapping `initiated_by_seller`→`physical_code`, niente PII cessionario,
  campi opzionali inclusi solo se valorizzati.
- `routes/v1/me-transfers.test.ts`: happy path 201 + ogni ramo errore (403/422/409/404), filtro
  app-layer `fromCustomerId` su GET lista e GET :id (un transfer di altro cedente NON è visibile),
  retry su collisione codice (P2002 → secondo tentativo).

**Integration (`tests/integration/...`, Testcontainers, solo CI):**
- avvio reale → riga `vehicle_transfers` `pending_recipient` con codice univoco; veicolo NON spostato
  (ownership invariata).
- BR-047: secondo avvio sullo stesso veicolo → 409.
- BR-040: avvio da non-proprietario → 403.
- isolamento: cedente A non vede via `GET :id` il transfer del cedente B (404).

---

## 8. Cosa PR1 NON fa

- Nessuna migration (schema `vehicle_transfers` già completo), nessuna nuova dipendenza, nessuna
  modifica CDK/IAM, nessun deploy nuovo richiesto dal codice.
- Nessuno spostamento di ownership, nessuna notifica, nessuno scheduler, nessuna UI.
- Nessun `email_invitation`, nessun `claim-without-seller`.

---

## 9. Divergenze documentazione da registrare

- **APPENDICE_A:** path consolidati sotto `/v1/me/transfers` (la §3.10 elenca path misti); il `method`
  API resta `physical_code` mappato su enum DB `initiated_by_seller`; codici errore dotted `transfer.*`
  / `me.transfer.*` al posto dei flat citati in §2.3. Aggiornare §2.3 / §3.10 di conseguenza.
- **APPENDICE_G:** aggiungere i 5 codici di §6.

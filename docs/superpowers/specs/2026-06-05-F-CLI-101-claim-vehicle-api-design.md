# F-CLI-101/102/103 — Claim veicolo via codice (API) — Design

**Data:** 2026-06-05
**Feature:** F-CLI-101 (aggiunta via codice), F-CLI-102 (via QR), F-CLI-103 (via link invito)
**Business rules:** BR-042 (claim via codice), BR-040 (un solo proprietario attivo), BR-020 (formato codice)
**Scope di questa PR:** **solo l'endpoint API** `POST /v1/me/vehicles/claim`. La UI mobile (input
manuale F-CLI-101; scansione QR F-CLI-102; deep-link F-CLI-103) è in PR successive — i tre flussi
convergono tutti su questo stesso endpoint (il client estrae il codice e lo invia).

## Contesto e motivazione

I tre flussi di acquisizione veicolo lato cliente (codice manuale, QR sul tag fisico, link invito)
producono tutti lo stesso input: un `garage_code`. L'endpoint di claim è quindi la fondazione comune.
È il **percorso primario di onboarding B2C**: l'officina censisce un veicolo (già `certified` via
`POST /vehicles`), consegna al cliente il codice/tag, il cliente lo aggancia al proprio account.

Pattern API-first già consolidato (F-CLI-304 PR1, F-CLI-004 PR1): prima l'endpoint con i suoi test,
poi la UI mobile che lo consuma.

## Decisioni chiave

### Path: `/v1/me/vehicles/claim` (diverge dalla doc)
APPENDICE_A §2.4 documenta `POST /v1/vehicles/claim`, ma tutta la superficie cliente esistente è
`/v1/me/*` (`/me/vehicles`, `/me/vehicles/:id`, `/me/vehicles/:id/access-log`, `/me/profile`,
`/me/private-interventions`, `/me/deadlines`). Per coerenza l'endpoint vive sotto `/me/vehicles/claim`,
registrato in `me-vehicles.ts`. Nessuna collisione con `GET /me/vehicles/:id` (metodo diverso; in
Fastify le rotte statiche hanno priorità sulle parametriche). **APPENDICE_A va aggiornata** per
riflettere il path reale.

### Idempotenza: seguo BR-042, non APPENDICE_A
Conflitto doc: BR-042 (APPENDICE_F, regole non-negoziabili) dice che un veicolo **già posseduto dal
richiedente** restituisce **successo idempotente**; APPENDICE_A §2.4 lo elenca invece come
`409 vehicle_already_owned_by_you`. Per la regola «le business rule vincono» seguo BR-042: ramo
idempotente → `200 { status: 'already_owned' }`. APPENDICE_A va corretta rimuovendo quel 409.

### Codici errore dotted, non flat
Il codebase usa codici domain dotted (`me.vehicle.not_found`, …) perché il global error handler li
wrappa in RFC7807 solo se il `code` matcha `/[a-z]\.[a-z]/`. Mappo quindi i codici flat della doc a:
- `me.vehicle.claim.code_not_found` → 404
- `me.vehicle.claim.pending` → 422
- `me.vehicle.claim.archived` → 422
- `me.vehicle.claim.owned_by_other` → 409

### Request body camelCase
`{ garageCode: string }` (camelCase, coerente con le response `/me/vehicles*`). La doc usa
`garage_code` snake_case → segnalato e da allineare in APPENDICE_A.

## Architettura

### Endpoint
Nuova rotta `POST /v1/me/vehicles/claim` in `packages/api/src/routes/v1/me-vehicles.ts`.
Catena auth identica ai sibling: `preHandler: [requireAuth, requireClientiPool, clientiContext]`.

### Contesto RLS
Tutta la logica gira in `app.withContext({ customerId, role: 'user' }, async (tx) => …)`:
- `vehicles` ha policy `USING(true)` → il customer legge il veicolo per `garageCode`.
- `vehicle_ownerships` ha policy `ownerships_access USING(true)` (nessun `WITH CHECK` esplicito → la
  `USING` vale anche da `WITH CHECK` per l'INSERT) → il customer inserisce l'ownership in contesto
  utente, senza elevazione admin.

**Frontiera di sicurezza** = controllo app-layer di stato/ownership + partial unique index
`uq_ownership_vehicle_active` su `(vehicle_id) WHERE ended_at IS NULL` (BR-040). Non si fa
affidamento sulla sola RLS (lezione #154): ogni decisione di accesso è esplicita nell'handler.

### Request
```http
POST /v1/me/vehicles/claim
Authorization: Bearer <customer_jwt>
Content-Type: application/json

{ "garageCode": "GO-482-KXRT" }
```
Schema Zod: `garageCode` → `.trim().toUpperCase()` poi `.regex(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/)`
(BR-020). Formato non valido → `400` (validazione Zod, gestita dal global handler). La normalizzazione
tollera input QR/manuale con casing/spazi diversi.

### Logica
Lookup unico:
```ts
const vehicle = await tx.vehicle.findFirst({
  where: { garageCode },
  select: {
    id: true, garageCode: true, make: true, model: true, year: true, plate: true, status: true,
    ownerships: { where: { endedAt: null }, select: { customerId: true } },
  },
});
```

| Caso | Esito |
|---|---|
| `vehicle == null` | `404 me.vehicle.claim.code_not_found` |
| `status == 'pending'` | `422 me.vehicle.claim.pending` |
| `status == 'archived'` | `422 me.vehicle.claim.archived` |
| `certified`, `ownerships` vuoto | crea ownership → `200 { status: 'claimed' }` |
| `certified`, ownership attiva `customerId == richiedente` | `200 { status: 'already_owned' }` (idempotente, BR-042) |
| `certified`, ownership attiva di altro customer | `409 me.vehicle.claim.owned_by_other` |

Creazione ownership:
```ts
const ownership = await tx.vehicleOwnership.create({
  data: { vehicleId: vehicle.id, customerId, startedAt: new Date() },
  select: { id: true, startedAt: true },
});
```

**Gestione race** (due claim concorrenti su veicolo libero): il secondo INSERT viola
`uq_ownership_vehicle_active` → Prisma `P2002`. Catch → refetch dell'ownership attiva:
- ora di proprietà del richiedente → `200 { status: 'already_owned' }`
- di altro customer → `409 me.vehicle.claim.owned_by_other`

(Pattern catch-and-refetch già usato per la race P2002 in `POST /vehicles`.)

### Response `200`
```json
{
  "vehicle": { "id": "...", "garageCode": "GO-482-KXRT", "make": "Fiat", "model": "Panda",
               "year": 2021, "plate": "AB123CD" },
  "ownership": { "id": "...", "startedAt": "2026-06-05T14:32:05.000Z" },
  "status": "claimed"
}
```
camelCase, `status: 'claimed' | 'already_owned'`. `200` in entrambi i casi di successo (coerente con
doc §2.4). Per il ramo idempotente la `ownership` ritornata è quella già esistente.

## Cosa NON fa (YAGNI)
- **Nessuna scrittura `access_logs`**: la colonna `user_id` è NOT NULL e referenzia `users` (officina);
  il claim cliente non può popolarla (coerente col commento già presente in `me-vehicles.ts`). La
  notifica «claim veicolo (successo/fallimento)» dell'APPENDICE_F è materia di un futuro canale
  notifiche cliente, fuori scope.
- **Nessuna `customer_tenant_relation`**: il claim lega customer↔veicolo, non customer↔officina; le
  relation le crea l'officina quando tocca il customer (BR-041/BR-152).
- Niente UI mobile, scansione QR, deep-link, F-CLI-104 (pre-registrazione pending).

## Testing
- **Integration** (`packages/api/tests/integration`, pool clienti, IP `10.20.4x` libero, helper con
  `mockImplementation` per input dinamici): un caso per ramo BR-042 — `claimed`, `already_owned`
  (idempotente, ri-claim restituisce la stessa ownership senza crearne una seconda), `owned_by_other`
  409, `pending` 422, `archived` 422, `code_not_found` 404 — più formato non valido 400 e non
  autenticato 401. Verifica che dopo `claimed` esista esattamente una ownership attiva (BR-040).
- **Unit** FakePrisma per i branch dell'handler (stato veicolo + ownership self/other/none).
- Note: nuova rotta che tocca `vehicleOwnership.create` su FakePrisma → eseguire `test:unit` mirato
  (api), non solo typecheck.

## Documentazione da aggiornare
- **APPENDICE_A §2.4**: path → `/v1/me/vehicles/claim`; body/response camelCase; rimuovere il
  `409 vehicle_already_owned_by_you` (allineato a BR-042 → idempotente 200); aggiornare la tabella
  endpoint (riga §2.4).
- **APPENDICE_G**: aggiungere i 4 codici dotted (`me.vehicle.claim.code_not_found`,
  `me.vehicle.claim.pending`, `me.vehicle.claim.archived`, `me.vehicle.claim.owned_by_other`).
- **APPENDICE_F**: citare BR-042/BR-040 nei commenti del codice (nessuna modifica alla regola).

## Right-sizing
~5-6 task, single-file additivo, zero schema/migration/nuove dipendenze. **Inline (executing-plans)**
+ una review Opus finale, come F-CLI-304 PR1 / F-CLI-004 PR1.

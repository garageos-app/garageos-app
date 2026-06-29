# Appendice A — API Reference

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md` (Sezione 7). Leggere prima quella sezione per contesto generale, principi di design, autenticazione e rate limiting.
>
> **Versione:** v0.1 — allineata a `GarageOS-Specifiche.md` v0.9
> **Ultimo aggiornamento:** 21 aprile 2026

---

## Indice

1. [Convenzioni](#1-convenzioni)
2. [Endpoint dettagliati (core)](#2-endpoint-dettagliati-core)
3. [Riferimento completo endpoint](#3-riferimento-completo-endpoint)
4. [Schemi di risposta comuni](#4-schemi-di-risposta-comuni)

---

## 1. Convenzioni

### 1.1 Notazione

Ogni endpoint è descritto con:

- **Metodo + Path**: es. `POST /vehicles`
- **Auth**: tipo di autenticazione richiesta (`None` | `Tenant User` | `Customer` | `Admin`)
- **Required Role**: se richiede ruolo specifico (es. `super_admin`)
- **Feature**: riferimento alla funzionalità F-XXX-YYY della Sezione 3
- **Request**: schema del body (se POST/PUT/PATCH)
- **Response**: schema del body di risposta
- **Errors**: codici di errore specifici

### 1.2 Tipi di autenticazione

- `None`: endpoint pubblico
- `Tenant User`: richiede JWT da pool Cognito "officine"
- `Customer`: richiede JWT da pool Cognito "clienti"
- `Any User`: accetta JWT da entrambi i pool
- `Admin`: richiede JWT con claim admin (team GarageOS)
- `Platform Admin`: richiede JWT da pool Cognito `platform-admins` (console di piattaforma GarageOS); preHandler `requirePlatformAdminsPool`

### 1.3 Header comuni

| Header | Valore | Obbligatorio | Note |
|---|---|---|---|
| `Authorization` | `Bearer <jwt>` | Salvo endpoint pubblici | |
| `Content-Type` | `application/json` | POST/PUT/PATCH con body | |
| `Accept-Language` | `it-IT` | No | Default it-IT in v1 |
| `Idempotency-Key` | UUID | Consigliato su POST critiche | |
| `X-Request-ID` | UUID | No (auto-generato) | Propagato nei log |

---

## 2. Endpoint dettagliati (core)

In questa sezione si documentano in modo **completo** gli endpoint più rappresentativi e complessi. I restanti endpoint seguono lo stesso pattern e sono elencati nella Sezione 3.

### 2.1 `POST /vehicles` — Censimento nuovo veicolo

**Feature:** F-OFF-102, F-OFF-103
**Auth:** Tenant User (qualsiasi ruolo)
**Rate limit:** standard utente

#### Descrizione

Censisce un nuovo veicolo nel sistema. L'officina fornisce i dati tecnici (presi dal libretto di circolazione) e i dati del cliente proprietario. Il sistema genera automaticamente il `garage_code` univoco e crea la relazione `customer_tenant_relation` e la `vehicle_ownership`.

#### Request

```http
POST /v1/vehicles
Content-Type: application/json
Authorization: Bearer <tenant_user_jwt>
Idempotency-Key: 01HKXM9...

{
  "vehicle": {
    "vin": "ZFA16900000512345",
    "plate": "AB123CD",
    "plate_country": "IT",
    "make": "Fiat",
    "model": "Panda",
    "version": "1.2 Lounge",
    "year": 2021,
    "registration_date": "2021-03-15",
    "vehicle_type": "car",
    "fuel_type": "petrol",
    "engine_displacement": 1242,
    "power_kw": 51,
    "color": "Bianco Gelato",
    "odometer_km": 45000
  },
  "customer": {
    "mode": "create_new",
    "first_name": "Mario",
    "last_name": "Rossi",
    "email": "mario.rossi@example.com",
    "phone": "+39 333 1234567",
    "tax_code": "RSSMRA80A01H501Z",
    "is_business": false
  },
  "location_id": "01HKXP3...",
  "send_invitation_email": true
}
```

#### Request schema (dettaglio)

**`vehicle` (oggetto)**:
| Campo | Tipo | Obbligatorio | Validazione |
|---|---|---|---|
| `vin` | string | sì | 17 char alfanumerici, checksum VIN |
| `plate` | string | sì | max 10 char |
| `plate_country` | string | no (default `IT`) | ISO 3166-1 alpha-2 |
| `make` | string | sì | max 50 char |
| `model` | string | sì | max 100 char |
| `version` | string | no | max 150 char |
| `year` | integer | sì | tra 1900 e anno corrente + 1 |
| `registration_date` | date ISO | no | |
| `vehicle_type` | enum | sì | `car` \| `motorcycle` \| `van` \| `truck` \| `agricultural` |
| `fuel_type` | enum | sì | `petrol` \| `diesel` \| `electric` \| `hybrid` \| `lpg` \| `methane` \| `hydrogen` \| `other` |
| `engine_displacement` | integer | no | cc |
| `power_kw` | integer | no | |
| `color` | string | no | |
| `odometer_km` | integer | sì | km attuali, ≥ 0 |

**`customer` (oggetto con discriminator su `mode`)**:

Se `mode = "existing"`:
| Campo | Tipo | Obbligatorio |
|---|---|---|
| `mode` | `"existing"` | sì |
| `customer_id` | UUID | sì |

Se `mode = "create_new"`:
| Campo | Tipo | Obbligatorio | Validazione |
|---|---|---|---|
| `mode` | `"create_new"` | sì | |
| `first_name` | string | sì | max 100 |
| `last_name` | string | sì | max 100 |
| `email` | string | sì | email RFC 5322 |
| `phone` | string | no | formato E.164 consigliato |
| `tax_code` | string | no | 16 char (persona) o 11 char (azienda) |
| `is_business` | boolean | no (default false) | |
| `business_name` | string | sì se is_business | |
| `vat_number` | string | sì se is_business | |

Altri campi nel root:
| Campo | Tipo | Obbligatorio | Note |
|---|---|---|---|
| `location_id` | UUID | sì | Deve appartenere al tenant del JWT |
| `send_invitation_email` | boolean | no (default true) | Se false, niente email al cliente |

#### Response `201 Created`

```json
{
  "vehicle": {
    "id": "01HKXN5...",
    "garage_code": "GO-482-KXRT",
    "vin": "ZFA16900000512345",
    "plate": "AB123CD",
    "plate_country": "IT",
    "make": "Fiat",
    "model": "Panda",
    "version": "1.2 Lounge",
    "year": 2021,
    "registration_date": "2021-03-15",
    "vehicle_type": "car",
    "fuel_type": "petrol",
    "engine_displacement": 1242,
    "power_kw": 51,
    "color": "Bianco Gelato",
    "status": "certified",
    "certified_at": "2026-04-21T14:32:05Z",
    "certified_by_tenant_id": "01HKXL0...",
    "created_at": "2026-04-21T14:32:05Z"
  },
  "customer": {
    "id": "01HKXN6...",
    "first_name": "Mario",
    "last_name": "Rossi",
    "email": "mario.rossi@example.com",
    "phone": "+39 333 1234567",
    "app_installed": false,
    "status": "active"
  },
  "ownership": {
    "id": "01HKXN7...",
    "vehicle_id": "01HKXN5...",
    "customer_id": "01HKXN6...",
    "started_at": "2026-04-21T14:32:05Z"
  },
  "invitation": {
    "id": "01HKXN8...",
    "target_email": "mario.rossi@example.com",
    "expires_at": "2026-05-21T14:32:05Z",
    "sent": true
  }
}
```

#### Errori specifici

| Status | Codice | Scenario |
|---|---|---|
| 400 | `invalid_vin_checksum` | VIN non rispetta checksum standard |
| 400 | `invalid_plate_format` | Formato targa non valido per il paese |
| 409 | `duplicate_vin` | Esiste già un veicolo con questo VIN |
| 409 | `duplicate_plate_warning` | Esiste targa identica ma VIN diverso (richiede conferma esplicita con `force: true`) |
| 422 | `location_not_in_tenant` | La location indicata non appartiene al tenant |

#### Note di implementazione

- Il `garage_code` è generato in transazione: 3 tentativi in caso di collisione UUID
- L'invio dell'email di invito avviene in background (job asincrono) se `send_invitation_email: true`
- La relazione `customer_tenant_relation` è creata automaticamente
- L'endpoint registra una riga in `access_log` con action `create`
- Per scaricare il PDF del tag, chiamare `GET /v1/vehicles/:id/tag` (vedi §2.13).

---

### 2.1bis `GET /v1/intervention-types` — Lista tipi intervento

**Feature:** F-OFF-302
**Auth:** Officine pool (mechanic / super_admin)

#### Descrizione

Ritorna l'unione di tipi system-wide (12 righe predefinite, `tenant_id IS NULL`) e tipi custom dell'officina autenticata. Usato dal form crea intervento per popolare il dropdown "Tipo intervento".

#### Request

```http
GET /v1/intervention-types
Authorization: Bearer <officine_user_jwt>
```

Nessun body, nessun query param.

#### Response `200 OK`

```jsonc
{
  "data": [
    {
      "id": "01HSYS...",
      "code": "TAGLIANDO",
      "nameIt": "Tagliando",
      "description": "Tagliando periodico completo secondo piano manutenzione",
      "icon": "wrench",
      "category": "maintenance",
      "suggestsDeadline": true,
      "defaultDeadlineMonths": 12,
      "defaultDeadlineKm": 15000,
      "custom": false
    }
    // … altri tipi system + tenant custom
  ]
}
```

- `category` enum: `maintenance | tires | repair | inspection | body | other`
- `custom: true` per righe del tenant, `custom: false` per system rows
- Ordinamento server-side: `(category ASC, nameIt ASC)`

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 401 | `UNAUTHORIZED` | Token assente o invalido |
| 403 | `FORBIDDEN` | Token clienti pool |

---

### 2.2 `POST /vehicles/:id/interventions` — Registrazione intervento

**Feature:** F-OFF-301, F-OFF-308
**Auth:** Tenant User (qualsiasi ruolo, must have access to vehicle)
**Rate limit:** standard utente

#### Descrizione

Registra un nuovo intervento officina su un veicolo. Può opzionalmente creare una scadenza successiva suggerita dal tipo di intervento.

#### Request

```http
POST /v1/vehicles/01HKXN5.../interventions
Content-Type: application/json
Authorization: Bearer <officine_user_jwt>

{
  "interventionTypeId": "01HSYS...",
  "interventionDate": "2026-04-21",
  "odometerKm": 45000,
  "title": "Tagliando completo",
  "description": "Sostituzione olio motore 5W30, filtro olio, filtro aria, filtro abitacolo. Controllo livelli e usura pastiglie freni.",
  "partsReplaced": [
    { "name": "Olio motore Selenia 5W30", "code": "SEL-5W30-4L", "quantity": 4, "notes": "Litri" },
    { "name": "Filtro olio", "code": "UFI-23.145.02", "quantity": 1 }
  ],
  "internalNotes": "Cliente segnala leggero rumore sospensione anteriore sx",
  "createDeadline": {
    "enabled": true,
    "monthsFromNow": 12,
    "kmIncrement": 15000
  },
  "forceKmDecrease": false
}
```

#### Response `201 Created`

```jsonc
{
  "intervention": {
    "id": "01HKXQ...",
    "tenantId": "01HKXL0...",
    "locationId": "01HKXP3...",
    "userId": "01HKXP8...",
    "vehicleId": "01HKXN5...",
    "interventionTypeId": "01HSYS...",
    "interventionType": {
      "id": "01HSYS...",
      "code": "TAGLIANDO",
      "nameIt": "Tagliando"
    },
    "interventionDate": "2026-04-21",
    "odometerKm": 45000,
    "title": "Tagliando completo",
    "description": "...",
    "partsReplaced": [...],
    "internalNotes": "...",
    "status": "active",
    "kmAnomaly": false,
    "wikiLockedAt": null,
    "createdAt": "2026-04-21T14:32:05Z"
  },
  "deadline": {
    "id": "01HKXR...",
    "dueDate": "2027-04-21",
    "dueOdometerKm": 60000,
    "interventionTypeId": "01HSYS...",
    "status": "open"
  }
  // notifications_scheduled[] — DEFERRED v1.1 (BR-064/066/129 pending)
}
```

#### Errori specifici

| Status | Codice | Scenario |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body Zod validation fail (errors[] dettagliato) |
| 400 | `intervention.creation.date_future` | Data futura non consentita (BR-069) |
| 400 | `intervention.creation.date_before_registration` | Data precedente all'immatricolazione del veicolo (BR-070) |
| 401 | `UNAUTHORIZED` | Token assente o invalido |
| 403 | `FORBIDDEN` | Token clienti pool su route officine |
| 404 | `NOT_FOUND` | Veicolo o tipo intervento non trovato/non accessibile |
| 409 | `intervention.creation.odometer_decrease_warning` | Km inferiori al massimo storico (BR-068) — recoverable: re-POST con `forceKmDecrease=true` |
| 422 | `intervention.creation.user_no_location` | Utente autenticato senza locationId |
| 422 | `vehicle.modification.archived` | Veicolo in stato `archived` (BR-061) |

---

### 2.3 `POST /v1/me/transfers` — Avvia passaggio di proprietà

**Feature:** F-CLI-401
**Auth:** Customer (deve essere attuale proprietario del veicolo)

> **Nota implementazione PR1 (2026-06):** il path reale è `POST /v1/me/transfers` (consolidato nella surface `/me/*` del customer). PR1 implementa solo `method: "physical_code"` (genera un codice `TR-XXXX-XXXX`, DB enum `initiated_by_seller`). Il metodo `email_invitation` è differito a quando il canale email sarà sbloccato. I tre endpoint di PR1 sono: `POST /me/transfers`, `GET /me/transfers`, `GET /me/transfers/:id`.

> **Nota implementazione PR2 (2026-06):** implementati `POST /me/transfers/:code/accept` (cessionario accetta, stato -> `pending_seller_confirmation`, `expiresAt` resettato a +7gg dall'accettazione, BR-043), `POST /me/transfers/:id/confirm` (cedente conferma -> swap atomico della proprieta, stato `completed`) e `POST /me/transfers/:id/reject` (entrambe le parti, finche non `completed`). accept/confirm non hanno body; reject accetta `{ reason?: string }` (max 500). Solo `physical_code`; notifiche ed email differite.

> **Nota implementazione PR4 (2026-06):** aggiunto `GET /me/transfers/:code/preview`: peek read-only del transfer tramite codice (il cessionario vede il veicolo prima dell'accept one-shot). Stessa catena di guardie dell'accept — `transfer.not_found` 404, `transfer.acceptance.self_not_allowed` 403, `transfer.acceptance.already_completed` 409, `transfer.acceptance.expired` 410, `transfer.acceptance.not_pending_recipient` 422 — senza side effect; risposta `{ transfer }` con lo stesso DTO (nessuna PII venditore). Nessun nuovo error code.

#### Descrizione

Il proprietario attuale avvia un passaggio di proprietà del veicolo. Può indicare l'email del cessionario (invito via email) oppure generare un codice temporaneo da condividere fisicamente.

#### Request

```http
POST /v1/me/transfers
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "vehicleId": "01HKXN5...",
  "method": "physical_code"
}
```

> `email_invitation` (con campo `invitedEmail`) è differito; attualmente solo `physical_code` è accettato.

#### Response `201 Created` (camelCase)

```json
{
  "id": "01HKYT...",
  "vehicleId": "01HKXN5...",
  "method": "physical_code",
  "transferCode": "TR-9K4M-7P2X",
  "status": "pending_recipient",
  "expiresAt": "2026-04-28T14:32:05Z",
  "createdAt": "2026-04-21T14:32:05Z",
  "vehicle": {
    "plate": "AB123CD",
    "make": "Fiat",
    "model": "500"
  }
}
```

`expiresAt` = 7 giorni dalla creazione. La risposta è in camelCase.

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 404 | `transfer.creation.vehicle_not_found` | `vehicleId` inesistente o fuori perimetro del customer |
| 403 | `transfer.creation.not_current_owner` | Il customer non è il proprietario attuale |
| 409 | `vehicle.archived` | Il veicolo è archiviato |
| 422 | `transfer.creation.vehicle_not_certified` | Impossibile trasferire veicolo in stato pending (BR-046) |
| 409 | `transfer.creation.already_pending` | Esiste già un trasferimento attivo per questo veicolo (BR-047) |

> I codici piatti `not_current_owner`, `transfer_already_pending`, `vehicle_not_certified` mostrati nella specifica originale sono sostituiti dalla famiglia dotted `transfer.creation.*` (vedi APPENDICE_G §3.8).

---

### 2.3bis `POST /vehicles/:id/ownership-transfer` — Trasferimento proprietà officina-mediated

**Feature:** F-OFF-110
**BR:** BR-049
**Auth:** Officine pool, ruolo `super_admin` o `mechanic`

#### Descrizione

L'officina trasferisce la proprietà di un veicolo certificato da un cliente esistente a un nuovo proprietario, in una singola operazione atomica. Variante single-step di BR-043: il cedente è fisicamente presente in officina, il libretto sostituisce la doppia conferma remota.

#### Path

```
POST /v1/vehicles/:id/ownership-transfer
```

#### Body

```json
{
  "recipient": {
    "kind": "existing",
    "customerId": "uuid"
  },
  "reason": "purchase",
  "notes": "string opzionale (max 1000)"
}
```

Oppure cessionario nuovo:

```json
{
  "recipient": {
    "kind": "new",
    "firstName": "Anna",
    "lastName": "Rossi",
    "email": "anna@example.com",
    "phone": "+39 333 1234567",
    "codiceFiscale": "RSSANN80A41H501Z",
    "isBusiness": false,
    "businessName": null,
    "vatNumber": null
  },
  "reason": "inheritance"
}
```

`reason` ∈ `purchase | inheritance | company_assignment | other`. Per `recipient.kind='new'`, se `isBusiness=true` allora `businessName` + `vatNumber` sono obbligatori. Se l'email corrisponde a un customer esistente (anche cross-tenant), il customer viene riusato e `customer_tenant_relations` upsert per l'officina corrente.

`documentS3Key` (opzionale, stringa, max 500, nullable) — chiave S3 restituita dall'endpoint `document-upload-url` (§2.3ter). Quando presente, il server verifica l'oggetto su S3 (`headObject`) e, se valido, lo salva come `VehicleTransfer.documentUrl`. In caso di chiave malformata, oggetto assente, dimensione o formato non conforme → `422 vehicle.transfer.document_invalid`. Se S3 è irraggiungibile durante la verifica → `502 vehicle.transfer.document_s3_unavailable`.

#### Response 200

```json
{
  "vehicle": { /* vehicleDetailSelect shape */ },
  "ownership": { "id": "uuid", "customerId": "uuid", "startedAt": "ISO" },
  "transfer": {
    "id": "uuid",
    "status": "completed",
    "completedAt": "ISO",
    "reason": "purchase",
    "notes": null
  }
}
```

#### Errori

Famiglia `vehicle.transfer.*` — vedi APPENDICE_G:
- `404 vehicle.not_found` — veicolo non visibile all'officina (RLS: deve aver creato O certificato)
- `422 vehicle.transfer.pending_not_transferable` — BR-046
- `422 vehicle.transfer.archived`
- `422 vehicle.transfer.no_active_ownership`
- `422 vehicle.transfer.recipient_not_found` — `kind=existing` customerId inesistente
- `409 vehicle.transfer.active_transfer_exists` — BR-047
- `409 vehicle.transfer.same_owner`
- `403 vehicle.transfer.role_denied` — ruolo non super_admin/mechanic
- `422 vehicle.transfer.document_invalid` — `documentS3Key` presente ma non valido (chiave malformata, oggetto assente su S3, o size/formato non conforme)
- `502 vehicle.transfer.document_s3_unavailable` — S3 irraggiungibile durante la verifica del documento

---

### 2.3ter `POST /vehicles/:id/ownership-transfer/document-upload-url` — Pre-firma upload libretto

**Feature:** F-OFF-110
**BR:** BR-049
**Auth:** Officine pool, ruolo `super_admin` o `mechanic`

#### Descrizione

Genera una pre-signed PUT URL per caricare il libretto di circolazione del veicolo prima di eseguire il trasferimento officina-mediated. La chiave S3 restituita (`s3Key`) va passata come `documentS3Key` nell'endpoint §2.3bis. L'URL scade dopo 15 minuti.

#### Path

```
POST /v1/vehicles/:id/ownership-transfer/document-upload-url
```

#### Body

```json
{
  "fileName": "libretto-fiat-500.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 2097152
}
```

| Campo | Tipo | Vincoli |
| --- | --- | --- |
| `fileName` | string | 1–255 caratteri, no control bytes |
| `mimeType` | string | `image/jpeg` \| `image/png` \| `application/pdf` \| `image/heic` |
| `sizeBytes` | integer | 1 – 10 485 760 (10 MB) |

#### Response 200

```json
{
  "uploadUrl": "https://s3.eu-west-1.amazonaws.com/...",
  "uploadMethod": "PUT",
  "uploadHeaders": {
    "Content-Type": "application/pdf"
  },
  "s3Key": "vehicle-transfers/<vehicleId>/<uuid>.pdf",
  "expiresAt": "2026-05-22T10:15:00.000Z"
}
```

Il client deve eseguire `PUT <uploadUrl>` con header `Content-Type` ricevuto e il file come corpo (nessun multipart). Dopo l'upload, passare `s3Key` come `documentS3Key` nella chiamata §2.3bis.

#### Errori

- `400` — body non valido (campo mancante, mimeType non consentito, sizeBytes fuori range)
- `401` — non autenticato
- `403 vehicle.transfer.role_denied` — ruolo non super_admin/mechanic
- `404 vehicle.not_found` — veicolo non visibile all'officina
- `502 vehicle.transfer.document_s3_unavailable` — S3 irraggiungibile durante la firma della URL

---

### 2.4 `POST /me/vehicles/claim` — Aggancio veicolo da codice (cliente)

**Feature:** F-CLI-101, F-CLI-102, F-CLI-103
**Auth:** Customer

> **Nota implementazione (F-CLI-101):** path `/v1/me/vehicles/claim` — divergente
> dalla v1 della doc (`/v1/vehicles/claim`) per coerenza con la superficie cliente
> `/me/*`. Body/response in **camelCase**. Idempotenza allineata a **BR-042**:
> veicolo già posseduto dal richiedente → `200 { "status": "already_owned" }`
> (non più `409 vehicle_already_owned_by_you`). Codici errore in forma dotted
> (`me.vehicle.claim.*`, vedi APPENDICE_G), wrappati RFC7807.

#### Descrizione

Il cliente finale aggancia un veicolo al proprio account inserendo il codice GarageOS. Usato sia per inserimento manuale (F-CLI-101) che per scansione QR (F-CLI-102) e link invito (F-CLI-103): il client invia solo il codice estratto. Il server normalizza il codice (trim + uppercase) prima della validazione BR-020.

#### Request

```http
POST /v1/me/vehicles/claim
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "garageCode": "GO-482-KXRT"
}
```

#### Response `200 OK`

```json
{
  "vehicle": {
    "id": "01HKXN5...",
    "garageCode": "GO-482-KXRT",
    "make": "Fiat",
    "model": "Panda",
    "year": 2021,
    "plate": "AB123CD"
  },
  "ownership": {
    "id": "01HKXN7...",
    "startedAt": "2026-04-21T14:32:05.000Z"
  },
  "status": "claimed"
}
```

`status` è `"claimed"` quando l'ownership viene creata, `"already_owned"` quando il richiedente possedeva già il veicolo (idempotente, BR-042 — in tal caso `ownership` è quella esistente).

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 400 | _(validazione Zod)_ | `garageCode` mancante o formato non valido (BR-020) |
| 404 | `me.vehicle.claim.code_not_found` | Codice non esistente |
| 409 | `me.vehicle.claim.owned_by_other` | Veicolo già di un altro cliente (usare il passaggio di proprietà) |
| 422 | `me.vehicle.claim.pending` | Veicolo `pending` non ancora certificato |
| 422 | `me.vehicle.claim.archived` | Veicolo archiviato |

---

### 2.4b `POST /me/push-tokens` + `DELETE /me/push-tokens/:id` — Registrazione push token (cliente)

**Feature:** F-CLI-302 (PR1)
**Auth:** Customer

> **Nota implementazione (F-CLI-302 PR1):** solo registrazione del token; la
> _delivery_ delle push (estensione del dispatcher all'Expo Push API) è una PR
> successiva. La tabella `push_tokens` e la sua RLS esistono già (init migration).
> Body/response in **camelCase**. **POST gira sotto `role:'admin'`** (pinnando
> sempre `customer_id` al chiamante): `expo_push_token` è univoco globale, quindi
> su uno switch di account sullo stesso device occorre **riassegnare** una riga di
> un altro cliente — impossibile sotto `role:'user'` (la RLS la nasconde → P2002).
> **DELETE gira sotto `role:'user'`** (la RLS limita al chiamante; un id altrui è
> invisibile → 404).

#### Descrizione

Il cliente registra il push token Expo del proprio dispositivo (opt-in dalla
schermata Notifiche). Upsert **BR-254**: (1) se il token esiste già → refresh +
riassegnazione al chiamante; (2) altrimenti se esiste una riga attiva per lo
stesso `(customerId, deviceName)` → aggiorna il token (rotazione device);
(3) altrimenti crea una nuova riga. Imposta `customer.app_installed = true`
(BR-224).

#### Request — POST

```http
POST /v1/me/push-tokens
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "expoPushToken": "ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "android",
  "deviceName": "Pixel 7",
  "appVersion": "0.1.0"
}
```

`platform` ∈ `{ ios, android }`. `deviceName` e `appVersion` sono opzionali.

#### Response `201 Created`

```json
{ "id": "01HKXN5..." }
```

#### Request — DELETE

```http
DELETE /v1/me/push-tokens/01HKXN5...
Authorization: Bearer <customer_jwt>
```

#### Response `204 No Content`

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 400 | _(validazione Zod)_ | `platform` non valido, `expoPushToken` mancante, o `:id` non UUID |
| 422 | `me.push-token.register.invalid_token` | `expoPushToken` malformato (atteso `ExpoPushToken[...]`) |
| 422 | `me.push-token.register.unknown_field` | Chiave fuori schema nel body POST |
| 404 | `me.push-token.not_found` | DELETE di un id inesistente o di un altro cliente (RLS) |

---

### 2.4c `GET /v1/me/interventions/:id` — Dettaglio intervento officina + contestazioni

**Feature:** F-CLI-206 · **Auth:** Customer (clienti pool)

Restituisce un singolo intervento officina e il **thread delle contestazioni del cliente** su di esso. Il chiamante deve essere il proprietario attuale del veicolo (gate app-layer); altrimenti `404`.

**Response 200:**

```json
{
  "intervention": {
    "id": "uuid",
    "vehicleId": "uuid",
    "interventionDate": "2026-05-01",
    "odometerKm": 84210,
    "type": { "code": "TAGLIANDO", "name_it": "Tagliando" },
    "title": "Tagliando completo",
    "description": "...",
    "partsReplacedCount": 3,
    "status": "disputed",
    "isDisputed": true,
    "tenant": { "businessName": "Officina Rossi", "locationCity": "Milano" },
    "attachmentsCount": 2
  },
  "disputes": [
    {
      "id": "uuid",
      "reasonCategory": "wrong_data",
      "customerDescription": "...",
      "status": "responded",
      "createdAt": "2026-05-02T10:00:00.000Z",
      "tenantResponse": "...",
      "tenantResponseAt": "2026-05-03T09:00:00.000Z",
      "resolvedAt": null
    }
  ]
}
```

**Errori:** `404 me.intervention.not_found` (intervento inesistente o veicolo non più di proprietà del cliente).

---

### 2.4d Scadenze personali — `/v1/me/personal-deadlines` (F-CLI-306)

**Feature:** F-CLI-306 · **Auth:** Customer (pool `clienti`) · **BR:** BR-290..BR-296

Sei endpoint per la gestione delle scadenze personali del cliente sui propri veicoli (assicurazione, bollo, revisione, ecc.). La superficie è **interamente privata**: nessun endpoint officina espone questi dati (BR-291). Sicurezza app-layer: RLS `USING(true)` + filtro `customerId` su ogni query (lezione #154 — mai solo RLS).

---

#### `POST /v1/me/personal-deadlines` — Crea scadenza

Crea una nuova scadenza sul veicolo indicato e materializza le righe reminder. BR-290: il caller deve essere proprietario attivo del veicolo.

**Request:**

```http
POST /v1/me/personal-deadlines
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "vehicleId": "01HKXN5...",
  "category": "insurance",
  "dueDate": "2027-03-15",
  "reminderLeadDays": [30, 7, 0],
  "notifyPush": true,
  "notifyEmail": true
}
```

Campi opzionali: `customLabel` (stringa, obbligatoria sse `category='other'`, max 80 char, BR-294), `recurrenceMonths` (int 1–120), `reminderDailyTailDays` (int 0–30, BR-293), `notes` (max 500 char).

**Response `201 Created`:**

```json
{
  "id": "uuid",
  "vehicleId": "uuid",
  "vehicle": { "plate": "AB123CD", "make": "Fiat", "model": "500" },
  "category": "insurance",
  "customLabel": null,
  "dueDate": "2027-03-15",
  "recurrenceMonths": null,
  "reminderLeadDays": [30, 7, 0],
  "reminderDailyTailDays": null,
  "notifyPush": true,
  "notifyEmail": true,
  "status": "open",
  "notes": null,
  "completedAt": null,
  "createdAt": "2026-06-16T10:00:00.000Z",
  "updatedAt": "2026-06-16T10:00:00.000Z"
}
```

**Errori:**

| Status | Code | Scenario |
|---|---|---|
| 403 | `personal_deadline.vehicle_not_owned` | `vehicleId` non di proprietà del caller o inesistente (BR-290) |
| 422 | `personal_deadline.custom_label_required` | `category='other'` senza `customLabel` (BR-294) |

---

#### `GET /v1/me/personal-deadlines` — Lista scadenze

Lista le scadenze del caller, ordinate per `dueDate` ascendente. Nessuna paginazione (volume atteso basso per cliente).

**Request:**

```http
GET /v1/me/personal-deadlines?status=open&vehicleId=01HKXN5...
Authorization: Bearer <customer_jwt>
```

Query opzionali: `status` (`open | completed | overdue | cancelled`), `vehicleId` (UUID).

**Response `200 OK`:**

```json
{
  "data": [
    { /* PersonalDeadlineDto */ }
  ]
}
```

---

#### `GET /v1/me/personal-deadlines/:id` — Dettaglio scadenza

```http
GET /v1/me/personal-deadlines/01HKXN5...
Authorization: Bearer <customer_jwt>
```

**Response `200 OK`:**

```json
{
  "personalDeadline": { /* PersonalDeadlineDto */ }
}
```

**Errori:** `404 personal_deadline.not_found` (inesistente o di un altro cliente — non rivela l'esistenza).

---

#### `PATCH /v1/me/personal-deadlines/:id` — Modifica scadenza

Aggiornamento parziale. Se cambia `dueDate`, `reminderLeadDays` o `reminderDailyTailDays`, i reminder `pending` vengono rigenerati (i `sent`/`failed`/`cancelled` restano intatti — append-only).

**Request (tutti i campi opzionali):**

```http
PATCH /v1/me/personal-deadlines/01HKXN5...
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "dueDate": "2027-04-01",
  "reminderLeadDays": [14, 0]
}
```

Campi modificabili: `category`, `customLabel`, `dueDate`, `recurrenceMonths`, `reminderLeadDays`, `reminderDailyTailDays`, `notifyPush`, `notifyEmail`, `notes`.

**Response `200 OK`:**

```json
{
  "personalDeadline": { /* PersonalDeadlineDto aggiornato */ }
}
```

**Errori:**

| Status | Code | Scenario |
|---|---|---|
| 404 | `personal_deadline.not_found` | Scadenza inesistente o di un altro cliente |
| 422 | `personal_deadline.update.empty_body` | Body vuoto o senza campi edibili |
| 422 | `personal_deadline.custom_label_required` | `category='other'` effettivo (body + DB) senza `customLabel` (BR-294) |

---

#### `DELETE /v1/me/personal-deadlines/:id` — Elimina scadenza

Eliminazione hard. La cascade DB rimuove anche le righe `personal_deadline_reminders`.

```http
DELETE /v1/me/personal-deadlines/01HKXN5...
Authorization: Bearer <customer_jwt>
```

**Response:** `204 No Content`

**Errori:** `404 personal_deadline.not_found`

---

#### `POST /v1/me/personal-deadlines/:id/complete` — Completa scadenza

Porta la scadenza da `open` a `completed` e cancella i reminder `pending`. Se la scadenza è ricorrente (`recurrenceMonths != null`), la risposta include `renewalSuggestion` con i dati precompilati per la prossima scadenza (BR-296 — nessuna auto-creazione; il cliente conferma nel form).

```http
POST /v1/me/personal-deadlines/01HKXN5.../complete
Authorization: Bearer <customer_jwt>
```

Nessun body.

**Response `200 OK` (scadenza non ricorrente):**

```json
{
  "personalDeadline": { /* PersonalDeadlineDto con status='completed' */ }
}
```

**Response `200 OK` (scadenza ricorrente):**

```json
{
  "personalDeadline": { /* PersonalDeadlineDto con status='completed' */ },
  "renewalSuggestion": {
    "suggestedDueDate": "2028-03-15",
    "category": "insurance",
    "recurrenceMonths": 12,
    "reminderLeadDays": [30, 7, 0],
    "notifyPush": true,
    "notifyEmail": true
  }
}
```

`renewalSuggestion` può includere `customLabel` (se presente nella scadenza originale) e `reminderDailyTailDays` (se valorizzato). Il campo `suggestedDueDate` è calcolato come `dueDate + recurrenceMonths` con aritmetica UTC sul calendario.

**Errori:**

| Status | Code | Scenario |
|---|---|---|
| 404 | `personal_deadline.not_found` | Scadenza inesistente o di un altro cliente |
| 409 | `personal_deadline.not_open` | Scadenza in stato terminale (`completed`/`cancelled`); `open`/`overdue` sono completabili (BR-298) |

---

### 2.5 `GET /vehicles/:id/timeline` — Storico interventi veicolo

**Feature:** F-OFF-105, F-CLI-201, F-CLI-205
**Auth:** Any User (con accesso al veicolo)

#### Descrizione

Restituisce la timeline unificata degli interventi del veicolo (officina + privati del customer richiedente), paginata e ordinata dal più recente.

#### Request

```http
GET /v1/vehicles/01HKXN5.../timeline?limit=20&cursor=eyJpZCI6...
Authorization: Bearer <any_user_jwt>
```

**Query parameters:**
| Nome | Tipo | Default | Note |
|---|---|---|---|
| `limit` | int | 20 | max 100 |
| `cursor` | string | - | Cursor paginazione |
| `type` | enum | `all` | `all` \| `shop_only` \| `private_only` |
| `from_date` | date | - | Filtra da data |
| `to_date` | date | - | Filtra fino a data |
| `tenant_ids` | string | - | UUID officine separati da virgola; filtra gli interventi officina a quelle officine (assente ⇒ tutte). UUID malformato ⇒ `400`. La lista delle officine presenti è in `GET …/timeline/officine`. |

#### Response `200 OK`

```json
{
  "data": [
    {
      "kind": "shop_intervention",
      "id": "01HKXQ...",
      "intervention_date": "2026-04-21",
      "odometer_km": 45000,
      "type": { "id": "uuid...", "code": "TAGLIANDO", "name_it": "Tagliando" },
      "title": "Tagliando completo",
      "description": "...",
      "parts_replaced_count": 4,
      "status": "active",
      "is_disputed": false,
      "wiki_window_open": true,
      "viewer_is_owner": true,
      "tenant": {
        "id": "01HKXL0...",
        "business_name": "Officina Rossi S.r.l.",
        "location_city": "Milano"
      },
      "has_attachments": true,
      "attachments_count": 2
    },
    {
      "kind": "private_intervention",
      "id": "01HKYP...",
      "intervention_date": "2026-03-10",
      "odometer_km": 43500,
      "custom_type": "Rabbocco liquido tergicristalli",
      "description": "...",
      "has_attachments": false
    }
  ],
  "meta": {
    "cursor": "eyJpZCI6IjAxSEtZUCJ9",
    "has_more": true,
    "total_interventions": 8,
    "shop_count": 6,
    "private_count": 2
  }
}
```

#### Campi `shop_intervention` (selezione)

| Campo | Tipo | Note |
|---|---|---|
| `type.id` | string (uuid) | Intervention type UUID. Used by clients that need to populate edit forms with the current type. |
| `type.code` | string | Codice mnemonico (es. `TAGLIANDO`). |
| `type.name_it` | string | Nome localizzato italiano. |
| `wiki_window_open` | boolean | Server-computed BR-062 predicate. `true` = free edits, no revision row created. `false` = audit active; subsequent PATCH requires `reason` ≥10 chars per BR-064. Computed from `wikiLockedAt IS NULL AND firstSeenByCustomerAt IS NULL AND now() - createdAt < 48h`. |
| `tenant.id` | string (uuid) | UUID dell'officina autrice. Chiave per il colore per-officina e il filtro `tenant_ids` lato client. |
| `viewer_is_owner` | boolean | `true` se l'officina chiamante ha creato l'intervento. `false` cross-tenant (BR-150/BR-153) e sempre `false` per il pool clienti. Il client lo usa per la sola-lettura (niente Modifica/risposta-dispute) sulle righe di altre officine. |

#### `GET /v1/vehicles/:id/timeline/officine` — Officine presenti nella timeline

**Auth:** Tenant User (pool `officine`). Restituisce la lista **distinta** delle officine con ≥1 intervento officina sul veicolo, ordinata per `business_name`. Alimenta il filtro multiselect e l'assegnazione colori stabile (indipendente dalla paginazione).

```json
{
  "data": [
    { "tenant_id": "01HKXL0...", "business_name": "Officina Matula", "viewer_is_owner": true },
    { "tenant_id": "01HKXM2...", "business_name": "Officina Soriente", "viewer_is_owner": false }
  ]
}
```

Errori: `400` UUID veicolo malformato · `404` veicolo inesistente · `403` pool clienti.

#### Regole di visibilità

- **Se richiedente è `Tenant User`**: vede `shop_interventions` di tutti i tenant (regola §2.4.1), NON vede `private_interventions`
- **Se richiedente è `Customer` proprietario attuale**: vede tutti gli `shop_interventions` + i suoi `private_interventions`
- **Se richiedente è `Customer` ma non proprietario**: errore 403
- **Interventi privati di precedenti proprietari**: sempre nascosti

Vedi anche §2.12 per il DTO completo del singolo intervento.

---

### 2.6 `POST /interventions/:id/dispute` — Contestazione intervento

**Feature:** F-CLI-206, F-OFF-602

**Auth:** Customer (deve essere proprietario attuale del veicolo)

#### Descrizione

Il cliente contesta un intervento officina. L'intervento resta in storico ma viene marcato come `disputed`. L'officina riceve notifica.

#### Request

```http
POST /v1/interventions/01HKXQ.../dispute
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "reason_category": "not_performed",
  "description": "Ho portato il veicolo per il cambio olio ma non ho mai richiesto la sostituzione del filtro aria.",
  "attachment_ids": ["01HKZA..."]
}
```

#### Response `201 Created`

```json
{
  "dispute": {
    "id": "01HKZB...",
    "intervention_id": "01HKXQ...",
    "customer_id": "01HKXN6...",
    "reason_category": "not_performed",
    "customer_description": "...",
    "status": "open",
    "created_at": "2026-04-22T09:15:00Z",
    "attachment_ids": ["01HKZA..."]
  },
  "intervention_status": "disputed"
}
```

#### Validazione `attachment_ids`

Gli `attachment_ids` devono essere stati pre-uploadati via `POST /v1/attachments/upload-url` con `owner_type=intervention_dispute` e `owner_id=<intervention_id>` (vedi §3.9 / §2.7). Devono essere `processed=true` (callback `confirm` chiamato) e non già associati ad altre dispute.

**Errori di validazione:**

- `422 intervention.dispute.attachment_not_found` — uno degli id non esiste, non è dispute attachment, o non è stato uploadato dal customer corrente.
- `422 intervention.dispute.attachment_not_processed` — un id esiste ma `processed=false` (manca il callback confirm).
- `409 intervention.dispute.attachment_already_claimed` — un id è già associato a un'altra dispute.

Il limite è 10 attachment per dispute (BR-180).

#### Note

- Una sola contestazione aperta per intervento per customer
- L'officina ha 14 giorni per rispondere, altrimenti escalation
- Lo stato `disputed` è visibile anche nello storico pubblico (share link)

---

### 2.6.1 `POST /interventions/:id/dispute-response` — Risposta officina

**Feature:** F-OFF-602

**Auth:** Tenant User (officina pool); ruolo in `{super_admin, mechanic}`

#### Descrizione

L'officina risponde a una o più contestazioni `open` su un proprio intervento, fornendo `tenant_response` (≥20 chars). Sblocca PATCH dell'intervento se non restano dispute `open` residue (`intervention.status` flippa da `disputed` ad `active`).

#### Request

```http
POST /v1/interventions/01HKXQ.../dispute-response
Content-Type: application/json
Authorization: Bearer <officina_jwt>

{
  "tenant_response": "L'intervento è stato eseguito come da preventivo firmato il 2026-04-20; in allegato il foglio di lavoro.",
  "dispute_id": "01HKZB...",
  "attachment_ids": []
}
```

| Campo | Tipo | Required | Note |
|---|---|---|---|
| `tenant_response` | string | yes | min 20, max 2000 chars (BR-129) |
| `dispute_id` | UUID | no | Se omesso, risponde a tutte le `open` su questa intervention |
| `attachment_ids` | UUID[] | no | Forward-compat; in v1 deve essere vuoto/assente |

#### Response `200 OK`

```json
{
  "disputes": [
    {
      "id": "01HKZB...",
      "intervention_id": "01HKXQ...",
      "customer_id": "01HKXN6...",
      "reason_category": "not_performed",
      "customer_description": "...",
      "tenant_response": "...",
      "tenant_response_at": "2026-04-28T09:15:00Z",
      "tenant_response_user_id": "01HKUS...",
      "status": "responded",
      "resolved_at": null,
      "created_at": "2026-04-22T09:15:00Z",
      "attachment_ids": ["01HKZD..."]
    }
  ],
  "intervention_status": "active"
}
```

`disputes` è sempre array (length 1 con `disputeId`, ≥1 col fanout).
`intervention_status` è `"active"` se 0 `open` residue post-update; `"disputed"` altrimenti.

**Allegati nelle risposte officina:**

L'array `attachment_ids` viene popolato solo per la dispute target (passata via `dispute_id` nella request body). Per le altre dispute toccate via fanout, l'array è vuoto (`[]`).

**Vincolo fanout + attachments:**

Quando si fa fanout (richiesta SENZA `dispute_id`) E `attachment_ids` non è vuoto → 422 `intervention.dispute.response.attachments_require_dispute_id`. Per allegare prove, specificare esplicitamente `dispute_id`.

#### Errori

| Status | `code` | Trigger |
|---|---|---|
| 400 | `intervention.dispute.response.description_too_short` | `tenant_response` < 20 |
| 400 | `validation.error` | Zod fail (max, attachmentIds shape, body shape) |
| 401 | `auth.unauthenticated` | JWT mancante/invalido |
| 403 | `intervention.dispute.response.permission_denied` | Ruolo non in allow-list |
| 404 | `not_found` | Intervention con id inesistente; `dispute_id` non trovato o di altro tenant |
| 409 | `intervention.dispute.response.no_active_dispute` | Nessuna `open` da rispondere; OPPURE intervention di altro tenant (vedi Note RLS) |
| 422 | `intervention.dispute.response.attachments_require_dispute_id` | Fanout + attachmentIds non vuoto |

#### Note

- BR-128: la response è immutabile. Non c'è un'edit/delete in v1.
- Multi-dispute (più customer sullo stesso intervento): risposta unica con stesso `tenant_response` testo per tutte le `open`, salvo targeting esplicito via `dispute_id`.
- BR-127 status flip: `intervention.status` flippa a `active` solo se 0 `open` residue. `responded` NON conta come "blocco PATCH".
- RLS topology: `interventions_read` è permissivo (post PR #22), quindi una POST con id di intervento di altro tenant non ritorna 404 ma **409 `no_active_dispute`** — il lookup dell'intervention succeed, ma le dispute di altro tenant sono invisibili via `intervention_disputes_access` (`findMany` ritorna `[]`). L'isolation di scrittura resta garantita: tenant B non può mai mutare le dispute di tenant A.

---

### 2.7 `POST /attachments/upload-url` + `POST /attachments/:id/confirm` — Workflow upload allegati

**Feature:** F-OFF-305 (+ reciprocal F-CLI-203/204 attachments)
**Auth:** Dual pool — `owner_type: intervention` → officina; `owner_type: private_intervention` → clienti (customer must own the row); `owner_type: intervention_dispute` → both pools

#### Descrizione

Workflow a 3 step per uploadare allegati via presigned URL S3:

1. Client chiama `POST /v1/attachments/upload-url` → server insert attachment row con `processed: false`, ritorna URL S3 PUT presigned (15 min) + metadata
2. Client `PUT` direct su `upload_url` con il file binary (server bypassed)
3. Client chiama `POST /v1/attachments/:id/confirm` → server verifica via S3 HeadObject, flippa `processed: false → true`

Dispatch per `owner_type` + auth pool: `intervention` (officina), `private_intervention` (clienti — XOR `tenant_id NULL + customer_id SET` per `chk_attachment_owner_consistent`), `intervention_dispute` (entrambi i pool).

---

#### Request: `POST /v1/attachments/upload-url`

```http
POST /v1/attachments/upload-url
Content-Type: application/json
Authorization: Bearer <officina_user_jwt>

{
  "owner_type": "intervention",
  "owner_id": "01HKXQ...",
  "file_name": "foto-prima.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 2457600
}
```

**Validation rules:**

- `owner_type`: enum `intervention | private_intervention`. Solo `intervention` accettato in v1; `private_intervention` ritorna 422.
- `owner_id`: UUID v4 dell'intervention. Server verifica che appartenga al tenant del caller (RLS scoping). Mismatch o non esistente → 404.
- `file_name`: 1-255 chars, no null bytes o control chars. Usato solo per display, mai nel S3 key.
- `mime_type`: enum whitelisted: `image/jpeg | image/png | image/webp | image/heic | application/pdf`.
- `size_bytes`: int positive, max 25 MB (26_214_400 bytes).

#### Response `201 Created`

```json
{
  "attachment_id": "01HKZE...",
  "upload_url": "https://garageos-production-attachments.s3.eu-central-1.amazonaws.com/attachments/intervention/01HKXQ.../01HKZE....jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=...",
  "upload_method": "PUT",
  "upload_headers": {
    "Content-Type": "image/jpeg"
  },
  "expires_at": "2026-05-04T14:47:05Z",
  "callback_url": "/v1/attachments/01HKZE.../confirm"
}
```

**Importante:** il client DEVE fare PUT con `Content-Type` esatto matchando `mime_type` richiesto + `Content-Length` matchando `size_bytes`. AWS S3 reject l'upload se i header divergono dalle condition signed nell'URL.

#### Errori

- `400 VALIDATION_ERROR` — body schema fail (Zod parsing)
- `401 UNAUTHORIZED` — JWT mancante/invalid
- `403 attachment.upload.officina_only` — clienti pool tenta `owner_type=intervention`
- `403 attachment.upload.officina_pool_not_allowed_for_private` — officina pool tenta `owner_type=private_intervention`
- `404 attachment.upload.intervention_not_found` — owner_id (intervention) non esiste o cross-tenant
- `404 attachment.upload.private_intervention_not_found` — owner_id (private_intervention) non esiste, soft-deleted, o di altro customer
- `502 attachment.upload.s3_unavailable` — AWS SDK signing fail

---

#### Request: `POST /v1/attachments/:id/confirm`

```http
POST /v1/attachments/01HKZE.../confirm
Authorization: Bearer <officina_user_jwt>
```

(No body. `id` viene dal URL path.)

#### Response `200 OK`

```json
{
  "id": "01HKZE...",
  "owner_type": "intervention",
  "owner_id": "01HKXQ...",
  "file_name": "foto-prima.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 2457600,
  "processed": true,
  "uploaded_at": "2026-05-04T14:32:10Z"
}
```

**Behavior:**

- **Idempotent**: se l'attachment è già `processed: true`, return 200 con stesso payload senza re-call S3. Permette retry sicuro lato client.
- **Verifica server-side**: invocazione `s3:HeadObject` per leggere `Content-Length` e `Content-Type` dell'oggetto uploadato. Mismatch con `size_bytes`/`mime_type` salvati alla request upload-url → 422 `metadata_mismatch` (defense vs file-swap post-presign).
- **Auth**: solo l'uploader originario (chi ha chiamato upload-url) può confirmare. Mismatch `uploadedByUserId` → 403.

#### Errori

- `400 VALIDATION_ERROR` — id non UUID
- `401 UNAUTHORIZED`
- `403 attachment.confirm.not_uploader` — caller diverso da uploader
- `404 attachment.confirm.not_found` — attachment non esiste o cross-tenant
- `422 attachment.confirm.upload_not_found` — file mai uploaded su S3 (presigned URL expirato senza PUT)
- `422 attachment.confirm.metadata_mismatch` — ContentLength o ContentType S3 non matcha la request originale
- `502 attachment.confirm.s3_unavailable` — AWS SDK HeadObject error generico

---

#### Flusso completo upload (recap)

1. Client → `POST /attachments/upload-url` ricevi `{attachment_id, upload_url, upload_method: PUT, upload_headers, callback_url}`.
2. Client → `PUT upload_url` con `Content-Type: <mime>` + `Content-Length: <size>` matching headers.
3. Client → `POST /attachments/<id>/confirm` (callback_url).
4. Server flippa `processed: true`.

#### Compression / thumbnail (deferred)

In v1 il `processed: true` flip non triggera compression/thumbnail (cluster G PR 24 con EventBridge fan-out). `thumbnailS3Key` resta `null` finché un futuro Lambda consumer non genera thumbnail post-confirm.

---

### 2.7.1 `GET /v1/attachments/:id/view-url` — URL presigned GET allegato

**Feature:** F-OFF-301 (companion slice D — detail page intervento)
**Auth:** Tenant User (officina pool; clienti pool ritorna `403`)
**Rate limit:** standard utente

#### Descrizione

Genera on-demand un URL presigned GET S3 per visualizzare o scaricare un allegato già confermato (`processed=true`). L'URL ha validità **15 minuti**. La generazione avviene al momento della richiesta (lazy presign): il DTO del dettaglio intervento (`GET /v1/interventions/:id`, §2.12) espone i metadati degli allegati ma **non** include URL di accesso precalcolati, per evitare fanout S3 non necessario al caricamento della pagina.

v1: supportato solo `ownerType='intervention'`. `private_intervention` e `intervention_dispute` sono deferiti rispettivamente alla mobile slice B2C e alla UI dispute response.

#### Request

```http
GET /v1/attachments/01HKZE.../view-url
Authorization: Bearer <officina_user_jwt>
```

**Path parameters:**

| Nome | Tipo | Note |
| --- | --- | --- |
| `id` | uuid v4 | UUID dell'allegato. UUID malformato → `400 VALIDATION_ERROR`. |

#### Response `200 OK`

```json
{
  "url": "https://garageos-production-attachments.s3.eu-central-1.amazonaws.com/attachments/intervention/01HKXQ.../01HKZE....jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=...",
  "expires_at": "2026-05-11T15:47:05.000Z"
}
```

| Campo | Tipo | Note |
| --- | --- | --- |
| `url` | string | URL presigned S3 GET. Valido per 15 minuti da `expires_at`. |
| `expires_at` | string (ISO 8601 UTC) | Scadenza dell'URL. Il client deve rigenerare chiamando di nuovo questo endpoint dopo la scadenza. |

#### Errori

| Status | Codice | Scenario |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `id` non è un UUID v4 valido |
| 401 | (auth middleware) | Authorization header mancante o JWT non valido |
| 403 | `FORBIDDEN` | JWT proviene dal pool `clienti` invece di `officine` |
| 404 | `attachment.not_found` | Allegato inesistente, non `processed`, o `deletedAt != null` |
| 422 | `attachment.owner_not_supported` | `ownerType != 'intervention'` (es. `intervention_dispute`, `private_intervention`) |
| 502 | `attachment.view_url.s3_unavailable` | AWS SDK presign fail (passthrough da `S3UnavailableError`) |

#### Note

- **Lazy presign**: l'URL non è precalcolato nel DTO del dettaglio intervento (§2.12). Il client deve chiamare questo endpoint separatamente per ogni allegato che vuole aprire o scaricare.
- **Visibilità cross-tenant (BR-150 / BR-153)**: gli allegati di tipo `intervention` sono parte dello storico officina condiviso, quindi sono presignabili da **qualsiasi** officina — stesso modello di visibilità del dettaglio intervento (§2.12). Il lookup officine **non** è tenant-scoped; il gate `ownerType === 'intervention'` è ciò che mantiene privati gli allegati riservati: `intervention_dispute` (prove di disputa) e `private_intervention` (lato cliente) restano `422` e non trapelano cross-tenant. `attachments_read` RLS è `USING (true)`; l'enforcement è application-layer.
- **Processed-only**: allegati in stato `processed=false` (upload pendente) o `deletedAt != null` (soft-deleted) ritornano `404 attachment.not_found` — non vengono distinti per evitare information leakage.

---

### 2.8 `GET /v1/customers/search` — Ricerca cliente officina

#### Descrizione

Ricerca tenant-scoped di customer per nome / ragione sociale / telefono, usata sia dall'autocomplete operatore nel form `intervention create` sia dalla barra di ricerca globale (F-OFF-502). Ritorna solo customer presenti in `customer_tenant_relations` per il tenant chiamante (BR-151 soddisfatto by-construction dalla JOIN: ogni riga ritornata è già relata, niente PII redaction necessaria).

Complementa `GET /v1/vehicles/search?customer=<uuid>` (PR #76): questo endpoint trova il customer per nome digitato, l'altro filtra i veicoli del customer scelto.

#### Request

`GET /v1/customers/search`

**Auth:** officina pool (Cognito group `officine`). Customer pool ritorna `403`.

**Query parameters:**

| Nome | Tipo | Required | Default | Note |
|---|---|---|---|---|
| `q` | string | sì | — | Min 2, max 60 char. Match ILIKE substring case-insensitive su `firstName`, `lastName`, `businessName`, `phone` (telefono aggiunto in F-OFF-502). Token whitespace-split: AND tra token, OR tra colonne. |
| `limit` | integer | no | 20 | 1-50. |
| `cursor` | string | no | — | Cursor opaco base64url ritornato dalla `meta.cursor` di una response precedente. |

**Campi NON ricercabili** (privacy-by-default): `email`, `taxCode`, `vatNumber`. Esposti nella response, non matchabili via `q`.

#### Response `200 OK`

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Mario",
      "lastName": "Rossi",
      "email": "mario.rossi@example.it",
      "phone": "+39 333 1234567",
      "isBusiness": false,
      "businessName": null,
      "vatNumber": null,
      "status": "active"
    }
  ],
  "meta": { "has_more": false }
}
```

Quando `meta.has_more` è `true`, `meta.cursor` è presente; passalo come query param `cursor` per la pagina successiva. Ordering è `id ASC` per stabilità del cursor.

#### Errori

- `400 VALIDATION_ERROR` — q troppo corto/lungo, limit fuori range, q mancante.
- `401` — JWT mancante o invalido.
- `403` — chiamante non in pool officina.

Niente `404`: nessun match → `200` con `data: []`.

#### Note

- **Tenant scoping**: la JOIN su `customer_tenant_relations` è enforced sia application-layer (Prisma `tenantRelations.some`) sia RLS-layer (la tabella CTR ha policy `_tenant_isolation`). Doppio lock difensivo.
- **Filtri**: `status='active'` (esclude `pending_verification` e `deleted`) + `customer_deleted=false` sulla relazione.
- **No audit log**: endpoint intra-tenant per costruzione, BR-154 non applicabile.
- **Non-features intenzionali**: cross-tenant search, fuzzy/typo tolerance (pg_trgm), bulk lookup `?ids=`, customer-pool auth.

---

### 2.8b `GET /v1/customers` — Elenco clienti officina (F-OFF-202)

Lista paginata dei clienti del tenant, ordinata alfabeticamente per
cognome/nome. Ricerca opzionale per nome (`q`). Tenant-scoped via
`customer_tenant_relations` (BR-151).

**Auth:** Tenant User (pool officine). `401` senza token, `403` con token pool
clienti.

**Query string:**

| Param | Tipo | Default | Note |
|---|---|---|---|
| `q` | string | — | opzionale; se presente `2..60` char. Match case-insensitive su `firstName`/`lastName`/`businessName` (AND tra token whitespace, OR tra colonne). `email`/`taxCode`/`vatNumber` NON matchabili. |
| `limit` | int | 20 | `1..50` |
| `cursor` | string | — | cursore opaco id-only (dalla `meta.cursor` della pagina precedente) |

**Ordinamento:** `lastName ASC, firstName ASC, id ASC`.

**Response 200** (camelCase):

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Mario",
      "lastName": "Rossi",
      "phone": "+39 333 1234567",
      "isBusiness": false,
      "businessName": null,
      "vehicleCount": 2,
      "lastInterventionAt": "2026-05-01T10:00:00.000Z"
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaco>" }
}
```

- `vehicleCount`: numero di ownership **attive** del cliente (`ended_at IS NULL`),
  non tenant-scoped — coerente con l'array `vehicles` del dettaglio.
- `lastInterventionAt`: colonna denormalizzata per-tenant
  `customer_tenant_relations.last_intervention_at` (`null` se nessun intervento).
- DTO **least-PII**: niente `email`/`taxCode`/`vatNumber` (esposti solo dal
  dettaglio `GET /v1/customers/:id`).
- `meta.cursor` presente solo quando `has_more` è `true`.

Distinto da `GET /v1/customers/search` (autocomplete: `q` obbligatorio,
ordinamento per `id`, DTO con email).

---

### 2.9 `GET /v1/customers/:id` — Dettaglio cliente officina

#### Descrizione

Lookup tenant-scoped del singolo customer. Ritorna anagrafica + note tenant-private + storia con questa officina + lista veicoli del customer al momento (current ownership). BR-151 PII gating: l'endpoint risponde `404 customer.not_found` quando il chiamante non ha una relazione `customer_tenant_relations` con il customer.

#### Request

`GET /v1/customers/:id`

**Auth:** officina pool (Cognito group `officine`). Customer pool ritorna `403`.

**Path parameters:**

| Nome | Tipo | Note |
| --- | --- | --- |
| `id` | uuid | id del customer da recuperare. UUID malformato → `400 VALIDATION_ERROR`. |

#### Response `200 OK`

```json
{
  "id": "uuid",
  "email": "mario.rossi@example.it",
  "firstName": "Mario",
  "lastName": "Rossi",
  "phone": "+39 333 1234567",
  "taxCode": "RSSMRA80A01H501Z",
  "isBusiness": false,
  "businessName": null,
  "vatNumber": null,
  "addressLine": "Via Roma 1",
  "city": "Roma",
  "province": "RM",
  "postalCode": "00100",
  "cognitoSub": null,
  "status": "active",
  "createdAt": "2026-01-15T10:30:00.000Z",
  "tenantRelation": {
    "tenantNotes": "Cliente VIP, sempre puntuale",
    "interventionCount": 3,
    "firstInterventionAt": "2025-01-15T10:00:00.000Z",
    "lastInterventionAt": "2026-04-30T09:00:00.000Z"
  },
  "vehicles": [
    { "id": "uuid", "plate": "AB123CD", "make": "Fiat", "model": "Panda", "year": 2018 }
  ]
}
```

`tenantRelation` contiene i campi della riga `customer_tenant_relations` filtrata sul tenant chiamante (sempre presente quando il 200 risponde — il 404 copre l'assenza). `vehicles` è la lista degli ownership attivi (`endedAt IS NULL`); array vuoto se il cliente non ha veicoli associati. `cognitoSub` è non-null quando il customer ha completato il signup nella mobile app (pool clienti) — la web app officina lo usa per mostrare un avviso "Cliente registrato" in edit mode (le modifiche propagano al profilo mobile).

#### Errori

- `400 VALIDATION_ERROR` — `:id` non è un uuid valido.
- `401` — JWT mancante o invalido.
- `403` — chiamante non in pool officina.
- `404 customer.not_found` — uno qualsiasi di: customer inesistente, customer con `status='deleted'` (BR-158 anonymized), nessuna relazione tenant-customer, relazione con `customerDeleted=true`. Il singolo 404 nasconde il motivo (BR-151 information leakage).

#### Note

- **PII gating**: BR-151 enforced application-layer. RLS `customers_read` è permissivo (`USING true`); l'isolation viene dalla predicato `tenantRelations.some({tenantId, customerDeleted: false})` in `findFirst`.
- **No audit log**: endpoint intra-tenant per costruzione, BR-154 non applicabile.

---

### 2.9b `POST /v1/customers` — Creazione cliente standalone (F-OFF-201)

Crea un cliente per il tenant, indipendentemente dalla creazione veicolo.
`email` è **unique globale**: se esiste già, la riga viene riusata e si
garantisce la relazione `customer_tenant_relations` (BR-041/BR-152).

**Auth:** Tenant User (pool officine). `401` senza token, `403` con token pool clienti.

**Body** (camelCase, `.strict()`):

| Campo | Regola |
|---|---|
| `firstName` | string 1..100, obbligatorio |
| `lastName` | string 1..100, obbligatorio |
| `email` | email valida, max 255, obbligatorio |
| `phone` | string max 30, opzionale |
| `taxCode` | string max 20, opzionale |
| `addressLine` | string max 255, opzionale |
| `city` | string max 100, opzionale |
| `province` | string max 2, opzionale |
| `postalCode` | string max 10, opzionale |
| `isBusiness` | boolean (default false) |
| `businessName` | string max 200, opzionale (obbligatorio se `isBusiness`) |
| `vatNumber` | string max 20, opzionale |

**Errori:**

- `400 VALIDATION_ERROR` — campo obbligatorio mancante o email malformata.
- `422 customer.create.unknown_field` — chiave non riconosciuta nel body.
- `422 customer.create.business_name_required` — `isBusiness` true senza `businessName`.

**Response `201`:** il DTO completo come `GET /v1/customers/:id` + campo
top-level `created: boolean` (true = nuova riga creata; false = cliente
preesistente collegato a questa officina). `201` in entrambi i casi: `created`
porta la distinzione (divergenza pragmatica dal REST stretto, per dare al
client un solo path).

Comportamento: dedupe per `email` → se esiste, upsert CTR e ritorna
l'esistente (`created:false`, l'anagrafica digitata è ignorata); altrimenti
crea cliente + CTR (`created:true`). Race P2002 → refetch + link.
`tenantNotes` non è impostabile in creazione (usa `PATCH /v1/customers/:id`).

---

### 2.10 `PATCH /v1/customers/:id` — Modifica cliente officina

#### Descrizione

Aggiornamento parziale dei dati anagrafica + note tenant-private. La officina può correggere typo / aggiornare contatti / cambiare stato B2B; l'email NON è modificabile (login identity B2C: cambiarla richiede flusso re-verification customer-self, deferred F-CLI-004). Dopo il PATCH ritorna lo stesso shape della GET.

#### Request

`PATCH /v1/customers/:id`

**Auth:** officina pool. Customer pool ritorna `403`.

**Path parameters:** `id: uuid`.

**Body schema** (tutti opzionali, almeno uno richiesto):

| Campo | Tipo | Vincoli | Nullable | Note |
| --- | --- | --- | --- | --- |
| `firstName` | string | 1-100 | no | Anagrafica core |
| `lastName` | string | 1-100 | no | Anagrafica core |
| `phone` | string | max 30 | sì | Contatto |
| `taxCode` | string | max 20 | sì | Codice fiscale (no validation Italian-format v1) |
| `isBusiness` | boolean | — | no | Toggle B2C/B2B |
| `businessName` | string | max 200 | sì | Ragione sociale (B2B) |
| `vatNumber` | string | max 20 | sì | P.IVA (B2B, no validation v1) |
| `addressLine` | string | max 255 | sì | Indirizzo |
| `city` | string | max 100 | sì | Città |
| `province` | string | max 2 | sì | Provincia ISO IT |
| `postalCode` | string | max 10 | sì | CAP |
| `tenantNotes` | string | max 5000 | sì | Note officina-private (su `customer_tenant_relations.tenant_notes`) |
| `email` | — | — | — | ❌ **Non modificabile** — chiave non in schema, 422 `customer.update.unknown_field`. Vedi BR-151 + F-CLI-004 deferred. |

`.strict()` schema: ogni chiave non listata → 422 `customer.update.unknown_field`. Body interamente vuoto → 422 `customer.update.empty_body`.

I campi `tenantNotes` aggiornano la riga `customer_tenant_relations` del tenant chiamante; tutti gli altri aggiornano la riga `customers` (cross-tenant: la modifica è visibile a ogni tenant relato — limitazione documentata, followup ticket per warning UI quando `cognitoSub != null`).

#### Response `200 OK`

Identica a `GET /v1/customers/:id` (re-query post-update via lo stesso `customerDetailSelect`).

#### Errori

- `400 VALIDATION_ERROR` — body con valore fuori vincoli (es. `firstName` > 100 char), `:id` non uuid, body non JSON.
- `401` — JWT mancante o invalido.
- `403` — chiamante non in pool officina.
- `404 customer.not_found` — stesse condizioni della GET.
- `422 customer.update.empty_body` — body vuoto.
- `422 customer.update.unknown_field` — body contiene chiavi non modificabili (es. `email`, `cognitoSub`, `status`).

#### Note

- **Atomicità**: `customer` row update + `customer_tenant_relations` row update avvengono nella stessa `prisma.$transaction`.
- **Idempotency**: PATCH idempotente; due chiamate con stesso body producono lo stesso stato finale.
- **No audit log v1**: `access_log` è vehicle-scoped, non si presta a un'azione customer-only. Followup ticket `customer_revisions` table per audit dedicato. Il campo `customer.updatedAt` di Prisma è il de-facto audit minimo.

---

### 2.11 `GET /v1/interventions/:id/disputes` — Lista contestazioni di un intervento

**Feature**: F-OFF-602 (read companion to dispute-response endpoint).
**Auth**: Tenant User (qualsiasi ruolo officina).
**Rate limit**: standard utente.

#### Descrizione

Restituisce la lista completa di tutte le contestazioni (`intervention_disputes`) associate a un intervento, indipendentemente dallo `status`. Pensato per popolare la UI dialog di risposta lato officina, dove l'operatore deve vedere `reason_category` + `customer_description` prima di scrivere una risposta, oltre allo storico delle risposte già inviate.

#### Request

```http
GET /v1/interventions/{id}/disputes
Authorization: Bearer <tenant_user_jwt>
```

#### Response 200

```json
{
  "disputes": [
    {
      "id": "uuid",
      "reasonCategory": "not_performed | wrong_data | not_authorized | other",
      "customerDescription": "string (BR-120, max 2000)",
      "status": "open | responded | resolved_by_cancellation | escalated | closed_by_admin",
      "tenantResponse": "string | null",
      "tenantResponseAt": "ISO 8601 | null",
      "tenantResponseUser": {
        "firstName": "string",
        "lastName": "string"
      },
      "createdAt": "ISO 8601",
      "resolvedAt": "ISO 8601 | null"
    }
  ]
}
```

`tenantResponseUser` è `null` quando la dispute non è stata ancora risposta (mirror del DTO Prisma — la relation è `User?`). Ordering: `createdAt ASC` (cronologico).

#### Errors

| Status | Code | Quando |
|---|---|---|
| 401 | (auth middleware) | Authorization header mancante o JWT non valido |
| 403 | `FORBIDDEN` | JWT proviene dal pool `clienti` invece di `officine` |
| 404 | `intervention.not_found` | Intervento non esiste oppure appartiene a un altro tenant (RLS-as-404) |

#### Note

- BR-128: le risposte (`tenantResponse + tenantResponseAt + tenantResponseUserId`) sono **immutabili**. Questo endpoint le espone in sola lettura — non esiste un PATCH delle risposte.
- Il POST response resta su `POST /v1/interventions/:id/dispute-response` (PR #28) e richiede ruolo `super_admin` o `mechanic`.
- Vedi anche §2.12 per il DTO completo dell'intervento.

---

### 2.12 `GET /v1/interventions/:id` — Dettaglio intervento officina

**Feature:** F-OFF-301
**Auth:** Tenant User (officina pool — tutti i ruoli: `super_admin`, `admin`, `mechanic`, `receptionist`)
**Rate limit:** standard utente
**Business rules:** BR-062, BR-064, BR-065, BR-066, BR-128, BR-130, BR-150, BR-151, BR-153

#### Descrizione

Restituisce il DTO completo di un singolo intervento officina, inclusi tipo, tenant, location, veicolo, operatore che ha creato il record, e lista degli allegati confermati. Pensato per popolare la detail page dell'intervento nella web app officina.

`wiki_window_open` è computato server-side come predicato composito BR-062: `wikiLockedAt IS NULL AND firstSeenByCustomerAt IS NULL AND now() - createdAt < 48h`. Non viene esposto il raw `wikiLockedAt` per evitare che il client ri-derivi la logica con bug di time-zone (vedi memory `feedback_compute_composite_br_predicates_server_side.md`).

#### Request

```http
GET /v1/interventions/01HKXQ.../
Authorization: Bearer <officina_user_jwt>
```

**Path parameters:**

| Nome | Tipo | Note |
| --- | --- | --- |
| `id` | uuid v4 | UUID dell'intervento. UUID malformato → `400 VALIDATION_ERROR`. |

#### Response `200 OK`

```jsonc
{
  "id": "01HKXQ...",
  "status": "active",                      // "active" | "disputed" | "cancelled"
  "is_disputed": false,                    // shortcut: status === 'disputed'
  "wiki_window_open": true,                // server-computed BR-062 predicate
  "intervention_date": "2026-04-21",       // date-only string YYYY-MM-DD
  "odometer_km": 45000,
  "created_at": "2026-04-21T14:32:05.000Z",
  "cancelled_at": null,                    // ISO 8601 UTC | null
  "cancelled_reason": null,                // string | null (BR-130)
  "title": "Tagliando completo",
  "description": "Sostituzione olio motore...",
  "internal_notes": "Cliente segnala rumore...",  // string | null — null se il viewer non è il tenant proprietario (BR-153)
  "viewer_is_owner": true,                 // true se il tenant chiamante ha creato l'intervento; false = vista cross-tenant sola lettura
  "parts_replaced": [                      // array; empty array if none
    { "name": "Olio motore Selenia 5W30", "code": "SEL-5W30-4L", "quantity": 4, "notes": "Litri" }
  ],
  "type": {
    "id": "01HSYS...",
    "code": "TAGLIANDO",
    "name_it": "Tagliando"
  },
  "tenant": {
    "id": "01HKXL0...",
    "business_name": "Officina Rossi S.r.l."
  },
  "location": {
    "id": "01HKXP3...",
    "name": "Sede Milano",
    "city": "Milano",
    "address": "Via Roma 1"               // string | null
  },
  "vehicle": {
    "id": "01HKXN5...",
    "garage_code": "GO-482-KXRT",
    "plate": "AB123CD",
    "make": "Fiat",
    "model": "Panda"
  },
  "created_by": {                          // null se l'utente è stato cancellato (SetNull FK) o se il viewer non è il tenant proprietario (BR-151)
    "id": "01HKXP8...",
    "first_name": "Giuseppe",
    "last_name": "Ferrari"
  },
  "attachments": [                         // solo processed=true e deletedAt=null
    {
      "id": "01HKZE...",
      "file_name": "foto-prima.jpg",
      "mime_type": "image/jpeg",
      "size_bytes": 2457600,
      "created_at": "2026-05-04T14:32:10.000Z"
    }
  ]
}
```

**Dettaglio campi:**

| Campo | Tipo | Nullable | Note |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | |
| `status` | enum | no | `active \| disputed \| cancelled` |
| `is_disputed` | boolean | no | Shortcut derivato: `status === 'disputed'` |
| `wiki_window_open` | boolean | no | Server-computed BR-062 predicate. `true` = modifiche libere; `false` = ogni PATCH richiede `reason` ≥ 10 char (BR-064). |
| `intervention_date` | string | no | YYYY-MM-DD, data dell'intervento |
| `odometer_km` | integer | no | Km al momento dell'intervento |
| `created_at` | string (ISO 8601) | no | |
| `cancelled_at` | string (ISO 8601) | sì | Non null solo se `status='cancelled'` |
| `cancelled_reason` | string | sì | Motivazione annullamento (BR-130) |
| `title` | string | no | |
| `description` | string | sì | |
| `internal_notes` | string | sì | `null` se il viewer non è il tenant proprietario (BR-153 — note riservate nascoste cross-tenant) |
| `viewer_is_owner` | boolean | no | `true` se il tenant chiamante è proprietario dell'intervento. `false` = vista cross-tenant in sola lettura (edit/dispute non disponibili) |
| `parts_replaced` | array | no | Array vuoto se nessun ricambio |
| `type` | object | no | Tipo intervento (`id`, `code`, `name_it`) |
| `tenant` | object | no | Tenant owner (`id`, `business_name`) |
| `location` | object | no | Location di esecuzione |
| `vehicle` | object | no | Veicolo target |
| `created_by` | object | sì | `null` se l'utente è stato cancellato (FK `SetNull` on delete) **oppure** se il viewer non è il tenant proprietario (BR-151) |
| `attachments` | array | no | Solo `processed=true` e `deletedAt=null`. Upload pendenti e soft-deleted sono nascosti. |

Per ottenere l'URL di accesso a un allegato, chiamare `GET /v1/attachments/:id/view-url` (§2.7.1) con l'`id` di ogni elemento dell'array `attachments`.

#### Errori

| Status | Codice | Scenario |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `id` non è un UUID v4 valido |
| 401 | (auth middleware) | Authorization header mancante o JWT non valido |
| 403 | `FORBIDDEN` | JWT proviene dal pool `clienti` invece di `officine` |
| 404 | `intervention.not_found` | Intervento inesistente (UUID valido ma nessuna riga) |

#### Note

- **Visibilità cross-tenant (BR-150 / BR-153)**: lo storico interventi officina è leggibile cross-tenant — una qualsiasi officina può aprire l'intervento di un altro tenant in **sola lettura** (libretto di manutenzione condiviso). `interventions_read` è permissivo cross-tenant (post migration 0003), quindi il lookup usa `findFirst({id})` + null check → `404` **solo** quando la riga non esiste. La proprietà è calcolata app-side (`row.tenantId === request.tenantId`) e pilota la redazione.
- **Redazione per non proprietari**: quando il viewer non è il tenant proprietario, `internal_notes` e `created_by` sono restituiti `null` (BR-153 note riservate; BR-151 identità meccanico). Tutti gli altri campi (incluso `attachments`) restano visibili. `viewer_is_owner=false` segnala al client la modalità sola lettura: PATCH/cancel/dispute restano comunque bloccati lato server al solo tenant proprietario.
- **`internal_notes` visibility**: esposto al solo Tenant User proprietario (BR-153). Il pool clienti non ha accesso a questo endpoint (403).
- **`created_by` null**: quando l'utente che ha creato l'intervento è stato rimosso (soft-delete con `SetNull` sulla FK `userId`) **oppure** quando il viewer è un tenant non proprietario (BR-151). Il client deve gestire il caso null nella UI.
- **Attachments fetch**: gli allegati sono caricati con una seconda query separata dopo il guard di esistenza dell'intervento (`attachments` non ha una Prisma relation diretta su `Intervention`). Solo `processed=true` e `deletedAt=null` sono inclusi.

---

### 2.13 `GET /v1/interventions/:id/pdf` — Export PDF intervento (F-OFF-309)

**Feature:** F-OFF-309
**Auth:** Tenant User (pool officine — tutti i ruoli).
**Rate limit:** standard utente.
**Business rules:** BR-040, BR-151, BR-213

#### Descrizione

Genera (o rigenera) il PDF dell'intervento e ritorna un URL S3 presigned con validità 1h.
Auth operatore (pool officine). RLS tenant-scoped (404 cross-tenant).

Il PDF contiene: intestazione officina (logo se disponibile), intestatario
(BR-151 PII-gated, fallback "Proprietario non in anagrafica"), veicolo,
data/km/tipo, titolo/descrizione, ricambi (senza costi), operatore (BR-213
fallback "Operatore"). Banner "INTERVENTO ANNULLATO" se `status=cancelled`.
`internal_notes` mai incluse. Il PDF è rigenerato a ogni chiamata (documento
mutabile, nessuna cache).

#### Request

```http
GET /v1/interventions/{id}/pdf
Authorization: Bearer <officine_user_jwt>
```

**Path parameters:**

| Nome | Tipo | Note |
| --- | --- | --- |
| `id` | uuid v4 | UUID dell'intervento. UUID malformato → `400 VALIDATION_ERROR`. |

#### Response `200 OK`

```json
{
  "pdf_download_url": "https://…s3…presigned…",
  "expires_at": "2026-05-30T19:00:00Z"
}
```

#### Errori

| Status | Codice | Scenario |
| --- | --- | --- |
| 401 | (auth middleware) | Authorization header mancante o JWT non valido |
| 404 | `intervention.not_found` | Intervento non trovato o non accessibile da questa officina (RLS-as-404) |
| 429 | (rate limit) | Troppe richieste |
| 500 | `intervention_pdf.render_failed` / `intervention_pdf.s3_upload_failed` | Render PDF o upload S3 falliti |

#### Note

- **PII gating (BR-151)**: il nome del proprietario è visibile solo se il tenant ha una relazione attiva con il customer (`customer_tenant_relations`). Altrimenti il PDF mostra "Proprietario non in anagrafica".
- **Operator fallback (BR-213)**: se il record utente dell'operatore è stato rimosso (`created_by` null), il PDF mostra "Operatore".
- **Active owner (BR-040)**: il proprietario è il `VehicleOwnership` con `endedAt=null`.
- **Nessuna cache**: il PDF è rigenerato a ogni chiamata perché i dati dell'intervento sono mutabili (wiki window aperta). La chiave S3 viene sovrascritta ad ogni generazione.
- **Logo officina**: se presente (`tenants.logo_url`), il logo viene scaricato da S3 e incluso nell'intestazione. In caso di errore S3 il PDF è generato senza logo (fallback graceful).

---

### 2.14 `GET /v1/vehicles/:id/tag` — Genera o recupera tag PDF veicolo

**Auth:** bearer JWT (qualunque utente attivo del tenant).
**Feature:** F-OFF-104 (stampa tag). BR-026 (lazy generation), BR-027 (audit log).

#### Request

- Path param `id`: UUID veicolo.

```http
GET /v1/vehicles/:id/tag
Authorization: Bearer <officine_user_jwt>
```

Nessun body, nessun query param.

#### Response 200

```json
{
  "tag_download_url": "https://garageos-prod-attachments.s3.eu-south-1.amazonaws.com/tags/GO-288-QPWZ.pdf?X-Amz-...",
  "expires_at": "2026-05-29T13:00:00.000Z"
}
```

Il `tag_download_url` è un presigned URL S3 valido 1h. Il PDF è A4 14-up con 14 etichette identiche (codice + QR code → `https://app.garageos.it/v/<code>`), formato Avery L7163.

#### Error matrix

| Status | Code | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Path id non UUID v4. |
| 401 | `auth.unauthorized` | JWT missing/invalid. |
| 404 | `vehicle.not_found` | Veicolo non esistente o cross-tenant. |
| 409 | `vehicle.archived` | `vehicle.status='archived'`. |
| 409 | `vehicle.not_certified` | `vehicle.status='pending'`. |
| 500 | `internal_error` | S3 head/upload/render/audit failure (vedi APPENDICE_G §3.17). |

#### Note

- Audit: ogni richiesta inserisce row in `vehicle_tag_prints` con `kind='first'`.
- Caching: PDF cached su S3 con key `tags/<garage_code>.pdf` (immutabile per BR-022). Second+ accessi → cache-hit (no re-render).

---

### 2.15 `POST /v1/vehicles/:id/tag-reprint` — Ristampa tag PDF veicolo

**Auth:** bearer JWT (mechanic | super_admin attivo del tenant).
**Feature:** F-OFF-109 (ristampa tag). BR-028.

#### Request

- Path param `id`: UUID veicolo.
- Body (Zod validato):

```json
{
  "reason": "lost | damaged | other",
  "reasonNote": "string (optional; required+min(3)+max(500) se reason='other')",
  "documentVerified": true
}
```

#### Response 200

```json
{
  "tag_download_url": "https://garageos-prod-attachments.s3.eu-south-1.amazonaws.com/tags/GO-288-QPWZ.pdf?X-Amz-...",
  "expires_at": "2026-05-29T13:00:00.000Z"
}
```

`tag_download_url` presigned valido 1h. PDF identico al primo (BR-022 immutable).

#### Error matrix

| Status | Code | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `documentVerified !== true`, `reason` non in enum, `reasonNote` mancante/len<3 quando `reason='other'`. |
| 401 | `auth.unauthorized` | JWT missing/invalid. |
| 404 | `vehicle.not_found` | Vehicle non esistente o cross-tenant. |
| 409 | `vehicle.archived` | `vehicle.status='archived'`. |
| 409 | `vehicle.not_certified` | `vehicle.status='pending'` o altro stato non-`certified`. |
| 409 | `vehicle_tag.never_printed` | Audit count = 0 (mai stampato). |
| 500 | `internal_error` | S3 / audit failure (vedi APPENDICE_G). |

#### Note

- Audit: inserisce row `vehicle_tag_prints` con `kind='reprint'`, `reason`, `reason_note`, `document_verified=true`, `printed_by_user_id`.
- Cache S3: riusa `tags/<garage_code>.pdf` da PR1 (cache-hit garantito post check audit-count).

#### Campo `tag_first_printed_at` in `GET /v1/vehicles/:id`

Il DTO di dettaglio veicolo include:

```json
{
  "tag_first_printed_at": "2026-04-10T12:34:56.789Z"
}
```

`tag_first_printed_at` — ISO timestamp del primo `vehicle_tag_prints` per il veicolo, OR null se mai stampato. Drives UI gating tra primo download (`GET /tag`) e ristampa (`POST /tag-reprint`).

---

## 3. Riferimento completo endpoint

Gli endpoint seguenti seguono gli stessi pattern mostrati sopra. Per ognuno si indica: metodo, path, feature, auth richiesta e breve descrizione.

### 3.1 Auth & Session

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| POST | `/auth/signup` | F-OFF-001, F-CLI-001 | None | Registrazione utente (payload con tipo `tenant_admin` o `customer`) |
| POST | `/auth/login` | F-OFF-005, F-CLI-002 | None | Login con email+password, ritorna JWT |
| POST | `/auth/logout` | F-OFF-005 | Any User | Invalida refresh token |
| POST | `/auth/refresh` | - | None | Refresh JWT da refresh token |
| POST | `/auth/password-reset-request` | F-OFF-005, F-CLI-002 | None | Richiede email reset |
| POST | `/auth/password-reset-confirm` | - | None | Conferma reset con token |
| POST | `/auth/verify-email` | F-OFF-001, F-CLI-001 | None | Verifica email con token |
| POST | `/auth/2fa/enable` | F-OFF-006 | Tenant User | Setup TOTP, ritorna QR code |
| POST | `/auth/2fa/verify` | F-OFF-006 | Tenant User | Verifica codice TOTP |
| POST | `/auth/password-changed` | F-OFF-005 | Tenant User (officine) | Notifica audit cambio password — il cambio avviene lato client via Cognito; questo endpoint registra solo la riga `audit_logs` (`user_password_changed`). 204. Rate-limit 5/15min per IP. |
| POST | `/auth/password-reset-completed` | F-OFF-005 | None | Notifica audit completamento reset password (pubblico — utente non autenticato). Registra riga `audit_logs` (`user_password_reset`) per l'utente officine attivo corrispondente all'email. Sempre 204 (anti-enumerazione). Rate-limit 5/15min per IP. |

> **Nota v1 (2026-05-04):** L'endpoint accetta `type=customer` solo. `type=tenant_admin` ritorna `422 auth.signup.tenant_signup_not_supported` finché il flusso server-side di creazione tenant + location primaria + super_admin user non viene shipato in una PR dedicata (vedi roadmap). Vedi anche `docs/superpowers/specs/2026-05-04-api-customer-signup-design.md` §3.4 per la motivazione.

### 3.2 Tenants

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/tenants/me` | F-OFF-007 | Tenant User | Info tenant corrente. Include `onboardingCompletedAt` (ISO string o `null`) usato dal client per il redirect al wizard di onboarding (F-OFF-002) |
| PATCH | `/tenants/me` | F-OFF-007 | Super Admin | **[DETTAGLIATO sotto]** Aggiorna dati tenant |
| POST | `/tenants/me/onboarding/complete` | F-OFF-002 | Super Admin | Marca il wizard di onboarding come completato (scrive `settings.onboardingCompletedAt`). Nessun body. `204`. Idempotente |
| GET | `/tenants/me/locations` | F-OFF-003, F-OFF-004 | Tenant User (Super Admin for F-OFF-004 scope) | **[DETTAGLIATO sotto per F-OFF-004]** Lista location attive (usata anche da InviteUserDialog) |
| POST | `/tenants/me/locations` | F-OFF-003 | Super Admin | Crea location |
| PATCH | `/tenants/me/locations/:id` | F-OFF-003 | Super Admin | Modifica location |
| DELETE | `/tenants/me/locations/:id` | F-OFF-003 | Super Admin | Disattiva location (soft delete) |
| GET | `/tenants/me/billing` | F-OFF-008 | Super Admin | Info billing (piano, prossima fattura) |
| GET | `/tenants/me/export` | F-OFF-704 | Super Admin | Export completo dati tenant (async, ritorna job ID) |
| GET | `/tenants/me/export/:job_id` | F-OFF-704 | Super Admin | Stato export + URL download se pronto |

#### PATCH /v1/tenants/me — Aggiorna dati tenant

**Auth:** Super Admin (Cognito group `officine` con `role=super_admin`).

**Request body** (partial, at least one field required):

```json
{
  "businessName": "Officina Rossi SRL",
  "addressLine": "Via Roma 1",
  "city": "Milano",
  "province": "MI",
  "postalCode": "20100",
  "phone": "+39 02 1234567",
  "email": "info@rossi.test"
}
```

**Editable fields:**
- `businessName` (string, min 1, max 200)
- `addressLine` (string, max 255, nullable)
- `city` (string, max 100, nullable)
- `province` (string, 2 char, auto-uppercased, nullable)
- `postalCode` (string, esattamente 5 cifre, nullable)
- `phone` (string, formato libero 6-30 caratteri `[+]?[0-9 ()-]`, nullable)
- `email` (string, RFC 5322, non-nullable)

**Non-editable fields** (read-only in response, must not be in body):
- `vatNumber`, `status`, `plan`, `billingStatus`, `createdAt`

**200 response:** same shape as `GET /v1/tenants/me`.

**Errors:**
- `400 VALIDATION_ERROR` — field validation failure
- `422 tenants.me.update.empty_body` — body has no editable fields
- `422 tenants.me.update.unknown_field` — body contains non-editable field (e.g. `vatNumber`)
- `401 UNAUTHORIZED` — missing/invalid JWT
- `403 auth.forbidden.wrong_pool` — JWT from clienti pool
- `403 auth.forbidden.super_admin_required` — JWT role is not super_admin

---

### 3.3 Users (officina)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/users/me` | F-OFF-007 | Tenant User | Profilo utente corrente |
| PATCH | `/users/me` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto]** Aggiorna profilo |
| POST | `/users/me/avatar/upload-url` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto]** Genera presigned PUT URL per upload avatar |
| POST | `/users/me/avatar/confirm` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto]** Conferma upload S3 e flippa `avatar_url` |
| DELETE | `/users/me/avatar` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto]** Rimuove avatar (`avatar_url=NULL` + DeleteObject) |
| GET | `/users` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Lista utenti tenant |
| POST | `/users/invitations` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Invita nuovo utente |
| GET | `/users/invitations` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Lista inviti pendenti |
| DELETE | `/users/invitations/:id` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Revoca invito |
| PATCH | `/users/:id` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Modifica ruolo/location/stato |
| DELETE | `/users/:id` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Rimuove utente (soft delete) |
| POST | `/users/:id/reactivate` | F-OFF-004 | Super Admin | **[DETTAGLIATO sotto]** Riattiva utente soft-deleted (BR-212) |

#### PATCH /v1/users/me — Aggiorna profilo utente

**Auth:** Tenant User (any role in `officine` pool).

**Request body** (partial, at least one field required):

```json
{
  "firstName": "Marco",
  "lastName": "Rossi",
  "phone": "+39 333 1234567"
}
```

**Editable fields:**
- `firstName` (string, trim, min 1, max 100)
- `lastName` (string, trim, min 1, max 100)
- `phone` (string, formato libero 6-30 caratteri `[+]?[0-9 ()-]`, nullable)

**Non-editable fields** (read-only in response, must not be in body):
- `email`, `role`, `tenantId`, `createdAt`, `cognitoSub`

**200 response:** same shape as `GET /v1/users/me`.

**`GET /v1/users/me` / `PATCH /v1/users/me` response shape** (camelCase wire): `id`, `email`, `firstName`, `lastName`, `role`, `tenantId`, `locationId`, `avatarUrl` (presigned URL or `null`), `phone`, `status`, `createdAt`, plus the brand-strip names:
- `tenant`: `{ "businessName": "Officina Matula" }` — nome dell'officina del chiamante.
- `location`: `{ "name": "Sede Milano", "city": "Milano" }` o `null` se l'utente non ha una sede assegnata.

**Errors:**
- `400 VALIDATION_ERROR` — field validation failure
- `422 users.me.update.empty_body` — body has no editable fields
- `422 users.me.update.unknown_field` — body contains non-editable field (e.g. `email`, `role`)
- `401 UNAUTHORIZED` — missing/invalid JWT
- `403 auth.forbidden.wrong_pool` — JWT from clienti pool
- `404 NOT FOUND` — cross-tenant guard (cognitoSub belongs to different tenant)

---

#### Avatar endpoints (`/users/me/avatar/*`)

Flusso 2-fase (analogo a `/attachments/upload-url` + `/confirm` di F-OFF-305 ma dedicato user-avatar, niente riga `attachments`):

**1. `POST /v1/users/me/avatar/upload-url`**

Restituisce un presigned PUT URL per la deterministic key `avatars/users/<user-id>.jpg`. Il client deve poi PUT-tare l'oggetto JPEG (output canvas client-side 512×512 ~85% quality) con header `Content-Type: image/jpeg` esatto.

Request body: `{}` (vuoto).

Response 200:
```json
{
  "upload_url": "https://<bucket>.s3.eu-central-1.amazonaws.com/avatars/users/<uuid>.jpg?...",
  "upload_method": "PUT",
  "upload_headers": { "Content-Type": "image/jpeg" },
  "expires_at": "2026-05-15T12:30:00Z"
}
```

Errori: `users.me.avatar.s3_unavailable` (502).

**2. `POST /v1/users/me/avatar/confirm`**

Verifica HeadObject (deve esistere e avere mime `image/jpeg`), poi flippa `users.avatar_url = '<key>'`. Idempotente.

Request body: `{}`.

Response 200: USER_ME response shape con `avatarUrl` come URL presigned 15-min.

Errori:
- `users.me.avatar.upload_not_found` (422) — HeadObject restituisce NoSuchKey
- `users.me.avatar.invalid_mime` (422) — HeadObject contentType ≠ `image/jpeg`
- `users.me.avatar.s3_unavailable` (502)

**3. `DELETE /v1/users/me/avatar`**

Best-effort `DeleteObject` su S3 + UPDATE `users SET avatar_url = NULL`. Idempotente (S3 failures loggate, request comunque 204).

Response 204 No Content.

**Note storage**:
- DB stora la S3 **key** (`avatars/users/<uuid>.jpg`), non l'URL.
- L'API layer trasforma key → presigned 15-min URL nel response di GET/PATCH/confirm.
- Riusa il bucket `S3_ATTACHMENTS_BUCKET` con prefix `avatars/users/`. Niente bucket pubblico.
- Output sempre JPEG: il frontend converte qualsiasi input (JPEG/PNG/WebP, max 5 MB) a JPEG 512×512 via canvas prima dell'upload.

---

#### F-OFF-004: Gestione utenti e inviti (Super Admin)

> **Nota spec reconciliation:** la spec originale citava il codice di errore `auth.forbidden.not_super_admin`. Questo codice **non esiste** nell'implementazione. Il codice corretto (già in uso da F-OFF-007, slice L, PR #102) è `auth.forbidden.super_admin_required` (vedi §3.3 APPENDICE_G). Tutti gli endpoint F-OFF-004 restituiscono `403 auth.forbidden.super_admin_required` quando il JWT non ha `role=super_admin`.

Il DTO **UserAdmin** usato nelle risposte ha la seguente shape:

```json
{
  "id": "uuid",
  "email": "marco@officina.it",
  "firstName": "Marco",
  "lastName": "Rossi",
  "role": "super_admin",
  "locationId": "uuid | null",
  "status": "active",
  "phone": "+39 333 1234567 | null",
  "avatarUrl": "https://presigned-url... | null",
  "lastLoginAt": "2026-05-19T10:00:00.000Z | null",
  "createdAt": "2026-04-01T09:00:00.000Z",
  "updatedAt": "2026-05-01T12:00:00.000Z",
  "deletedAt": "null | ISO8601"
}
```

Il DTO **InvitationAdmin** usato nelle risposte ha la seguente shape:

```json
{
  "id": "uuid",
  "targetEmail": "nuovo@officina.it",
  "firstName": "Luca | null",
  "lastName": "Ferrari | null",
  "role": "mechanic | null",
  "locationId": "uuid | null",
  "expiresAt": "2026-05-26T10:00:00.000Z",
  "acceptedAt": "null | ISO8601",
  "createdAt": "2026-05-19T10:00:00.000Z"
}
```

**Auth comune a tutti gli endpoint F-OFF-004:** Tenant User con `role=super_admin` nel pool `officine`.

---

#### GET /v1/users — Lista utenti tenant

Restituisce tutti gli utenti del tenant del chiamante (attivi, inattivi e soft-deleted). Il client filtra lato UI per `status`.

**Auth:** Super Admin.

**Request:** nessun body, nessun query param.

**Response 200:**
```json
{
  "users": [
    {
      "id": "a1b2c3d4-...",
      "email": "marco@officina.it",
      "firstName": "Marco",
      "lastName": "Rossi",
      "role": "super_admin",
      "locationId": null,
      "status": "active",
      "phone": null,
      "avatarUrl": null,
      "lastLoginAt": "2026-05-19T08:30:00.000Z",
      "createdAt": "2026-04-01T09:00:00.000Z",
      "updatedAt": "2026-05-01T12:00:00.000Z",
      "deletedAt": null
    }
  ]
}
```

**Errori:**
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.wrong_pool` — JWT da pool clienti
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin

---

#### POST /v1/users/invitations — Crea invito utente

Crea un `invitation` row di tipo `internal_user` e invia email magic-link via Resend (best-effort). Il token plaintext non viene mai restituito nella risposta.

**Auth:** Super Admin.

**Rate limit:** 10 inviti per ora per tenant.

**Request body:**
```json
{
  "email": "nuovo@officina.it",
  "firstName": "Luca",
  "lastName": "Ferrari",
  "role": "mechanic",
  "locationId": "b2c3d4e5-..."
}
```

Campi:
- `email` — email dell'invitato (trim + lowercase)
- `firstName` / `lastName` — max 100 caratteri
- `role` — `"super_admin"` | `"mechanic"`
- `locationId` — UUID della sede, `null` se `role=super_admin`; **obbligatorio** se `role=mechanic` (BR-204)

**Response 201:**
```json
{
  "invitation": {
    "id": "c3d4e5f6-...",
    "targetEmail": "nuovo@officina.it",
    "firstName": "Luca",
    "lastName": "Ferrari",
    "role": "mechanic",
    "locationId": "b2c3d4e5-...",
    "expiresAt": "2026-05-26T10:00:00.000Z",
    "acceptedAt": null,
    "createdAt": "2026-05-19T10:00:00.000Z"
  }
}
```

**Errori:**
- `400 VALIDATION_ERROR` — campo mancante o formato errato
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin
- `409 user.invitation.email_already_active` — un utente attivo con questa email esiste già nel tenant
- `409 user.invitation.duplicate_pending` — esiste già un invito pendente per (tenant, email) — BR-206
- `409 user.invitation.email_in_other_tenant` — email registrata in altro tenant (Cognito hit) — BR-213
- `409 user.invitation.email_soft_deleted_in_tenant` — email appartiene a utente soft-deleted same-tenant. Operator deve usare /reactivate — BR-212
- `422 user.location_required_for_mechanic` — role=mechanic ma locationId assente — BR-204
- `422 user.invitation.location_invalid` — locationId non appartiene al tenant o non attiva
- `502 auth.cognito_unavailable` — Cognito `AdminGetUser` lookup failed (early-check pre-invitation)

---

#### GET /v1/users/invitations — Lista inviti pendenti

Restituisce gli inviti `internal_user` non ancora accettati e non scaduti del tenant del chiamante.

**Auth:** Super Admin.

**Request:** nessun body, nessun query param.

**Response 200:**
```json
{
  "invitations": [
    {
      "id": "c3d4e5f6-...",
      "targetEmail": "nuovo@officina.it",
      "firstName": "Luca",
      "lastName": "Ferrari",
      "role": "mechanic",
      "locationId": "b2c3d4e5-...",
      "expiresAt": "2026-05-26T10:00:00.000Z",
      "acceptedAt": null,
      "createdAt": "2026-05-19T10:00:00.000Z"
    }
  ]
}
```

**Errori:**
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin

---

#### DELETE /v1/users/invitations/:id — Revoca invito

Tombstons l'invito impostando `acceptedAt = now()`. Il log di audit distingue revoca da accettazione tramite il campo `action`.

**Auth:** Super Admin.

**Response 204 No Content.**

**Errori:**
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin
- `404 user.invitation.not_found` — ID non esiste o cross-tenant
- `410 user.invitation.already_accepted` — invito già accettato o revocato in precedenza

---

#### GET /v1/invitations/:token — Lettura pubblica invito (pre-fill form)

Endpoint pubblico (nessun JWT). Restituisce i campi necessari al form di accettazione. Tutti i casi invalidi (token inesistente, tipo errato, scaduto, già consumato) restituiscono `404 user.invitation.not_found` per anti-enum.

**Auth:** nessuna.

**Params:**
- `:token` — magic-link token (stringa, max 200 caratteri)

**Response 200:**
```json
{
  "invitation": {
    "targetEmail": "nuovo@officina.it",
    "firstName": "Luca",
    "lastName": "Ferrari",
    "role": "mechanic",
    "tenantName": "Officina Verdi",
    "locationName": "Sede Milano",
    "expiresAt": "2026-05-26T10:00:00.000Z"
  }
}
```

Campi interni (`id`, `locationId`, `tenantId`, `acceptedAt`, `createdAt`, `token`) NON esposti.

**Errori:**
- `404 user.invitation.not_found` — anti-enum: token non trovato, tipo errato, scaduto o già consumato

---

#### POST /v1/invitations/:token/accept — Accettazione pubblica invito

Endpoint pubblico (nessun JWT). Il bearer dell'URL è il token stesso. Crea l'account Cognito e l'utente DB in 4 fasi con rollback su Cognito in caso di errore. Il client deve fare un login separato dopo la 201 per ottenere il JWT.

**Auth:** nessuna.

**Rate limit:** 5 tentativi per minuto per IP.

**Params:**
- `:token` — magic-link token

**Request body:**
```json
{
  "password": "SecureP@ss123"
}
```

**Response 201:**
```json
{
  "user": {
    "id": "a1b2c3d4-...",
    "email": "nuovo@officina.it",
    "firstName": "Luca",
    "lastName": "Ferrari",
    "role": "mechanic",
    "locationId": "b2c3d4e5-...",
    "status": "active",
    "phone": null,
    "avatarUrl": null,
    "lastLoginAt": null,
    "createdAt": "2026-05-19T10:00:00.000Z",
    "updatedAt": "2026-05-19T10:00:00.000Z",
    "deletedAt": null
  }
}
```

**Fasi interne:**
1. Read + pre-flight check (no writes; anti-enum 404 su tutti i casi invalidi)
2. Cognito `AdminCreateUser` SUPPRESS → estrae `cognitoSub`
3. Cognito `AdminSetUserPassword` Permanent (rollback `AdminDeleteUser` se fallisce)
4. DB transaction: insert `User` + consuma `invitation` + `audit_log`

**Errori:**
- `400 VALIDATION_ERROR` — campo mancante o password < 8 caratteri
- `404 user.invitation.not_found` — anti-enum (vedi sopra)
- `409 user.invitation.email_already_active` — account già esistente per questa email
- `422 user.invitation.accept_password_policy` — password rifiutata da Cognito per policy
- `502 user.invitation.cognito_unavailable` — Cognito temporaneamente non disponibile

---

#### PATCH /v1/users/:id — Modifica utente (admin)

Modifica `role`, `locationId` e/o `status` di un utente del tenant. Almeno un campo richiesto. Cognito attributi sincronizzati best-effort dopo il commit DB.

**Auth:** Super Admin.

**Params:**
- `:id` — UUID dell'utente target

**Request body** (almeno un campo):
```json
{
  "role": "super_admin",
  "locationId": "b2c3d4e5-...",
  "status": "inactive"
}
```

Campi:
- `role` — `"super_admin"` | `"mechanic"` (optional)
- `locationId` — UUID | `null` (optional)
- `status` — `"active"` | `"inactive"` (optional)

**Response 200:**
```json
{
  "user": { "...UserAdmin DTO..." }
}
```

**Errori:**
- `400 VALIDATION_ERROR` — nessun campo fornito o valore non valido
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin
- `404 user.not_found` — utente non trovato o cross-tenant
- `409 user.last_super_admin` — modifica lascerebbe il tenant senza super_admin attivi — BR-203
- `422 user.location_required_for_mechanic` — role=mechanic ma locationId risultante è null — BR-204
- `422 user.location_invalid` — locationId non appartiene al tenant o non attiva

---

#### DELETE /v1/users/:id — Rimozione utente (soft delete)

Imposta `status=inactive` e `deletedAt=now()`. Non cancella fisicamente. L'utente non può fare login dopo il soft-delete.

**Auth:** Super Admin.

**Params:**
- `:id` — UUID dell'utente target

**Response 204 No Content.**

**Errori:**
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin
- `404 user.not_found` — utente non trovato o già soft-deleted o cross-tenant
- `409 user.last_super_admin` — rimozione lascerebbe il tenant senza super_admin attivi — BR-203
- `422 user.cannot_delete_self_via_admin` — l'actor non può rimuovere se stesso tramite questo endpoint

---

#### POST /v1/users/:id/reactivate — Riattivazione utente (F-OFF-004 slice 2026-05-21)

**Auth:** Tenant User con `role=super_admin` nel pool `officine`.

**Request body** (tutti optional):

```json
{
  "role": "super_admin" | "mechanic",
  "locationId": "uuid | null"
}
```

Body vuoto `{}` valido: ripristina role/locationId originali (validati). `locationId: null` esplicito ammesso solo se nuovo `role === 'super_admin'` (BR-204).

**Response 200:**

```json
{ "user": { /* USER_ADMIN serializer */ } }
```

**Response header opzionale:** `x-cognito-sync-failed: true` se Cognito `AdminEnableUser` o `AdminUpdateUserAttributes` post-tx ha fallito (DB già committed; operator deve eseguire enable manuale via console).

**Error codes:**

| HTTP | Code | Trigger |
|---|---|---|
| 403 | `auth.forbidden.super_admin_required` | Caller non super_admin |
| 404 | `user.not_found` | Target non esiste, è in altro tenant, o non è soft-deleted |
| 422 | `user.already_active` | Race/replay defensive (BR-212) |
| 422 | `user.location_required_for_mechanic` | BR-204 |
| 422 | `user.location_invalid` | Sede stale o cross-tenant |

**Business rules**: BR-212 (Riattivazione).

---

#### GET /v1/tenants/me/locations — Lista location attive (F-OFF-004 scope)

Restituisce le location `status=active` non soft-deleted del tenant corrente. Usato da `InviteUserDialog` per popolare il select sede al momento dell'invito.

**Auth:** Super Admin (per utilizzo F-OFF-004; il medesimo endpoint è listato anche in F-OFF-003 per Tenant User).

**Response 200:**
```json
{
  "locations": [
    {
      "id": "b2c3d4e5-...",
      "name": "Sede Milano",
      "addressLine": "Via Milano 1",
      "city": "Milano",
      "province": "MI",
      "postalCode": "20100",
      "country": "IT",
      "phone": "+39 02 1234567",
      "email": "milano@officina.it",
      "isPrimary": true
    }
  ]
}
```

> Nota (F-OFF-003 PR2, 2026-06-01): i campi indirizzo completi (`addressLine`, `province`, `postalCode`, `country`, `phone`, `email`) sono stati aggiunti alla response per popolare il form di modifica nella UI gestione sedi. Il consumer F-OFF-004 (`InviteUserDialog`) ne legge solo un sottoinsieme.

Ordine: sede primaria prima (`isPrimary DESC`), poi alfabetico per nome.

**Errori:**
- `401 UNAUTHORIZED` — JWT mancante/invalido
- `403 auth.forbidden.super_admin_required` — JWT role != super_admin

---

#### POST /v1/tenants/me/locations — Crea sede (F-OFF-003)

Crea una sede **secondaria** per il tenant corrente. La sede nasce sempre `isPrimary=false` e `status=active`; per designare la primaria si usa il PATCH (`isPrimary:true`). Vedi BR-200/BR-201.

**Auth:** Super Admin (`requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin`).

**Request body:**
```json
{
  "name": "Sede Roma",
  "addressLine": "Via Roma 1",
  "city": "Roma",
  "province": "RM",
  "postalCode": "00100",
  "country": "IT",
  "phone": "+39 06 1234567",
  "email": "roma@officina.it"
}
```

Validazione: `name` (1–200, obbligatorio), `addressLine` (1–255, obbligatorio), `city` (1–100, obbligatorio), `province` (2 lettere, uppercased, obbligatorio), `postalCode` (5 cifre, obbligatorio), `country` (2 lettere, default `IT`), `phone` (opzionale/null), `email` (opzionale/null). `isPrimary` **non accettato** → `422 tenants.me.locations.update.unknown_field`.

**Response 201:**
```json
{
  "location": {
    "id": "b2c3d4e5-...",
    "name": "Sede Roma",
    "addressLine": "Via Roma 1",
    "city": "Roma",
    "province": "RM",
    "postalCode": "00100",
    "country": "IT",
    "phone": "+39 06 1234567",
    "email": "roma@officina.it",
    "isPrimary": false,
    "status": "active",
    "createdAt": "2026-06-01T10:00:00.000Z",
    "updatedAt": "2026-06-01T10:00:00.000Z"
  }
}
```

#### PATCH /v1/tenants/me/locations/:id — Modifica sede / designa primaria (F-OFF-003)

Modifica i campi indirizzo e/o promuove la sede a primaria. Almeno un campo richiesto. Body `.partial()`, stessi campi del POST **+ `isPrimary`**.

- `isPrimary:true` → **swap atomico**: la primaria corrente viene demota (`isPrimary=false`) e questa sede promossa, in un'unica transazione (rispetta il partial-unique-index BR-201).
- `isPrimary:false` esplicito → `422 tenants.me.locations.cannot_unset_primary` (non si lascia il tenant senza primaria; per cambiarla, promuovi un'altra sede).

**Auth:** Super Admin.

**Response 200:** stesso shape `{ "location": { … } }` del POST.

**Errori:**
- `404 tenants.me.locations.not_found` — `:id` non appartiene al tenant o è soft-deleted
- `422 tenants.me.locations.update.empty_body` — body `{}`
- `422 tenants.me.locations.update.unknown_field` — chiave non in schema
- `422 tenants.me.locations.cannot_unset_primary` — `isPrimary:false`

#### DELETE /v1/tenants/me/locations/:id — Disattiva sede (F-OFF-003)

Soft delete: `status=inactive` + `deletedAt=now()`. Gli interventi storici conservano il loro `location_id` (nessuna cancellazione dati).

**Auth:** Super Admin.

**Response 200:** `{ "location": { … } }` con `status: "inactive"`.

**Errori:**
- `404 tenants.me.locations.not_found` — `:id` non del tenant o già disattivata
- `422 tenants.me.locations.cannot_delete_primary` — la sede è la primaria (designa prima un'altra primaria) — BR-201
- `422 tenants.me.locations.has_active_users` — esistono meccanici attivi assegnati a questa sede (riassegnali prima) — BR-204

---

### 3.4 Customers (lato officina)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/customers/search` | F-OFF-202, F-OFF-502 | Tenant User | **[DETTAGLIATO §2.8]** Ricerca cliente per nome/ragione sociale/telefono (tenant-scoped) |
| GET | `/customers` | F-OFF-202 | Tenant User | **[DETTAGLIATO §2.8b]** Lista clienti del tenant (con ricerca) |
| POST | `/customers` | F-OFF-201 | Tenant User | **[DETTAGLIATO §2.9b]** Crea nuovo cliente (dedupe email + link CTR) |
| GET | `/customers/:id` | F-OFF-203 | Tenant User | **[DETTAGLIATO §2.9]** Dettaglio cliente officina (BR-151) |
| PATCH | `/customers/:id` | F-OFF-204 | Tenant User | **[DETTAGLIATO §2.10]** Modifica cliente officina |
| POST | `/customers/:id/invite` | F-OFF-205 | Tenant User | Invia invito app a cliente |
| GET | `/customers/:id/vehicles` | - | Tenant User | Veicoli del cliente |
| GET | `/customers/:id/interventions` | F-OFF-203 | Tenant User | Tutti gli interventi di questo cliente presso il tenant |
| PATCH | `/customers/:id/notes` | F-OFF-206 | Tenant User | Modifica note riservate |
| POST | `/customers/import` | F-OFF-207 | Super Admin | Import massivo da CSV |

### 3.5 Vehicles

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/vehicles/search` | F-OFF-101, F-OFF-502 | Tenant User | Ricerca unificata per codice/targa/VIN/cliente |
| GET | `/vehicles/:id` | F-OFF-105 | Tenant User | Dettaglio veicolo (regole visibilità applicate). Response include `tag_first_printed_at: ISO\|null` (vedi §2.14). |
| POST | `/vehicles` | F-OFF-102, F-OFF-103 | Tenant User | **[DETTAGLIATO §2.1]** Censisce nuovo veicolo |
| PATCH | `/vehicles/:id` | F-OFF-106 | Tenant User | Modifica dati veicolo (alcuni campi immutabili) |
| POST | `/vehicles/:id/certify` | F-OFF-107 | Tenant User | Promuove veicolo da pending a certified |
| GET | `/vehicles/:id/tag` | F-OFF-104, F-OFF-109 | Tenant User | **[DETTAGLIATO §2.13]** Presigned URL per scaricare PDF del tag (codice + QR) |
| POST | `/vehicles/:id/tag-reprint` | F-OFF-109 | Tenant User | **[DETTAGLIATO §2.14]** Ristampa tag PDF veicolo (richiede audit precedente + reason) |
| GET | `/vehicles/:id/access-log` | F-OFF-601, F-CLI-304 | Any User | Log accessi al veicolo |
| GET | `/vehicles/:id/timeline` | F-OFF-105, F-CLI-201 | Any User | **[DETTAGLIATO §2.5]** Timeline interventi |
| POST | `/me/vehicles/claim` | F-CLI-101, F-CLI-102, F-CLI-103 | Customer | **[DETTAGLIATO §2.4]** Aggancia veicolo tramite codice |
| GET | `/me` | F-CLI-004 | Customer | Profilo del cliente autenticato |
| PATCH | `/me/profile` | F-CLI-004 | Customer | Modifica nome/cognome/telefono (email immutabile) |
| GET | `/me/vehicles` | F-CLI-105 | Customer | Lista veicoli del customer |
| GET | `/me/vehicles/:id` | F-CLI-106 | Customer | Dettaglio veicolo per customer |
| GET | `/me/vehicles/:id/access-log` | F-CLI-304 | Customer | Audit accessi al veicolo (BR-155, redatto) |
| PATCH | `/me/vehicles/:id` | F-CLI-107 | Customer | Modifica dati non tecnici (nickname, foto) |
| DELETE | `/me/vehicles/:id` | F-CLI-108 | Customer | Rimuove associazione (no cancellazione veicolo) |
| GET | `/me/interventions/:id` | F-CLI-206 | Customer | **[DETTAGLIATO §2.4c]** Dettaglio intervento officina + thread contestazioni cliente |
| POST | `/me/vehicles/pending` | F-CLI-104 | Customer | Pre-registrazione veicolo pendente con libretto |
| POST | `/vehicles/:id/share-link` | F-CLI-502 | Customer | Genera link condivisione temporaneo |
| DELETE | `/vehicles/:id/share-link/:token` | F-CLI-502 | Customer | Revoca link |
| GET | `/me/vehicles/:id/export.pdf` | F-CLI-501 | Customer | **[DETTAGLIATO §3.5b]** Export PDF storico interventi officina |

#### GET /v1/me/vehicles/:id/access-log (F-CLI-304)

Restituisce l'audit trail degli accessi a un veicolo di proprietà del cliente
autenticato (BR-155). Solo pool clienti.

Query: `limit` (1-50, default 20), `cursor` (cursor opaco composito `(createdAt, id)`).

Risposta `200`:

```jsonc
{
  "data": [
    {
      "action": "view",            // "view" | "new_intervention"
      "tenantName": "Officina Rossi",
      "locationCity": "Bologna",   // string | null
      "occurredAt": "2026-06-04T14:32:10.123Z",
      "mechanicName": "Mario Bianchi"  // presente solo se esiste un customer_tenant_relation (BR-151)
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaco>" }
}
```

Redazione (BR-155): la risposta non include mai indirizzo IP, user agent o id
interni. Compaiono solo `view` e la `create` di intervento (esposta come
`new_intervention`); le registrazioni veicolo (`vehicle_registered`) e le altre
azioni sono escluse. `404 me.vehicle.not_found` se il cliente non possiede
attualmente il veicolo.

#### GET /v1/me/vehicles/:id/export.pdf (F-CLI-501)

Genera un PDF professionale con lo **storico completo degli interventi officina**
del veicolo posseduto dal cliente autenticato, da mostrare a un potenziale
acquirente. Solo pool clienti.

> **Divergenza dal path storico.** La specifica originale citava
> `GET /vehicles/:id/export.pdf`; l'endpoint vive sulla superficie cliente
> `/me/...` per coerenza con il resto dell'app cliente (stessa scelta di
> `POST /me/vehicles/claim`, F-CLI-101). Riusa la meccanica PDF di F-OFF-309
> (`pdf-lib` render server-side → S3 → presigned URL).

Comportamento:

- **Gate ownership** (frontiera di sicurezza, mai solo RLS): solo il proprietario
  attivo (`vehicle_ownerships.ended_at IS NULL`, BR-040) può generare il PDF;
  altrimenti `404 me.vehicle.not_found` (nessun leak di esistenza).
- **Contenuto**: interventi officina con stato `active` e `disputed`,
  **cross-tenant** (BR-150: ogni officina che ha lavorato sul veicolo). Gli
  interventi `cancelled` sono **esclusi**; il thread di contestazione non è
  esposto; le `internal_notes` non sono mai incluse.
- Header GarageOS-branded (documento multi-officina, nessun logo officina,
  nessun nome proprietario); ogni intervento è etichettato `officina · città`.
- PDF rigenerato e sovrascritto a ogni richiesta (storico mutabile), persistito
  su S3 con chiave `vehicle-history-pdfs/<vehicleId>.pdf`, presigned 1h.
- Storico vuoto (0 interventi) → `200` con PDF "Nessun intervento officina
  registrato".

Risposta `200`:

```jsonc
{
  "pdf_download_url": "https://<bucket>.s3.<region>.amazonaws.com/vehicle-history-pdfs/<vehicleId>.pdf?X-Amz-…",
  "expires_at": "2026-06-09T19:00:00Z"
}
```

Errori: `401`, `404 me.vehicle.not_found`, `429`, `500`. Nessun codice
4xx domain-specific nuovo.

### 3.6 Interventions

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| POST | `/vehicles/:id/interventions` | F-OFF-301, F-OFF-308 | Tenant User | **[DETTAGLIATO §2.2]** Crea intervento |
| GET | `/interventions/:id` | F-OFF-301 | Tenant User | **[DETTAGLIATO §2.12]** Dettaglio intervento officina (BR-062 wiki_window_open, allegati confermati) |
| PATCH | `/interventions/:id` | F-OFF-304 | Tenant User | Modifica intervento (wiki rules). Vedi §2.12 per read-after-write. |
| POST | `/interventions/:id/cancel` | F-OFF-307 | Super Admin | Annulla intervento con motivazione |
| GET | `/interventions/:id/revisions` | F-OFF-304 | Any User | Storico modifiche. Vedi §2.12 per il DTO completo dell'intervento. |
| POST | `/interventions/:id/dispute` | F-CLI-206 | Customer | **[DETTAGLIATO §2.6]** Contesta intervento |
| POST | `/interventions/:id/dispute-response` | F-OFF-602 | Tenant User | **[DETTAGLIATO §2.6.1]** Risposta officina a contestazione |
| GET | `/interventions/:id/disputes` | F-OFF-602 | Tenant User | **[DETTAGLIATO §2.11]** Lista contestazioni intervento |
| GET | `/intervention-types` | F-OFF-302 | Any User | Catalogo tipi intervento |
| POST | `/intervention-types` | F-OFF-302 | Super Admin | Crea tipo custom (tenant) |
| GET | `/intervention-templates` | F-OFF-303 | Tenant User | Template tenant (v1.1) |

### 3.7 Private Interventions (cliente)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/me/vehicles/:id/private-interventions` | F-CLI-201 | Customer | Lista interventi privati |
| POST | `/me/vehicles/:id/private-interventions` | F-CLI-203 | Customer | Crea intervento privato |
| GET | `/me/private-interventions/:id` | F-CLI-202 | Customer | Dettaglio |
| PATCH | `/me/private-interventions/:id` | F-CLI-204 | Customer | Modifica |
| DELETE | `/me/private-interventions/:id` | F-CLI-204 | Customer | Cancella |

### 3.8 Deadlines

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/deadlines` | F-OFF-402 | Tenant User | Lista aggregata scadenze del tenant (officina). Filtri status (default open) + intervention_type_id + cursor pagination. BR-151 PII customer filtrata. |
| POST | `/vehicles/:id/deadlines` | F-OFF-401 | Tenant User | Crea scadenza |
| GET | `/vehicles/:id/deadlines` | F-OFF-401 | Any User | Lista scadenze del veicolo |
| PATCH | `/deadlines/:id` | F-OFF-401 | Tenant User | Modifica scadenza |
| DELETE | `/deadlines/:id` | F-OFF-401 | Tenant User | Cancella scadenza |
| POST | `/deadlines/:id/complete` | F-OFF-405 | Tenant User | Marca come completata |
| GET | `/tenants/me/deadlines/upcoming` | F-OFF-402, F-OFF-404 | Tenant User | Scadenze in arrivo |
| GET | `/me/deadlines` | F-CLI-301 | Customer | Scadenze sui miei veicoli |
| POST | `/me/personal-deadlines` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Crea scadenza personale su veicolo posseduto |
| GET | `/me/personal-deadlines` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Lista scadenze personali (filtri `?status=`, `?vehicleId=`) |
| GET | `/me/personal-deadlines/:id` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Dettaglio scadenza personale |
| PATCH | `/me/personal-deadlines/:id` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Modifica scadenza personale |
| DELETE | `/me/personal-deadlines/:id` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Elimina scadenza personale |
| POST | `/me/personal-deadlines/:id/complete` | F-CLI-306 | Customer | **[DETTAGLIATO §2.4d]** Completa scadenza; risposta include `renewalSuggestion` se ricorrente (BR-296) |

### 3.9 Attachments

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| POST | `/attachments/upload-url` | F-OFF-305 | Tenant User | **[DETTAGLIATO §2.7]** Richiede presigned URL upload |
| POST | `/attachments/:id/confirm` | F-OFF-305 | Tenant User | **[DETTAGLIATO §2.7]** Conferma upload completato |
| GET | `/attachments/:id/view-url` | F-OFF-301 | Tenant User | **[DETTAGLIATO §2.7.1]** Presigned GET URL per visualizzare allegato (15 min, lazy per click) |
| GET | `/attachments/:id` | (deferred) | - | Dettaglio attachment metadata (non shipped in v1) |
| GET | `/attachments/:id/download-url` | F-OFF-305 | Any User | Presigned URL download (15 min validity) |
| DELETE | `/attachments/:id` | F-OFF-305 | Any User | Rimuove allegato |

**Cross-pool note (`owner_type=intervention_dispute`):**

L'`owner_type=intervention_dispute` è cross-pool: customer-pool per allegati alla contestazione (§2.6), officina-pool per allegati alla risposta (§2.6.1). In entrambi i casi `owner_id` è l'`intervention.id` del genitore. Il binding alla `dispute.id` avviene atomicamente al momento del create della dispute o della risposta.

Auth gating per `owner_type=intervention_dispute`:
- Customer-pool: il caller deve essere current owner del veicolo (BR-120).
- Officina-pool: il caller deve essere `super_admin` o `mechanic` E deve esistere almeno una dispute `open` sull'intervention.

L'`owner_type=intervention` resta officina-only.

### 3.10 Transfers

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| POST | `/me/transfers` | F-CLI-401 | Customer | **[DETTAGLIATO §2.3]** Avvia passaggio di proprietà (PR1) |
| GET | `/me/transfers` | F-CLI-401 | Customer | Lista trasferimenti del customer (PR1) |
| GET | `/me/transfers/:id` | F-CLI-401 | Customer | Dettaglio trasferimento (PR1) |
| POST | `/me/transfers/:code/accept` | F-CLI-402, F-CLI-403 | Customer | Cessionario accetta trasferimento (PR2) |
| GET | `/me/transfers/:code/preview` | F-CLI-402 | Customer | Anteprima trasferimento via codice, read-only (PR4) |
| POST | `/me/transfers/:id/confirm` | F-CLI-403 | Customer | Cedente conferma dopo accettazione cessionario (PR2) |
| POST | `/me/transfers/:id/reject` | F-CLI-403 | Customer | Rifiuta trasferimento (PR2) |
| POST | `/me/transfers/claim-without-seller` | F-CLI-404 | Customer | Claim autonomo con libretto (PR2+) |

### 3.11 Notifications

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/me/notifications` | F-CLI-305 | Customer | Lista notifiche |
| POST | `/me/notifications/:id/read` | F-CLI-305 | Customer | Marca come letta |
| POST | `/me/notifications/read-all` | F-CLI-305 | Customer | Marca tutte come lette |
| GET | `/me/notification-preferences` | F-CLI-005 | Customer | Preferenze canali |
| PATCH | `/me/notification-preferences` | F-CLI-005 | Customer | Modifica preferenze (email + push per-evento) |
| POST | `/me/push-tokens` | F-CLI-302 | Customer | **[DETTAGLIATO §2.4b]** Registra push token device |
| DELETE | `/me/push-tokens/:id` | F-CLI-302 | Customer | **[DETTAGLIATO §2.4b]** Rimuove push token |

### 3.12 Admin (team GarageOS)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/v1/admin/me` | Slice 0 | Platform Admin | **[DETTAGLIATO §3.12.1]** Identità admin autenticato (JWT claims, no DB) |
| POST | `/v1/admin/tenants` | Slice 1 | Platform Admin | **[DETTAGLIATO §3.12.2]** Crea nuovo tenant (officina), location primaria e invito owner |
| GET | `/v1/admin/tenants` | Slice 2 | Platform Admin | **[DETTAGLIATO §3.12.3]** Lista tutti i tenant con stato e owner summary |
| POST | `/v1/admin/tenants/:id/suspend` | Slice 2 | Platform Admin | **[DETTAGLIATO §3.12.4]** Sospendi tenant (BR-210) |
| POST | `/v1/admin/tenants/:id/reactivate` | Slice 2 | Platform Admin | **[DETTAGLIATO §3.12.4]** Riattiva tenant (BR-210) |
| POST | `/v1/admin/tenants/:id/regenerate-invitation` | Slice 2 | Platform Admin | **[DETTAGLIATO §3.12.5]** Rigenera magic-link invito owner (unico endpoint a restituire token in chiaro) |
| GET | `/v1/admin/tenants/:id` | Slice 3 | Platform Admin | **[DETTAGLIATO §3.12.6]** Profilo completo tenant (shape TENANT_ME) |
| PATCH | `/v1/admin/tenants/:id` | Slice 3 | Platform Admin | **[DETTAGLIATO §3.12.7]** Modifica profilo tenant, inclusa P.IVA (campo inibito in PATCH /v1/tenants/me) |
| GET | `/v1/admin/tenants/:id/users` | Slice 3 | Platform Admin | **[DETTAGLIATO §3.12.8]** Lista utenti del tenant (inclusi soft-deleted) |
| PATCH | `/v1/admin/tenants/:id/users/:userId` | Slice 3 | Platform Admin | **[DETTAGLIATO §3.12.9]** Modifica ruolo/sede/stato utente cross-tenant (BR-203, BR-204) |
| POST | `/v1/admin/tenants/:id/users/invitations` | Slice 3 | Platform Admin | **[DETTAGLIATO §3.12.10]** Invita nuovo utente nel tenant; rate-limit 30/h |
| GET | `/admin/tenants` | F-ADM-001 | Admin | Lista tutti i tenant |
| POST | `/admin/tenants/:id/suspend` | F-ADM-002 | Admin | Sospendi tenant |
| POST | `/admin/tenants/:id/activate` | F-ADM-002 | Admin | Riattiva tenant |
| POST | `/admin/tenants/:id/impersonate` | F-ADM-001 | Admin | Genera token di impersonation per supporto |
| GET | `/admin/vehicles/lookup` | F-ADM-003 | Admin | Ricerca veicolo per supporto recupero codice |
| POST | `/admin/vehicles/:id/resend-code` | F-ADM-003 | Admin | Reinvia codice a cliente verificato |
| GET | `/admin/disputes` | F-ADM-004 | Admin | Contestazioni non risolte |
| POST | `/admin/disputes/:id/escalate` | F-ADM-004 | Admin | Escalation dispute |
| GET | `/admin/pending-vehicles` | F-ADM-006 | Admin | Coda libretti da validare |
| POST | `/admin/pending-vehicles/:id/approve` | F-ADM-006 | Admin | Approva validazione libretto |
| POST | `/admin/pending-vehicles/:id/reject` | F-ADM-006 | Admin | Rifiuta validazione |
| GET | `/admin/metrics` | F-ADM-008 | Admin | Dashboard KPI |

#### 3.12.1 `GET /v1/admin/me` — Identità platform admin

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** standard
**Shipped:** Slice 0 PR-B

Restituisce i campi di identità estratti direttamente dal JWT verificato, senza alcuna lettura dal database. Usato dalla console di piattaforma per mostrare l'operatore autenticato. I campi `firstName`/`lastName` corrispondono agli standard claims Cognito `given_name`/`family_name`.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Se il JWT appartiene al pool `officine` o `clienti`, il middleware risponde `403 FORBIDDEN`.

**Response `200 OK`:**

```json
{
  "sub": "cognito-uuid",
  "email": "admin@garageos.it",
  "firstName": "Nome",
  "lastName": "Cognome"
}
```

| Campo | Tipo | Fonte |
|---|---|---|
| `sub` | `string` | JWT claim `sub` |
| `email` | `string` | JWT claim `email` |
| `firstName` | `string` | JWT claim `given_name` |
| `lastName` | `string` | JWT claim `family_name` |

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)

#### 3.12.2 `POST /v1/admin/tenants` — Crea nuovo tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** standard
**Shipped:** Slice 1

Crea un nuovo tenant (officina) con location primaria (placeholder indirizzo) e un invito `super_admin` (tipo `internal_user`, scadenza 7 giorni). Invia il magic-link di onboarding all'`ownerEmail` via Resend. Sostituisce `scripts/rebuild-tenants.mjs` per i nuovi tenant in produzione.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant — l'endpoint opera a livello piattaforma.

**Request body:**

```json
{
  "businessName": "Officina Rossi SRL",
  "vatNumber": "12345678901",
  "email": "info@officinarossi.it",
  "ownerFirstName": "Giuseppe",
  "ownerLastName": "Rossi",
  "ownerEmail": "giuseppe.rossi@officinarossi.it"
}
```

| Campo | Tipo | Obbligatorio | Note |
|---|---|---|---|
| `businessName` | string | sì | Max 200 caratteri |
| `vatNumber` | string | sì | 11 cifre esatte, univoco tra i tenant |
| `email` | string | sì | Email di contatto del tenant |
| `ownerFirstName` | string | sì | Nome del primo super_admin |
| `ownerLastName` | string | sì | Cognome del primo super_admin |
| `ownerEmail` | string | sì | Email del primo super_admin; riceve il magic-link di onboarding |

**Response `201 Created`:**

```json
{
  "tenant": {
    "id": "uuid",
    "businessName": "Officina Rossi SRL",
    "vatNumber": "12345678901",
    "status": "active"
  },
  "invitation": {
    "ownerEmail": "giuseppe.rossi@officinarossi.it",
    "expiresAt": "2026-07-05T10:00:00Z",
    "emailSent": true
  }
}
```

Nessun token di invito viene restituito nella risposta — la consegna è esclusivamente via email (Resend).

**Errori:**

- `400 tenant.vat_number_invalid` — `vatNumber` non è composto da 11 cifre
- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `409 tenant.vat_number_duplicate` — partita IVA già registrata in un tenant esistente
- `409 user.invitation.email_in_other_tenant` — `ownerEmail` già registrata in un altro tenant (Cognito hit)
- `502 auth.cognito_unavailable` — Cognito `AdminGetUser` lookup fallito durante il pre-check email

#### 3.12.3 `GET /v1/admin/tenants` — Lista tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** nessuno (solo lettura)
**Shipped:** Slice 2

Restituisce tutti i tenant non eliminati in ordine decrescente di creazione, ciascuno con il riepilogo dell'owner derivato dall'ultima invitation `super_admin` di tipo `internal_user`. L'owner viene risolto con un'unica query batch (nessun N+1).

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant — opera a livello piattaforma con `withContext({ role: 'admin' })`.

**Response `200 OK`:**

```json
{
  "tenants": [
    {
      "id": "uuid",
      "businessName": "Officina Rossi SRL",
      "vatNumber": "12345678901",
      "email": "info@officinarossi.it",
      "status": "active",
      "createdAt": "2026-06-01T10:00:00.000Z",
      "owner": {
        "email": "giuseppe.rossi@officinarossi.it",
        "invitationStatus": "pending"
      }
    }
  ]
}
```

| Campo | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | |
| `businessName` | `string` | |
| `vatNumber` | `string` | 11 cifre |
| `email` | `string` | Email di contatto del tenant (non nullable) |
| `status` | `"active" \| "suspended" \| "pending" \| "cancelled"` | |
| `createdAt` | `string` (ISO-8601) | |
| `owner` | `{ email: string; invitationStatus: "pending" \| "accepted" \| "expired" } \| null` | `null` se nessun invito `super_admin` esiste per il tenant |

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)

#### 3.12.4 `POST /v1/admin/tenants/:id/suspend` e `/reactivate` — Lifecycle tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** nessuno
**Shipped:** Slice 2

Gestiscono la transizione di stato del tenant (BR-210):

- `suspend`: `active` → `suspended`
- `reactivate`: `suspended` → `active`

Anti-enumerazione: UUID non valido nel formato e ID sconosciuto restituiscono entrambi `404 tenant.not_found`.
L'audit log registra `tenant_suspended` / `tenant_reactivated` con `actorType: 'system'` e il Cognito sub del platform-admin nel campo `metadata`.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant (`withContext({ role: 'admin' })` diretto).

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant da modificare |

**Response `200 OK` — suspend:**

```json
{
  "tenant": {
    "id": "uuid",
    "status": "suspended"
  }
}
```

**Response `200 OK` — reactivate:**

```json
{
  "tenant": {
    "id": "uuid",
    "status": "active"
  }
}
```

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)
- `409 tenant.invalid_status` — transizione non consentita (es. sospendere un tenant già sospeso)

#### 3.12.5 `POST /v1/admin/tenants/:id/regenerate-invitation` — Rigenera magic-link

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** 30 richieste/ora per platform-admin (chiave: `jwt.sub`, fallback `ip`)
**Shipped:** Slice 2

Path di recovery dell'operatore: rigenera il token del magic-link sull'invitation `super_admin` esistente tramite UPDATE in-place (non crea una nuova riga). Il vecchio token viene invalidato immediatamente al commit della transazione.

> **Nota:** Questo è il **solo endpoint in GarageOS che restituisce un token in chiaro** (`magicLinkUrl`). È intenzionale: il platform-admin autenticato esegue un'azione di recovery esplicita e può consegnare il link direttamente al titolare dell'officina tramite un canale secondario quando la consegna email fallisce.

L'invio email è best-effort (mirror di Slice 1). Se fallisce, `emailSent: false` e `magicLinkUrl` nella risposta è il fallback dell'operatore.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant.

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant di cui rigenerare l'invito |

**Response `200 OK`:**

```json
{
  "invitation": {
    "ownerEmail": "giuseppe.rossi@officinarossi.it",
    "expiresAt": "2026-07-05T10:00:00.000Z",
    "emailSent": true,
    "magicLinkUrl": "https://app.garageos.aifollyadvisor.com/invitations/TOKEN"
  }
}
```

| Campo | Tipo | Note |
|---|---|---|
| `ownerEmail` | `string` | Email del titolare destinatario del link |
| `expiresAt` | `string` (ISO-8601) | Scadenza del nuovo token (7 giorni da adesso) |
| `emailSent` | `boolean` | `false` se l'invio email ha fallito (best-effort) |
| `magicLinkUrl` | `string` | URL completo del magic-link — **token in chiaro, solo in questo endpoint** |

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)
- `404 user.invitation.not_found` — nessun invito `super_admin` esistente per questo tenant (tenant provisionato prima di Slice 1)
- `409 tenant.invalid_status` — il tenant non è `active` (sospeso o cancellato — il guard mirror quello di `invitations-public-accept.ts`)
- `410 user.invitation.already_accepted` — l'invitation è già stata accettata; usare un flow di invito separato per aggiungere utenti
- `429 admin.tenant.rate_limited` — oltre 30 richieste/ora per platform-admin

#### 3.12.6 `GET /v1/admin/tenants/:id` — Profilo tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** standard
**Shipped:** Slice 3

Restituisce il profilo completo del tenant indicato dal percorso. La shape di risposta è identica a quella di `GET /v1/tenants/me` (serializzatore `serializeTenantMe`), incluso il campo derivato `onboardingCompletedAt`.

Anti-enumerazione: UUID non valido nel formato e ID sconosciuto restituiscono entrambi `404 tenant.not_found`.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant (`withContext({ role: 'admin' })` diretto).

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant |

**Response `200 OK`:**

```json
{
  "tenant": {
    "id": "uuid",
    "businessName": "Officina Rossi SRL",
    "vatNumber": "12345678901",
    "email": "info@officinarossi.it",
    "phone": "+39 02 1234567",
    "addressLine": "Via Roma 1",
    "city": "Milano",
    "province": "MI",
    "postalCode": "20100",
    "status": "active",
    "plan": "base",
    "billingStatus": "ok",
    "createdAt": "2026-06-01T10:00:00.000Z",
    "onboardingCompletedAt": "2026-06-02T08:00:00.000Z"
  }
}
```

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)

#### 3.12.7 `PATCH /v1/admin/tenants/:id` — Modifica profilo tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** standard
**Shipped:** Slice 3

Modifica il profilo del tenant. A differenza di `PATCH /v1/tenants/me`, **la P.IVA (`vatNumber`) è modificabile** da questo endpoint (campo legale che richiede validazione operatore). L'aggiornamento è atomico: il log di audit `tenant_profile_updated` viene scritto nella stessa transazione Postgres. `actorType:'system'` nel log di audit; il Cognito sub del platform-admin è catturato nel campo `metadata`.

Anti-enumerazione: UUID non valido nel formato e ID sconosciuto restituiscono entrambi `404 tenant.not_found`.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant.

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant da modificare |

**Request body** (parziale, almeno un campo):

```json
{
  "businessName": "Officina Rossi SRL",
  "vatNumber": "12345678901",
  "email": "info@officinarossi.it",
  "phone": "+39 02 1234567",
  "addressLine": "Via Roma 1",
  "city": "Milano",
  "province": "MI",
  "postalCode": "20100"
}
```

| Campo | Tipo | Note |
|---|---|---|
| `businessName` | string | Max 200 caratteri |
| `vatNumber` | string | 11 cifre esatte (VatNumberSchema) — modificabile solo da questo endpoint admin |
| `email` | string | RFC 5322, non-nullable |
| `phone` | string \| null | Formato libero 6-30 char `[+]?[0-9 ()-]` |
| `addressLine` | string \| null | Max 255 caratteri |
| `city` | string \| null | Max 100 caratteri |
| `province` | string \| null | 2 lettere maiuscole (auto-uppercase) |
| `postalCode` | string \| null | Esattamente 5 cifre |

**Response `200 OK`:** stessa shape di `GET /v1/admin/tenants/:id` (§3.12.6).

**Errori:**

- `400 VALIDATION_ERROR` — validazione campi fallita
- `400 tenant.vat_number_invalid` — `vatNumber` non è composto da 11 cifre
- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)
- `409 tenant.vat_number_duplicate` — P.IVA già registrata in un altro tenant
- `422 tenants.me.update.empty_body` — body senza campi modificabili
- `422 tenants.me.update.unknown_field` — body contiene un campo non modificabile

#### 3.12.8 `GET /v1/admin/tenants/:id/users` — Lista utenti tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** nessuno (solo lettura)
**Shipped:** Slice 3

Restituisce tutti gli utenti (attivi, inattivi e soft-deleted) del tenant indicato. Equivalente a `GET /v1/users` ma con scope cross-tenant. Il client filtra per `status` lato UI.

Anti-enumerazione: UUID non valido nel formato e ID sconosciuto restituiscono entrambi `404 tenant.not_found` (un tenant inesistente non restituisce `[]`).

> **Nota sicurezza:** la policy RLS `users_read` è `USING(true)` (permissiva). Il filtro `{ tenantId: id }` a livello applicativo è l'unico guard cross-tenant e non va mai omesso.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. `withContext({ role: 'admin' })` diretto.

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant |

**Response `200 OK`:**

```json
{
  "users": [
    {
      "id": "a1b2c3d4-...",
      "email": "marco@officina.it",
      "firstName": "Marco",
      "lastName": "Rossi",
      "role": "super_admin",
      "locationId": null,
      "status": "active",
      "phone": null,
      "avatarUrl": null,
      "lastLoginAt": "2026-05-19T08:30:00.000Z",
      "createdAt": "2026-04-01T09:00:00.000Z",
      "updatedAt": "2026-05-01T12:00:00.000Z",
      "deletedAt": null
    }
  ]
}
```

Shape per-elemento: DTO **UserAdmin** (definito in §3.3).

**Errori:**

- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)

#### 3.12.9 `PATCH /v1/admin/tenants/:id/users/:userId` — Modifica utente tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** standard
**Shipped:** Slice 3

Modifica ruolo, sede e/o stato di un utente nel tenant indicato. Delega tutta la logica di business a `updateOfficineUser` (identico al percorso officine `PATCH /v1/users/:id`): le stesse guardie BR-203 (ultimo super_admin) e BR-204 (meccanico senza sede) si applicano in modo identico. `actorType:'system'` nel log di audit; il Cognito sub del platform-admin è catturato in `metadata`.

Anti-enumerazione: UUID non valido nel formato per `:id` o `:userId` → `404 tenant.not_found`.

Se `role='mechanic'` e `locationId` è assente nel body, l'endpoint tenta auto-default alla sede primaria attiva del tenant (BR-204 defaulting). Se non esiste, `updateOfficineUser` solleva `user.location_required_for_mechanic 422`.

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant.

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant |
| `userId` | `string` (UUID) | ID dell'utente target |

**Request body** (almeno un campo):

```json
{
  "role": "super_admin",
  "locationId": "b2c3d4e5-...",
  "status": "inactive"
}
```

| Campo | Tipo | Note |
|---|---|---|
| `role` | `"super_admin"` \| `"mechanic"` | optional |
| `locationId` | UUID \| `null` | optional |
| `status` | `"active"` \| `"inactive"` | optional |

**Response `200 OK`:**

```json
{ "user": { /* DTO UserAdmin — vedi §3.3 */ } }
```

**Errori:**

- `400 VALIDATION_ERROR` — nessun campo fornito o valore non valido
- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID tenant non valido o inesistente/eliminato (anti-enum)
- `404 user.not_found` — utente non trovato o cross-tenant
- `409 user.last_super_admin` — modifica lascerebbe il tenant senza super_admin attivi — BR-203
- `422 user.location_required_for_mechanic` — `role=mechanic` ma `locationId` risultante è null — BR-204
- `422 user.location_invalid` — `locationId` non appartiene al tenant o non attiva

#### 3.12.10 `POST /v1/admin/tenants/:id/users/invitations` — Invita utente nel tenant

**Auth:** Platform Admin (pool Cognito `platform-admins`)
**Rate limit:** 30 richieste/ora per platform-admin (chiave: `jwt.sub`, fallback `ip`)
**Shipped:** Slice 3

Invia un invito magic-link a un nuovo utente (meccanico o super_admin) nel tenant indicato. Segue lo stesso flusso di `POST /v1/users/invitations` (§3.3): pre-check Cognito → transazione DB (invitation + audit) → email best-effort.

**Differenze chiave rispetto all'endpoint officine:**
- Opera cross-tenant (path `:id`).
- L'invito è consentito **indipendentemente dallo stato del tenant** (`active`, `suspended`, ecc.) — comportamento intenzionale per la gestione operativa.
- `actorType:'system'` nel log di audit; il Cognito sub del platform-admin è catturato in `metadata`.
- Il `magicLinkUrl` in chiaro è restituito nella risposta (come in §3.12.5 `regenerate-invitation`).

**Chain preHandler:** `requireAuth` → `requirePlatformAdminsPool`. Nessun contesto tenant.

**Parametri path:**

| Param | Tipo | Note |
|---|---|---|
| `id` | `string` (UUID) | ID del tenant di destinazione |

**Request body:**

```json
{
  "email": "luca.ferrari@officinarossi.it",
  "firstName": "Luca",
  "lastName": "Ferrari",
  "role": "mechanic"
}
```

| Campo | Tipo | Obbligatorio | Note |
|---|---|---|---|
| `email` | string | sì | Lowercased, max 255 |
| `firstName` | string | sì | Max 100 caratteri |
| `lastName` | string | sì | Max 100 caratteri |
| `role` | `"super_admin"` \| `"mechanic"` | sì | |

> **BR-204:** Se `role='mechanic'`, la `locationId` viene auto-assegnata alla sede primaria attiva del tenant. Se non esiste una sede primaria → `422 user.location_required_for_mechanic`.

**Response `200 OK`:**

```json
{
  "invitation": {
    "email": "luca.ferrari@officinarossi.it",
    "role": "mechanic",
    "expiresAt": "2026-07-05T10:00:00.000Z",
    "emailSent": true,
    "magicLinkUrl": "https://app.garageos.aifollyadvisor.com/invitations/TOKEN"
  }
}
```

| Campo | Tipo | Note |
|---|---|---|
| `email` | `string` | Email destinatario |
| `role` | `"super_admin"` \| `"mechanic"` | Ruolo assegnato |
| `expiresAt` | `string` (ISO-8601) | Scadenza token (7 giorni) |
| `emailSent` | `boolean` | `false` se l'invio email ha fallito (best-effort) |
| `magicLinkUrl` | `string` | URL magic-link in chiaro — consegnabile via canale alternativo se email fallisce |

**Errori:**

- `400 VALIDATION_ERROR` — campo mancante o non valido
- `401` — token mancante o non valido (`requireAuth`)
- `403 FORBIDDEN` — JWT da pool non autorizzato (`requirePlatformAdminsPool`)
- `404 tenant.not_found` — UUID non valido o tenant inesistente/eliminato (anti-enum)
- `409 user.invitation.duplicate_pending` — invito pendente già esistente per questa email nel tenant
- `409 user.invitation.email_in_other_tenant` — email già registrata in Cognito (altro tenant) o con invito pendente in altro tenant
- `422 user.location_required_for_mechanic` — `role=mechanic` ma nessuna sede primaria attiva nel tenant — BR-204
- `429 admin.tenant.rate_limited` — oltre 30 richieste/ora per platform-admin
- `502 auth.cognito_unavailable` — Cognito non raggiungibile durante il pre-check email

### 3.13 Public

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/health` | - | None | Health check (per load balancer) |
| GET | `/invitations/:token` | F-OFF-004, F-OFF-205 | None | **[DETTAGLIATO §3.3 F-OFF-004]** Dettagli invito prima di accettarlo |
| POST | `/invitations/:token/accept` | F-OFF-004 | None | **[DETTAGLIATO §3.3 F-OFF-004]** Accettazione invito con scelta password |
| GET | `/public/vehicles/:share_token` | F-CLI-502 | None | Vista storico condiviso |
| GET | `/v1/openapi.json` | - | None | OpenAPI spec |

### 3.14 Scheduler callbacks (interni)

Endpoint chiamati solo da EventBridge/sistemi interni. Protetti con firma HMAC
(ad eccezione di `deadline-reminder`, vedi nota post-H3 sotto).

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/internal/scheduler/transfer-expiration` | Chiusura trasferimenti scaduti |
| POST | `/internal/scheduler/invitation-expiration` | Cleanup inviti scaduti |
| POST | `/internal/s3/attachment-uploaded` | Callback S3 event per processing allegato |

> **Note (post-H3):** The original spec called for a `POST /internal/scheduler/deadline-reminder`
> HTTP endpoint protected by HMAC. H3 (PR shipped 2026-05-08) replaced this with direct Lambda
> invocation by EventBridge Scheduler — the Scheduler role calls `lambda:InvokeFunction` on the
> api Lambda with payload `{ source: 'aws.scheduler', detail: { deadlineNotificationId, reminderType } }`,
> which is short-circuited before Fastify by `withSchedulerGuard` (mirroring G2's `withWarmingGuard`).
> IAM-grade auth replaces HMAC; no internal HTTP surface exists for scheduler callbacks of this kind.

---

## 4. Schemi di risposta comuni

### 4.1 Errore RFC 7807

```json
{
  "type": "https://api.garageos.it/errors/<error_code>",
  "title": "<titolo human-readable>",
  "status": 400,
  "detail": "<descrizione dettagliata>",
  "instance": "<path endpoint>",
  "request_id": "req_01HJ8K...",
  "errors": [
    {
      "field": "<campo>",
      "code": "<codice_errore>",
      "message": "<messaggio>"
    }
  ]
}
```

### 4.2 Paginazione

```json
{
  "data": [...],
  "meta": {
    "cursor": "<cursor_next>",
    "has_more": true,
    "total": 142
  }
}
```

Il `cursor` è opaco per il client (Base64 di un oggetto interno).

### 4.3 Timestamps

Tutti i timestamp sono in **ISO 8601 UTC** con suffisso `Z`:

```
"2026-04-21T14:32:05Z"
```

Le date (senza orario) sono in formato `YYYY-MM-DD`:

```
"2026-04-21"
```

### 4.4 IDs

Tutti gli ID di entità sono **UUID v7** in formato stringa:

```
"01HKXN5A6MGYVP7ZS3T9X4K2R8"
```

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
  },
  "tag_download_url": "https://api.garageos.it/v1/vehicles/01HKXN5.../tag.pdf"
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
- Il `tag_download_url` è un URL firmato valido 1 ora per scaricare il PDF del tag

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

### 2.3 `POST /transfers` — Avvia passaggio di proprietà

**Feature:** F-CLI-401
**Auth:** Customer (deve essere attuale proprietario del veicolo)

#### Descrizione

Il proprietario attuale avvia un passaggio di proprietà del veicolo. Può indicare l'email del cessionario (invito via email) oppure generare un codice temporaneo da condividere fisicamente.

#### Request

```http
POST /v1/transfers
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "vehicle_id": "01HKXN5...",
  "method": "email_invitation",
  "invited_email": "luigi.bianchi@example.com"
}
```

**Oppure:**

```json
{
  "vehicle_id": "01HKXN5...",
  "method": "physical_code"
}
```

#### Response `201 Created`

```json
{
  "id": "01HKYT...",
  "vehicle_id": "01HKXN5...",
  "from_customer_id": "01HKXN6...",
  "method": "email_invitation",
  "invited_email": "luigi.bianchi@example.com",
  "transfer_code": null,
  "status": "pending_recipient",
  "expires_at": "2026-04-28T14:32:05Z"
}
```

**Se `method: "physical_code"`:**

```json
{
  "id": "01HKYT...",
  "vehicle_id": "01HKXN5...",
  "from_customer_id": "01HKXN6...",
  "method": "physical_code",
  "invited_email": null,
  "transfer_code": "TR-9K4M-7P2X",
  "transfer_code_expires_at": "2026-04-28T14:32:05Z",
  "status": "pending_recipient"
}
```

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 403 | `not_current_owner` | Il customer non è il proprietario attuale |
| 409 | `transfer_already_pending` | Esiste già un trasferimento attivo per questo veicolo |
| 422 | `vehicle_not_certified` | Impossibile trasferire veicolo in stato pending |

---

### 2.4 `POST /vehicles/claim` — Aggancio veicolo da codice (cliente)

**Feature:** F-CLI-101, F-CLI-102, F-CLI-103
**Auth:** Customer

#### Descrizione

Il cliente finale aggancia un veicolo al proprio account inserendo il codice GarageOS. Usato sia per inserimento manuale che per scansione QR (client invia solo il codice estratto).

#### Request

```http
POST /v1/vehicles/claim
Content-Type: application/json
Authorization: Bearer <customer_jwt>

{
  "garage_code": "GO-482-KXRT"
}
```

#### Response `200 OK` (veicolo libero)

```json
{
  "vehicle": {
    "id": "01HKXN5...",
    "garage_code": "GO-482-KXRT",
    "make": "Fiat",
    "model": "Panda",
    "year": 2021,
    "plate": "AB123CD"
  },
  "ownership": {
    "id": "01HKXN7...",
    "started_at": "2026-04-21T14:32:05Z"
  },
  "status": "claimed"
}
```

#### Errori

| Status | Codice | Scenario |
|---|---|---|
| 404 | `garage_code_not_found` | Codice non esistente |
| 409 | `vehicle_already_owned_by_other` | Veicolo già assegnato ad altro cliente (suggerisce percorso transfer o claim autonomo) |
| 409 | `vehicle_already_owned_by_you` | Già agganciato allo stesso cliente |
| 422 | `vehicle_pending_not_claimable` | Veicolo in stato pending non ancora certificato |

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
      "tenant": {
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
| 404 | `attachment.not_found` | Allegato non trovato, non `processed`, `deletedAt != null`, o appartenente a un altro tenant |
| 422 | `attachment.owner_not_supported` | `ownerType != 'intervention'` (es. `intervention_dispute`, `private_intervention`) |
| 502 | `attachment.view_url.s3_unavailable` | AWS SDK presign fail (passthrough da `S3UnavailableError`) |

#### Note

- **Lazy presign**: l'URL non è precalcolato nel DTO del dettaglio intervento (§2.12). Il client deve chiamare questo endpoint separatamente per ogni allegato che vuole aprire o scaricare.
- **Tenant scoping**: il filtro `attachment.tenantId` è enforced application-layer. `attachments_read` RLS è permissivo cross-tenant (stessa topologia di `interventions_read`); il guard esplicito `{id, tenantId}` è la linea di difesa principale.
- **Processed-only**: allegati in stato `processed=false` (upload pendente) o `deletedAt != null` (soft-deleted) ritornano `404 attachment.not_found` — non vengono distinti per evitare information leakage.

---

### 2.8 `GET /v1/customers/search` — Autocomplete cliente officina

#### Descrizione

Ricerca tenant-scoped di customer per nome / ragione sociale, pensata per autocomplete operatore officina nel form `intervention create`. Ritorna solo customer presenti in `customer_tenant_relations` per il tenant chiamante (BR-151 soddisfatto by-construction dalla JOIN: ogni riga ritornata è già relata, niente PII redaction necessaria).

Complementa `GET /v1/vehicles/search?customer=<uuid>` (PR #76): questo endpoint trova il customer per nome digitato, l'altro filtra i veicoli del customer scelto.

#### Request

`GET /v1/customers/search`

**Auth:** officina pool (Cognito group `officine`). Customer pool ritorna `403`.

**Query parameters:**

| Nome | Tipo | Required | Default | Note |
|---|---|---|---|---|
| `q` | string | sì | — | Min 2, max 60 char. Match ILIKE substring case-insensitive su `firstName`, `lastName`, `businessName`. |
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
**Business rules:** BR-062, BR-064, BR-065, BR-066, BR-128, BR-130, BR-150, BR-151

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
  "internal_notes": "Cliente segnala rumore...",  // string | null
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
  "created_by": {                          // null se l'utente è stato cancellato (SetNull FK)
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
| `internal_notes` | string | sì | Visibile solo a Tenant User (BR-150/BR-151) |
| `parts_replaced` | array | no | Array vuoto se nessun ricambio |
| `type` | object | no | Tipo intervento (`id`, `code`, `name_it`) |
| `tenant` | object | no | Tenant owner (`id`, `business_name`) |
| `location` | object | no | Location di esecuzione |
| `vehicle` | object | no | Veicolo target |
| `created_by` | object | sì | `null` se l'utente è stato cancellato (FK `SetNull` on delete) |
| `attachments` | array | no | Solo `processed=true` e `deletedAt=null`. Upload pendenti e soft-deleted sono nascosti. |

Per ottenere l'URL di accesso a un allegato, chiamare `GET /v1/attachments/:id/view-url` (§2.7.1) con l'`id` di ogni elemento dell'array `attachments`.

#### Errori

| Status | Codice | Scenario |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `id` non è un UUID v4 valido |
| 401 | (auth middleware) | Authorization header mancante o JWT non valido |
| 403 | `FORBIDDEN` | JWT proviene dal pool `clienti` invece di `officine` |
| 404 | `intervention.not_found` | Intervento non trovato o non accessibile da questa officina |

#### Note

- **RLS topology**: `interventions_read` è permissivo cross-tenant (post migration 0003). Il lookup usa `findFirst({id, tenantId})` + null check manuale → `404`. Non usare `findUniqueOrThrow` che lascerebbe filtrare righe cross-tenant. Stesso pattern di §2.11 disputes list.
- **`internal_notes` visibility**: esposto solo al Tenant User (BR-150). Il pool clienti non ha accesso a questo endpoint (403), quindi BR-151 è soddisfatto by-construction.
- **`created_by` null**: quando l'utente che ha creato l'intervento è stato rimosso (soft-delete con `SetNull` sulla FK `userId`). Il client deve gestire il caso null nella UI.
- **Attachments fetch**: gli allegati sono caricati con una seconda query separata dopo il guard di esistenza dell'intervento (`attachments` non ha una Prisma relation diretta su `Intervention`). Solo `processed=true` e `deletedAt=null` sono inclusi.

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

> **Nota v1 (2026-05-04):** L'endpoint accetta `type=customer` solo. `type=tenant_admin` ritorna `422 auth.signup.tenant_signup_not_supported` finché il flusso server-side di creazione tenant + location primaria + super_admin user non viene shipato in una PR dedicata (vedi roadmap). Vedi anche `docs/superpowers/specs/2026-05-04-api-customer-signup-design.md` §3.4 per la motivazione.

### 3.2 Tenants

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/tenants/me` | F-OFF-007 | Tenant User | Info tenant corrente |
| PATCH | `/tenants/me` | F-OFF-007 | Super Admin | **[DETTAGLIATO sotto]** Aggiorna dati tenant |
| GET | `/tenants/me/locations` | F-OFF-003 | Tenant User | Lista location |
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
- `businessName` (string, max 150)
- `addressLine` (string, max 200)
- `city` (string, max 100)
- `province` (string, 2 char, auto-uppercased)
- `postalCode` (string, max 10)
- `phone` (string, E.164 format)
- `email` (string, RFC 5322)

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
| POST | `/users/me/avatar` | F-OFF-007 | Tenant User | Upload avatar |
| GET | `/users` | F-OFF-004 | Super Admin | Lista utenti tenant |
| POST | `/users/invitations` | F-OFF-004 | Super Admin | Invita nuovo utente |
| DELETE | `/users/invitations/:id` | F-OFF-004 | Super Admin | Revoca invito |
| PATCH | `/users/:id` | F-OFF-004 | Super Admin | Modifica ruolo/location/stato |
| DELETE | `/users/:id` | F-OFF-004 | Super Admin | Rimuove utente (soft delete) |

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
- `firstName` (string, max 100)
- `lastName` (string, max 100)
- `phone` (string, E.164 format)

**Non-editable fields** (read-only in response, must not be in body):
- `email`, `role`, `tenantId`, `createdAt`, `cognitoSub`

**200 response:** same shape as `GET /v1/users/me`.

**Errors:**
- `400 VALIDATION_ERROR` — field validation failure
- `422 users.me.update.empty_body` — body has no editable fields
- `422 users.me.update.unknown_field` — body contains non-editable field (e.g. `email`, `role`)
- `401 UNAUTHORIZED` — missing/invalid JWT
- `403 auth.forbidden.wrong_pool` — JWT from clienti pool
- `404 NOT FOUND` — cross-tenant guard (cognitoSub belongs to different tenant)

---

### 3.4 Customers (lato officina)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/customers/search` | F-OFF-202 | Tenant User | **[DETTAGLIATO §2.8]** Autocomplete cliente per nome/ragione sociale (tenant-scoped) |
| GET | `/customers` | F-OFF-202 | Tenant User | Lista clienti del tenant (con ricerca) |
| POST | `/customers` | F-OFF-201 | Tenant User | Crea nuovo cliente |
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
| GET | `/vehicles/:id` | F-OFF-105 | Tenant User | Dettaglio veicolo (regole visibilità applicate) |
| POST | `/vehicles` | F-OFF-102, F-OFF-103 | Tenant User | **[DETTAGLIATO §2.1]** Censisce nuovo veicolo |
| PATCH | `/vehicles/:id` | F-OFF-106 | Tenant User | Modifica dati veicolo (alcuni campi immutabili) |
| POST | `/vehicles/:id/certify` | F-OFF-107 | Tenant User | Promuove veicolo da pending a certified |
| GET | `/vehicles/:id/tag.pdf` | F-OFF-104, F-OFF-109 | Tenant User | Scarica PDF del tag (codice + QR) |
| GET | `/vehicles/:id/access-log` | F-OFF-601, F-CLI-304 | Any User | Log accessi al veicolo |
| GET | `/vehicles/:id/timeline` | F-OFF-105, F-CLI-201 | Any User | **[DETTAGLIATO §2.5]** Timeline interventi |
| POST | `/vehicles/claim` | F-CLI-101, F-CLI-102 | Customer | **[DETTAGLIATO §2.4]** Aggancia veicolo tramite codice |
| GET | `/me/vehicles` | F-CLI-105 | Customer | Lista veicoli del customer |
| GET | `/me/vehicles/:id` | F-CLI-106 | Customer | Dettaglio veicolo per customer |
| PATCH | `/me/vehicles/:id` | F-CLI-107 | Customer | Modifica dati non tecnici (nickname, foto) |
| DELETE | `/me/vehicles/:id` | F-CLI-108 | Customer | Rimuove associazione (no cancellazione veicolo) |
| POST | `/me/vehicles/pending` | F-CLI-104 | Customer | Pre-registrazione veicolo pendente con libretto |
| POST | `/vehicles/:id/share-link` | F-CLI-502 | Customer | Genera link condivisione temporaneo |
| DELETE | `/vehicles/:id/share-link/:token` | F-CLI-502 | Customer | Revoca link |
| GET | `/vehicles/:id/export.pdf` | F-CLI-501 | Customer | Export PDF storico |

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
| POST | `/transfers` | F-CLI-401 | Customer | **[DETTAGLIATO §2.3]** Avvia passaggio di proprietà |
| GET | `/transfers/:id` | F-CLI-402 | Customer | Dettaglio trasferimento |
| POST | `/transfers/:code/accept` | F-CLI-402, F-CLI-403 | Customer | Cessionario accetta trasferimento |
| POST | `/transfers/:id/confirm` | F-CLI-403 | Customer | Cedente conferma dopo accettazione cessionario |
| POST | `/transfers/:id/reject` | F-CLI-403 | Customer | Rifiuta trasferimento |
| POST | `/transfers/claim-without-seller` | F-CLI-404 | Customer | Claim autonomo con libretto |
| GET | `/me/transfers` | F-CLI-401, F-CLI-402 | Customer | Miei trasferimenti in corso |

### 3.11 Notifications

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/me/notifications` | F-CLI-305 | Customer | Lista notifiche |
| POST | `/me/notifications/:id/read` | F-CLI-305 | Customer | Marca come letta |
| POST | `/me/notifications/read-all` | F-CLI-305 | Customer | Marca tutte come lette |
| GET | `/me/notification-preferences` | F-CLI-005 | Customer | Preferenze canali |
| PATCH | `/me/notification-preferences` | F-CLI-005 | Customer | Modifica preferenze |
| POST | `/me/push-tokens` | - | Customer | Registra push token device |
| DELETE | `/me/push-tokens/:id` | - | Customer | Rimuove push token |

### 3.12 Admin (team GarageOS)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
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

### 3.13 Public

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/health` | - | None | Health check (per load balancer) |
| GET | `/invitations/:token` | F-OFF-004, F-OFF-205 | None | Dettagli invito prima di accettarlo |
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

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
Authorization: Bearer <tenant_user_jwt>

{
  "intervention_type_id": "01HSYS...",
  "intervention_date": "2026-04-21",
  "odometer_km": 45000,
  "title": "Tagliando completo",
  "description": "Sostituzione olio motore 5W30, filtro olio, filtro aria, filtro abitacolo. Controllo livelli e usura pastiglie freni. Rotazione pneumatici.",
  "parts_replaced": [
    { "name": "Olio motore Selenia 5W30", "code": "SEL-5W30-4L", "quantity": 4, "notes": "Litri" },
    { "name": "Filtro olio", "code": "UFI-23.145.02", "quantity": 1 },
    { "name": "Filtro aria", "code": "MANN-C28068", "quantity": 1 },
    { "name": "Filtro abitacolo", "code": "MANN-CU2422", "quantity": 1 }
  ],
  "internal_notes": "Cliente segnala leggero rumore sospensione anteriore sx, verificare al prossimo intervento",
  "create_deadline": {
    "enabled": true,
    "months_from_now": 12,
    "km_increment": 15000
  }
}
```

#### Response `201 Created`

```json
{
  "intervention": {
    "id": "01HKXQ...",
    "tenant_id": "01HKXL0...",
    "location_id": "01HKXP3...",
    "user_id": "01HKXP8...",
    "vehicle_id": "01HKXN5...",
    "intervention_type": {
      "id": "01HSYS...",
      "code": "TAGLIANDO",
      "name_it": "Tagliando"
    },
    "intervention_date": "2026-04-21",
    "odometer_km": 45000,
    "title": "Tagliando completo",
    "description": "...",
    "parts_replaced": [...],
    "status": "active",
    "wiki_locked_at": "2026-04-23T14:32:05Z",
    "created_at": "2026-04-21T14:32:05Z"
  },
  "deadline": {
    "id": "01HKXR...",
    "due_date": "2027-04-21",
    "due_odometer_km": 60000,
    "intervention_type_id": "01HSYS...",
    "status": "open"
  },
  "notifications_scheduled": [
    { "type": "push_customer", "target": "mario.rossi@example.com", "status": "queued" },
    { "type": "email_customer", "target": "mario.rossi@example.com", "status": "queued" }
  ]
}
```

#### Errori specifici

| Status | Codice | Scenario |
|---|---|---|
| 403 | `vehicle_access_denied` | Il tenant non ha accesso al veicolo (raro, solo se veicolo in stato particolare) |
| 404 | `vehicle_not_found` | |
| 404 | `intervention_type_not_found` | |
| 422 | `odometer_km_decrease` | km inferiori all'ultimo intervento registrato (warning, richiede `force: true`) |
| 422 | `intervention_date_future` | Data futura non consentita |

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
      "type": { "code": "TAGLIANDO", "name_it": "Tagliando" },
      "title": "Tagliando completo",
      "description": "...",
      "parts_replaced_count": 4,
      "status": "active",
      "is_disputed": false,
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

#### Regole di visibilità

- **Se richiedente è `Tenant User`**: vede `shop_interventions` di tutti i tenant (regola §2.4.1), NON vede `private_interventions`
- **Se richiedente è `Customer` proprietario attuale**: vede tutti gli `shop_interventions` + i suoi `private_interventions`
- **Se richiedente è `Customer` ma non proprietario**: errore 403
- **Interventi privati di precedenti proprietari**: sempre nascosti

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
    "created_at": "2026-04-22T09:15:00Z"
  },
  "intervention_status": "disputed"
}
```

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
      "created_at": "2026-04-22T09:15:00Z"
    }
  ],
  "intervention_status": "active"
}
```

`disputes` è sempre array (length 1 con `disputeId`, ≥1 col fanout).
`intervention_status` è `"active"` se 0 `open` residue post-update; `"disputed"` altrimenti.

#### Errori

| Status | `code` | Trigger |
|---|---|---|
| 400 | `intervention.dispute.response.description_too_short` | `tenant_response` < 20 |
| 400 | `validation.error` | Zod fail (max, attachmentIds shape, body shape) |
| 401 | `auth.unauthenticated` | JWT mancante/invalido |
| 403 | `intervention.dispute.response.permission_denied` | Ruolo non in allow-list |
| 404 | `not_found` | Intervention non trovata o cross-tenant; `dispute_id` non trovato/cross-tenant |
| 409 | `intervention.dispute.response.no_active_dispute` | Nessuna `open` da rispondere |
| 422 | `intervention.dispute.attachments_not_supported` | `attachment_ids` non vuoto |

#### Note

- BR-128: la response è immutabile. Non c'è un'edit/delete in v1.
- Multi-dispute (più customer sullo stesso intervento): risposta unica con stesso `tenant_response` testo per tutte le `open`, salvo targeting esplicito via `dispute_id`.
- BR-127 status flip: `intervention.status` flippa a `active` solo se 0 `open` residue. `responded` NON conta come "blocco PATCH".

---

### 2.7 `POST /attachments/upload-url` — Presigned URL upload

**Feature:** F-OFF-305
**Auth:** Any User

#### Descrizione

Richiede un URL firmato S3 per l'upload di un allegato. Il client poi uploada direttamente su S3 senza passare dal backend.

#### Request

```http
POST /v1/attachments/upload-url
Content-Type: application/json
Authorization: Bearer <any_user_jwt>

{
  "owner_type": "intervention",
  "owner_id": "01HKXQ...",
  "file_name": "foto-prima.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 2457600
}
```

#### Response `201 Created`

```json
{
  "attachment_id": "01HKZE...",
  "upload_url": "https://garageos-prod-attachments.s3.eu-central-1.amazonaws.com/...",
  "upload_method": "PUT",
  "upload_headers": {
    "Content-Type": "image/jpeg"
  },
  "expires_at": "2026-04-21T14:47:05Z",
  "callback_url": "/v1/attachments/01HKZE.../confirm"
}
```

#### Flusso completo upload

1. Client chiama `POST /attachments/upload-url` → riceve URL
2. Client fa `PUT` diretto su `upload_url` con il file binary
3. Client chiama `POST /attachments/:id/confirm` per notificare completamento
4. Backend verifica file esistente su S3, aggiorna `processed: false`, enqueue job compressione

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

### 3.2 Tenants

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/tenants/me` | F-OFF-007 | Tenant User | Info tenant corrente |
| PATCH | `/tenants/me` | F-OFF-007 | Super Admin | Aggiorna dati tenant |
| GET | `/tenants/me/locations` | F-OFF-003 | Tenant User | Lista location |
| POST | `/tenants/me/locations` | F-OFF-003 | Super Admin | Crea location |
| PATCH | `/tenants/me/locations/:id` | F-OFF-003 | Super Admin | Modifica location |
| DELETE | `/tenants/me/locations/:id` | F-OFF-003 | Super Admin | Disattiva location (soft delete) |
| GET | `/tenants/me/billing` | F-OFF-008 | Super Admin | Info billing (piano, prossima fattura) |
| GET | `/tenants/me/export` | F-OFF-704 | Super Admin | Export completo dati tenant (async, ritorna job ID) |
| GET | `/tenants/me/export/:job_id` | F-OFF-704 | Super Admin | Stato export + URL download se pronto |

### 3.3 Users (officina)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/users/me` | F-OFF-007 | Tenant User | Profilo utente corrente |
| PATCH | `/users/me` | F-OFF-007 | Tenant User | Aggiorna profilo |
| POST | `/users/me/avatar` | F-OFF-007 | Tenant User | Upload avatar |
| GET | `/users` | F-OFF-004 | Super Admin | Lista utenti tenant |
| POST | `/users/invitations` | F-OFF-004 | Super Admin | Invita nuovo utente |
| DELETE | `/users/invitations/:id` | F-OFF-004 | Super Admin | Revoca invito |
| PATCH | `/users/:id` | F-OFF-004 | Super Admin | Modifica ruolo/location/stato |
| DELETE | `/users/:id` | F-OFF-004 | Super Admin | Rimuove utente (soft delete) |

### 3.4 Customers (lato officina)

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| GET | `/customers` | F-OFF-202 | Tenant User | Lista clienti del tenant (con ricerca) |
| POST | `/customers` | F-OFF-201 | Tenant User | Crea nuovo cliente |
| GET | `/customers/:id` | F-OFF-203 | Tenant User | Dettaglio cliente (se relazione esistente) |
| PATCH | `/customers/:id` | F-OFF-204 | Tenant User | Modifica dati cliente |
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
| GET | `/interventions/:id` | F-OFF-301 | Any User | Dettaglio intervento |
| PATCH | `/interventions/:id` | F-OFF-304 | Tenant User | Modifica intervento (wiki rules) |
| POST | `/interventions/:id/cancel` | F-OFF-307 | Super Admin | Annulla intervento con motivazione |
| GET | `/interventions/:id/revisions` | F-OFF-304 | Any User | Storico modifiche |
| POST | `/interventions/:id/dispute` | F-CLI-206 | Customer | **[DETTAGLIATO §2.6]** Contesta intervento |
| POST | `/interventions/:id/dispute-response` | F-OFF-602 | Tenant User | **[DETTAGLIATO §2.6.1]** Risposta officina a contestazione |
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
| POST | `/attachments/upload-url` | F-OFF-305 | Any User | **[DETTAGLIATO §2.7]** Richiedi presigned URL |
| POST | `/attachments/:id/confirm` | F-OFF-305 | Any User | Conferma upload completato |
| GET | `/attachments/:id/download-url` | F-OFF-305 | Any User | Presigned URL download (15 min validity) |
| DELETE | `/attachments/:id` | F-OFF-305 | Any User | Rimuove allegato |

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

Endpoint chiamati solo da EventBridge/sistemi interni. Protetti con firma HMAC.

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/internal/scheduler/deadline-reminder` | Trigger invio promemoria scadenza |
| POST | `/internal/scheduler/transfer-expiration` | Chiusura trasferimenti scaduti |
| POST | `/internal/scheduler/invitation-expiration` | Cleanup inviti scaduti |
| POST | `/internal/s3/attachment-uploaded` | Callback S3 event per processing allegato |

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

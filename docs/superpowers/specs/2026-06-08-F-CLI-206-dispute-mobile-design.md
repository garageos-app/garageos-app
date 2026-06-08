# F-CLI-206 — Contestazione intervento officina (mobile + API) — Design

**Data:** 2026-06-08 · **Feature:** F-CLI-206 (Specifiche §3.3.3) · **Tipo:** cross-layer API + mobile · **Branch:** `feat/cli-206-dispute-mobile`

## What

Permettere al cliente B2C, dall'app mobile, di **contestare un intervento officina** scrivendo categoria + motivazione, e di **vedere lo stato della contestazione** (incluse le risposte dell'officina) nel dettaglio dell'intervento.

Il backend di creazione (`POST /v1/interventions/:id/dispute`, #21/#53) e di risposta officina (`POST .../dispute-response`, #28) esistono già e sono testati. Mancano: (1) un endpoint **cliente** per leggere un singolo intervento officina + il thread contestazioni; (2) tutta la **UI mobile**.

## Why

- Spec F-CLI-206 (MUST): «L'utente può contestare un intervento officina (scrivendo la motivazione). L'intervento resta ma viene marcato come contestato. L'officina riceve notifica e può rispondere.»
- BR-120 (solo proprietario attuale), BR-122 (max una contestazione attiva per intervento/cliente), BR-123 (4 categorie), BR-124 (descrizione 20–2000), BR-127 (badge CONTESTATO ovunque), BR-128 (storico contestazioni sempre visibile per trasparenza).

## Scope

**In scope:**
- Nuovo endpoint API `GET /v1/me/interventions/:id` (intervento officina + thread contestazioni del cliente).
- Mobile: schermo dettaglio intervento officina, form contestazione (testo-only), badge CONTESTATO in timeline, righe officina tappabili.

**Fuori scope (espliciti):**
- Allegati nel form contestazione (differiti a slice successiva; il backend accetta già `attachmentIds`).
- Notifica push/email all'officina alla creazione (già `TODO(F-OFF-602)` nel backend; dipende dall'arco notifiche / Resend).
- Visibilità contestazioni di ex-proprietari (la contestazione è «congelata» al passaggio, BR-120).
- Dettaglio per interventi privati (già esiste, `private-interventions/[id]`).

---

## Sezione 1 — Endpoint API `GET /v1/me/interventions/:id`

Endpoint cliente che legge un **intervento officina** + le **contestazioni del cliente** su di esso.

- **File:** nuovo `packages/api/src/routes/v1/me-interventions.ts` (registrato in `server.ts`).
- **Auth chain:** `requireAuth → requireClientiPool → clientiContext` (mirror degli altri `/me/*`).
- **Contesto:** `withContext({ customerId, role: 'user' })`.
  - `interventions` SELECT RLS è permissiva (cross-tenant readable, migration 0003) → lettura senza elevazione admin.
  - `intervention_disputes` USING permette `customer_id = current_customer_id()` → il cliente legge **solo** le proprie contestazioni (RLS + filtro app-side ridondante per determinismo).
- **Gate ownership (vera frontiera, app-layer — lezione #154 `rls_only_endpoint_leaks_in_prod`):**
  prima si carica l'intervento (`findFirst` su `id`, niente pre-filtro tenant), poi
  `vehicleOwnership.findFirst({ vehicleId: intervention.vehicleId, customerId, endedAt: null })`
  → se assente → `404 me.intervention.not_found`. Coerente con l'accesso alla timeline (che mostra solo veicoli posseduti). Un `findFirst` su id assente → anch'esso 404 (no leak di esistenza cross-tenant).
- **Serializer puro** `projectShopInterventionDetail(row, disputes)` in `lib/customer-intervention-detail.ts` (DB-free, unit-testabile, mirror `serializeUserMe`).

**Response 200:**

```json
{
  "intervention": {
    "id": "uuid",
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
      "customerDescription": "I km riportati sono errati...",
      "status": "responded",
      "createdAt": "2026-05-02T10:00:00.000Z",
      "tenantResponse": "Abbiamo verificato...",
      "tenantResponseAt": "2026-05-03T09:00:00.000Z",
      "resolvedAt": null
    }
  ]
}
```

- `disputes` ordinate `createdAt desc`. NIENTE `tenantResponseUserId`/nome tecnico (BR-151 — il cliente non vede l'identità del meccanico oltre la `CustomerTenantRelation`, e qui non serve).
- camelCase coerente con `/me`, `/me/vehicles`, `/me/deadlines`.
- `interventionDate` è `@db.Date` → serializzato **date-only** `YYYY-MM-DD` (lezione `db_date_serialized_as_iso` #156: il consumer mobile usa `formatDate`; assicurare `.toISOString().slice(0,10)` lato serializer, NON timestamp pieno). `createdAt`/`tenantResponseAt` sono timestamp pieni ISO.

**Errori:** `404 me.intervention.not_found` (nuovo codice, da aggiungere ad APPENDICE_G).

---

## Sezione 2 — Schermi e route mobile

### 2.1 Dettaglio intervento officina — `app/interventions/[id].tsx`

Route **top-level** (mirror `private-interventions/[id].tsx`; NON sotto `(tabs)` → niente collisione di segmento, lezione `expo_route_group_segment_collision`).

- **Hook** `useMeShopInterventionDetail(id)` (`src/queries/meShopInterventionDetail.ts`) → `GET /v1/me/interventions/:id`, queryKey `['me','intervention',id]`. Stati loading/error/empty (riusa `LoadingState`/`ErrorState`).
- **Tipi** `src/lib/types/intervention.ts`: `ShopInterventionDetail`, `Dispute`, `DisputeReasonCategory`, `DisputeStatus` (mirror dell'API, api/mobile non condividono package).
- **Contenuto:**
  1. **Card intervento:** tipo (`name_it`), titolo, data (`formatDate`), km (`formatKm`), officina (`businessName · città`), descrizione completa, conteggio pezzi/allegati. Badge "CONTESTATO" se `isDisputed` (riusa/estende `BadgeCertificato` o nuovo `BadgeContestato`).
  2. **Sezione contestazioni** (BR-128): per ogni dispute → badge stato IT (Aperta / Risposta ricevuta / Risolta / Escalata / Chiusa), categoria (label IT BR-123) + testo inviato, e se `tenantResponse` presente → blocco "Risposta dell'officina" + data. Se `disputes` vuoto → sezione assente.
  3. **Bottone "Contesta":** mostrato **solo se** nessuna contestazione attiva (`status ∈ {open, responded}`) — coerente con BR-122 e il 409 backend. → naviga a `/interventions/[id]/dispute`.

### 2.2 Form contestazione — `app/interventions/[id]/dispute.tsx`

Route nidificata top-level (mirror `private-interventions/new.tsx`), header `Stack.Screen` proprio.

- **Componente** `DisputeForm` (`src/components/DisputeForm.tsx`, mirror `PrivateInterventionForm`): picker categoria (4 opzioni BR-123 con label IT) + textarea descrizione con contatore (20–2000 char). Validator puro `validateDisputeForm` (stessa regola del backend: min 20 / max 2000, categoria obbligatoria).
- **Hook** `useCreateDispute(interventionId)` (`src/queries/createDispute.ts`, mirror `createPrivateIntervention`) → `POST /v1/interventions/:id/dispute` body `{ reasonCategory, description }`. Su 201 → invalida `['me','intervention',id]` + `['me','vehicles']` (timeline) → `router.back()` al dettaglio.

### 2.3 Timeline — righe officina tappabili + badge

In `HistoryTab` (`app/(tabs)/vehicles/[id].tsx`): le righe `shop_intervention` ricevono `onPress: () => router.push('/interventions/'+item.id)` (oggi solo le private sono tappabili). `TimelineRow` mostra il badge "CONTESTATO" quando `item.is_disputed` (oggi nel tipo `TimelineItem` ma non renderizzato — BR-127).

### Label IT (i18n mobile, regola CLAUDE.md)

Categorie (BR-123):
- `not_performed` → "L'intervento non è mai stato effettuato"
- `wrong_data` → "I dati riportati sono errati (km, data, pezzi)"
- `not_authorized` → "Non ho autorizzato questo intervento"
- `other` → "Altro"

Stati dispute: `open` → "Aperta", `responded` → "Risposta ricevuta", `resolved_by_cancellation` → "Risolta (intervento annullato)", `escalated` → "In gestione GarageOS", `closed_by_admin` → "Chiusa".

---

## Sezione 3 — Error handling, flusso dati, testing

### Error handling (mobile)

Mappatura RFC7807 `ApiError.code` → IT (in `error-messages.ts`, parser già allineato #161):
- `403 intervention.dispute.not_owner` → "Solo il proprietario attuale può contestare questo intervento."
- `409 intervention.dispute.already_exists` → "Hai già una contestazione aperta per questo intervento." (difensivo: bottone già nascosto; su 409 invalido + `router.back()`).
- `422 intervention.dispute.intervention_cancelled` → "Non puoi contestare un intervento annullato."
- `404 me.intervention.not_found` (GET) → `ErrorState` "Intervento non trovato o non più di tua proprietà."
- Validazione client (categoria mancante / descrizione <20 o >2000) → field error, nessuna chiamata.

### Flusso dati

1. Timeline (`HistoryTab`) → tap riga officina → `/interventions/[id]`.
2. Detail: `useMeShopInterventionDetail` carica intervento + thread.
3. "Contesta" → `/interventions/[id]/dispute` → compila → submit.
4. `useCreateDispute` POST 201 → invalida `['me','intervention',id]` + `['me','vehicles']` → `router.back()`.
5. Detail re-fetch: thread mostra la contestazione, badge CONTESTATO presente; bottone "Contesta" sparisce (ora c'è una `open`).

### Testing

**API (Vitest unit + integration su CI):**
- Unit: serializer puro `projectShopInterventionDetail` (FakePrisma esteso con `intervention.findFirst` + `vehicleOwnership.findFirst` + `interventionDispute.findMany`).
- Integration: GET happy (intervento + thread); 404 non-proprietario; thread vuoto; con `tenantResponse` valorizzato; isolamento RLS cross-cliente (cliente B non vede la dispute di A).

**Mobile (Jest):**
- `DisputeForm.test.tsx`: render 4 categorie, validazione min/max + contatore, submit→mutate.
- `createDispute.test.tsx`: POST shape, invalidazioni, error 409/403.
- `meShopInterventionDetail.test.tsx`: GET shape.
- screen `interventions/[id]`: card + thread + bottone condizionale (mostrato/nascosto su dispute attiva); mock expo-router.
- `TimelineRow.test.tsx`: badge CONTESTATO su `is_disputed`; onPress riga officina.

**Gate:** `pnpm -r typecheck` (pre-push). Integration NON girata localmente (Docker, CLAUDE.md) → CI. Dopo nuova route mobile: `rm packages/mobile/.expo/types/router.d.ts` (rigenerato da tsc).

### Docs

- APPENDICE_A: nuova sezione `GET /v1/me/interventions/:id` + riga indice tabella.
- APPENDICE_G: nuovo codice `me.intervention.not_found`.

### Note di rischio / lezioni applicate

- **Gate ownership app-layer** è la frontiera, mai RLS sola (#154).
- **`@db.Date` date-only** nel serializer per `interventionDate` (#156).
- **Route mobile nidificata** top-level, niente group collision (#160/#162); `router.back()` cross-screen verificato in smoke.
- **handler-change-breaks-unit-mock**: nuovo endpoint, nessun handler esistente modificato lato API; lato mobile `TimelineRow` cambia → aggiornare `TimelineRow.test.tsx`.
- Smoke device post-merge (non bloccante): tap intervento officina → dettaglio → Contesta → compila → submit → torna al dettaglio con thread + badge; ri-tap → bottone assente.

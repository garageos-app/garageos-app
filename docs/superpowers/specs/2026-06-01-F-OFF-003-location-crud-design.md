> **SUPERSEDED by sede-unica (2026-06-30)** — multi-location removed; locations table dropped; tenant address is now the single source of officina address.

# F-OFF-003 — Gestione location (CRUD) — Design

**Date:** 2026-06-01 · **Feature:** F-OFF-003 (GarageOS-Specifiche §3, 🟢 MUST) · **Status:** approved

## What

Completa la gestione delle sedi (`locations`) per un tenant officina. Oggi esiste **solo** `GET /v1/tenants/me/locations` (`tenants-locations-list.ts`); mancano create/update/delete e qualsiasi UI. Senza questi, un tenant non può creare una seconda sede dal prodotto — il che rende **F-OFF-503 (filtri per location) prematuro** (niente da filtrare). Vedi audit `docs/superpowers/audits/2026-05-31-implementation-status-inventory.md` §"Strategic conclusion".

Questa slice è il **prerequisito** di F-OFF-503: una volta creabili più sedi, i filtri per location avranno senso.

## Why

- Spec: `docs/GarageOS-Specifiche.md` §3 riga F-OFF-003 ("Il Super Admin può creare/modificare/disattivare le location del tenant").
- API già dichiarata in `docs/APPENDICE_A_API.md` (POST/PATCH/DELETE `/tenants/me/locations`), ma senza sezione dettagliata.
- Business rules: **BR-200** (tenant ha sempre una location, creata al signup), **BR-201** (esattamente una primaria attiva; per disattivare la primaria bisogna prima designarne un'altra), **BR-204** (mechanic deve avere una location attiva; super_admin può `null`), **BR-205** (visibilità cross-location).

## Scope & split

- **PR1 — API**: i 3 endpoint write + nuovi error code + test integration/unit. Sblocca già F-OFF-503 e il data layer multi-location (la 2ª sede si può creare via API).
- **PR2 — web**: pagina gestione sedi in Settings + dialog create/edit + azioni "imposta primaria" / "disattiva".
- **Nessuna migration DB**: lo schema `Location` e il partial-unique-index di BR-201 (`UNIQUE (tenant_id) WHERE is_primary=true AND status='active'`) esistono già.

Spec unica, due piani d'implementazione separati (uno per PR).

## Data model (esistente — nessuna modifica)

Tabella `locations` (campi rilevanti): `id, tenant_id, name, address_line, city, province, postal_code, country, latitude?, longitude?, phone?, email?, is_primary, status (LocationStatus: active|inactive), created_at, updated_at, deleted_at?`.

`latitude`/`longitude` restano **fuori scope** (nullable, nessun geocoding in v1).

## API design

### Auth chain (comune ai 3 endpoint)

`requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin` — identica a `tenants-locations-list.ts` e `tenants-update.ts`. Tenant-scoping application-side; write tramite `app.withContext(...)`.

### Validazione (Zod inline, mirror `tenants-update.ts`)

Regex riusati: `province` → `[A-Z]{2}` (uppercased), `postalCode` → `[0-9]{5}`, `phone` → `/^[+]?[0-9 ()-]{6,30}$/`, `email` → `z.email()`. Pattern `.strict()` (unknown → 422) e, per PATCH, `.partial()` + loop `'key' in body` con `body[key] ?? null` per `exactOptionalPropertyTypes`.

### `POST /v1/tenants/me/locations` — crea sede secondaria

- **Body** (`.strict()`): `name` (1–200, req), `addressLine` (req, max 255), `city` (req, max 100), `province` (`[A-Z]{2}`, req), `postalCode` (`[0-9]{5}`, req), `country` (default `"IT"`), `phone?`, `email?`.
- `isPrimary` **non accettato** in POST: una nuova sede nasce `isPrimary=false`. La primaria si designa solo via PATCH.
- Effetto: crea con `status='active'`, `isPrimary=false`, `tenantId` dal JWT.
- **201** con la location creata (DTO: tutti i campi pubblici, niente `tenantId`/`deletedAt` interni se non utili al client — allineare al DTO della lista + campi indirizzo).

### `PATCH /v1/tenants/me/locations/:id` — modifica + promozione primaria

- **Body** (`.partial().strict()`): campi editabili come POST **+ `isPrimary: true`**.
- `isPrimary: true` → **swap atomico in transazione**: prima demota la primaria corrente del tenant (`is_primary=false`), poi promuove `:id` (`is_primary=true`). Ordine demote→promote per non violare il partial-unique-index a metà transazione.
- `isPrimary: false` esplicito → **422 `tenants.me.locations.cannot_unset_primary`** ("Per cambiare la sede primaria, designa un'altra sede come primaria.") — non si può lasciare il tenant senza primaria.
- Empty body `{}` → **422 `tenants.me.locations.update.empty_body`**.
- Unknown field → **422 `tenants.me.locations.update.unknown_field`**.
- `:id` non nel tenant o soft-deleted → **404**.
- **200** con la location aggiornata.

### `DELETE /v1/tenants/me/locations/:id` — disattiva (soft delete)

- Effetto: `status='inactive'` + `deletedAt=now()`. Gli interventi storici conservano il loro `location_id` (nessuna cancellazione dati).
- **Guard BR-201**: se la location è `isPrimary` → **422 `tenants.me.locations.cannot_delete_primary`** ("Designa prima un'altra sede come primaria.").
- **Guard meccanici attivi**: se esistono `users` con `locationId=:id` e `status='active'` → **422 `tenants.me.locations.has_active_users`** ("Riassegna o disattiva prima i meccanici di questa sede."). Coerente con BR-204 (un meccanico deve avere una sede attiva): evita meccanici orfani.
- `:id` non nel tenant o già disattivata → **404**.
- **200** (o 204) al successo.

### Nuovi error code (APPENDICE_G)

| Code | Status | Quando |
|---|---|---|
| `tenants.me.locations.cannot_unset_primary` | 422 | PATCH con `isPrimary:false` esplicito |
| `tenants.me.locations.cannot_delete_primary` | 422 | DELETE su location primaria |
| `tenants.me.locations.has_active_users` | 422 | DELETE su location con meccanici attivi |
| `tenants.me.locations.update.empty_body` | 422 | PATCH body vuoto |
| `tenants.me.locations.update.unknown_field` | 422 | PATCH/POST campo non riconosciuto |

(I codici seguono la convenzione dotted `businessError(code, status, detail)` che passa il global handler — cfr. `feedback_middleware_throw_fastifyerror_not_reply_send`.)

## Web design (PR2)

- **Settings → Sedi**: tabella sedi del tenant (riusa GET list, ma serve la lista *completa* incl. campi indirizzo — valutare estensione del `select` di GET o nuovo DTO). Colonne: nome, città, badge "Primaria", stato.
- **Dialog Crea sede** + **Modifica sede** (mirror `InviteUserDialog`/`EditUserDialog`): campi indirizzo con la stessa validazione client del backend.
- Azioni per riga: **Imposta come primaria** (PATCH `isPrimary:true`), **Disattiva** (DELETE, con conferma). La primaria non mostra "Disattiva".
- **Error mapping** → messaggi IT per i guard 422 (`cannot_delete_primary`, `has_active_users`, `cannot_unset_primary`).
- **Single-location**: UI usabile ma sobria — un'unica sede primaria, nessuna azione "disattiva" sulla primaria; "Aggiungi sede" sempre disponibile.

## Testing

**PR1 — integration** (Testcontainers; IP `10.20.4x` libero per rate-limit isolation):
- POST happy path (sede secondaria creata `isPrimary=false`).
- PATCH campi indirizzo; PATCH `isPrimary:true` → swap atomico (resta **esattamente una** primaria nel tenant).
- PATCH `isPrimary:false` → 422 `cannot_unset_primary`.
- PATCH empty body / unknown field → 422.
- DELETE primaria → 422 `cannot_delete_primary`.
- DELETE con meccanico attivo → 422 `has_active_users`.
- DELETE sede secondaria senza utenti → success; interventi storici conservano `location_id`.
- 404 cross-tenant (PATCH/DELETE su `:id` di altro tenant).
- `requireSuperAdmin`: mechanic → 403.

**PR1 — unit**: FakePrisma per `tx.location.create/update/findFirst`, `tx.user.count`, e la transazione di swap.

**PR2 — web**: render lista, submit form create/edit, Radix dialog via `userEvent.click` (cfr. `feedback_radix_tabs_user_event_not_fire_event`), mapping errori 422.

## Rischi / da verificare nel plan

1. **RLS WRITE policy su `locations`** (migration 0003/0004): la SELECT è permissiva (`USING true`), ma INSERT/UPDATE potrebbero richiedere un context con role. Leggere la policy in fase di plan e decidere fra `withContext({ tenantId })` e `withContext({ tenantId, role: 'admin' })`. Cfr. `feedback_withcontext_empty_blocks_rls_writes`.
2. **Ordine dello swap primaria** nella transazione (demote→promote) per non violare il partial-unique-index a metà.
3. **DTO della lista GET**: oggi seleziona solo `{id, name, city, isPrimary}`. La UI di gestione (PR2) ha bisogno dei campi indirizzo completi — decidere se estendere il `select` di GET o aggiungere un campo. Da risolvere nel plan PR2.

## Out of scope

- `latitude`/`longitude` / geocoding.
- Riassegnazione massiva meccanici (l'operatore riassegna via F-OFF-004 prima di disattivare).
- F-OFF-503 (filtri per location) — slice successiva, sbloccata da questa.

> **SUPERSEDED by sede-unica (2026-06-30)** — multi-location removed; per-location filtering no longer needed; mechanic now sees all tenant interventions/deadlines.

# F-OFF-503 — Filtri per location (design)

## What

Aggiunge un **filtro per sede** alle viste officina che mostrano dati location-scoped. Un super_admin di un tenant multi-sede sceglie da un selettore globale (in `TopBar`) una sede e tutte le viste interessate si restringono ad essa; "Tutte le sedi" mostra l'intero tenant (comportamento attuale).

Nello stesso slice viene **chiuso il gap BR-205**: oggi gli endpoint list filtrano solo per `tenantId`, quindi un meccanico vede gli interventi/scadenze/dispute di **tutte** le sedi. Da questa slice il meccanico è forzato server-side alla **propria** location.

Viste coperte (le tre che hanno una base dati per la location):

- **Interventi recenti** — `GET /v1/interventions/recent` (card HomeDashboard)
- **Scadenze** — `GET /v1/deadlines` (card HomeDashboard + pagina `DeadlineDashboard`)
- **Dispute** — `GET /v1/disputes/open` (card HomeDashboard; location via `intervention`)

**Fuori scope esplicito — Clienti.** La tabella `customers` non ha `location_id` (i clienti sono tenant-level, raggiunti via ownership del veicolo). Un filtro "clienti per sede" non ha base dati diretta e introdurrebbe semantica ambigua (cliente con interventi in due sedi). La descrizione spec "ogni vista" si intende quindi limitata alle viste con `location_id`. I clienti restano non filtrati.

## Why

- Spec: `docs/GarageOS-Specifiche.md` §3 riga **F-OFF-503** ("Per tenant multi-location, filtri per restringere ogni vista a una specifica sede", 🟢 MUST).
- Sbloccato da **F-OFF-003** (PR #140 + #141): ora le sedi secondarie sono creabili/gestibili dal prodotto, quindi c'è qualcosa da filtrare. Vedi audit `docs/superpowers/audits/2026-05-31-implementation-status-inventory.md` §"Strategic conclusion".
- Business rules:
  - **BR-205** — visibilità cross-location: super_admin vede tutte le sedi; meccanico vede **solo** la propria `location_id`. Oggi la parte "meccanico" **non è enforced** lato API → questa slice la implementa.
  - **BR-204** — un meccanico ha sempre `location_id` popolato (super_admin può `null`). Garantisce che l'enforcement BR-205 per il meccanico abbia sempre una location di riferimento.

## Stato attuale (esplorazione codebase)

**Modello dati** (`packages/database/prisma/schema.prisma`):

| Entità | `location_id` | Filtrabile |
|---|---|---|
| `Intervention` | **NOT NULL** | ✓ |
| `Deadline` | **NOT NULL** | ✓ |
| `User` | nullable (super_admin null, mechanic set) | n/a (sorgente del vincolo) |
| `Customer` | **assente** | ✗ (fuori scope) |
| `AccessLog`, `Invitation` | nullable | non interessate |

**API oggi:** `interventions-recent.ts`, `deadlines-list-tenant.ts`, `disputes-open.ts` filtrano per `tenantId` soltanto (deadlines via RLS `withContext({tenantId})`). Nessun param `location_id`; nessuna risposta espone `locationId`; **nessun vincolo location per il meccanico**.

**Frontend:** `useProfileMe()` espone `role: 'super_admin' | 'mechanic'` e `locationId`. `useLocations()` (in `queries/users-admin.ts`, re-export da `queries/locations.ts`) restituisce le sedi del tenant. `TopBar` (`components/layout/TopBar.tsx`) è l'header globale. Viste: `HomeDashboard` (ScadenzeCard / InterventionsCard / DisputesCard) + `DeadlineDashboard`. Nessuna pagina lista-interventi o lista-clienti standalone.

**Perché server-side e non client-side:** gli endpoint restituiscono top-N (`recent`) o pagine cursor (`deadlines`); filtrare dopo il fetch darebbe risultati sbagliati (es. top-10 globale filtrato a una sede ≠ top-10 di quella sede), e le risposte non portano nemmeno `locationId`. Il filtro deve quindi vivere nella query.

## Scope & split

- **PR1 — API**: param opzionale `location_id` sui 3 endpoint + enforcement BR-205 per il meccanico + test integration. Nessuna migration, nessun nuovo error code.
- **PR2 — web**: `LocationFilterProvider` (Context + localStorage), selettore sede in `TopBar`, wiring dei 3 hook query consumer.

Spec unica, due piani d'implementazione separati (uno per PR). Nessuna migration DB (entrambe le colonne `location_id` esistono già).

## API design (PR1)

### Param & risoluzione per ruolo

Ogni endpoint accetta un query param opzionale `location_id` (validato come `z.uuid().optional()`). La risoluzione della location effettiva è keyed sul **ruolo** dell'utente autenticato. Ruolo e location sono **già sul `request`**: `tenantContext` popola `request.userRole` (`'super_admin' | 'mechanic'`) e `request.locationId` (`string | undefined`) dai claim JWT (`custom:role` / `custom:location_id`) — **nessuna lookup DB aggiuntiva** nel handler.

| Ruolo | Comportamento |
|---|---|
| **mechanic** | Forzato alla propria `location_id`; il param `location_id` in input è **ignorato** (enforcement BR-205). |
| **super_admin** | Se `location_id` presente → filtra a quella sede; se assente → tutte le sedi (comportamento attuale). |

Pseudologica condivisa (computata nel handler, tutto già su `request`):

```text
effectiveLocationId =
  request.userRole === 'mechanic'   ? request.locationId          // sempre valorizzato per BR-204
  : /* super_admin */                 parsedQuery.location_id ?? undefined   // undefined = nessun filtro
```

**Caveat staleness:** per il meccanico `request.locationId` proviene dal claim JWT, quindi una riassegnazione di sede del meccanico si riflette solo al refresh del token (~1h TTL). È coerente con la gestione di staleness già documentata in `tenant-context.ts` (l'access token resta valido fino alla scadenza); non introduce nuovi rischi rispetto al modello esistente.

### Applicazione per endpoint

- **`GET /v1/interventions/recent`**
  `where: { tenantId, status: { in: ['active','disputed'] }, ...(effLoc ? { locationId: effLoc } : {}) }`
- **`GET /v1/deadlines`**
  aggiunge `...(effLoc ? { locationId: effLoc } : {})` allo `where` esistente (resta tenant-scoped via RLS `withContext({tenantId})`).
- **`GET /v1/disputes/open`**
  `where: { intervention: { tenantId, ...(effLoc ? { locationId: effLoc } : {}) }, status: ... }` su **entrambi** i gruppi (`pendingResponse` e `inProgress`), incluse le `count`.

### location_id estraneo / invalido

Validazione **solo di formato** (uuid). Una `location_id` non appartenente al tenant produce semplicemente risultati vuoti (le query sono già tenant-scoped) → **nessun 422 di ownership, nessun nuovo error code, nessuna lookup aggiuntiva**. Il selettore offre solo le sedi attive del tenant, quindi una location estranea è raggiungibile solo via richiesta artigianale ed è innocua. Decisione presa per mantenere PR1 leggera.

### Note di risoluzione del ruolo/location del meccanico

- Il meccanico ha sempre `location_id` per BR-204 (vincolo dati). Difensivamente, se per qualche ragione fosse `null`, l'enforcement non può sapere quale sede mostrare: in quel caso il where non aggiunge alcun filtro location (degrada al comportamento tenant-scoped attuale) — situazione che le invarianti BR-204 rendono non raggiungibile, ma evitiamo di throware.
- L'enforcement key è il **ruolo**, non "ha una location": un super_admin con `location_id` valorizzato vede comunque tutte le sedi salvo selezione esplicita.

### Test (integration, solo CI)

- mechanic A (sede X) vede solo interventi/scadenze/dispute della sede X (non quelli di sede Y dello stesso tenant);
- mechanic con `location_id` param di un'altra sede → param **ignorato**, vede comunque solo la propria;
- super_admin senza param → vede tutte le sedi (comportamento invariato);
- super_admin con `location_id=X` → vede solo X;
- super_admin con `location_id` formato invalido → 422 (Zod);
- super_admin con `location_id` uuid estraneo al tenant → risultati vuoti, no errore.

Pattern test: `mockImplementation` per threadare l'input (vedi `feedback_integration_test_mock_dynamic_input`); IP `10.20.4x` libero per isolamento rate-limit (vedi `feedback_integration_test_rate_limit_isolation`).

## Web design (PR2)

### `LocationFilterProvider` (nuovo)

- Stato: `selectedLocationId: string | null` (`null` = "Tutte le sedi").
- Persistenza: `localStorage` con chiave **tenant-scoped** `garageos:location-filter:<tenantId>` (il tenantId viene da `useProfileMe()`), così la selezione è sticky tra refresh/sessioni e non perde di significato cambiando tenant.
- Validazione al load: se la `location_id` memorizzata non è più tra le sedi attive (`useLocations()`), reset a `null`.
- API esposta: hook `useLocationFilter()` → `{ selectedLocationId, setSelectedLocationId }`.
- Montaggio: dentro l'area autenticata (sotto `AuthProvider`/`QueryClientProvider`), così può leggere profilo + sedi.

### Selettore in `TopBar`

- Reso **solo se** `role === 'super_admin'` **e** numero di sedi **attive ≥ 2**. Altrimenti non renderizza nulla:
  - meccanico → nessun selettore (è già vincolato server-side alla sua sede);
  - super_admin di tenant single-location (es. il pilota) → nessun selettore (zero rumore UI).
- Componente: Radix `Select` (in JSDOM i test usano `userEvent.click`, vedi `feedback_radix_tabs_user_event_not_fire_event`).
- Opzioni: "Tutte le sedi" (default) + ciascuna sede attiva per nome.
- Posizione: nell'header accanto a search / theme toggle (layout esistente).

### Wiring consumer

Gli hook query leggono `selectedLocationId` da `useLocationFilter()`, e quando valorizzato:

1. appendono `&location_id=<id>` alla URL della richiesta;
2. **includono `selectedLocationId` nella `queryKey`** così React Query rifetcha al cambio sede.

Hook interessati:

- `useInterventionsRecent` (`queries/interventionsRecent.ts`)
- `useDeadlinesUpcoming` + la query lista piena in `queries/deadlinesList.ts` (consumata da `DeadlineDashboard`)
- `useDisputesOpen` (`queries/disputesOpen.ts`)

Nota: il meccanico riceve comunque solo la propria sede (enforced server-side anche se l'hook non passa alcun param), quindi il wiring è additivo e non rischia regressioni per il meccanico.

### Test (web, JSDOM, anche in locale)

- `LocationFilterProvider`: persistenza localStorage (set → reload legge il valore); reset quando la sede salvata non è più attiva; chiave scoped per tenant.
- `TopBar`: selettore assente per meccanico; assente per super_admin con 1 sola sede; presente con ≥2 sedi; cambio selezione aggiorna il context.
- Hook consumer: `queryKey` include la sede; URL contiene `location_id` quando selezionato, assente quando "Tutte le sedi".

## Non-goals / YAGNI

- Filtro clienti per sede (no `location_id` su `customers`).
- Persistenza del filtro nello URL (scelto Context + localStorage).
- Filtro per meccanico nello UI (è vincolato server-side; nessun selettore).
- Report/altre viste (F-OFF-701 ha il proprio filtro location, fuori da questo slice).
- Geocoding / mappe.

## Rischi & mitigazioni

- **R1 — comportamento meccanico cambia** (vede meno dati di prima). È il fix BR-205 voluto; coperto da test integration espliciti + annotato nella PR description.
- **R2 — drift wire shape test integration** (`del()`/param): replicare esattamente la query che invia il browser (vedi `feedback_integration_test_mirror_frontend_wire`).
- **R3 — `location_id` salvato in localStorage obsoleto** dopo disattivazione sede: gestito dalla validazione al load del provider (reset a `null`).
- **R4 — staleTime cache vs cambio sede**: mitigato includendo la sede nella `queryKey` (chiavi distinte per sede ≠ collisione cache).

## Riferimenti

- Slice prerequisito: F-OFF-003 (spec `docs/superpowers/specs/2026-06-01-F-OFF-003-location-crud-design.md`, PR #140 + #141).
- BR-204 / BR-205: `docs/APPENDICE_F_BUSINESS_LOGIC.md`.
- Endpoint correlati: `packages/api/src/routes/v1/{interventions-recent,deadlines-list-tenant,disputes-open}.ts`.
- Memorie pattern: `feedback_integration_test_mock_dynamic_input`, `feedback_integration_test_rate_limit_isolation`, `feedback_integration_test_mirror_frontend_wire`, `feedback_radix_tabs_user_event_not_fire_event`, `feedback_handler_change_breaks_unit_mock`.

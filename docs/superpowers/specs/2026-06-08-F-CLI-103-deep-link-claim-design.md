# F-CLI-103 — Aggiunta veicolo via link invito (deep-link app-side)

**Data:** 2026-06-08
**Feature:** F-CLI-103 (Specifiche §3.3.2, §4.4, §4.5)
**Tipo:** mobile-only, additivo. No backend, no migration, no deploy, no nuove dep.

## Contesto

Il filone "claim veicolo" lato cliente è già implementato per due dei tre canali
di ingresso (Specifiche §4.4):

- **F-CLI-101** inserimento manuale del codice GarageOS (#159 API + #160 UI)
- **F-CLI-102** scansione QR del tag (#162)

Manca il terzo canale, **F-CLI-103**: il cliente riceve dall'officina (email/SMS,
F-OFF-205) un link al veicolo e, cliccandolo, deve trovare l'app **pre-compilata
con il codice**, pronta per confermare l'aggancio.

L'URL canonico del link è `https://app.garageos.it/v/<code>` (Specifiche §4.5,
stesso URL codificato nel QR del tag). Tutti i flussi convergono sull'endpoint
esistente `POST /v1/me/vehicles/claim`: il client invia solo il codice estratto,
il server resta autoritativo.

### Infrastruttura già esistente e riusata

- `scheme: "garageos"` già configurato in `app.json`; `expo-linking ~7.0.0` già dep.
- `extractGarageCode(raw)` (`src/lib/qr.ts`): estrae il codice dall'URL `…/v/<code>`
  o da codice nudo, normalizza `trim().toUpperCase()`, valida con `GARAGE_CODE_RE`
  (BR-020). Riusato as-is.
- `validateClaimForm` / `GARAGE_CODE_RE` (`src/lib/validators/claimVehicle.ts`).
- `ClaimVehicleForm` (`src/components/ClaimVehicleForm.tsx`) — oggi senza pre-fill.
- `useClaimVehicle` (`src/queries/claimVehicle.ts`) + `claim-vehicle.tsx`.

## Scope

### In scope

Metà **app-side** del deep-link: l'app intercetta un link in arrivo
`garageos://v/<code>` (custom scheme, testabile in Expo Go), valida il codice e
atterra l'utente sul form claim **pre-compilato**; l'utente conferma con "Aggiungi".
Lo stesso meccanismo gestirà gli universal-link `https://app.garageos.it/v/<code>`
quando attiveremo un dev build, **senza modifiche al codice** (la route è
scheme-agnostica).

### Fuori scope (differito, da segnalare in PR)

- **Universal Links / App Links nativi** (`associatedDomains` iOS, `intentFilters`
  Android + hosting `apple-app-site-association` / `assetlinks.json` sul dominio):
  richiedono un **dev build EAS** (non Expo Go) e config infra. Differiti.
- **Ramo "app non installata → landing/store → deep-link differito"** (Specifiche
  §4.5): web/infra, non mobile.
- **Signup-con-codice-preservato** (utente totalmente nuovo che si registra
  partendo dal link): richiede di threadare il codice attraverso registrazione +
  conferma email (async, 24h). Differito a slice futura.
- **F-OFF-205** (lato officina che *invia* il link): feature server/web separata.

> Nota: questa slice chiude il **filone claim lato client** (canali manuale + QR +
> link). NON crea la sorgente "pending" per F-OFF-107 — quella nasce dalla
> pre-registrazione F-CLI-104, indipendente.

## Architettura

Approccio scelto: **route redirector file-based** `app/v/[code].tsx` (idiomatico
expo-router, coerente col resto dell'app; scartata la `linking` config custom in
`_layout` perché meno visibile e duplica l'auth-gating che le route già danno).

```
Deep link:  garageos://v/GO-482-KXRT     (Expo Go: exp://<host>/--/v/GO-482-KXRT)
            [domani anche https://app.garageos.it/v/GO-482-KXRT via dev build]
                              │
                              ▼
                  app/v/[code].tsx  (REDIRECTOR — nessuna UI oltre lo spinner)
                  - legge [code] (useLocalSearchParams), extractGarageCode → valida
                  - status 'loading'      → <LoadingState variant="fullscreen" />
                  - authed   + valido     → <Redirect href="/claim-vehicle?code=GO-…" />
                  - unauth   + valido     → <Redirect href="/login?claimCode=GO-…" />
                  - code malformato/assente → redirect senza param (form vuoto)
                              │
             ┌────────────────┴───────────────────┐
       authed │                              unauth │
             ▼                                       ▼
   claim-vehicle.tsx                         login.tsx
   legge ?code → ClaimVehicleForm            al signIn riuscito:
   initialCode (pre-fill)                    params.claimCode presente
             │                               → router.replace('/claim-vehicle?code=…')
             │                               altrimenti → '/(tabs)' (invariato)
             ▼
   utente conferma "Aggiungi"
   → useClaimVehicle → POST /me/vehicles/claim
   → router.replace('/(tabs)/vehicles/:id')  (dettaglio)
```

## Componenti

### 1. `ClaimVehicleForm` — nuova prop `initialCode?: string`

Lo state `code` si inizializza da `initialCode ?? ''` (mirror del pattern `initial?`
di `PrivateInterventionForm`). Comportamento create esistente invariato quando la
prop è assente. Nessun auto-submit: il codice è solo pre-compilato, l'utente tocca
"Aggiungi" (coerente con il flusso QR e con lo step "Conferma aggancio" §4.4).

### 2. `claim-vehicle.tsx` — legge il param `code`

`useLocalSearchParams<{ code?: string }>()`; se presente e valido (`GARAGE_CODE_RE`)
lo passa come `initialCode` al form; se malformato lo ignora (form vuoto). Resto
invariato (onSubmit → `useClaimVehicle` → dettaglio).

### 3. `app/v/[code].tsx` (nuovo) — redirector auth-aware

Legge `[code]`, `extractGarageCode`, poi `Redirect` secondo gli edge-case sotto.
Usa `useAuth` per lo status (sincrono dal JWT) e `LoadingState` durante il load
(no flash, come `index.tsx`).

### 4. `login.tsx` — post-login deferred

Legge `params.claimCode` (già legge `params.reset`). Al `signIn` riuscito: se
`claimCode` presente → `router.replace('/claim-vehicle?code=<claimCode>')`,
altrimenti `/(tabs)` come oggi. Banner `reset` esistente intatto.

### Cosa NON si tocca

Endpoint `/me/vehicles/claim`, `useClaimVehicle`, `QrScanner`, `extractGarageCode`,
schema DB. Zero backend/migration/deploy/dep.

## Edge case

| Caso | Comportamento |
|---|---|
| `[code]` valido + authed | `Redirect /claim-vehicle?code=GO-…` → form pre-compilato |
| `[code]` valido + unauth | `Redirect /login?claimCode=GO-…` → post-login → claim pre-compilato |
| `[code]` malformato/assente | authed → `/claim-vehicle` (form vuoto); unauth → `/login` semplice. Mai pre-compilare con input non conforme. |
| status `loading` | `<LoadingState variant="fullscreen" />` |

## Sicurezza

- Il codice nel link **non è un token di autenticazione** — è l'identificatore
  pubblico del veicolo (Specifiche §4.5, §4.4). Chi ha il link vede il codice ma non
  acquisisce il veicolo se è già di altri: la frontiera resta il check app-layer +
  `uq_ownership_vehicle_active` (BR-040) sull'endpoint, **invariato**. Il deep-link
  pre-compila soltanto; il server resta autoritativo.
- `extractGarageCode` valida con la **stessa** `GARAGE_CODE_RE` del backend (BR-020)
  prima di pre-compilare → nessun input non conforme entra nel form.
- `claimCode` nel param `/login` è già nel link pubblico → nessun leak di PII/segreti.

## Testing

Mobile jest in locale, TDD red→green. `pnpm -r typecheck` repo-wide. API/integration
non toccati. Target CI 14/14.

1. **`ClaimVehicleForm.test.tsx`** (esteso): con `initialCode` il campo è
   pre-compilato e l'invio manda quel codice; regressione: senza prop, campo vuoto.
2. **`app/v/[code].tsx`** (nuovo test): mock `useAuth` + `Redirect`. 4 casi —
   authed+valido → `/claim-vehicle?code=…`; unauth+valido → `/login?claimCode=…`;
   invalido → senza code; loading → `LoadingState`.
3. **`claim-vehicle.tsx`**: mock `useLocalSearchParams` → `?code=` valido passato
   come `initialCode`; malformato ignorato.
4. **`login.tsx`** (esteso): `signIn` ok + `params.claimCode` → `router.replace`
   al claim; senza → `/(tabs)` (invariato); banner `reset` intatto.

### Gotcha da applicare

- Nuova route `app/v/[code].tsx` + `router.replace` verso nuova route →
  `rm .expo/types/router.d.ts` (lo stale locale blocca tsc; CI non ce l'ha).
- Run jest mobile → redirect a file controllato + loop `grep __EXIT`.

### Smoke device (Expo Go, post-merge, non bloccante)

Con Metro attivo, lanciare il deep-link:
`adb shell am start -W -a android.intent.action.VIEW -d "exp://<host>/--/v/GO-482-KXRT"`
(o `npx uri-scheme open`). Verificare: loggato → claim pre-compilato → "Aggiungi" →
dettaglio; sloggato → login → post-accesso claim pre-compilato; codice malformato →
form vuoto.

## Business rules

- **BR-020** garage_code format — riusata via `GARAGE_CODE_RE` (già nel validator).
- **BR-040 / BR-042** ownership uniqueness e rami claim — invariati, sull'endpoint
  esistente. Nessuna nuova BR.
```

## Documentazione

`docs/APPENDICE_A_API.md` §2.4 cita già F-CLI-103 come consumer di
`POST /me/vehicles/claim` — nessuna modifica API. Eventuale nota in PR sulle
deviazioni doc (universal-link nativi e landing differiti).

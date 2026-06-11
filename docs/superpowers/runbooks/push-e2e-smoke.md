# Smoke push e2e — F-CLI-302/303 (build standalone preview)

**Stato: ✅ PASS — eseguito 2026-06-11 (device Xiaomi, APK preview build `71e50abc`)**

Prima verifica end-to-end della catena push: registrazione token (PR1 #173) →
delivery dispatcher (PR2 #174) → preferenze editabili (PR3 #175), su APK
standalone `preview` (stesso artefatto della demo cliente — nessun Metro,
nessun account Expo sul device).

## Prerequisiti (fatti il 2026-06-11)

- Progetto EAS `@michele.matula/garageos-mobile`, projectId
  `c97d3080-7775-4979-8e5f-7f2e9153205b` in `app.config.js` (PR #193).
- Firebase `garageos-b09f3`, app Android `it.garageos.mobile`; FCM V1
  service-account key caricata nelle credenziali EAS; `google-services.json`
  via file env var `GOOGLE_SERVICES_JSON` (gitignored, repo pubblico).
- Env EAS `preview`/`production`: `EXPO_PUBLIC_API_URL`,
  `EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID`, `EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID`.
- `EXPO_ACCESS_TOKEN` nel secret app: NON necessario (expo-client.ts tratta il
  placeholder come unset; serve solo con Enhanced Push Security attiva).
- Build: `npx eas-cli@latest build --profile preview --platform android`
  (da `packages/mobile`).

## Step

a. **Install APK** sul device (Xiaomi `CI659HAE8LSW6H5L`): scaricare l'APK
   dalla build page EAS → `adb install <apk>`. Nessun Metro/adb reverse:
   l'APK parla direttamente con l'API prod.
b. **Login cliente1** (`matulamichele+cliente1@gmail.com`). Primo avvio:
   concedere il permesso notifiche quando richiesto.
c. **Registrazione token**: Profilo → Notifiche (`/notification-preferences`)
   → toggle push device ON → atteso nessun errore. Verifica DB (SQL editor):
   riga in `push_tokens` (`active=true`, `expo_push_token` like
   `ExponentPushToken[...]`) + `customers.app_installed=true` per cliente1.
d. **Trigger primario — `intervention.revised`** (BR-064): in app aprire un
   intervento officina di un veicolo di cliente1 (setta
   `first_seen_by_customer_at` → chiude la finestra wiki); dal web prod
   (super_admin Giuseppe) PATCH dello stesso intervento con motivazione ≥10
   char → atteso: push "intervento modificato" sul device (app in background).
e. **Trigger fallback — `intervention.cancelled`**: se (d) non è praticabile,
   creare intervento usa-e-getta sul veicolo di cliente1 dal web e annullarlo
   con motivo → push di annullamento.
f. **App chiusa (kill)**: ripetere un trigger con l'app uccisa dal task
   manager → la push deve comunque arrivare (consegna FCM a livello OS).
   Su MIUI, se non arriva: Impostazioni → batteria/autostart per GarageOS
   (taratura utile per la demo).
g. **Toggle OFF evento**: disattivare la preferenza push dell'evento usato →
   ripetere il trigger → atteso NESSUNA push (skipped `pref-off`).
   Riattivare a fine test.
h. **Tap sulla notifica**: verificare il comportamento di apertura app.
i. **Audit log Lambda** (opzionale): CloudWatch → log `push: {... result:
   'sent', attempted, sent}` per il dispatch di (d)/(f).

## Esiti (2026-06-11)

Eseguito con account `matulamichele+b2cpwd@gmail.com` (Pippo Baudo, customer
`731b3cb3`), proprietario del veicolo `GO-346-AJJE` — cliente1 non aveva
interventi officina. Intervento usato: `a2a66c05-e69b-4fea-95de-e74a6d8c9b3d`.

- a. Install APK via link build page sul telefono (no adb) — OK. Convive con
  Expo Go (app standalone separata).
- b. Login + permesso notifiche: il prompt NON appare al login, appare al
  primo toggle push ON (richiesta lazy, design PR1) — OK, comportamento atteso.
- c. Token registrato: `POST /v1/me/push-tokens` → 201 (285ms). Il cambio
  account cliente1→b2cpwd ha esercitato anche la deregistrazione al logout
  (DELETE visibili nei log) — OK.
- d. Trigger `intervention.revised` (PATCH web con reason, finestra wiki già
  chiusa su intervento >48h): **1° tentativo FAIL — bug prod reale**:
  `expo-server-sdk` fa `require('../package.json')` lazy al send; nel bundle
  esbuild ESM il file non esiste → `push: {result:'error', "Cannot find
  module '../package.json'"}`. Invisibile a unit/integration (SDK mockato).
  **Fix #195** (`a7132da`): `expo-server-sdk` in `bundling.nodeModules`
  (pattern @prisma/client). Post-deploy: `push: {result:'sent', attempted:1,
  sent:1}` e notifica sul device — OK.
- f. App KILLED (task manager) → push arriva comunque (FCM a livello OS) — OK
  su questo Xiaomi senza toccare battery optimization.
- g. Toggle OFF preferenza evento → nessuna push (atteso `pref-off`) → ON di
  nuovo — OK. Nota minor: lo skip pref-off NON produce log line (ritorno
  silenzioso in `dispatchPush`); l'assert è solo comportamentale.
- h. Tap sulla notifica → apre l'app sull'ultima pagina visitata: il routing
  da `data` payload NON è implementato lato mobile (deferito in PR1 #173, mai
  ripreso — nessun `addNotificationResponseReceivedListener` nel codebase).
  Il payload server-side è già pronto → candidata mini-slice
  "notification tap deep-link".

### Prerequisiti scoperti in corsa (3 build EAS fallite prima della buona)

1. Builder EAS: pnpm 9 default vs `engines` pnpm≥10 → pin `node`/`pnpm` in
   `eas.json` (profilo `base` + `extends`) — #194.
2. Metro sul builder non risolve deps transitive RN (`invariant`) col layout
   pnpm isolated; `node-linker=hoisted` root-wide però rompe i test web
   (react 19 web vs 18.3 mobile) → **`shamefully-hoist=true` nel root
   `.npmrc`** (isolated semantics + pacchetti esposti a root) — #194.
   NB: pnpm IGNORA i .npmrc non-root nei workspace (il vecchio
   `packages/mobile/.npmrc` era inerte).
3. `expo-server-sdk` nel bundle Lambda (sopra) — #195.

### Dati di test lasciati in prod

L'intervento `a2a66c05` ha ~4 revisioni con reason di test ("test notifiche
push e2e" e simili) — innocue (audit trail), eventualmente da considerare
nella pulizia DB prod. Token push attivo: b2cpwd su Xiaomi (cliente1
deregistrato dal logout).

## Note demo cliente

L'APK `preview` è installabile su qualunque device Android senza account
Expo: la push viaggia Expo → FCM → device come una normale app di produzione.
Unica accortezza demo: primo avvio con permesso notifiche concesso; su
Xiaomi/MIUI verificare battery optimization se le push tardano.

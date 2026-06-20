# Design — "Accedi con Google" nella mobile app (clienti)

- **Data:** 2026-06-20
- **Stato:** approvato (brainstorming)
- **Tipo:** large vertical slice, cross-layer (infra CDK + nuova Lambda + mobile + refactor backend)
- **Scope:** solo Google. Apple rimandato (vedi "Estensibilità futura").

## What

Aggiungere il login federato "Accedi con Google" alla mobile app dei clienti
(`packages/mobile`), sia in **registrazione** che in **login**, con **merge
automatico** verso un eventuale account/`customers` esistente con la stessa email.

Lato runtime cambia solo *come l'app ottiene i token la prima volta*: si passa dal
flusso SRP diretto a un flusso OAuth tramite la Hosted UI di Cognito. Tutto ciò che
sta a valle (storage token, `api-client`, refresh, validazione JWT lato backend)
rimane invariato.

## Why

- Il login email/password attuale è l'unico metodo: attrito alto in onboarding B2C.
- "Sign in with Google" è una metodologia standard (OpenID Connect federation via
  Cognito come identity broker); non si reimplementa OAuth a mano.
- Il backend è già **pool-agnostico** e si basa sul claim `custom:customer_id`:
  l'integrazione non richiede modifiche all'API se garantiamo quel claim anche per
  gli utenti federati.

## Stato attuale (baseline)

- Mobile: Cognito **SRP diretto** via `amazon-cognito-identity-js`. Nessuna Hosted
  UI, nessun IdP social. File chiave: `src/auth/AuthContext.tsx`, `src/lib/cognito.ts`,
  `src/lib/secure-storage.ts`, `src/lib/api-client.ts`, `app/login.tsx`, `app/signup.tsx`.
- Signup server-driven `POST /v1/auth/signup` (`packages/api/src/routes/v1/auth-signup.ts`):
  3 fasi (advisory lock → crea/promuovi `customers` + audit log + notification prefs →
  best-effort `cognito_sub`; più best-effort SES). Concetto di **shadow customer**
  (cliente creato dall'officina, mai loggato → promozione).
- Backend: `aws-jwt-verify` (`packages/api/src/plugins/auth.ts`,
  `middleware/require-auth.ts`) estrae `custom:customer_id`. **Pool-agnostico.**
- Infra: `infrastructure/lib/constructs/cognito.ts` — pool clienti senza dominio,
  senza IdP, app client con `userSrp`/`userPassword`, `preventUserExistenceErrors`.

## Architettura e flusso

**Componenti toccati:** infra CDK (solo pool clienti), nuova Lambda di trigger,
mobile app, refactor abilitante nel backend. **L'API non cambia** (continua a leggere
`custom:customer_id`).

Flusso "Accedi con Google" (nuovo utente):

1. L'app apre il browser di sistema (`expo-auth-session` + `expo-web-browser`) sulla
   Hosted UI di Cognito — **Authorization Code flow + PKCE**.
2. Cognito redirige a Google → login/consenso → torna a Cognito.
3. **Trigger PreSignUp** (`PreSignUp_ExternalProvider`): se esiste già un utente
   Cognito nativo con la stessa email → `AdminLinkProviderForUser` (merge) +
   auto-confirm.
4. Cognito emette i token → scatta il **Trigger Pre-Token-Generation**: upsert
   idempotente di `customers` (logica di provisioning condivisa) + iniezione di
   `custom:customer_id` nel token.
5. Cognito redirige all'app via **deep link** (`garageos://auth/callback`); l'app
   scambia il `code` per `idToken`/`accessToken`/`refreshToken`.
6. Da qui in poi identico a oggi: `secure-storage`, `api-client`, refresh.

I tre casi mappati su `customers`, tutti gestiti dai trigger in modo idempotente:

| Situazione | Comportamento |
|---|---|
| Email Google mai vista | Crea nuovo `customers` (riga + audit log + notification prefs) e setta `custom:customer_id` |
| Email = shadow customer | Promuove la riga esistente e linka (no duplicato) |
| Email = account password attivo | `AdminLinkProviderForUser` (merge): un solo account, entrambi i metodi |

## Infrastruttura (CDK / Cognito)

Modifiche a `infrastructure/lib/constructs/cognito.ts` — **solo pool clienti**, il
pool officine non si tocca:

- **Google IdP** (`UserPoolIdentityProviderGoogle`): Client ID + Secret di Google.
  Attribute mapping: `email → email`, `given_name → given_name`,
  `family_name → family_name`, `email_verified`.
- **Dominio Hosted UI**: `userPoolDomain` con prefisso `garageos-{env}-clienti`
  (no certificato/Route53; custom domain rimandabile).
- **App client clienti esteso** (stesso client, non uno nuovo):
  - OAuth: `authorizationCodeGrant`, scope `openid email profile`.
  - `supportedIdentityProviders`: `COGNITO` (login password esistente) **+ Google**.
  - `callbackUrls` / `logoutUrls`: deep link app (`garageos://auth/callback`) + URI
    di sviluppo Expo.
  - SRP/`userPassword` **restano attivi** → login email/password invariato.
- **Secret di Google** in **AWS Secrets Manager** (mai in chiaro nel codice/CDK),
  referenziato dal construct.

**Task operatore (manuale, prerequisito al deploy):** creare l'OAuth 2.0 Client su
Google Cloud Console (tipo "Web application"; il redirect è verso il dominio Cognito,
non l'app). Redirect URI autorizzato:
`https://garageos-{env}-clienti.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`.
Client ID + Secret risultanti vanno in Secrets Manager.

## Lambda trigger e provisioning

**Nuova Lambda** (collocazione decisa in fase di plan: `packages/cognito-triggers`
oppure dentro `infrastructure/`) con due handler, agganciata al pool clienti via CDK.
Necessita: connessione DB (Prisma/Supabase) + IAM
`cognito-idp:AdminLinkProviderForUser` e `AdminUpdateUserAttributes`.

**Refactor abilitante:** estrarre la logica di provisioning oggi dentro
`auth-signup.ts` (3 fasi) in una **funzione condivisa** (in `packages/database` o lib
condivisa), così endpoint signup **e** trigger usano lo stesso codice testato.
L'endpoint signup viene rifattorizzato per chiamarla; comportamento invariato.

**Handler PreSignUp** (`PreSignUp_ExternalProvider`):

- Guard di sicurezza: procede solo se `email_verified=true` da Google.
- Cerca utente Cognito nativo con stessa email → se esiste, `AdminLinkProviderForUser`.
- `autoConfirmUser=true`, `autoVerifyEmail=true`.

**Handler Pre-Token-Generation:**

- Lookup `customers` per email/`cognito_sub`.
- Se manca → esegue la funzione di provisioning condivisa (idempotente).
- Inietta `custom:customer_id` nelle claim dell'idToken.
- Sul refresh la riga esiste già → lookup leggero + iniezione claim.

**Invariante risultante:** `custom:customer_id` è **sempre** presente nel token,
come per il login password. Il backend non distingue Google da password.

## Mobile

- `src/lib/cognito.ts`: aggiungere il flusso federato (`expo-auth-session` /
  `expo-web-browser`, Authorization Code + PKCE verso la Hosted UI), scambio `code`
  → token, persistenza identica all'attuale `SignInResult`.
- `app/login.tsx`: bottone "Accedi con Google" (additivo, il form email/password
  resta).
- Deep link / scheme `garageos://` configurato (app config Expo).
- Per il percorso Google: **niente schermata verifica email** (email già certificata
  da Google).
- Dipendenze nuove (`expo-auth-session`, `expo-web-browser`): da giustificare in PR.

## Sicurezza ed edge case

- **Anti-account-takeover:** merge/link solo se Google certifica `email_verified=true`.
- **Idempotenza** del provisioning sul Pre-Token-Generation (rischio principale: si
  esegue a ogni refresh): nessuna riga/audit log duplicati.
- **Nessuna PII/tenant leak** dal merge: l'identità Google si attacca alla riga
  `customers` corretta; il claim iniettato corrisponde a quella riga.
- **Secret Google** solo in Secrets Manager.

## Testing (two-tier)

**Tier 1 — copertura piena:**

- Funzione di provisioning condivisa, tre casi: nuovo (crea + audit log + notification
  prefs), shadow (promozione, no duplicato), password attivo (riusa riga, no duplicato).
- **Idempotenza**: invocazioni ripetute non creano righe/audit log doppi.
- Regressione: `auth-signup.ts` rifattorizzato → BR-test esistenti restano verdi.
- Sicurezza: PreSignUp **non linka** se `email_verified=false` (test negativo); merge
  collega all'utente nativo corretto; `custom:customer_id` iniettato = riga giusta.
- **BR:** grep `APPENDICE_F` per le BR del signup clienti (shadow promotion, una sola
  identità per email, notification prefs di default); un test per ciascuna toccata.
  Elenco definito in fase di plan dopo il grep.

**Tier 2 — minima:**

- Login mobile: bottone Google presente e avvia il flusso (orchestratore mockato);
  stato d'errore (utente annulla / browser chiuso). Niente test di puro rendering.

**Smoke runbook (obbligatorio, device-facing):** il flusso OAuth via browser non è
coperto da JSDOM. Provare su **dev build reale** (non solo Expo Go: i deep link con
scheme custom in Expo Go passano dal proxy `exp://` e vanno verificati). Casi smoke:
nuovo utente Google, utente Google esistente, e merge (email già registrata con
password → login Google → stesso profilo).

## Estensibilità futura (Apple)

Il pattern IdP di Cognito è incrementale: aggiungere "Accedi con Apple" sarà un
secondo `UserPoolIdentityProvider` + client OAuth dedicato + bottone, **senza rework**
dei trigger o del backend. Da affrontare prima della pubblicazione su App Store iOS
(linea guida Apple 4.8).

## Fuori scope

- Apple Sign In (rimandato).
- Custom domain per la Hosted UI (si usa il dominio prefisso Cognito).
- Modifiche al pool/flow officine.
- Modifiche al backend API (verifier/middleware restano invariati).

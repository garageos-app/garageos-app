# Design — Backend audit per cambio/reset password

- **Data:** 2026-06-03
- **Tipo:** hardening / sicurezza (vertical slice piccola, api + web + docs)
- **Gap di partenza:** audit `docs/superpowers/audits/2026-05-31-implementation-status-inventory.md`
  riga "Password change backend audit | MUST(part) | Cognito-only client-side;
  no backend rate-limit/audit row".
- **BR coinvolte:** BR-280 (cosa viene loggato), BR-281 (cosa NON), BR-282
  (immutabilità append-only), BR-225 (rate-limit anti-abuso, pattern signup).

## 1. Problema

Cambio password (utente loggato, `Impostazioni → Password`) e reset password
(flusso "Password dimenticata", F-OFF-005) avvengono **interamente client-side
via Cognito**:

- `packages/web/src/queries/changePassword.ts` → `CognitoUser.changePassword`
- `packages/web/src/queries/passwordReset.ts` → `forgotPassword` / `confirmPassword`

Il backend non ne sa nulla: **nessuna riga in `audit_logs`** e **nessun
rate-limit applicativo**. BR-280 elenca esplicitamente "Login/logout utente" tra
gli eventi sempre loggati ma **omette il cambio/reset password**, che è un evento
di sicurezza di pari (o maggiore) rilevanza forense.

## 2. Vincolo architetturale decisivo

Il backend **non può eseguire lui stesso il cambio password**:

- `requireAuth` verifica il token tramite `jwtVerifier` con un `customJwtCheck`
  che **rifiuta qualsiasi token con `token_use !== 'id'`**
  (`packages/api/src/plugins/auth.ts:84-88`). Il bearer è quindi l'**ID token**.
- Cognito `ChangePassword` richiede invece un **AccessToken**, che il backend
  non riceve mai.

Spostare il flusso server-side richiederebbe di cambiare l'auth (far circolare
l'access token) e riscrivere la web — fuori scope per uno slice di hardening.
Decisione: **il cambio resta client-side Cognito**; aggiungiamo endpoint di
**audit-notify best-effort**.

## 3. Architettura: due endpoint di audit-notify

Il cambio/reset vero avviene client-side (Cognito verifica già la vecchia
password ed applica il proprio rate-limit). I nuovi endpoint hanno **un solo
scopo**: scrivere la riga forense in `audit_logs`, più un rate-limit applicativo
come tappo anti-spam sull'endpoint stesso.

Entrambe le route vivono in un nuovo file
`packages/api/src/routes/v1/auth-password-audit.ts`
(`export const authPasswordAuditRoutes`), registrato in `server.ts` accanto
agli altri `auth*Routes`.

### 3.1 `POST /v1/auth/password-changed` — autenticato (officine pool)

- **preHandler:** `requireAuth → requireOfficinaPool → tenantContext`
- **Body:** nessuno (l'attore è identificato dal JWT).
- **Logica:** lookup utente via `cognitoSub` (`request.userId`) + `tenantId`
  (`request.tenantId`) dentro `withContext({ role: 'admin' as const })`
  — stesso pattern di `users-admin-update.ts:160-163` per ottenere lo UUID DB
  dell'attore. Scrive **una** riga `audit_logs`:
  - `tenantId` = `request.tenantId`
  - `actorType` = `'user'`
  - `actorId` = `userId` (UUID DB)
  - `action` = `'user_password_changed'`
  - `entityType` = `'user'`
  - `entityId` = `userId` (l'utente cambia la **propria** password)
  - `ipAddress` = `request.ip`
  - `metadata` = `{}`
- **Risposta:** `204 No Content`.
- **Rate-limit:** 5 tentativi / 15 minuti per IP (pattern `auth-signup.ts:74-95`),
  codice `auth.password_change.rate_limited` (429).
- **Edge:** se il lookup utente non trova la riga (token valido ma utente
  disattivato fra l'emissione e la chiamata) → `tenantContext` avrebbe già
  risposto 401; in pratica il lookup interno trova sempre la riga. Per robustezza,
  se non trovata, l'handler logga warn e risponde comunque 204 (non scrive riga).

### 3.2 `POST /v1/auth/password-reset-completed` — pubblico

- **preHandler:** nessuno (durante forgot-password l'utente non è autenticato).
- **Body:** `{ email: string }` (Zod: email, trim, lowercase, max 255).
- **Logica:** `withContext({ role: 'admin' as const })` (come `auth-signup.ts`,
  per bypassare l'RLS `users` su una scrittura cross-tenant senza JWT) → lookup
  **utenti officine attivi** (`status='active'`, `deletedAt=null`) per email.
  `users.email` **non è unique** (solo `@@index`, schema riga 293), quindi il
  lookup può restituire più righe: scrive **una riga `user_password_reset` per
  ogni match**, ciascuna con il proprio `tenantId`/`actorId`.
  - `actorType` = `'user'`, `entityType='user'`, `entityId`=`userId`,
    `actorId`=`userId`, `ipAddress`=`request.ip`, `metadata={}`.
- **Risposta:** **sempre `204` costante**, indipendentemente dall'esistenza
  dell'email (anti-enumeration, coerente con `passwordReset.ts` lato web). Scrive
  righe solo se trova utenti.
- **Rate-limit:** 5 / 15 min per IP, codice `auth.password_reset.rate_limited`.

## 4. Lato web — notify best-effort (non blocca mai il flusso utente)

Il successo del cambio/reset non deve **mai** dipendere dalla riuscita del
notify. Tutte le chiamate sono fire-and-forget con `.catch()` silenzioso.

### 4.1 Cambio (autenticato)

`packages/web/src/components/settings/PasswordForm.tsx` — in `onSubmit`, dopo
`if (result.ok)`: invoca `apiFetch('/v1/auth/password-changed', { method: 'POST' })`
(via `useApiFetch`) in modo best-effort, poi mostra il toast "Password aggiornata."
come oggi. Un fallimento del notify non altera l'esito UI.

### 4.2 Reset (non autenticato)

La pagina `/reset-password` (consumer di `useConfirmPasswordReset`) — dopo il
successo della conferma: `fetch` **grezza** (NON `apiFetch`, che richiede sempre
un token e lancia se assente, `api-client.ts:25-28`) verso
`<VITE_API_BASE_URL>/v1/auth/password-reset-completed` con
`{ 'Content-Type': 'application/json' }` e body `{ email }`, best-effort.

> Nota implementativa: incapsulare la `fetch` grezza in un piccolo helper
> riusabile (es. `queries/passwordReset.ts` → `notifyPasswordResetCompleted(email)`)
> così la pagina resta pulita e il test la può mockare.

## 5. Error handling

- Endpoint **change**: 401 dai middleware (token mancante/invalid/utente
  disattivato); 429 `auth.password_change.rate_limited`; 204 altrimenti.
- Endpoint **reset**: 204 costante; 429 `auth.password_reset.rate_limited`;
  422 solo per body malformato (email mancante/non valida) — non è un percorso
  reale del client ma Zod lo impone.
- Lato web: ogni fallimento del notify è ingoiato; nessun impatto su toast/UX.

## 6. Caveat accettati (esplicitati per il review)

1. **Audit best-effort / client-skippable.** Un client manomesso può saltare il
   notify. Coerente col modello attuale (login/logout e tutte le op auth sono
   client-side Cognito). Cattura in modo affidabile l'happy-path, che è il
   valore forense reale.
2. **Rate-limit in gran parte ridondante** col limite Cognito sul cambio vero.
   Qui cappa solo lo spam sugli endpoint di audit. È economico e segue il
   pattern esistente, quindi lo includiamo.
3. **Endpoint reset non autenticato** → rischio "pollution" dell'audit-log
   (un attacker può generare righe `user_password_reset` per email note).
   Mitigato da: rate-limit per IP + scrittura **solo se l'utente esiste**.
   Accettato per v1.

## 7. Documentazione da aggiornare

- **`docs/APPENDICE_F_BUSINESS_LOGIC.md` BR-280:** aggiungere alla lista degli
  eventi sempre loggati "Cambio password / reset password completato".
- **`docs/APPENDICE_A_API.md`:** documentare i due endpoint (sezione `auth`).
- **`docs/APPENDICE_G_ERROR_CODES.md`:** aggiungere i due codici
  `auth.password_change.rate_limited` e `auth.password_reset.rate_limited`.
- Citare `BR-280` nei commenti dei nuovi handler.

## 8. Pre-flight verificati (sibling/grep)

- Audit write pattern: `users-admin-update.ts:185-198`,
  `auth-signup.ts:222-233`.
- Rate-limit per route: `auth-signup.ts:74-95` (errorResponseBuilder con
  `err.name` dotted → Problem+JSON via error-handler).
- `withContext({ role: 'admin' })` per write cross-tenant senza JWT:
  `auth-signup.ts:132`.
- `AuditActorType` enum (schema:189) = {user, customer, system, admin} →
  usiamo `user`.
- Registrazione route: `server.ts:184` (`authSignupRoutes`).
- IP integration dedicato libero: scegliere `10.20.4x.x` non usato (vedi
  `feedback_integration_test_rate_limit_isolation`).

## 9. Testing

- **API unit** (FakePrisma): change scrive la riga audit corretta (action,
  actorType, entityId); reset scrive una riga per ogni match e **nessuna** riga
  se non trova utenti, rispondendo 204 in entrambi i casi.
- **API integration:** change autenticato → 204 + riga in `audit_logs`; reset
  pubblico → 204 + riga per email esistente, 204 + 0 righe per email ignota;
  429 al superamento del rate-limit (IP dedicato `10.20.4x.x`).
- **Web:** `PasswordForm` invoca il notify dopo il successo **e** mostra il toast
  anche se il notify fallisce; la pagina reset invoca `notifyPasswordResetCompleted`
  best-effort dopo la conferma.

## 10. Right-sizing

~5-6 task, due layer (api + web) + docs, additivo e a basso rischio.
→ **inline (executing-plans) + 1 sola review Opus finale**, niente pipeline
subagent (regola CLAUDE.md §"Right-sizing the workflow to the task").

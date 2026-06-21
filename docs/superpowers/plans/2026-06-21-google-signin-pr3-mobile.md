# Google Sign-In — PR3 (mobile clienti) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere il login federato "Accedi con Google" alla mobile app clienti (registrazione + login + merge automatico), consumando l'infrastruttura Cognito già live in prod (PR2 #215). Solo consumer-side: nessuna modifica ad API, DB o infra.

**Architecture:** Authorization Code + PKCE verso la Hosted UI di Cognito, **diretto a Google** (`identity_provider=Google` sull'authorize endpoint, salta la pagina chooser di Cognito). `expo-auth-session` + `expo-web-browser` gestiscono il flusso OAuth e lo scambio `code`→token; il payload dell'`id_token` viene decodificato per estrarre `custom:customer_id` ed `email`, producendo lo **stesso `SignInResult`** del flusso SRP. Tutto a valle (secure-storage, api-client, refresh via `refreshSession` SDK) resta invariato. Bottone presentazionale condiviso fra Login e Signup; ogni schermata possiede orchestrazione, navigazione e banner d'errore.

**Tech Stack:** Expo SDK 52, React Native 0.76 (Hermes), expo-auth-session, expo-web-browser, expo-crypto (PKCE, già presente), amazon-cognito-identity-js (refresh invariato).

**Spec:** `docs/superpowers/specs/2026-06-20-mobile-google-signin-design.md` (§Mobile). Arco a 3 PR: PR1 #214 + PR2 #215 entrambi shipped e PR2 deployata/verificata in prod 2026-06-21.

**LOC budget:** target ~450 net, hard PR limit 1500. Controller verifica LOC cumulativo dopo ogni task; halt + ask a ~80% del limite.

## Deviations from spec (verified against actual code — the code wins)

1. **Direct-to-Google invece di Hosted UI chooser.** La spec §"Architettura e flusso" punto 1 dice "L'app apre il browser sulla Hosted UI di Cognito". Raffinamento UX deciso in brainstorming (2026-06-21): si passa `identity_provider=Google` all'`/oauth2/authorize` così l'utente va dritto a Google. Email/password restano nativi nell'app (SRP), quindi non serve la Hosted UI per esporre quel form. Nessun impatto su infra (il client OAuth deployato supporta sia `COGNITO` sia `GOOGLE`).
2. **Bottone anche su Signup.** La spec §Mobile cita solo `app/login.tsx`. Decisione brainstorming: bottone additivo su Login ("Accedi con Google") **e** Signup ("Registrati con Google") per scopribilità. Stesso flusso tecnico (Google copre registrazione e login).
3. **Refresh confermato invariato.** La spec dice "refresh invariato"; verificato in `src/auth/AuthContext.tsx:91-110` → `refreshSession(email, refreshToken)` (amazon-cognito-identity-js, `src/lib/cognito.ts:68-85`). Lo si riusa per le sessioni Google: stesso pool/client, l'SDK passa solo il refresh token. **Punto meno certo → check esplicito allo smoke**; fallback documentato = refresh via `/oauth2/token` `grant_type=refresh_token` (NON implementato in questa PR salvo fallimento smoke).
4. **`custom:customer_id` letto senza ri-verifica firma.** Parità con il flusso esistente: `extractFromSession` (`cognito.ts:33-46`) legge `idToken.payload` senza ri-verificare (l'SDK ha già validato). Per Google decodifichiamo il JWT lato client solo per leggere le claim; il backend verifica la firma via `aws-jwt-verify`. Nessuna nuova superficie di rischio.

## Gotchas the implementer MUST respect (from project memory)

- **Smoke su DEV BUILD reale, non Expo Go (BLOCKER).** I deep link con scheme custom (`garageos://`) in Expo Go passano dal proxy `exp://` e non combaciano col callback Cognito. Build dev client: `pnpm --filter @garageos/mobile android` (= `expo run:android`, variante debug → JS live da Metro) + `adb reverse tcp:8081`. (Vedi memory: smoke mandatory per shell/device PR; `feedback_cognito_srp_expo_go_bridgeless`.)
- **`expo install`, non `pnpm add`**, per le nuove dipendenze: i pin dell'SDK vincono sul plan (`feedback_expo_sdk_install_fix_dep_drift`).
- **Killare Metro prima di `expo install`/`pnpm install`**: Metro locka `node_modules` su Windows → EPERM (`feedback_metro_locks_node_modules_eperm`).
- **Mock di default-import in jest richiede `{ __esModule: true, default: {...} }`** (`feedback_jest_mock_default_import_needs_esmodule`). `expo-web-browser`/`expo-auth-session` si importano come namespace (`import * as`), quindi mock namespace; attenzione se un sotto-import è default.
- **Scrivere `.env.local` con la Write tool (UTF-8), mai `Out-File`** (default UTF-16 BOM rompe il parsing) — `feedback_powershell_utf16_npmrc`.
- **EXPO_PUBLIC_* sono inlined da babel-preset-expo al transform time.** Per i test, i default vanno in `jest.config.js` PRIMA di `module.exports` (come gli altri tre, righe 6-8), non in setupFiles.
- **Commit summary ≤ 72 char** (commitlint è gate CI su OGNI commit del PR — `feedback_ci_commitlint_all_commits_scope`); scope `mobile`.
- **Tier 2 mobile = 2-3 test mirati per schermata, niente test di puro rendering** (CLAUDE.md "Test depth"). Eccezione: `decodeJwtPayload` è logica pura → unit test pieno (il parsing è esattamente ciò che si rompe).

## Branch

`feat/google-signin-pr3-mobile` (da `main` aggiornato).

```bash
git checkout main && git pull origin main
git checkout -b feat/google-signin-pr3-mobile
```

## File structure

| File | Responsabilità | Azione |
|---|---|---|
| `packages/mobile/package.json` | deps expo-auth-session + expo-web-browser | Modify (via expo install) |
| `packages/mobile/.env.local` | `EXPO_PUBLIC_COGNITO_HOSTED_UI` | Modify |
| `packages/mobile/jest.config.js` | default env var per i test | Modify |
| `packages/mobile/jest.setup.ts` | mock expo-web-browser + expo-auth-session | Modify |
| `packages/mobile/src/lib/cognito.ts` | `signInWithGoogle()` + `decodeJwtPayload()` | Modify |
| `packages/mobile/src/auth/AuthContext.tsx` | metodo `signInWithGoogle` | Modify |
| `packages/mobile/src/components/auth/GoogleSignInButton.tsx` | bottone presentazionale condiviso | Create |
| `packages/mobile/app/login.tsx` | wiring bottone su Login | Modify |
| `packages/mobile/app/signup.tsx` | wiring bottone su Signup | Modify |
| `packages/mobile/src/lib/error-messages.ts` | messaggi IT codici `auth.google.*` | Modify |
| `packages/mobile/tests/lib/cognito-google-signin.test.ts` | unit decoder + orchestratore | Create |
| `packages/mobile/tests/auth/AuthContext.test.tsx` | metodo signInWithGoogle | Modify |
| `packages/mobile/tests/components/GoogleSignInButton.test.tsx` | bottone | Create |
| `packages/mobile/tests/screens/login.test.tsx` | Login + Google | Modify |
| `packages/mobile/tests/screens/signup.test.tsx` | Signup + Google | Modify |
| `packages/mobile/tests/lib/error-messages.test.ts` | nuovi codici | Modify |
| `docs/superpowers/runbooks/2026-06-21-google-signin-pr3-smoke.md` | runbook smoke device | Create |

---

## Task 1: Dipendenze OAuth + config Hosted UI

**Files:**
- Modify: `packages/mobile/package.json` (via `expo install`)
- Modify: `packages/mobile/.env.local`
- Modify: `packages/mobile/jest.config.js`

**Interfaces:**
- Produces: env var runtime `EXPO_PUBLIC_COGNITO_HOSTED_UI`; pacchetti `expo-auth-session`, `expo-web-browser` disponibili.

- [ ] **Step 1: Killare Metro se attivo, poi installare le dipendenze**

Killare eventuali processi Metro/node (lock `node_modules` su Windows), poi:

Run: `pnpm --filter @garageos/mobile exec expo install expo-auth-session expo-web-browser`
Expected: entrambi aggiunti a `dependencies` con i pin dell'SDK 52 (es. `expo-auth-session ~6.x`, `expo-web-browser ~14.x`).

- [ ] **Step 2: Aggiungere l'env var di runtime**

In `packages/mobile/.env.local` aggiungere la riga (valore = output CDK `CognitoClientiHostedUiDomain`, già live in prod):

```
EXPO_PUBLIC_COGNITO_HOSTED_UI=https://garageos-production-clienti.auth.eu-central-1.amazoncognito.com
```

- [ ] **Step 3: Aggiungere il default env per i test**

In `packages/mobile/jest.config.js`, dopo la riga 8 (insieme agli altri default EXPO_PUBLIC_*, PRIMA di `module.exports`):

```js
process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI ??= 'https://test-clienti.auth.eu-central-1.amazoncognito.com';
```

- [ ] **Step 4: Verificare che la suite resti verde**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: PASS (nessuna modifica al codice ancora).

Run: `pnpm --filter @garageos/mobile test`
Expected: PASS (suite invariata; le nuove deps non sono ancora importate).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/package.json packages/mobile/.env.local packages/mobile/jest.config.js pnpm-lock.yaml
git commit -m "chore(mobile): add expo-auth-session + hosted ui env for google sign-in"
```

> Nota PR description: giustificare le 2 nuove dipendenze (librerie Expo standard per OAuth/PKCE; non si reimplementa OAuth a mano).

---

## Task 2: `signInWithGoogle` + `decodeJwtPayload` in cognito.ts

**Files:**
- Modify: `packages/mobile/src/lib/cognito.ts`
- Modify: `packages/mobile/jest.setup.ts` (mock expo-web-browser + expo-auth-session)
- Test: `packages/mobile/tests/lib/cognito-google-signin.test.ts` (Create)

**Interfaces:**
- Consumes: tipo `SignInResult` esistente (`cognito.ts:25-31`); env `EXPO_PUBLIC_COGNITO_HOSTED_UI`, `EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID`.
- Produces:
  - `export function decodeJwtPayload(jwt: string): Record<string, unknown>` — decodifica base64url del payload (parte centrale) → oggetto; lancia su JWT malformato.
  - `export function signInWithGoogle(): Promise<SignInResult>` — apre il browser, scambia il code, ritorna `SignInResult`. Su annullamento utente lancia `Error` con `.code === 'auth.google.cancelled'`; su qualsiasi altro fallimento (scambio token, browser error) lancia `Error` con `.code === 'auth.google.exchange_failed'`.

**Contratto di `signInWithGoogle` (wiring OAuth — i dettagli esatti sono il punto, l'implementer verifichi le firme `expo-auth-session` reali):**

- `redirectUri = makeRedirectUri({ scheme: 'garageos', path: 'auth/callback' })` → deve produrre **esattamente** `garageos://auth/callback` (combacia col callback deployato; verificato in `infrastructure/lib/config/production.ts:78`).
- `discovery = { authorizationEndpoint: \`${hostedUi}/oauth2/authorize\`, tokenEndpoint: \`${hostedUi}/oauth2/token\` }` dove `hostedUi = process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI` (fail-fast se assente, come per pool/client a `cognito.ts:17-18`).
- `AuthRequest` con `clientId`, `redirectUri`, `responseType: Code`, `scopes: ['openid','email','profile']`, `usePKCE: true`, `extraParams: { identity_provider: 'Google' }`.
- `result = await request.promptAsync(discovery)`. Se `result.type !== 'success'` → lancia `auth.google.cancelled` (copre `cancel`/`dismiss`/`locked`).
- `tokenResult = await exchangeCodeAsync({ clientId, code: result.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier } }, discovery)`.
- `payload = decodeJwtPayload(tokenResult.idToken)`; `customerId = String(payload['custom:customer_id'] ?? '')`, `email = String(payload.email ?? '')`.
- Ritorna `{ idToken: tokenResult.idToken, accessToken: tokenResult.accessToken, refreshToken: tokenResult.refreshToken, customerId, email }`.
- Qualsiasi throw da promptAsync/exchange (eccetto il cancel già gestito) → ricondurre a `auth.google.exchange_failed`.
- A livello modulo: `WebBrowser.maybeCompleteAuthSession()` (necessario per chiudere il browser al ritorno del redirect).

- [ ] **Step 1: Mock expo-web-browser + expo-auth-session in jest.setup.ts**

`cognito.ts` importerà questi pacchetti al module-load; i test che importano il modulo reale (es. `cognito-forgot-password.test.ts`, e il nuovo test sotto) li caricheranno. Aggiungere in `packages/mobile/jest.setup.ts`:

```ts
// expo-web-browser: maybeCompleteAuthSession is a no-op in jest; the OAuth flow
// is exercised on-device (smoke). Namespace import → namespace mock.
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
}));

// expo-auth-session: default stubs so cognito.ts imports cleanly. Individual
// tests override AuthRequest/exchangeCodeAsync via the mocked fns below.
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(() => 'garageos://auth/callback'),
  exchangeCodeAsync: jest.fn(),
  ResponseType: { Code: 'code' },
  AuthRequest: jest.fn().mockImplementation(() => ({
    codeVerifier: 'test-verifier',
    promptAsync: jest.fn(),
  })),
}));
```

- [ ] **Step 2: Write the failing tests**

Create `packages/mobile/tests/lib/cognito-google-signin.test.ts`. Mirror `cognito-forgot-password.test.ts` per il mock di `amazon-cognito-identity-js` (richiesto perché `cognito.ts` lo importa al load). Casi:

```ts
// decodeJwtPayload — pure logic (node has global atob/Buffer)
it('decodeJwtPayload extracts claims from a JWT middle segment', () => {
  const payload = { 'custom:customer_id': 'cust-123', email: 'u@example.com' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const jwt = `header.${b64}.sig`;
  expect(decodeJwtPayload(jwt)).toMatchObject(payload);
});

it('decodeJwtPayload throws on malformed jwt', () => {
  expect(() => decodeJwtPayload('not-a-jwt')).toThrow();
});

// signInWithGoogle — success
it('returns a SignInResult on successful code exchange', async () => {
  const idTokenPayload = { 'custom:customer_id': 'cust-9', email: 'g@example.com' };
  const idToken = `h.${Buffer.from(JSON.stringify(idTokenPayload)).toString('base64url')}.s`;
  (AuthRequest as jest.Mock).mockImplementation(() => ({
    codeVerifier: 'v',
    promptAsync: jest.fn().mockResolvedValue({ type: 'success', params: { code: 'abc' } }),
  }));
  (exchangeCodeAsync as jest.Mock).mockResolvedValue({
    idToken, accessToken: 'acc', refreshToken: 'ref',
  });
  await expect(signInWithGoogle()).resolves.toEqual({
    idToken, accessToken: 'acc', refreshToken: 'ref',
    customerId: 'cust-9', email: 'g@example.com',
  });
});

// signInWithGoogle — user cancels
it('throws auth.google.cancelled when the user dismisses the browser', async () => {
  (AuthRequest as jest.Mock).mockImplementation(() => ({
    codeVerifier: 'v',
    promptAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
  }));
  await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth.google.cancelled' });
  expect(exchangeCodeAsync).not.toHaveBeenCalled();
});

// signInWithGoogle — exchange failure
it('throws auth.google.exchange_failed when token exchange rejects', async () => {
  (AuthRequest as jest.Mock).mockImplementation(() => ({
    codeVerifier: 'v',
    promptAsync: jest.fn().mockResolvedValue({ type: 'success', params: { code: 'abc' } }),
  }));
  (exchangeCodeAsync as jest.Mock).mockRejectedValue(new Error('network'));
  await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth.google.exchange_failed' });
});
```

Importare i simboli mockati da `expo-auth-session` in cima al test (`import { AuthRequest, exchangeCodeAsync } from 'expo-auth-session'`) e castarli a `jest.Mock`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @garageos/mobile test cognito-google-signin`
Expected: FAIL (`decodeJwtPayload`/`signInWithGoogle` non esportati).

- [ ] **Step 4: Implement in cognito.ts**

Aggiungere in cima al file gli import (dopo i polyfill esistenti):

```ts
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
```

`WebBrowser.maybeCompleteAuthSession()` a livello modulo. Implementare `decodeJwtPayload` (base64url → JSON, usando `atob` globale [Hermes su RN 0.76; Node nei test] con normalizzazione `-`→`+`, `_`→`/`) e `signInWithGoogle` secondo il contratto sopra. Header commenti in inglese.

> Nota decoder: in RN Hermes e in Node `atob` è globale. Implementare:
> ```ts
> export function decodeJwtPayload(jwt: string): Record<string, unknown> {
>   const seg = jwt.split('.')[1];
>   if (!seg) throw new Error('malformed jwt');
>   const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
>   return JSON.parse(decodeURIComponent(escape(atob(b64)))) as Record<string, unknown>;
> }
> ```
> (le email/UUID sono ASCII; `escape`/`unescape` round-trip è il decoder UTF-8 minimale senza Buffer su device.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test cognito-google-signin`
Expected: PASS (4 test).

Run: `pnpm --filter @garageos/mobile test cognito-forgot-password`
Expected: PASS (regressione: il modulo carica ancora con i nuovi import mockati).

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/lib/cognito.ts packages/mobile/jest.setup.ts packages/mobile/tests/lib/cognito-google-signin.test.ts
git commit -m "feat(mobile): add google oauth code+pkce flow in cognito lib"
```

---

## Task 3: `signInWithGoogle` in AuthContext

**Files:**
- Modify: `packages/mobile/src/auth/AuthContext.tsx`
- Test: `packages/mobile/tests/auth/AuthContext.test.tsx` (Modify)

**Interfaces:**
- Consumes: `signInWithGoogle` da `@/lib/cognito` (Task 2).
- Produces: `AuthContextValue.signInWithGoogle: () => Promise<void>` — invoca il flusso Google e persiste i token **identico** a `signIn` (stesso `writeTokens` + `tokensRef` + `setStatus('authenticated')`).

- [ ] **Step 1: Write the failing test**

In `tests/auth/AuthContext.test.tsx`, aggiungere un test che mocka `cognito.signInWithGoogle` per risolvere uno `SignInResult`, invoca il metodo dal context e asserisce che `writeTokens` è chiamato con il payload corretto e `status` diventa `authenticated`. Mirror del test esistente per `signIn`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test AuthContext`
Expected: FAIL (`signInWithGoogle` non sul context).

- [ ] **Step 3: Implement**

In `AuthContext.tsx`: importare `signInWithGoogle` da `@/lib/cognito`; aggiungere un `useCallback` che ricalca `signIn` (righe 64-81) ma chiama `signInWithGoogle()` invece di `signInSrp(email,password)`. Estrarre la duplicazione di persistenza in un helper interno `applySignInResult(result)` (DRY: usato da `signIn`, `signInWithGoogle`, e idealmente `refresh`). Aggiungere `signInWithGoogle` al tipo `AuthContextValue` e al `value` memoizzato (+ dependency array).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test AuthContext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/auth/AuthContext.tsx packages/mobile/tests/auth/AuthContext.test.tsx
git commit -m "feat(mobile): expose signInWithGoogle on auth context"
```

---

## Task 4: GoogleSignInButton + wiring Login + messaggi errore

**Files:**
- Create: `packages/mobile/src/components/auth/GoogleSignInButton.tsx`
- Modify: `packages/mobile/app/login.tsx`
- Modify: `packages/mobile/src/lib/error-messages.ts`
- Test: `packages/mobile/tests/components/GoogleSignInButton.test.tsx` (Create)
- Test: `packages/mobile/tests/screens/login.test.tsx` (Modify)
- Test: `packages/mobile/tests/lib/error-messages.test.ts` (Modify)

**Interfaces:**
- Produces: `GoogleSignInButton({ label, onPress, loading, disabled }: { label: string; onPress: () => void; loading?: boolean; disabled?: boolean })` — Pressable presentazionale, `accessibilityRole="button"`, mostra `ActivityIndicator` quando `loading`. Nessuna logica OAuth dentro.

**Messaggi errore (IT) da aggiungere a `error-messages.ts`:**

```
'auth.google.exchange_failed': 'Accesso con Google non riuscito. Riprova.',
```

(`auth.google.cancelled` NON va in mappa: l'annullamento è silenzioso, gestito nello screen senza banner.)

- [ ] **Step 1: Write failing tests (component + login screen)**

`GoogleSignInButton.test.tsx`: (a) rende la label passata; (b) `onPress` chiamato al press; (c) quando `loading`, mostra lo spinner e `onPress` non scatta (disabled).

In `login.test.tsx` aggiungere:
- bottone "Accedi con Google" presente;
- press → chiama `cognito.signInWithGoogle` (mockato via `jest.mock('@/lib/cognito')` già presente) e su success `replace('/(tabs)')` (e `?claimCode` → `/claim-vehicle?code=...`, riusando la stessa logica di nav del submit password);
- su reject con `code: 'auth.google.exchange_failed'` → banner "Accesso con Google non riuscito. Riprova.";
- su reject con `code: 'auth.google.cancelled'` → **nessun** banner.

`error-messages.test.ts`: `mapErrorToUserMessage('auth.google.exchange_failed')` → stringa IT attesa.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/mobile test GoogleSignInButton login error-messages`
Expected: FAIL (componente/bottone/messaggio assenti).

- [ ] **Step 3: Implement**

Creare `GoogleSignInButton.tsx` (presentazionale, stile coerente con i Pressable esistenti in `login.tsx`; bordo/sfondo neutro per distinguerlo dal submit primario; testo "Accedi con Google" passato come prop). Niente logo Google bitmap (YAGNI per pilot; eventuale icona `@expo/vector-icons` opzionale).

In `login.tsx`: aggiungere stato `googleSubmitting`, un divider "oppure", e `<GoogleSignInButton label="Accedi con Google" loading={googleSubmitting} disabled={submitting} onPress={handleGoogle} />`. `handleGoogle`:
```ts
async function handleGoogle() {
  if (googleSubmitting || submitting) return;
  setError(null);
  setGoogleSubmitting(true);
  try {
    await signInWithGoogle();
    router.replace(params.claimCode ? `/claim-vehicle?code=${params.claimCode}` : '/(tabs)');
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== 'auth.google.cancelled') setError(mapErrorToUserMessage(code));
  } finally {
    setGoogleSubmitting(false);
  }
}
```
Aggiungere `signInWithGoogle` alla destrutturazione di `useAuth()`. Aggiungere il messaggio IT a `error-messages.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test GoogleSignInButton login error-messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components/auth/GoogleSignInButton.tsx packages/mobile/app/login.tsx packages/mobile/src/lib/error-messages.ts packages/mobile/tests/components/GoogleSignInButton.test.tsx packages/mobile/tests/screens/login.test.tsx packages/mobile/tests/lib/error-messages.test.ts
git commit -m "feat(mobile): add google sign-in button on login screen"
```

---

## Task 5: Wiring Google su Signup

**Files:**
- Modify: `packages/mobile/app/signup.tsx`
- Test: `packages/mobile/tests/screens/signup.test.tsx` (Modify)

**Interfaces:**
- Consumes: `GoogleSignInButton` (Task 4), `signInWithGoogle` da `useAuth` (Task 3).

- [ ] **Step 1: Write the failing test**

In `signup.test.tsx`: bottone "Registrati con Google" presente; press → chiama `signInWithGoogle` (mockare `@/lib/cognito` o `useAuth`); su success → `router.replace('/(tabs)')` (utente Google = email già verificata, **niente** schermata verify-email, vedi spec §Mobile); su reject `auth.google.exchange_failed` → la schermata gestisce l'errore (banner o stato; mirror minimale di login, niente test di rendering puro).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test screens/signup`
Expected: FAIL (bottone assente).

- [ ] **Step 3: Implement**

In `signup.tsx`: aggiungere sotto `<SignupForm>` (dentro lo ScrollView) un divider "oppure" + `<GoogleSignInButton label="Registrati con Google" loading={googleSubmitting} onPress={handleGoogle} />` con stato/handler analoghi a Task 4 ma success → `router.replace('/(tabs)')`. Aggiungere uno stato d'errore minimale (es. `Alert` o banner riusando lo stile) per `auth.google.exchange_failed`; annullamento silenzioso.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test screens/signup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/signup.tsx packages/mobile/tests/screens/signup.test.tsx
git commit -m "feat(mobile): add google sign-up button on signup screen"
```

---

## Task 6: Runbook smoke device + suite completa

**Files:**
- Create: `docs/superpowers/runbooks/2026-06-21-google-signin-pr3-smoke.md`

- [ ] **Step 1: Scrivere il runbook smoke**

Contenuto: build dev client (`pnpm --filter @garageos/mobile android` + `adb reverse tcp:8081`, device Xiaomi `CI659HAE8LSW6H5L`, **NON Expo Go**); casi:
1. **Nuovo utente Google** (email mai vista) → crea `customers`, atterra su `/(tabs)`, vede stato vuoto.
2. **Utente Google esistente** → ri-login, stesso profilo/veicoli.
3. **Merge** — email già registrata con password → "Accedi con Google" → stesso account/profilo (verifica account linking PreSignUp).
4. **Refresh sessione Google** — lasciare scadere/forzare un refresh (chiamata API dopo >1h o invalidare idToken) → `refreshSession` SDK rinnova senza ri-login. ⚠️ punto critico (Deviation 3): se fallisce, annotare e applicare il fallback `/oauth2/token`.
5. **Annullamento** — chiudere il browser → nessun crash, nessun banner.
6. **Login password invariato** — regressione: email/password native funzionano ancora.

- [ ] **Step 2: Suite mobile completa + typecheck**

Run: `pnpm --filter @garageos/mobile test`
Expected: PASS (intera suite).

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/runbooks/2026-06-21-google-signin-pr3-smoke.md
git commit -m "docs(mobile): add google sign-in pr3 smoke runbook"
```

---

## Review gates (in order)

1. Per-task review opzionale solo su Task 2 (nuovo wiring OAuth/PKCE — superficie più rischiosa).
2. `pnpm -r typecheck` (pre-push hook) — unico gate locale obbligatorio.
3. **Final whole-branch `/code-review high`** — load-bearing, mai saltare. Cross-check: parità `SignInResult`, refresh reuse, nessuna PII/token leak nei log, gestione cancel/error.
4. CI full matrix (`gh pr checks --watch`).
5. **Smoke runbook su dev build reale = BLOCKER** (Task 6) — nessun review stage lo sostituisce.

## Post-merge

- Aggiornare `project_resume_checkpoint.md`: arco "ACCEDI CON GOOGLE" completo lato codice (PR1+PR2+PR3); resta lo smoke device come blocker di chiusura arco se non già fatto.
- Promemoria operativo invariato: rotazione `client_secret` Google consigliata (non bloccante).

## Self-review (compilata in fase di plan)

- **Spec coverage:** §Mobile → Task 2-5; deep link/scheme → già in `app.config.js` (verificato, nessuna modifica); "niente verify-email per Google" → Task 5 (success → /(tabs)); deps da giustificare → Task 1 nota PR; testing two-tier → Task 2 (unit decoder) + Task 4/5 (Tier 2 screen); smoke → Task 6. ✓
- **Placeholder scan:** nessun TBD/TODO; codice mostrato dove serve. ✓
- **Type consistency:** `SignInResult` (5 campi) usato identico in cognito/AuthContext/test; `signInWithGoogle(): Promise<SignInResult>` (lib) vs `signInWithGoogle(): Promise<void>` (context) — distinzione intenzionale e documentata negli Interfaces. Codici errore `auth.google.cancelled`/`auth.google.exchange_failed` coerenti fra Task 2/4/5. ✓
- **Pre-flight:** nessuna operazione Prisma/RLS/migration/BR/infra (consumer-only). Cognito IAM già grant in PR2. Commit summary tutti ≤72 char. ✓

# F-CLI-002 — Mobile password recovery (design)

**Date:** 2026-05-16
**Feature:** F-CLI-002 — sub-feature *recupero password* (login/logout già esistenti, biometric login deferred)
**Spec parent:** `docs/GarageOS-Specifiche.md:502`
**Target:** `packages/mobile/` (Expo SDK 52, RN 0.76.9)
**Estimated size:** 600-800 LOC across ~10 files

## 1. Scope

### In-scope

- Schermata `/forgot-password` (email → invio codice)
- Schermata `/reset-password` (codice + nuova password + conferma)
- Wiring del link "Hai dimenticato la password?" su `app/login.tsx` (oggi placeholder Alert "Disponibile a breve")
- Cooldown 60s su "Invia di nuovo il codice" (riusa pattern `verify-email-sent.tsx` PR #106)
- Estensione `lib/cognito.ts` con `forgotPasswordRequest()` + `confirmForgotPassword()`
- Estensione `lib/error-messages.ts` con codici Cognito-specifici
- Validator puri JS per i due form
- Unit test su validators, wrapper Cognito, presentational components

### Out-of-scope (deferred)

- Biometric login (parte di F-CLI-002 ma SHOULD, sliceabile separatamente — vedi `docs/GarageOS-Specifiche.md:1449`)
- Logout flow (già esiste via `signOut` in AuthContext)
- Login MFA challenge (non in scope F-CLI-002 v1)
- API endpoint backend Fastify (non necessario — Cognito SDK fa tutto client-side)
- Email template customization Cognito (usa template default Cognito su brand SES già verificato per signup)
- Web forgot-password (è una slice mobile-only)
- Detox / e2e integration test (smoke operator runbook post-merge mirror PR #106)

## 2. Architecture

### 2.1 User flow

```
[Login screen]
  └─ tap "Hai dimenticato la password?"
       → router.push('/forgot-password')

[/forgot-password]
  ├─ campo email
  ├─ submit → forgotPasswordRequest(email)
  │    ├─ ok                       → router.push('/reset-password?email=<email>')
  │    ├─ UserNotFoundException    → trattato come ok (anti-enumeration)
  │    └─ altri errori             → mapped banner
  └─ link "Torna al login" → router.back()

[/reset-password?email=X]
  ├─ campo code (6 cifre Cognito)
  ├─ campo password (nuova)
  ├─ campo confirmPassword
  ├─ submit → confirmForgotPassword(email, code, newPassword)
  │    ├─ ok            → router.replace('/login') + feedback "Password aggiornata"
  │    └─ err           → mapped banner (code/expired/policy/limit)
  ├─ pulsante "Invia di nuovo il codice" (cooldown 60s)
  │    → forgotPasswordRequest(email) resend
  └─ link "Torna al login"
```

### 2.2 Anti-enumeration (security)

Cognito `forgotPassword` ritorna `UserNotFoundException` per email non registrate. Mappare questo errore come "email non trovata" leaka quali email esistano nel pool clienti. **Decisione:** silenziamo questo specifico errore e procediamo a `/reset-password` come se l'invio fosse avvenuto. L'utente che ha digitato l'email sbagliata vedrà il form di reset, tenterà un codice che non arriverà mai, e quel tentativo fallirà come `CodeMismatchException`. Cognito built-in rate-limit (5 request/5min default) protegge da brute force.

Pattern OWASP standard per password recovery — usato anche su signup F-CLI-001 (`auth.signup.email_already_active` ritorna 200-like alla resend-verification).

### 2.3 Deep-link guard

Se l'utente arriva direttamente a `/reset-password` senza query `email` (deep-link manuale o ricarica), mostriamo un campo email **editabile in più** (con stesso validator email). Quando email arriva via query param da `/forgot-password`, il campo viene nascosto.

Implementazione: `useLocalSearchParams<{ email?: string }>()` — se assente, render conditional di un email input prima del code input.

### 2.4 Why client-side Cognito (no backend endpoint)

- `CognitoUser.forgotPassword()` chiama direttamente Cognito Identity Provider API
- `CognitoUser.confirmPassword(code, newPassword)` idem
- Nessun coordinamento con DB (i tokens vengono ri-generati al prossimo login)
- Niente IAM Lambda da estendere — diversamente da signup F-CLI-001 che ha richiesto `AdminCreateUser`, `AdminSetUserPassword`, `AdminDeleteUser`, `AdminAddUserToGroup`, qui usiamo solo le API user-self-service che non richiedono credenziali admin
- Cognito gestisce: invio email tramite SES configurato sul pool, scadenza codice (24h default), rate limit, validazione password policy

## 3. Files

### 3.1 New files (11 — 6 source + 5 test)

| Path | Role |
|---|---|
| `packages/mobile/app/forgot-password.tsx` | Screen orchestrator: state, call cognito wrapper, navigate next |
| `packages/mobile/app/reset-password.tsx` | Screen orchestrator: state, call cognito wrapper, success redirect |
| `packages/mobile/src/components/auth/ForgotPasswordForm.tsx` | Presentational form: email input, validation, onSubmit prop |
| `packages/mobile/src/components/auth/ResetPasswordForm.tsx` | Presentational form: code+password+confirm inputs, validation, onSubmit prop, optional email input |
| `packages/mobile/src/lib/validators/forgotPassword.ts` | Pure validator: email |
| `packages/mobile/src/lib/validators/resetPassword.ts` | Pure validator: code (6 digits) + password (policy mirror) + confirm match |
| `packages/mobile/tests/components/ForgotPasswordForm.test.tsx` | Component test: render + validation + onSubmit happy/error |
| `packages/mobile/tests/components/ResetPasswordForm.test.tsx` | Component test: render + validation + onSubmit happy/error |
| `packages/mobile/tests/lib/validators/forgotPassword.test.ts` | Validator unit test |
| `packages/mobile/tests/lib/validators/resetPassword.test.ts` | Validator unit test |
| `packages/mobile/tests/lib/cognito-forgot-password.test.ts` | Mock CognitoUser.forgotPassword + confirmPassword, verify wrapper Promise mapping |

### 3.2 Edited files (3)

| Path | Change |
|---|---|
| `packages/mobile/src/lib/cognito.ts` | Add `forgotPasswordRequest(email)` + `confirmForgotPassword(email, code, newPassword)` exports |
| `packages/mobile/src/lib/error-messages.ts` | Add 6 Cognito codes (`CodeMismatchException`, `ExpiredCodeException`, `CodeDeliveryFailureException`, `InvalidPasswordException` in this context, `NotAuthorizedException` in reset context) — `UserNotFoundException` resta non-mappato silenziato |
| `packages/mobile/app/login.tsx` | Replace `Alert.alert('Disponibile a breve')` con `router.push('/forgot-password')` (linee 114-120) |

## 4. Component interfaces

### 4.1 `lib/cognito.ts` additions

```ts
export type ForgotPasswordResult =
  | { ok: true; deliveryMedium: 'EMAIL' | 'SMS' | 'UNKNOWN' }
  | { ok: false; code: string };

export function forgotPasswordRequest(email: string): Promise<ForgotPasswordResult>;
// Notes:
//   - Wraps CognitoUser.forgotPassword({ onSuccess, onFailure, inputVerificationCode })
//   - Resolves ok:true on success OR on UserNotFoundException (anti-enumeration)
//   - Resolves ok:false with code = err.code or err.name otherwise

export type ConfirmForgotPasswordResult = { ok: true } | { ok: false; code: string };

export function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<ConfirmForgotPasswordResult>;
// Notes:
//   - Wraps CognitoUser.confirmPassword(code, newPassword, { onSuccess, onFailure })
//   - Resolves ok:true on success
//   - Resolves ok:false with err.code (CodeMismatchException, ExpiredCodeException, InvalidPasswordException, LimitExceededException, NotAuthorizedException)
```

Both wrappers return discriminated unions — mirror del pattern signup `queries/signup.ts` introdotto in PR #103/#106. Coerente con la memoria `feedback_hook_return_result_not_state.md`.

### 4.2 Presentational components

```ts
// ForgotPasswordForm.tsx
type Props = {
  onSubmit: (email: string) => Promise<{ ok: true } | { ok: false; code: string; message?: string }>;
  onNavigateBack: () => void;
};

// ResetPasswordForm.tsx
type Props = {
  initialEmail: string | null;  // from useLocalSearchParams; if null → email field shown
  onSubmit: (payload: { email: string; code: string; newPassword: string }) =>
    Promise<{ ok: true } | { ok: false; code: string; message?: string }>;
  onResend: (email: string) =>
    Promise<{ ok: true } | { ok: false; code: string; message?: string }>;
  onNavigateBack: () => void;
};
```

Mirror del pattern `SignupForm.tsx`: form prende `onSubmit` callback, gestisce state locale + validation + banner, parent screen orchestra navigation + API call.

### 4.3 Validators

```ts
// forgotPassword.ts
export type ForgotPasswordInput = { email: string };
export type ForgotPasswordErrors = Partial<Record<keyof ForgotPasswordInput, string>>;
export function validateForgotPassword(input: ForgotPasswordInput): ForgotPasswordErrors;

// resetPassword.ts
export type ResetPasswordInput = {
  email: string;        // can be empty when initialEmail provided + field hidden
  code: string;
  password: string;
  confirmPassword: string;
};
export type ResetPasswordErrors = Partial<Record<keyof ResetPasswordInput, string>>;
export function validateResetPassword(input: ResetPasswordInput): ResetPasswordErrors;
```

Policy password mirror Cognito clienti pool (`infrastructure/lib/constructs/cognito.ts:86-91`):
- minLength 8
- requireLowercase
- requireDigits

Code format: `/^\d{6}$/` — Cognito invia sempre 6 cifre numeriche per email delivery.

## 5. Error mapping additions

`lib/error-messages.ts` — nuove voci nel record `MESSAGES`:

```ts
// Cognito forgot-password / reset-password
CodeMismatchException: "Codice non valido. Controlla l'email e riprova.",
ExpiredCodeException: 'Il codice è scaduto. Richiedi un nuovo codice.',
InvalidPasswordException: 'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
CodeDeliveryFailureException: "Errore nell'invio del codice. Riprova tra qualche minuto.",
// LimitExceededException già presente
// UserNotFoundException già presente — silenziato a livello wrapper, qui non viene chiamato
```

Nota: `InvalidPasswordException` è già nel record (mapped a "Email o password non corretti" per login context). Necessitiamo gestione contestuale: nel reset-password context il significato è policy violation, nel login context è credenziali errate. **Soluzione:** non sovrascriviamo il mapping globale; in `app/reset-password.tsx` quando il code result.code === 'InvalidPasswordException' usiamo un override locale (analogo al pattern `auth.signup.password_policy_violation` in `SignupForm.tsx:58-61` che mappa l'errore inline sotto al campo).

## 6. Test plan

### 6.1 Unit tests (matrici)

**`validators/forgotPassword.test.ts`** (~5 cases):
- empty email → error 'Email obbligatoria'
- invalid format `'foo'` → error 'Email non valida'
- valid format `'a@b.c'` → no error
- whitespace trim (validator NON trimma, screen sì — mirror signup): leading/trailing spazio testato dal componente

**`validators/resetPassword.test.ts`** (~10 cases):
- code: empty, 5 digits, 7 digits, alpha-numeric, valid 6 digits
- password: empty, < 8 chars, no lowercase, no digit, valid
- confirmPassword: empty, mismatch, match
- email (quando present): empty, invalid format, valid

**`lib/cognito-forgot-password.test.ts`** (~6 cases):
- `forgotPasswordRequest` happy → ok:true with `deliveryMedium: 'EMAIL'`
- `forgotPasswordRequest` UserNotFoundException → ok:true (anti-enumeration)
- `forgotPasswordRequest` LimitExceededException → ok:false code='LimitExceededException'
- `confirmForgotPassword` happy → ok:true
- `confirmForgotPassword` CodeMismatchException → ok:false code='CodeMismatchException'
- `confirmForgotPassword` ExpiredCodeException → ok:false code='ExpiredCodeException'

Mock approach: jest module-mock `amazon-cognito-identity-js` per intercettare `CognitoUser.prototype.forgotPassword` + `confirmPassword` (mirror del pattern login test approach se esistente, altrimenti pattern signup test).

### 6.2 Component tests

**`ForgotPasswordForm.test.tsx`** (~5 cases):
- render heading + email input + submit button
- empty submit → inline error 'Email obbligatoria'
- invalid email submit → inline error 'Email non valida'
- valid email + onSubmit ok → no banner, submit happens
- valid email + onSubmit ok:false LimitExceededException → banner mapped message

**`ResetPasswordForm.test.tsx`** (~7 cases):
- render heading + code/password/confirm inputs + (no email input when initialEmail provided)
- email input visible when initialEmail null
- empty submit → inline errors on tutti i campi
- mismatch confirm → inline error 'Le password non coincidono'
- valid submit + onSubmit ok → no banner
- valid submit + onSubmit ok:false CodeMismatchException → banner "Codice non valido..."
- valid submit + onSubmit ok:false InvalidPasswordException → inline error sotto password field (NON banner)
- resend button cooldown disabled state

### 6.3 No integration test e2e

Coerente con strategia mobile post-#106: smoke operator runbook post-merge invece di Detox in pipeline. Vedi memoria `project_resume_checkpoint` per pattern smoke runbook signup.

### 6.4 Smoke runbook operator post-merge

1. Setup: Expo Go iOS sandbox via USB sideload (vedi memoria `feedback_expo_go_sideload_usb_smoke`)
2. Login screen → tap "Hai dimenticato la password?" → verify navigate `/forgot-password`
3. Insert email `b2c-test@demo-giuseppe.test` (utente test pool clienti) → tap "Invia codice"
4. Verify navigate `/reset-password?email=…`
5. Apri Gmail matulamichele@gmail.com → verify codice 6 cifre Cognito arrivato
6. Insert code + nuova password "TestB2C2026!" + confirm → tap "Reimposta"
7. Verify redirect `/login` + feedback "Password aggiornata"
8. Login con nuova password → verify accesso ok
9. Negative path A: codice sbagliato → verify banner "Codice non valido..."
10. Negative path B: email inesistente `not-found@example.com` → verify anyway redirect a `/reset-password` (anti-enumeration check)
11. Negative path C: insert code valido di un'altra request poi richiesta nuovo codice → verify primo codice marcato ExpiredCodeException → banner "Il codice è scaduto..."

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cognito email delivery in spam/junk | Medium | SES brand già verificato per signup (PR #100/#106). Smoke check Gmail principale + spam folder. |
| `amazon-cognito-identity-js` bridgeless SRP gotcha (vedi memoria `feedback_cognito_srp_expo_go_bridgeless`) | Low — già risolto per signup | `crypto-polyfill.ts` già caricato in `_layout.tsx:3` e in `cognito.ts:4`. Forgot password riusa stesso CognitoUserPool singleton, stesso SDK path. |
| Local jest fail per React dual instance | Low — già risolto PR #109 | `'^react$'` moduleNameMapper attivo. |
| Test mock di `CognitoUser` class instances | Medium | Pattern jest module-mock già usato in altri test mobile. Documentare in helper se diventa boilerplate. |
| Anti-enumeration UX confusion (utente reali email-typo non riceve codice) | Low | Documentazione user-facing: helper text sotto code input "Non hai ricevuto il codice? Controlla la spam o richiedi un nuovo invio." |

## 8. References

- Spec parent: `docs/GarageOS-Specifiche.md:502` (F-CLI-002)
- Auth flow infra: `docs/APPENDICE_C_INFRASTRUCTURE.md` §Cognito (CDK clienti pool)
- BR rules: nessuna BR specifica DB-side (operazione tutta su Cognito Identity Provider — non tocca `users` table)
- Companion plan: `docs/superpowers/plans/2026-05-16-f-cli-002-mobile-password-recovery.md` (creato post-spec-review nel prossimo step)
- Related memories: `feedback_cognito_srp_expo_go_bridgeless`, `feedback_local_env_blocks_test_validation`, `feedback_hook_return_result_not_state`, `project_resume_checkpoint`

## 9. Open questions

Nessuna — design pronto per writing-plans.

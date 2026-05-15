# Design — Mobile signup UI (F-CLI-001)

**Spec date:** 2026-05-15
**Author:** Michele Matula (with Claude Code)
**Feature reference:** GarageOS-Specifiche §3.3.1 F-CLI-001 (Registrazione utente), APPENDICE_A §3.1 `/v1/auth/signup`
**Business rules:** BR-220, BR-221, BR-224, BR-225, BR-226 (server-side, già coperte da PR #55+#57)
**Backend dependency:** `/v1/auth/signup` LIVE (PR #55) + `/v1/auth/resend-verification` LIVE (PR #57) + Lambda IAM `AdminSetUserPassword`+`AdminDeleteUser` LIVE (PR #101)
**Estimated scope:** ~750-900 LOC (single PR)
**Slice:** vertical slice "Mobile signup UI" — finisce F-CLI-001 client-side, sblocca onboarding cliente B2C reale

---

## 1. Goal

Aggiungere al pacchetto `packages/mobile/` (Expo SDK 52, scaffold live da PR #100) la UI di registrazione cliente che consuma `POST /v1/auth/signup`, autentica automaticamente l'utente via Cognito SRP post-signup, e mostra una schermata informativa di verifica email.

Login già live (PR #100). Manca: la screen `/signup`, il wrapper API pubblico (no bearer), la schermata `/verify-email-sent` con resend, il link "Registrati" da login attualmente stubbato `Alert.alert('Disponibile a breve')`.

## 2. Non-goals

- **Deep-link `garageos://verify-email?token=...`**: il link nell'email punta a `https://app.garageos.aifollyadvisor.com/verify-email?token=...` (web app, già live da PR #57). Il cliente clicca dall'inbox → si apre il browser → la verifica avviene web-side. Mobile non gestisce deep-link in v1.
- **Social login (Google/Apple)** — F-CLI-001 lo menziona come futuro, fuori scope.
- **Biometric login (FaceID/TouchID)** — F-CLI-002 in slice successivo.
- **Onboarding wizard post-signup** — F-CLI-003 SHOULD, slice separato (tutorial come aggiungere veicolo, codice GarageOS, privacy).
- **Foto profilo / phone number** — F-CLI-004 profile edit (slice futuro). Signup body è minimal: email, password, firstName, lastName.
- **Backend changes**: zero. Tutti gli endpoint, le BR, le policy IAM e i flussi server sono già in main.

## 3. Architectural decisions

### 3.1 Pubblico (no bearer) via fetch diretto (Option A)

Il wrapper `signupCustomer` e `resendVerification` chiamano `fetch` direttamente, senza passare per `apiClient` (che inietta sempre `Bearer` da `getIdToken` e su 401 fa refresh+retry). Il signup è un endpoint pubblico, l'utente è `unauthenticated` quando lo chiama. Pattern mirror `queries/changePassword.ts` (PR #105): wrapper puro, ritorna `{ok:true}|{ok:false,code,message}` discriminated.

L'alternativa (estendere `apiClient` con flag `skipAuth`) è stata scartata: il wrapper pubblico è ~30 LOC, l'estensione del client + relativi test costerebbe il doppio per zero riuso futuro (gli altri endpoint pubblici — verify-email, resend-verification — sono già o gestiti dal web o saranno pure wrapper).

### 3.2 Auto-login post-signup (Option α)

Su `201 Created`, il client chiama immediatamente `AuthContext.signIn(email, password)` (SRP via amazon-cognito-identity-js, già live). Razionali:

- Riusa la flow di login esistente, niente nuovo codice di token handling.
- UX standard B2C consumer (Stripe, Vercel, Linear) — riduce drop-off del "ti sei registrato, ora accedi" double prompt.
- I tokens non transitano API logs (audit clean).
- Pattern allineato con web (PR #92 customer signup → auto-login).

Se `signIn` fallisce (edge case: Cognito eventual consistency tra `AdminSetUserPassword` e `InitiateAuth`, o policy violation che lo Zod client-side non ha intercettato), fallback: `router.replace('/login')` con toast `"Registrazione completata. Effettua il login."`.

### 3.3 Verify-email non gating (Option β)

`Customer.email_verified` lato Cognito parte a `false` e viene aggiornato dal web `/verify-email` post-click. **Cognito NON blocca login con `email_verified=false`** — la policy `MFA OFF + email_verified ignored` è quella del clienti pool. Quindi l'utente, post auto-login, ha sessione valida e può navigare `/(tabs)`.

La schermata `/verify-email-sent` è puramente informativa:
- Spiega che è stata inviata una email con un link di verifica.
- Espone un pulsante "Invia di nuovo" (chiama `POST /v1/auth/resend-verification`, con cooldown 60s lato client per evitare abuse e dare feedback).
- Espone un pulsante "Continua" → `router.replace('/(tabs)')`.

Coerente con feedback `feedback_compute_composite_br_predicates_server_side.md`: nessuna logica composta lato client — verify status si vede dal claim Cognito nel JWT (fuori scope qui, badge in `/(tabs)/profile` sarà slice F-CLI-004).

### 3.4 Stack navigation + reset history (Option I)

- Da `/login` → `router.push('/signup')` (back button torna a login).
- Da `/signup` → success → `signIn()` → `router.replace('/verify-email-sent')` (cancella `/signup` + `/login` dalla history).
- Da `/verify-email-sent` → "Continua" → `router.replace('/(tabs)')` (cancella `/verify-email-sent` dalla history; back button da `/(tabs)` non torna alla verify screen).

La verify screen è una **route normale Expo Router**, non `presentation: 'modal'`, perché è un full-screen permanente fino a "Continua" (modal stile sheet/swipe-down non è desiderato — l'utente non deve poterla dismissare con gesture casuale).

### 3.5 Validazione client mirror Cognito clienti pool

Zod schema enforce:
- email: format + max 255 + trim + lowercase
- password: min 8, lowercase, digit (mirror Cognito policy `infrastructure/lib/constructs/cognito.ts:86-91`)
- confirmPassword: cross-field `===` password
- firstName, lastName: trim + min 1 + max 100

Helper text statico sempre visibile sotto il campo password ("Almeno 8 caratteri, una lettera minuscola, un numero") per ridurre cycle errore → fix → resubmit.

Mismatch tra Zod e Cognito (es. utente inserisce 8 char con sola maiuscola, supera client, fallisce server) → handler 422 `auth.signup.password_policy_violation` → inline error sotto password con messaggio da `error-messages.ts`.

## 4. Endpoint contract (consumer)

### 4.1 POST /v1/auth/signup

```
POST /v1/auth/signup
Content-Type: application/json
(no Authorization header)

{
  "type": "customer",
  "email": "mario.rossi@example.com",
  "password": "miapassword1",
  "firstName": "Mario",
  "lastName": "Rossi"
}
```

**Responses gestite client:**

| Status | error_code | Trattamento client |
|--------|------------|--------------------|
| 201 | — | `{ok:true, customer:{id,email,firstName,lastName,status,createdAt}}` → auto-login |
| 409 | `auth.signup.email_already_active` | Banner "Email già registrata, accedi" + link a `/login` |
| 422 | `auth.signup.password_policy_violation` | Inline error sotto password |
| 422 | `auth.signup.tenant_signup_not_supported` | Banner generico (non dovrebbe accadere: client invia sempre `type:'customer'`) |
| 429 | `auth.signup.rate_limited` | Banner "Troppi tentativi, riprova tra Xs" (retryAfter dal body se presente) |
| 502 | `auth.signup.cognito_unavailable` | Banner errore + "Riprova" |
| 0 (network) | `network.unreachable` | Banner "Connessione assente" |

### 4.2 POST /v1/auth/resend-verification

```
POST /v1/auth/resend-verification
Content-Type: application/json

{ "email": "mario.rossi@example.com" }
```

**Responses gestite:**

| Status | Trattamento client |
|--------|--------------------|
| 200 | Toast "Email inviata", avvia cooldown 60s del pulsante |
| 429 | `auth.resend_verification.rate_limited` | Toast errore con retryAfter |
| 0 (network) | Toast "Connessione assente" |

L'endpoint è anti-enum (200 anche se email non esiste) — il client non distingue.

## 5. Module map

### 5.1 New files

| File | Purpose |
|------|---------|
| `packages/mobile/src/lib/validators/signup.ts` | Zod schema signup form + `signupSchema.parse(input)` |
| `packages/mobile/src/queries/signup.ts` | `signupCustomer(input)` + `resendVerification(email)` + `useSignup()` + `useResendVerification()` hooks |
| `packages/mobile/src/components/auth/SignupForm.tsx` | RHF + Zod form, 5 campi (email, password, confirmPassword, firstName, lastName), inline errors, helper text password, error banner |
| `packages/mobile/app/signup.tsx` | Screen route, layout identico a `login.tsx`, monta `SignupForm`, gestisce success → `AuthContext.signIn()` + `router.replace('/verify-email-sent')` |
| `packages/mobile/app/verify-email-sent.tsx` | Screen informativa post-signup: brand, testo "Abbiamo inviato un link a <email>", pulsante "Invia di nuovo" (cooldown), pulsante "Continua" → `/(tabs)` |
| `packages/mobile/tests/lib/validators/signup.test.ts` | Unit Zod, 8 cases |
| `packages/mobile/tests/queries/signup.test.ts` | Unit wrapper, 6 cases (201/409/422/429/502/network) |
| `packages/mobile/tests/components/SignupForm.test.tsx` | Unit form, render + submit + 4 error branches + helper text |
| `packages/mobile/tests/screens/signup.test.tsx` | Screen test render + mock submit + redirect + retry |
| `packages/mobile/tests/screens/verify-email-sent.test.tsx` | Screen test render + resend + cooldown + continue |

### 5.2 Modified files

| File | Change |
|------|--------|
| `packages/mobile/app/login.tsx` | Sostituire `Alert.alert('Disponibile a breve')` su "Non hai un account? Registrati" con `router.push('/signup')`. Lo stub `'Hai dimenticato la password?'` resta (slice F-CLI-002 successivo). |
| `packages/mobile/src/lib/error-messages.ts` | Aggiungere 6 codici: `auth.signup.email_already_active`, `auth.signup.password_policy_violation`, `auth.signup.tenant_signup_not_supported`, `auth.signup.cognito_unavailable`, `auth.signup.rate_limited`, `auth.resend_verification.rate_limited`. |
| `packages/mobile/tests/screens/login.test.tsx` | Aggiungere 1 test: tap "Registrati" → `router.push('/signup')` chiamato. |
| `packages/mobile/tests/lib/error-messages.test.ts` | Aggiungere case per i 6 nuovi codici. |

### 5.3 NO new dependencies

- `react-hook-form` e `zod`: già `devDeps` mobile (verificare in `package.json`). Se non presenti come deps runtime, **non aggiungere** — fall back a controlled `useState` form (vedi §6.4).
- `@tanstack/react-query`: già live, hook `useMutation` per signup + resend.

## 6. Behavioural details

### 6.1 Form layout (`SignupForm.tsx`)

Identico stile `Login.tsx`:
- SafeAreaView + KeyboardAvoidingView wrap.
- Brand header (logo "G" + "GarageOS") in cima.
- Campi verticali con `label` + `TextInput` + `fieldError` text (rosso, 12px).
- Helper text statico sotto password: "Almeno 8 caratteri, una lettera minuscola, un numero" (12px, muted, sempre visibile).
- Error banner full-width sopra il primo campo (visibile solo su errore API).
- Submit button full-width primary, disabled durante submit con `ActivityIndicator`.
- Link inferiore "Hai già un account? Accedi" → `router.back()` (torna a `/login`).

### 6.2 SignupForm submit flow

```
onSubmit (RHF handleSubmit, Zod-validated)
  → setSubmitting(true), setError(null)
  → result = await signupCustomer({email, password, firstName, lastName})
  → if (result.ok === false):
      → setError(mapErrorToUserMessage(result.code))
      → setSubmitting(false)
      → return
  → try:
      → await signIn(email, password)  // AuthContext SRP
      → router.replace('/verify-email-sent', { params: { email } })
    catch:
      → toast "Registrazione completata. Effettua il login."
      → router.replace('/login')
```

`router.replace` con params: passare l'email come query param (`/verify-email-sent?email=...`) — `useLocalSearchParams` la legge nella screen successiva. Niente state globale.

### 6.3 VerifyEmailSent screen

- Brand header.
- Icona email centrale (Ionicons `mail-outline` 64px, già presente in expo stack o usare emoji fallback se Ionicons non importato — verificare a plan time).
- H1 "Conferma la tua email".
- Body "Abbiamo inviato un link di verifica a `<email>`. Clicca sul link per confermare il tuo indirizzo."
- Pulsante secondario "Invia di nuovo" — chiama `resendVerification(email)`:
  - Disabled durante request.
  - Su success → cooldown 60s (countdown nel testo "Invia di nuovo (Xs)").
  - Su 429 → toast errore con retry-after.
- Pulsante primario "Continua" → `router.replace('/(tabs)')`.
- Link inferiore "Email sbagliata? Torna al login" → logout + `router.replace('/login')`.

### 6.4 Form library decision

Verificare a plan-time se `react-hook-form` + `@hookform/resolvers` sono già in `packages/mobile/package.json`:
- **Se sì** → usali (mirror PR #102/#103/#104/#105 web pattern).
- **Se no** → controlled state via `useState`, validazione manuale via `signupSchema.safeParse()` su submit. RHF non è una dipendenza critica per signup (5 campi, no array/dynamic). Pattern mirror `login.tsx` attuale.

Rationale: mobile è snello, evitare di trascinare dipendenze in scaffold solo per un form. Decisione finale **a plan time** dopo verifica package.json.

### 6.5 Test isolation (Cognito mock)

I test screen NON devono toccare la rete o Cognito SDK. Pattern stabilito mobile (`tests/screens/login.test.tsx`):
- `jest.mock('@/auth/useAuth')` con stub `signIn` mockato.
- `jest.mock('@/queries/signup')` con stub wrapper.
- `jest.mock('expo-router')` con stub `useRouter().push/replace`.

Pattern aderente a `feedback_jsdom_radix_select_mock_pattern.md` (mock orchestrator, capture invocations).

## 7. Test plan

| Suite | Cases | What |
|-------|-------|------|
| `validators/signup.test.ts` | 8 | email valida/invalida, password min 8, password no lowercase, password no digit, confirmPassword mismatch, firstName empty, lastName empty, all-fields-ok |
| `queries/signup.test.ts` | 6 | 201 → `{ok:true}`, 409 → `{ok:false, code:'auth.signup.email_already_active'}`, 422 password policy, 429 rate limited, 502 cognito unavailable, network error |
| `queries/resendVerification.test.ts` | 3 | 200 ok, 429, network |
| `components/SignupForm.test.tsx` | 8 | render + 5 fields, submit valid → calls wrapper, submit invalid → blocked, 409 banner, 422 password inline, helper text always visible, submitting disables button, link "Accedi" calls router.back |
| `screens/signup.test.tsx` | 4 | render mounts SignupForm, submit success → signIn called + router.replace verify-email-sent, signIn failure → router.replace login + toast, signup failure → form re-enables |
| `screens/verify-email-sent.test.tsx` | 5 | render with email param, "Invia di nuovo" calls resend + cooldown starts, cooldown countdown decreases, "Continua" → router.replace tabs, "Torna al login" → signOut + router.replace login |
| `screens/login.test.tsx` (1 new case) | 1 | tap "Registrati" → router.push('/signup') |
| `lib/error-messages.test.ts` (6 new cases) | 6 | new codes mapped to Italian strings |

**Total nuovi test:** ~41 (8+6+3+8+4+5+1+6).

**Run gate:** typecheck pre-push (husky), test:unit full mobile in CI.

## 8. Smoke runbook (operator-driven, Xiaomi 13T Pro)

1. EAS preview build (o `pnpm --filter @garageos/mobile start` + Expo Go) con `EXPO_PUBLIC_API_URL=https://api.garageos.aifollyadvisor.com` e Cognito clienti pool IDs production.
2. App start → screen Login.
3. Tap "Non hai un account? Registrati" → /signup.
4. Insert email nuova (es. `signup-test-<random>@example.com`), password `miapassword1`, confirm uguale, firstName "Test", lastName "Smoke".
5. Submit → loader → redirect a `/verify-email-sent` con email mostrata.
6. Verifica inbox SES (richiede dominio fuori sandbox o email aggiunta a verified identity).
7. Tap "Invia di nuovo" → toast "Email inviata" → cooldown 60s.
8. Tap "Invia di nuovo" durante cooldown → disabled, niente request.
9. Tap "Continua" → `/(tabs)`, lista veicoli (vuota, OK).
10. Logout from `/(tabs)/profile` → `/login`.
11. Login con stesso email/password → success → `/(tabs)`.

**Negative cases:**
- Email duplicata: ripeti step 4 con email già usata → banner "Email già registrata, accedi".
- Password debole "abc" → 3 errori Zod (length + lowercase + digit) inline + helper text rimane visibile.
- Password mismatch → inline error sotto confirmPassword.
- Rate limit: 6 submit rapidi → 429 banner.
- Offline: airplane mode + submit → banner "Connessione assente".

## 9. Open questions / risks

### 9.1 react-hook-form runtime dep (risk)

Se RHF non è in deps mobile, plan-time decision tree:
- **A:** aggiungerlo (segue web pattern, ~50KB bundle impact).
- **B:** controlled state form (~150 LOC in più, niente dep, segue `login.tsx` pattern).

Default: B (mirror `login.tsx`, mantiene leggero).

### 9.2 SES sandbox limits (smoke)

SES production-exit case `177883174800151` è pending AWS reply (vedi memory checkpoint). Smoke step 6 richiede sandbox-mode email verified preventivamente, oppure attendere prod-exit. **Non blocca PR merge** — smoke con email verified è sufficiente per accettazione tecnica.

### 9.3 Deep-link mobile per verify-email (future)

Out of scope. Quando aggiungeremo `Linking` config in `app.json` (scheme `garageos://`) + handler verify-email mobile, sarà slice separato che richiede:
- Aggiornare backend SES template `buildVerificationUrl` con scheme detect (web vs deep-link).
- Mobile route `/verify-email?token=...` che chiama `POST /v1/auth/verify-email` e mostra success/error.

Decisione corrente: web `/verify-email` è sufficiente per v1 (apre il browser dall'inbox, conferma, l'utente torna in app già autenticato e l'attributo Cognito si propaga al prossimo refresh token).

### 9.4 Profile screen badge "Email non verificata"

Out of scope. Quando F-CLI-004 profile screen verrà costruito, leggere `email_verified` dal JWT (decode payload custom claim) e mostrare badge + CTA "Re-invia verifica". Per ora, l'utente non vede feedback in-app post `/verify-email-sent` → migliorabile in slice futuro.

## 10. Scope estimate

| Layer | LOC |
|-------|-----|
| `validators/signup.ts` | ~30 |
| `queries/signup.ts` (2 wrappers + 2 hooks) | ~120 |
| `components/auth/SignupForm.tsx` | ~250 |
| `app/signup.tsx` | ~80 |
| `app/verify-email-sent.tsx` | ~150 |
| `app/login.tsx` (mod) | +3 |
| `lib/error-messages.ts` (mod) | +6 entries |
| Tests | ~250 |
| **Total code + tests** | ~880 |
| Spec + plan docs | ~500 |

Sotto soglia hard 1500 LOC, sopra soglia review 500 LOC ma giustificato da scope monolitico (form + 2 screens + tests). Niente split candidate identificabile.

## 11. Acceptance criteria

- [ ] User non-autenticato vede link "Non hai un account? Registrati" su `/login`, tap → `/signup`.
- [ ] User compila form con dati validi → `POST /v1/auth/signup` 201 → auto-login Cognito SRP → `/verify-email-sent` con email param visibile.
- [ ] User su `/verify-email-sent` può cliccare "Invia di nuovo" → request → cooldown 60s con countdown.
- [ ] User clicca "Continua" → `/(tabs)`.
- [ ] User logout → login con credenziali appena create → `/(tabs)`.
- [ ] Negative: email duplicata → banner inline.
- [ ] Negative: password policy violation → inline error sotto password.
- [ ] Negative: rate limit 429 → banner con retry-after.
- [ ] Negative: network down → banner offline.
- [ ] Full suite test mobile PASS (existing + ~41 new).
- [ ] CI 11/11 green.
- [ ] Operator smoke runbook eseguito su Xiaomi 13T Pro (golden path + 4 negative cases).

## 12. Backout plan

PR squash revert → mobile torna a stato pre-#NN (signup link stubbato). Nessuna migration, nessuna AWS infra change, nessun database change. Revert è totalmente reversibile.

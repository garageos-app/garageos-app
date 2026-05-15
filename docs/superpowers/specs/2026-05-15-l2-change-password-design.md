# Slice L2 — Change password (F-OFF-007)

**Status:** approved 2026-05-15 — ready for writing-plans
**Scope:** self-service password change client-side (Cognito SDK) per utenti officina
**Target size:** ~180 LOC code + ~250 LOC test (single PR)
**Out of scope (deferred):** live policy checklist, strength meter, global signOut (revoke other sessions), password history, email "password changed" notification, slice M multi-user invitations

---

## 1. Goal

Sbloccare l'ultimo pezzo MUST della famiglia F-OFF-007 ("Profilo utente"): ogni utente officina (Super Admin o meccanico) può cambiare la propria password dalla pagina Impostazioni, senza dover passare dal flusso reset-via-email.

Demo polish, slice indipendente, zero impatto backend.

---

## 2. Architecture

### 2.1 Backend

**Nessuna modifica.** Cognito SDK client-side è l'unica chiamata: `CognitoUser.changePassword(oldPassword, newPassword, callback)` autentica con il refresh token corrente e parla direttamente con il pool officine.

Nessun nuovo endpoint, nessuna migration, nessun nuovo error code in APPENDICE_G (`auth.password.too_weak` già documentato e non utilizzato server-side per questo flow).

### 2.2 Frontend (`packages/web`)

| Nuovo file | Responsabilità |
|---|---|
| `src/lib/validators/password.ts` | Zod schema policy + form schema (refine cross-field) |
| `src/lib/auth/change-password.ts` | Wrapper promisify su `CognitoUser.changePassword` + error mapping |
| `src/hooks/useChangePassword.ts` | React hook con `isPending` + `mutate` che ritorna `ChangePasswordResult` |
| `src/components/settings/PasswordForm.tsx` | Form RHF+Zod 3-fields, helper text statico, error inline |
| `src/lib/validators/password.test.ts` | Schema cases |
| `src/lib/auth/change-password.test.ts` | Mock SDK, copre tutti i code branch |
| `src/hooks/useChangePassword.test.tsx` | Lifecycle + return propagation |
| `src/components/settings/PasswordForm.test.tsx` | Form behavior + error mapping |

| File modificato | Cambio |
|---|---|
| `src/pages/Settings.tsx` | Aggiunge tab `Sicurezza` + dirty-tab guard include passwordFormRef |
| `src/pages/Settings.test.tsx` | Nuovi case: tab visible, dirty-guard include security form |

### 2.3 Non-goals

- **No backend changes** — Cognito SDK fa tutto client-side via refresh token
- **No live policy checklist con check verde** — solo helper text statico + error inline (decisione UX brainstorm)
- **No strength meter** — fuori scope demo polish
- **No global signOut** — Cognito `changePassword` non revoca refresh token altre sessioni; accettato per v1. Futuro hardening trigger: pilot incident / customer ask
- **No email notification "password changed"** — Cognito non lo invia by default; pattern futuro insieme a F-OFF-006 2FA
- **No password history** — Cognito non lo offre nativamente; out of scope
- **No force logout post-success** — sessione mantenuta (decisione UX brainstorm), pattern Cognito default
- **No Playwright/E2E** — smoke manuale post-merge (pattern `feedback_skip_local_integration_tests`)

---

## 3. UX flow

### 3.1 Tab placement

Aggiunto tab `Sicurezza` parallelo a `Profilo` / `Officina` in `Settings.tsx`. Visibile a TUTTI gli utenti (sia `super_admin` che `mechanic`, perché il cambio password è universale).

```
Impostazioni
┌──────────┬────────────┬────────────┐
│ Profilo  │ Sicurezza  │ Officina*  │   (*solo super_admin)
└──────────┴────────────┴────────────┘
```

### 3.2 PasswordForm layout

```
┌─────────────────────────────────────┐
│ Password                            │
│                                     │
│ Password attuale  [_______________] │
│   [error: Campo obbligatorio]       │
│                                     │
│ Nuova password    [_______________] │
│   Almeno 10 caratteri, una          │
│   maiuscola, una minuscola, un      │
│   numero.                           │
│   [error: Almeno una maiuscola]     │
│                                     │
│ Conferma nuova    [_______________] │
│   [error: Le password non coincidono]│
│                                     │
│            [ Cambia password ]      │
└─────────────────────────────────────┘
```

Tutti i campi sono `<Input type="password">`. Helper text sotto `newPassword` è sempre visibile (gray-600). Errori inline sotto ciascun campo (red-600).

### 3.3 Submit lifecycle

Submit → Zod validate (sync) → se OK → `useChangePassword.mutate(old, new)` → branch su result:

| Result | Azione |
|---|---|
| `{ ok: true }` | sonner toast "Password aggiornata" (success) + `form.reset()` + sessione mantenuta |
| `{ ok: false, code: 'wrong_old_password' }` | `form.setError('oldPassword', { message: 'Password attuale non corretta' })` |
| `{ ok: false, code: 'password_too_weak' }` | `form.setError('newPassword', { message: 'La password non rispetta i requisiti' })` — defensive: Zod dovrebbe già averla bloccata, Cognito server-side è ultimate authority |
| `{ ok: false, code: 'rate_limited' }` | sonner toast errore "Troppi tentativi, riprova tra qualche minuto" |
| `{ ok: false, code: 'not_authenticated' }` | sonner toast errore "Sessione scaduta. Effettua di nuovo l'accesso." (no redirect automatico — l'utente clicca menu profilo) |
| `{ ok: false, code: 'unknown' }` | sonner toast errore "Impossibile contattare il server. Riprova." |

Bottone disabilitato durante `isPending` con label "Aggiornamento...".

### 3.4 Dirty-tab guard

Settings.tsx ha già un AlertDialog cross-tab per "Modifiche non salvate". Esteso a includere `passwordFormRef.current.formState.isDirty`. Se l'utente compila la password e cerca di cambiare tab senza submit, viene avvisato.

---

## 4. Implementation detail

### 4.1 `lib/validators/password.ts`

```ts
import { z } from 'zod';

export const passwordPolicySchema = z
  .string()
  .min(10, 'Almeno 10 caratteri')
  .regex(/[a-z]/, 'Almeno una lettera minuscola')
  .regex(/[A-Z]/, 'Almeno una lettera maiuscola')
  .regex(/[0-9]/, 'Almeno un numero');

export const changePasswordFormSchema = z
  .object({
    oldPassword: z.string().min(1, 'Campo obbligatorio'),
    newPassword: passwordPolicySchema,
    confirmPassword: z.string().min(1, 'Campo obbligatorio'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Le password non coincidono',
  })
  .refine((v) => v.newPassword !== v.oldPassword, {
    path: ['newPassword'],
    message: 'La nuova password deve essere diversa dalla precedente',
  });

export type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;
```

Policy mirrora `infrastructure/lib/constructs/cognito.ts:51-57` (officine pool): min 10, upper+lower+digit, no symbols.

### 4.2 `lib/auth/change-password.ts`

```ts
import {
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { officineUserPool } from '@/lib/cognito';

export type ChangePasswordCode =
  | 'wrong_old_password'      // NotAuthorizedException
  | 'password_too_weak'       // InvalidPasswordException (server-side policy fail)
  | 'rate_limited'            // LimitExceededException, TooManyRequestsException
  | 'not_authenticated'       // no current user, or session invalid
  | 'unknown';                // everything else

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; code: ChangePasswordCode };

const COGNITO_ERROR_TO_CODE: Record<string, ChangePasswordCode> = {
  NotAuthorizedException: 'wrong_old_password',
  InvalidPasswordException: 'password_too_weak',
  LimitExceededException: 'rate_limited',
  TooManyRequestsException: 'rate_limited',
};

export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const user = officineUserPool.getCurrentUser();
  if (!user) return { ok: false, code: 'not_authenticated' };

  // Cognito SDK richiede una sessione valida prima di changePassword;
  // getSession() fa refresh automatico se il refreshToken è valido.
  const sessionOk = await new Promise<boolean>((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(!err && !!session && session.isValid());
    });
  });
  if (!sessionOk) return { ok: false, code: 'not_authenticated' };

  return new Promise<ChangePasswordResult>((resolve) => {
    user.changePassword(oldPassword, newPassword, (err) => {
      if (!err) return resolve({ ok: true });
      const name = (err as { name?: string }).name;
      const code = (name && COGNITO_ERROR_TO_CODE[name]) ?? 'unknown';
      resolve({ ok: false, code });
    });
  });
}
```

**Lesson da PR #103** (`feedback_hook_return_result_not_state`): nessuna reliance su state post-await; tutto il risultato passa attraverso il return value.

### 4.3 `hooks/useChangePassword.ts`

```ts
import { useCallback, useState } from 'react';
import { changePassword, type ChangePasswordResult } from '@/lib/auth/change-password';

export function useChangePassword() {
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(
    async (oldPassword: string, newPassword: string): Promise<ChangePasswordResult> => {
      setIsPending(true);
      try {
        return await changePassword(oldPassword, newPassword);
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  return { mutate, isPending };
}
```

### 4.4 `components/settings/PasswordForm.tsx`

Pattern parallel a `ProfileForm.tsx`:
- `useForm` con `zodResolver(changePasswordFormSchema)`
- `formRef?: (form: UseFormReturn<...>) => void` lift al parent per dirty-tab guard
- `onSubmit` chiama `mutation.mutate(values.oldPassword, values.newPassword)` poi branch sul result
- 3 `<Input type="password">` con `<Label>` + helper text + error message inline
- `<Button type="submit" disabled={!isDirty || mutation.isPending}>`

Nessun valore precompilato (no `profile.password`), `defaultValues` tutto stringa vuota.

### 4.5 `pages/Settings.tsx` update

```ts
type TabId = 'profile' | 'security' | 'tenant';   // 'security' aggiunto

// ... existing refs ...
const passwordFormRef = useRef<UseFormReturn<ChangePasswordFormValues> | null>(null);

function anyDirty(): boolean {
  return (
    profileFormRef.current?.formState.isDirty === true ||
    passwordFormRef.current?.formState.isDirty === true ||
    tenantFormRef.current?.formState.isDirty === true
  );
}

function discardChangesAndSwitch() {
  if (!pendingTab) return;
  profileFormRef.current?.reset();
  passwordFormRef.current?.reset();
  tenantFormRef.current?.reset();
  setActiveTab(pendingTab);
  setPendingTab(null);
}

// in render:
<TabsList>
  <TabsTrigger value="profile">Profilo</TabsTrigger>
  <TabsTrigger value="security">Sicurezza</TabsTrigger>
  {isSuperAdmin && <TabsTrigger value="tenant">Officina</TabsTrigger>}
</TabsList>

<TabsContent value="security" className="mt-6">
  <PasswordForm
    formRef={(f) => { passwordFormRef.current = f; }}
  />
</TabsContent>
```

---

## 5. Test plan

### 5.1 `lib/validators/password.test.ts` (~50 LOC, 8 cases)

- `passwordPolicySchema`:
  - rejects < 10 chars
  - rejects missing lowercase
  - rejects missing uppercase
  - rejects missing digit
  - accepts valid (`Abcdefg123`)
- `changePasswordFormSchema`:
  - rejects mismatch newPassword vs confirmPassword
  - rejects newPassword === oldPassword
  - accepts valid full payload

### 5.2 `lib/auth/change-password.test.ts` (~80 LOC, 6 cases)

Mock `@/lib/cognito` con `officineUserPool.getCurrentUser` stubbed.

- `getCurrentUser` returns null → `{ ok: false, code: 'not_authenticated' }`
- `getSession` returns invalid → `{ ok: false, code: 'not_authenticated' }`
- `changePassword` callback err `name='NotAuthorizedException'` → `wrong_old_password`
- `changePassword` callback err `name='InvalidPasswordException'` → `password_too_weak`
- `changePassword` callback err `name='LimitExceededException'` → `rate_limited`
- `changePassword` callback err `name='SomethingElse'` → `unknown`
- `changePassword` callback no err → `{ ok: true }`

### 5.3 `hooks/useChangePassword.test.tsx` (~40 LOC, 3 cases)

`renderHook` + mock `changePassword` module.

- initial state: `isPending: false`
- during `mutate()` pending → `isPending: true`, resolved → `isPending: false`
- mutate ritorna il result correttamente (ok + error case)

### 5.4 `components/settings/PasswordForm.test.tsx` (~120 LOC, 8 cases)

Mock `useChangePassword` hook.

- renders 3 inputs + helper text
- submit blocked if form invalid (Zod errors visible)
- mismatch new/confirm → error inline su confirmPassword
- success path: mutate returns ok → form.reset called + sonner toast success
- wrong old password → setError on oldPassword
- rate_limited → toast errore
- unknown error → toast errore
- button disabled durante isPending

Pattern shadcn/Radix per `userEvent.click` (vedi `feedback_radix_tabs_user_event_not_fire_event`).

### 5.5 `pages/Settings.test.tsx` extension (~40 LOC, 3 cases)

- tab `Sicurezza` visibile sia per super_admin sia per mechanic
- dirty-tab guard scatta quando il password form è dirty
- discardChangesAndSwitch resetta anche passwordFormRef

---

## 6. Scope estimate

| Area | Code LOC | Test LOC |
|---|---|---|
| validators/password.ts | 25 | 50 |
| auth/change-password.ts | 50 | 80 |
| hooks/useChangePassword.ts | 25 | 40 |
| settings/PasswordForm.tsx | 60 | 120 |
| pages/Settings.tsx update | 20 | 40 |
| **Totale** | **~180** | **~250** |

**~430 LOC totali**. Sopra il target iniziale 50-100 LOC, ma realistic for production-grade UI flow con full test coverage. Bundle in singolo PR (~slice L1 = ~2040 LOC, ~slice L = ~2100 LOC: L2 è il più piccolo della famiglia, ben sotto i 1500 hard-limit CLAUDE.md).

---

## 7. Risks / unknowns

- **Cognito `getSession()` requirement** — il SDK richiede sessione valida prima di `changePassword`. Se il token è scaduto e il refreshToken anche, fail con `NotAuthorizedException`. Mitigazione: chiamata esplicita `getSession()` prima, mappata a `not_authenticated` con toast leggibile.
- **`changePassword` vs `confirmPassword` confusion** — il metodo SDK è `changePassword(old, new, cb)` per utente loggato, distinto da `confirmPassword(code, password, cb)` per reset flow. JSDoc nel wrapper.
- **Server-side policy double-check** — Zod client-side è first line; Cognito è ultimate authority. Se la policy CDK cambia senza aggiornare Zod, gli utenti vedono `password_too_weak` da Cognito invece dell'errore Zod locale. Mitigazione: commento "policy mirror" nel validators file con file link a `infrastructure/lib/constructs/cognito.ts:51-57`.
- **Refresh token survival** — `changePassword` di Cognito NON revoca i refresh token altre sessioni (decisione UX accettata in `non-goals`). Documentato per pilot scenarios; futuro hardening trigger.

---

## 8. Demo runbook (post-merge)

1. Login super_admin Giuseppe → `/settings` → tab `Sicurezza`
2. Compila campi con vecchia + nuova valida (`TestMech2026!` → `NuovaPwd2026!`) → Cambia password
3. Verifica: toast "Password aggiornata", form svuotato, sessione mantenuta (no redirect)
4. Logout → Login con NUOVA password → success
5. Negative: logout, login con VECCHIA password → "Email o password non corretti"
6. Negative: tab Sicurezza → vecchia password errata → "Password attuale non corretta" inline
7. Negative: mismatch new/confirm → "Le password non coincidono" inline
8. Negative: nuova password "abc" → 3 errori Zod (length, upper, digit)
9. Repeat con mechanic-test@demo-giuseppe.test

---

## 9. Dependencies / ordering

- **Prerequisito ZERO** (slice indipendente)
- **Sblocca**: niente; F-OFF-006 2FA (futuro), F-OFF-501 vehicle transfer, slice M multi-user invitations non dipendono da L2
- **Pattern reuse downstream**: il pattern `changePassword` wrapper + hook può essere riusato per F-CLI-001 mobile signup change password e altri flow auth client-side

---

## 10. Acceptance criteria

- [ ] Tab `Sicurezza` visibile in `/settings` per ogni ruolo officina
- [ ] PasswordForm con 3 campi type=password + helper text + error inline
- [ ] Submit success: toast + form reset + sessione mantenuta
- [ ] Submit con vecchia password errata: error inline su oldPassword
- [ ] Submit con nuova password che viola policy: error inline su newPassword (Zod o Cognito)
- [ ] Submit con mismatch new/confirm: error inline su confirmPassword
- [ ] Rate limit Cognito: toast errore
- [ ] Dirty-tab guard include passwordForm
- [ ] Login con NUOVA password funziona post-change
- [ ] Tutti i test passano (unit + integration esistenti regression-free)

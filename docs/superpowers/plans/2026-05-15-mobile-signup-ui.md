# Mobile signup UI (F-CLI-001) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/signup` + `/verify-email-sent` screens to the mobile app, consuming the existing public `POST /v1/auth/signup` and `POST /v1/auth/resend-verification` endpoints, with auto-login via Cognito SRP on success.

**Architecture:** Pure `fetch` wrapper (no `apiClient`, no Bearer) for the public endpoints; controlled-state form (no `react-hook-form`/`zod` — neither is in mobile deps, follow `login.tsx` pattern); Expo Router `push` for entry, `replace` for forward transitions; auto-login via existing `AuthContext.signIn()`. Zero backend changes.

**Tech Stack:** Expo SDK 52, React Native 0.76.9, TypeScript, expo-router 4, amazon-cognito-identity-js 6 (already integrated for login), Jest + @testing-library/react-native. NO new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-15-mobile-signup-ui-design.md`

**Critical gotchas to bake in:**
- API responses use **RFC 7807 problem+json** shape with `{ code, detail, ... }` — **NOT** `error_code`/`error_message`. The existing `ApiError.fromResponse` reads the wrong shape (latent bug, out of scope). Our public wrappers read `body.code` / `body.detail` directly.
- `error-handler.ts:170-173` produces dot-separated domain codes verbatim (e.g. `auth.signup.email_already_active`).
- `react-hook-form` and `zod` are **NOT** in `packages/mobile/package.json`. Do not add them. Use controlled `useState` mirroring `app/login.tsx`.
- Mobile error mapping is via `src/lib/error-messages.ts` (flat object lookup). Mirror the existing pattern.
- Tests use Jest's classic `jest.mock('module-path')` + auto-mock; no need for `react-query` provider for non-hook wrappers (pure functions).
- `expo-router` mocks in tests: see `tests/screens/login.test.tsx` for the canonical pattern (`useRouter: jest.fn()` + `mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn() })`).
- The Cognito clienti pool password policy is **minLength 8, requireLowercase, requireDigits** (no uppercase, no symbols) — verified in `infrastructure/lib/constructs/cognito.ts:86-91`.

**Branch:** `feat/mobile-signup-ui` (already created, spec committed at `fc28dc1`).

**Commits:** Frequent (per task). Pre-push hook runs only `pnpm -r typecheck`. CI runs the rest.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/mobile/src/lib/validators/signup.ts` | Pure validation function for signup form input |
| `packages/mobile/src/queries/signup.ts` | `signupCustomer()` + `resendVerification()` — pure fetch wrappers returning discriminated results |
| `packages/mobile/src/components/auth/SignupForm.tsx` | Controlled-state form, 4 fields + helper text + error banner + submit button |
| `packages/mobile/app/signup.tsx` | Screen route, mounts `SignupForm`, owns submit orchestration (wrapper → signIn → navigate) |
| `packages/mobile/app/verify-email-sent.tsx` | Informational screen with resend + cooldown + continue |
| `packages/mobile/tests/lib/validators/signup.test.ts` | Validator unit tests (8 cases) |
| `packages/mobile/tests/queries/signup.test.ts` | Wrapper unit tests (9 cases: signupCustomer + resendVerification) |
| `packages/mobile/tests/components/SignupForm.test.tsx` | Form unit tests (8 cases) |
| `packages/mobile/tests/screens/signup.test.tsx` | Screen tests (4 cases) |
| `packages/mobile/tests/screens/verify-email-sent.test.tsx` | Screen tests (5 cases) |

### Modified files

| Path | Change |
|------|--------|
| `packages/mobile/app/login.tsx` | Replace `Alert.alert('Disponibile a breve')` on "Registrati" link with `router.push('/signup')` |
| `packages/mobile/src/lib/error-messages.ts` | Add 6 new domain codes |
| `packages/mobile/tests/screens/login.test.tsx` | Add 1 test for the "Registrati" link |
| `packages/mobile/tests/lib/error-messages.test.ts` | Add 1 test covering the new codes |

---

## Task 1: Error message mappings

Smallest, isolated, no deps. TDD baseline.

**Files:**
- Modify: `packages/mobile/src/lib/error-messages.ts`
- Modify: `packages/mobile/tests/lib/error-messages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/mobile/tests/lib/error-messages.test.ts`:

```ts
  it('maps auth.signup.email_already_active', () => {
    expect(mapErrorToUserMessage('auth.signup.email_already_active')).toBe(
      'Un account con questa email è già registrato. Effettua il login.',
    );
  });

  it('maps auth.signup.password_policy_violation', () => {
    expect(mapErrorToUserMessage('auth.signup.password_policy_violation')).toBe(
      'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
    );
  });

  it('maps auth.signup.tenant_signup_not_supported', () => {
    expect(mapErrorToUserMessage('auth.signup.tenant_signup_not_supported')).toBe(
      'La registrazione officina non è ancora disponibile.',
    );
  });

  it('maps auth.signup.cognito_unavailable', () => {
    expect(mapErrorToUserMessage('auth.signup.cognito_unavailable')).toBe(
      'Servizio di autenticazione temporaneamente non disponibile. Riprova tra qualche istante.',
    );
  });

  it('maps auth.signup.rate_limited', () => {
    expect(mapErrorToUserMessage('auth.signup.rate_limited')).toBe(
      'Troppi tentativi di registrazione. Riprova tra qualche minuto.',
    );
  });

  it('maps auth.resend_verification.rate_limited', () => {
    expect(mapErrorToUserMessage('auth.resend_verification.rate_limited')).toBe(
      'Troppi tentativi. Riprova tra qualche minuto.',
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/lib/error-messages.test.ts -- --testPathPattern=error-messages`

Expected: 6 new tests FAIL with `Expected: "..." | Received: "Si è verificato un errore. Riprova più tardi."` (the fallback).

- [ ] **Step 3: Add the 6 mappings**

In `packages/mobile/src/lib/error-messages.ts`, extend the `MESSAGES` object. Replace the existing object literal:

```ts
const MESSAGES: Record<string, string> = {
  // Cognito SDK errors
  NotAuthorizedException: 'Email o password non corretti.',
  UserNotConfirmedException: "Account non confermato. Controlla l'email di verifica.",
  PasswordResetRequiredException: 'È necessario reimpostare la password.',
  LimitExceededException: 'Troppi tentativi. Riprova tra qualche minuto.',
  UserNotFoundException: 'Email o password non corretti.',
  InvalidPasswordException: 'Email o password non corretti.',

  // API domain codes
  'me.vehicle.not_found': 'Veicolo non trovato o non più di tua proprietà.',
  'vehicle.timeline.not_owner': 'Solo il proprietario attivo può consultare la timeline.',
  'auth.session_expired': "Sessione scaduta. Effettua di nuovo l'accesso.",
  'network.unreachable': 'Connessione assente. Controlla la rete.',

  // Signup domain codes (F-CLI-001)
  'auth.signup.email_already_active':
    'Un account con questa email è già registrato. Effettua il login.',
  'auth.signup.password_policy_violation':
    'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
  'auth.signup.tenant_signup_not_supported':
    'La registrazione officina non è ancora disponibile.',
  'auth.signup.cognito_unavailable':
    'Servizio di autenticazione temporaneamente non disponibile. Riprova tra qualche istante.',
  'auth.signup.rate_limited':
    'Troppi tentativi di registrazione. Riprova tra qualche minuto.',
  'auth.resend_verification.rate_limited':
    'Troppi tentativi. Riprova tra qualche minuto.',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/lib/error-messages.test.ts`

Expected: 10/10 tests pass (4 existing + 6 new).

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/lib/error-messages.ts packages/mobile/tests/lib/error-messages.test.ts
git commit -m "feat(mobile): add signup domain error code mappings

Add 6 IT user-facing messages for auth.signup.* and
auth.resend_verification.rate_limited domain codes returned by the
public /v1/auth/signup and /v1/auth/resend-verification endpoints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Signup form validator

Pure function. No external deps. Mirrors `login.tsx` inline validator pattern but extracted to its own module for testability.

**Files:**
- Create: `packages/mobile/src/lib/validators/signup.ts`
- Create: `packages/mobile/tests/lib/validators/signup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/lib/validators/signup.test.ts`:

```ts
import { validateSignupForm } from '@/lib/validators/signup';

describe('validateSignupForm', () => {
  const valid = {
    email: 'mario.rossi@example.com',
    password: 'miapassword1',
    confirmPassword: 'miapassword1',
    firstName: 'Mario',
    lastName: 'Rossi',
  };

  it('returns empty errors for fully valid input', () => {
    expect(validateSignupForm(valid)).toEqual({});
  });

  it('flags missing email', () => {
    expect(validateSignupForm({ ...valid, email: '' })).toMatchObject({
      email: 'Email obbligatoria',
    });
  });

  it('flags malformed email', () => {
    expect(validateSignupForm({ ...valid, email: 'not-an-email' })).toMatchObject({
      email: 'Email non valida',
    });
  });

  it('flags password shorter than 8 chars', () => {
    expect(validateSignupForm({ ...valid, password: 'short1', confirmPassword: 'short1' }))
      .toMatchObject({ password: 'Almeno 8 caratteri' });
  });

  it('flags password without lowercase', () => {
    expect(validateSignupForm({ ...valid, password: 'PASSWORD1', confirmPassword: 'PASSWORD1' }))
      .toMatchObject({ password: 'Almeno una lettera minuscola' });
  });

  it('flags password without digit', () => {
    expect(validateSignupForm({ ...valid, password: 'password', confirmPassword: 'password' }))
      .toMatchObject({ password: 'Almeno un numero' });
  });

  it('flags confirm password mismatch', () => {
    expect(validateSignupForm({ ...valid, confirmPassword: 'different1' })).toMatchObject({
      confirmPassword: 'Le password non coincidono',
    });
  });

  it('flags empty firstName and lastName', () => {
    expect(validateSignupForm({ ...valid, firstName: '', lastName: '   ' })).toMatchObject({
      firstName: 'Nome obbligatorio',
      lastName: 'Cognome obbligatorio',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/lib/validators/signup.test.ts`

Expected: ALL 8 tests FAIL with `Cannot find module '@/lib/validators/signup'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/lib/validators/signup.ts`:

```ts
// Pure validator for the signup form. No Zod (not in mobile deps);
// mirror the inline pattern from app/login.tsx but extracted for testability.
// The Cognito clienti pool policy is the authoritative gate (minLength 8,
// requireLowercase, requireDigits — see infrastructure/lib/constructs/cognito.ts:86-91).
// Client-side validation is best-effort UX; server rejection surfaces as
// auth.signup.password_policy_violation if a request slips through.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupFormInput = {
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
};

export type SignupFormErrors = Partial<Record<keyof SignupFormInput, string>>;

export function validateSignupForm(input: SignupFormInput): SignupFormErrors {
  const errors: SignupFormErrors = {};

  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
  }

  if (!input.password) {
    errors.password = 'Password obbligatoria';
  } else if (input.password.length < 8) {
    errors.password = 'Almeno 8 caratteri';
  } else if (!/[a-z]/.test(input.password)) {
    errors.password = 'Almeno una lettera minuscola';
  } else if (!/[0-9]/.test(input.password)) {
    errors.password = 'Almeno un numero';
  }

  if (!input.confirmPassword) {
    errors.confirmPassword = 'Conferma la password';
  } else if (input.password !== input.confirmPassword) {
    errors.confirmPassword = 'Le password non coincidono';
  }

  if (!input.firstName.trim()) {
    errors.firstName = 'Nome obbligatorio';
  }
  if (!input.lastName.trim()) {
    errors.lastName = 'Cognome obbligatorio';
  }

  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/lib/validators/signup.test.ts`

Expected: 8/8 PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/lib/validators/signup.ts packages/mobile/tests/lib/validators/signup.test.ts
git commit -m "feat(mobile): add signup form validator

Pure function mirroring Cognito clienti pool policy (min 8 chars,
lowercase, digit) plus email format + confirm-match + name presence.
Extracted for testability; no Zod dep (not in mobile package).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: signupCustomer + resendVerification wrappers

Pure `fetch` wrappers. No `apiClient` (those are public endpoints, no Bearer). Return discriminated result `{ ok: true, customer } | { ok: false, code, message }`. Mirror pattern from PR #105 `queries/changePassword.ts`.

**Critical:** read RFC 7807 `code` + `detail` from the response body, NOT `error_code`/`error_message` (which is what the existing `api-client.ts` does — latent bug in the existing code, out of scope here).

**Files:**
- Create: `packages/mobile/src/queries/signup.ts`
- Create: `packages/mobile/tests/queries/signup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/queries/signup.test.ts`:

```ts
import { signupCustomer, resendVerification } from '@/queries/signup';

describe('signupCustomer', () => {
  const apiUrl = 'https://api.test.example.com';
  const input = {
    email: 'mario.rossi@example.com',
    password: 'miapassword1',
    firstName: 'Mario',
    lastName: 'Rossi',
  };

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('POSTs to /v1/auth/signup with type=customer and returns customer on 201', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        customer: {
          id: 'cust-1',
          email: 'mario.rossi@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          status: 'active',
          createdAt: '2026-05-15T12:00:00Z',
        },
      }),
    });

    const result = await signupCustomer(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.customer.email).toBe('mario.rossi@example.com');
    }
    expect(fetch).toHaveBeenCalledWith(
      `${apiUrl}/v1/auth/signup`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ type: 'customer', ...input }),
      }),
    );
    // Public endpoint — must NOT send Authorization header
    const headers = (fetch as unknown as jest.Mock).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('parses RFC 7807 problem+json code on 409', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        type: 'https://garageos/errors/auth.signup.email_already_active',
        title: 'Conflict',
        status: 409,
        code: 'auth.signup.email_already_active',
        detail: 'Un account con questa email è già registrato.',
      }),
    });

    const result = await signupCustomer(input);

    expect(result).toEqual({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
  });

  it('parses 422 password_policy_violation', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        code: 'auth.signup.password_policy_violation',
        detail: 'La password non rispetta i requisiti.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({
      ok: false,
      code: 'auth.signup.password_policy_violation',
    });
  });

  it('parses 429 rate_limited', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'auth.signup.rate_limited',
        detail: 'Troppi tentativi.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'auth.signup.rate_limited' });
  });

  it('parses 502 cognito_unavailable', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({
        code: 'auth.signup.cognito_unavailable',
        detail: 'Servizio non disponibile.',
      }),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'auth.signup.cognito_unavailable' });
  });

  it('returns network.unreachable on fetch throw', async () => {
    (fetch as unknown as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));

    const result = await signupCustomer(input);
    expect(result).toEqual({
      ok: false,
      code: 'network.unreachable',
      message: 'Connessione assente. Controlla la rete.',
    });
  });

  it('falls back to generic code when problem+json body missing', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await signupCustomer(input);
    expect(result).toMatchObject({ ok: false, code: 'http.500' });
  });
});

describe('resendVerification', () => {
  const apiUrl = 'https://api.test.example.com';

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('POSTs email and returns ok on 200', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sent: true }),
    });

    const result = await resendVerification('mario.rossi@example.com');

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      `${apiUrl}/v1/auth/resend-verification`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'mario.rossi@example.com' }),
      }),
    );
  });

  it('returns rate_limited on 429', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'auth.resend_verification.rate_limited',
        detail: 'Troppi tentativi.',
      }),
    });

    const result = await resendVerification('mario.rossi@example.com');
    expect(result).toMatchObject({
      ok: false,
      code: 'auth.resend_verification.rate_limited',
    });
  });

  it('returns network.unreachable on fetch throw', async () => {
    (fetch as unknown as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
    const result = await resendVerification('mario.rossi@example.com');
    expect(result).toMatchObject({ ok: false, code: 'network.unreachable' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/queries/signup.test.ts`

Expected: ALL 10 tests FAIL with `Cannot find module '@/queries/signup'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/queries/signup.ts`:

```ts
// Pure fetch wrappers for the public auth endpoints.
// These DO NOT use apiClient because:
//  - signup / resend-verification are public (no Bearer token).
//  - apiClient injects Authorization unconditionally and triggers
//    onAuthLost on 401 — wrong semantics for an unauthenticated caller.
//
// Discriminated return shape — callers branch on `result.ok`, exactly
// the pattern used by queries/changePassword.ts (PR #105).
//
// API returns RFC 7807 problem+json with { code, detail, ... }.
// Note: existing api-error.ts reads error_code/error_message — that's a
// latent bug in the existing api-client path; do NOT fix it here.

const FALLBACK_MESSAGE = 'Si è verificato un errore. Riprova più tardi.';
const NETWORK_MESSAGE = 'Connessione assente. Controlla la rete.';

export type SignupInput = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
};

export type SignupCustomer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  createdAt: string;
};

export type SignupResult =
  | { ok: true; customer: SignupCustomer }
  | { ok: false; code: string; message: string };

export type ResendResult = { ok: true } | { ok: false; code: string; message: string };

function getBaseUrl(): string {
  const url = process.env.EXPO_PUBLIC_API_URL;
  if (!url) throw new Error('EXPO_PUBLIC_API_URL is not set');
  return url;
}

function parseProblem(status: number, body: unknown): { code: string; message: string } {
  let code = `http.${status}`;
  let message = FALLBACK_MESSAGE;
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.code === 'string') code = obj.code;
    if (typeof obj.detail === 'string') message = obj.detail;
  }
  return { code, message };
}

export async function signupCustomer(input: SignupInput): Promise<SignupResult> {
  const url = `${getBaseUrl()}/v1/auth/signup`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: 'customer', ...input }),
    });
  } catch {
    return { ok: false, code: 'network.unreachable', message: NETWORK_MESSAGE };
  }

  const body = await res.json().catch(() => ({}));

  if (res.ok) {
    const customer = (body as { customer?: SignupCustomer }).customer;
    if (!customer) {
      return { ok: false, code: 'http.unexpected_body', message: FALLBACK_MESSAGE };
    }
    return { ok: true, customer };
  }

  const { code, message } = parseProblem(res.status, body);
  return { ok: false, code, message };
}

export async function resendVerification(email: string): Promise<ResendResult> {
  const url = `${getBaseUrl()}/v1/auth/resend-verification`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch {
    return { ok: false, code: 'network.unreachable', message: NETWORK_MESSAGE };
  }

  if (res.ok) return { ok: true };

  const body = await res.json().catch(() => ({}));
  const { code, message } = parseProblem(res.status, body);
  return { ok: false, code, message };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/queries/signup.test.ts`

Expected: 10/10 PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/queries/signup.ts packages/mobile/tests/queries/signup.test.ts
git commit -m "feat(mobile): add signupCustomer + resendVerification wrappers

Pure fetch wrappers for public auth endpoints (no Bearer, no apiClient).
Discriminated result {ok:true,customer} | {ok:false,code,message}.
Reads RFC 7807 problem+json shape (code, detail) returned by Fastify
error-handler.ts — NOT the legacy error_code/error_message that the
existing api-client mistakenly parses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: SignupForm component

Controlled-state form mirroring `login.tsx` style. 5 fields, helper text for password, inline errors, error banner for API failures, submit button with `ActivityIndicator`. Accepts a single prop `onSubmit(input): Promise<SignupResult>` so the parent screen owns auto-login + navigation.

**Files:**
- Create: `packages/mobile/src/components/auth/SignupForm.tsx`
- Create: `packages/mobile/tests/components/SignupForm.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/components/SignupForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SignupForm } from '@/components/auth/SignupForm';

const VALID = {
  email: 'mario.rossi@example.com',
  password: 'miapassword1',
  confirmPassword: 'miapassword1',
  firstName: 'Mario',
  lastName: 'Rossi',
};

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Email'), VALID.email);
  fireEvent.changeText(screen.getByPlaceholderText('Password'), VALID.password);
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), VALID.confirmPassword);
  fireEvent.changeText(screen.getByPlaceholderText('Nome'), VALID.firstName);
  fireEvent.changeText(screen.getByPlaceholderText('Cognome'), VALID.lastName);
}

describe('SignupForm', () => {
  it('renders all 5 fields plus helper text and submit', () => {
    render(<SignupForm onSubmit={jest.fn()} onNavigateLogin={jest.fn()} />);
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Conferma password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Nome')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Cognome')).toBeOnTheScreen();
    expect(screen.getByText(/Almeno 8 caratteri/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Registrati' })).toBeOnTheScreen();
  });

  it('blocks submit and shows inline errors when fields invalid', async () => {
    const onSubmit = jest.fn();
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText('Email obbligatoria')).toBeOnTheScreen();
    });
    expect(screen.getByText('Password obbligatoria')).toBeOnTheScreen();
    expect(screen.getByText('Nome obbligatorio')).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit on password confirm mismatch', async () => {
    const onSubmit = jest.fn();
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'different1');
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with trimmed/lowercased payload on valid submit', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true, customer: { id: 'c1' } });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), '  Mario.Rossi@Example.com ');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'miapassword1');
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'miapassword1');
    fireEvent.changeText(screen.getByPlaceholderText('Nome'), '  Mario  ');
    fireEvent.changeText(screen.getByPlaceholderText('Cognome'), '  Rossi ');
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'mario.rossi@example.com',
      password: 'miapassword1',
      firstName: 'Mario',
      lastName: 'Rossi',
    });
  });

  it('shows banner when onSubmit returns email_already_active', async () => {
    const onSubmit = jest.fn().mockResolvedValue({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText(/Un account con questa email/)).toBeOnTheScreen();
    });
  });

  it('shows inline password error when API returns password_policy_violation', async () => {
    const onSubmit = jest.fn().mockResolvedValue({
      ok: false,
      code: 'auth.signup.password_policy_violation',
      message: 'La password non rispetta i requisiti.',
    });
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      // The mapped IT message from error-messages.ts should appear under the password field
      expect(screen.getByText(/La password non rispetta i requisiti/)).toBeOnTheScreen();
    });
  });

  it('guards against double submit', async () => {
    const onSubmit = jest.fn(
      () =>
        new Promise(() => {
          // pending forever
        }) as Promise<{ ok: true }>,
    );
    render(<SignupForm onSubmit={onSubmit} onNavigateLogin={jest.fn()} />);
    fillValid();
    const button = screen.getByRole('button', { name: 'Registrati' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('navigates to login when "Accedi" link tapped', () => {
    const onNavigateLogin = jest.fn();
    render(<SignupForm onSubmit={jest.fn()} onNavigateLogin={onNavigateLogin} />);
    fireEvent.press(screen.getByText(/Hai già un account/));
    expect(onNavigateLogin).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/components/SignupForm.test.tsx`

Expected: 8 tests FAIL with `Cannot find module '@/components/auth/SignupForm'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/components/auth/SignupForm.tsx`:

```tsx
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  validateSignupForm,
  type SignupFormErrors,
} from '@/lib/validators/signup';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

export type SignupFormPayload = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
};

export type SignupFormSubmitResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

type SignupFormProps = {
  onSubmit: (payload: SignupFormPayload) => Promise<SignupFormSubmitResult>;
  onNavigateLogin: () => void;
};

export function SignupForm({ onSubmit, onNavigateLogin }: SignupFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<SignupFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);

  async function handleSubmit() {
    if (submitting) return;
    const v = validateSignupForm({ email, password, confirmPassword, firstName, lastName });
    setErrors(v);
    setBanner(null);
    if (Object.keys(v).length > 0) return;

    setSubmitting(true);
    try {
      const payload: SignupFormPayload = {
        email: email.trim().toLowerCase(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      };
      const result = await onSubmit(payload);
      if (result.ok) return; // parent navigates away
      const message = mapErrorToUserMessage(result.code);
      // password_policy_violation → inline error under password field
      if (result.code === 'auth.signup.password_policy_violation') {
        setErrors({ password: message });
        return;
      }
      setBanner(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>G</Text>
        </View>
        <Text style={styles.wordmark}>GarageOS</Text>
      </View>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          editable={!submitting}
        />
        {errors.email ? <Text style={styles.fieldError}>{errors.email}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          editable={!submitting}
        />
        <Text style={styles.helper}>Almeno 8 caratteri, una lettera minuscola, un numero</Text>
        {errors.password ? <Text style={styles.fieldError}>{errors.password}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Conferma password</Text>
        <TextInput
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Conferma password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          editable={!submitting}
        />
        {errors.confirmPassword ? (
          <Text style={styles.fieldError}>{errors.confirmPassword}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Nome</Text>
        <TextInput
          style={styles.input}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Nome"
          autoCapitalize="words"
          autoComplete="given-name"
          editable={!submitting}
        />
        {errors.firstName ? <Text style={styles.fieldError}>{errors.firstName}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Cognome</Text>
        <TextInput
          style={styles.input}
          value={lastName}
          onChangeText={setLastName}
          placeholder="Cognome"
          autoCapitalize="words"
          autoComplete="family-name"
          editable={!submitting}
        />
        {errors.lastName ? <Text style={styles.fieldError}>{errors.lastName}</Text> : null}
      </View>

      <Pressable
        onPress={handleSubmit}
        accessibilityRole="button"
        disabled={submitting}
        style={({ pressed }) => [
          styles.submit,
          pressed && styles.submitPressed,
          submitting && styles.submitDisabled,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryFg} />
        ) : (
          <Text style={styles.submitText}>Registrati</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onNavigateLogin}
        style={styles.linkRow}
        accessibilityRole="link"
        disabled={submitting}
      >
        <Text style={styles.linkText}>Hai già un account? Accedi</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
  brand: { alignItems: 'center', marginBottom: spacing.lg, gap: spacing.sm },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.primaryFg, fontSize: 28, fontWeight: 'bold' },
  wordmark: { fontSize: 24, fontWeight: '700', color: colors.fg, letterSpacing: -0.5 },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.fg,
    backgroundColor: colors.bg,
  },
  helper: { fontSize: 12, color: colors.muted },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  submit: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitPressed: { opacity: 0.8 },
  submitDisabled: { backgroundColor: colors.muted },
  submitText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  linkRow: { alignItems: 'center', padding: spacing.sm },
  linkText: { color: colors.primary, fontSize: 14 },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/components/SignupForm.test.tsx`

Expected: 8/8 PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/components/auth/SignupForm.tsx packages/mobile/tests/components/SignupForm.test.tsx
git commit -m "feat(mobile): add SignupForm component

Controlled-state RN form with 5 fields (email, password, confirm, first,
last), helper text on password, inline + banner error display, double-
submit guard. Mirrors app/login.tsx style. Maps API
auth.signup.password_policy_violation to inline password error; other
domain codes show as banner above the form.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: /signup screen route

Mounts `SignupForm`, owns the post-201 orchestration: call `AuthContext.signIn(email, password)`, navigate to `/verify-email-sent?email=...` on success. On SRP failure: redirect to `/login` (signup itself succeeded — credentials are valid in Cognito).

**Files:**
- Create: `packages/mobile/app/signup.tsx`
- Create: `packages/mobile/tests/screens/signup.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/screens/signup.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Signup from '../../app/signup';
import { AuthProvider } from '@/auth/AuthContext';
import * as signupQuery from '@/queries/signup';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useRouter } from 'expo-router';

jest.mock('@/queries/signup');
jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedSignup = signupQuery as jest.Mocked<typeof signupQuery>;
const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;

function fillForm() {
  fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
  fireEvent.changeText(screen.getByPlaceholderText('Password'), 'miapassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'miapassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Nome'), 'Mario');
  fireEvent.changeText(screen.getByPlaceholderText('Cognome'), 'Rossi');
}

function renderSignup() {
  return render(
    <AuthProvider>
      <Signup />
    </AuthProvider>,
  );
}

describe('Signup screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedStorage.writeTokens.mockResolvedValue();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
  });

  it('renders the SignupForm', () => {
    renderSignup();
    expect(screen.getByRole('button', { name: 'Registrati' })).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('on success: calls signupCustomer + signIn + replaces to /verify-email-sent', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: true,
      customer: {
        id: 'cust-1',
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        status: 'active',
        createdAt: '2026-05-15T12:00:00Z',
      },
    });
    mockedCognito.signInSrp.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust-1',
      email: 'mario.rossi@example.com',
    });
    renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith({
        pathname: '/verify-email-sent',
        params: { email: 'mario.rossi@example.com' },
      }),
    );
    expect(mockedSignup.signupCustomer).toHaveBeenCalledWith({
      email: 'mario.rossi@example.com',
      password: 'miapassword1',
      firstName: 'Mario',
      lastName: 'Rossi',
    });
    expect(mockedCognito.signInSrp).toHaveBeenCalledWith(
      'mario.rossi@example.com',
      'miapassword1',
    );
  });

  it('on signupCustomer failure: banner shown, no signIn call', async () => {
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
    renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText(/Un account con questa email è già registrato/)).toBeOnTheScreen();
    });
    expect(mockedCognito.signInSrp).not.toHaveBeenCalled();
  });

  it('on signIn failure post-signup: redirects to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: true,
      customer: {
        id: 'cust-1',
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        status: 'active',
        createdAt: '2026-05-15T12:00:00Z',
      },
    });
    mockedCognito.signInSrp.mockRejectedValue(new Error('SRP transient'));
    renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/screens/signup.test.tsx`

Expected: 4 tests FAIL with `Cannot find module '../../app/signup'`.

- [ ] **Step 3: Write the screen**

Create `packages/mobile/app/signup.tsx`:

```tsx
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { SignupForm, type SignupFormPayload } from '@/components/auth/SignupForm';
import { signupCustomer } from '@/queries/signup';
import { colors } from '@/theme/colors';

export default function Signup() {
  const { signIn } = useAuth();
  const router = useRouter();

  async function handleSubmit(payload: SignupFormPayload) {
    const result = await signupCustomer(payload);
    if (!result.ok) {
      return result;
    }
    try {
      await signIn(payload.email, payload.password);
      router.replace({
        pathname: '/verify-email-sent',
        params: { email: payload.email },
      });
    } catch {
      // Signup succeeded server-side but Cognito SRP failed (eventual
      // consistency or transient). Tell the user to log in manually.
      router.replace('/login');
    }
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <SignupForm onSubmit={handleSubmit} onNavigateLogin={() => router.back()} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center' },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/screens/signup.test.tsx`

Expected: 4/4 PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/signup.tsx packages/mobile/tests/screens/signup.test.tsx
git commit -m "feat(mobile): add /signup screen route

Wraps SignupForm in SafeArea+KeyboardAvoiding+ScrollView (mirror login.tsx).
Owns post-201 orchestration: signupCustomer -> AuthContext.signIn ->
router.replace to /verify-email-sent. On SRP failure (eventual consistency
between AdminSetUserPassword and InitiateAuth), falls back to /login.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: /verify-email-sent screen

Static informational screen + resend button with 60s cooldown + continue button + back-to-login link.

**Files:**
- Create: `packages/mobile/app/verify-email-sent.tsx`
- Create: `packages/mobile/tests/screens/verify-email-sent.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/screens/verify-email-sent.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import VerifyEmailSent from '../../app/verify-email-sent';
import { AuthProvider } from '@/auth/AuthContext';
import * as signupQuery from '@/queries/signup';
import * as storage from '@/lib/secure-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';

jest.mock('@/queries/signup');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useLocalSearchParams: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedSignup = signupQuery as jest.Mocked<typeof signupQuery>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

function renderScreen() {
  return render(
    <AuthProvider>
      <VerifyEmailSent />
    </AuthProvider>,
  );
}

describe('VerifyEmailSent screen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedStorage.clearTokens.mockResolvedValue();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn() });
    mockedParams.mockReturnValue({ email: 'mario.rossi@example.com' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('displays the email from search params', () => {
    renderScreen();
    expect(screen.getByText(/mario.rossi@example.com/)).toBeOnTheScreen();
  });

  it('calls resendVerification and starts 60s cooldown on tap', async () => {
    mockedSignup.resendVerification.mockResolvedValue({ ok: true });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo/ }));
    await waitFor(() =>
      expect(mockedSignup.resendVerification).toHaveBeenCalledWith('mario.rossi@example.com'),
    );
    await waitFor(() => {
      expect(screen.getByText(/Invia di nuovo \(60s\)/)).toBeOnTheScreen();
    });
  });

  it('decrements the cooldown countdown each second', async () => {
    mockedSignup.resendVerification.mockResolvedValue({ ok: true });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo/ }));
    await waitFor(() => {
      expect(screen.getByText(/Invia di nuovo \(60s\)/)).toBeOnTheScreen();
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/Invia di nuovo \(57s\)/)).toBeOnTheScreen();
  });

  it('"Continua" replaces to /(tabs)', () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Continua' }));
    expect(replace).toHaveBeenCalledWith('/(tabs)');
  });

  it('"Torna al login" signs out and replaces to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    renderScreen();
    fireEvent.press(screen.getByText(/Torna al login/));
    await waitFor(() => expect(mockedStorage.clearTokens).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/screens/verify-email-sent.test.tsx`

Expected: 5 tests FAIL with `Cannot find module '../../app/verify-email-sent'`.

- [ ] **Step 3: Write the screen**

Create `packages/mobile/app/verify-email-sent.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { resendVerification } from '@/queries/signup';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

const COOLDOWN_SECONDS = 60;

export default function VerifyEmailSent() {
  const router = useRouter();
  const { signOut } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function startCooldown() {
    setCooldown(COOLDOWN_SECONDS);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function handleResend() {
    if (busy || cooldown > 0 || !email) return;
    setBusy(true);
    setFeedback(null);
    const result = await resendVerification(email);
    setBusy(false);
    if (result.ok) {
      setFeedback('Email inviata.');
      startCooldown();
    } else {
      setFeedback(mapErrorToUserMessage(result.code));
    }
  }

  async function handleBackToLogin() {
    await signOut();
    router.replace('/login');
  }

  const resendDisabled = busy || cooldown > 0 || !email;
  const resendLabel = cooldown > 0 ? `Invia di nuovo (${cooldown}s)` : 'Invia di nuovo';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>G</Text>
          </View>
          <Text style={styles.wordmark}>GarageOS</Text>
        </View>

        <Text style={styles.icon}>✉️</Text>
        <Text style={styles.h1}>Conferma la tua email</Text>
        <Text style={styles.body}>
          Abbiamo inviato un link di verifica a <Text style={styles.bodyStrong}>{email}</Text>.
          Clicca sul link per confermare il tuo indirizzo.
        </Text>

        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}

        <Pressable
          onPress={handleResend}
          accessibilityRole="button"
          disabled={resendDisabled}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.pressed,
            resendDisabled && styles.secondaryDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={styles.secondaryText}>{resendLabel}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => router.replace('/(tabs)')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>Continua</Text>
        </Pressable>

        <Pressable onPress={handleBackToLogin} style={styles.linkRow} accessibilityRole="link">
          <Text style={styles.linkText}>Email sbagliata? Torna al login</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  brand: { alignItems: 'center', marginBottom: spacing.lg, gap: spacing.sm },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.primaryFg, fontSize: 28, fontWeight: 'bold' },
  wordmark: { fontSize: 24, fontWeight: '700', color: colors.fg, letterSpacing: -0.5 },
  icon: { fontSize: 56, textAlign: 'center' },
  h1: { fontSize: 22, fontWeight: '700', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 15, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  bodyStrong: { color: colors.fg, fontWeight: '600' },
  feedback: { fontSize: 13, color: colors.muted, textAlign: 'center' },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryDisabled: { opacity: 0.6 },
  secondaryText: { color: colors.primary, fontSize: 16, fontWeight: '500' },
  pressed: { opacity: 0.8 },
  linkRow: { alignItems: 'center', padding: spacing.sm },
  linkText: { color: colors.primary, fontSize: 14 },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/screens/verify-email-sent.test.tsx`

Expected: 5/5 PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/verify-email-sent.tsx packages/mobile/tests/screens/verify-email-sent.test.tsx
git commit -m "feat(mobile): add /verify-email-sent screen

Informational screen post-signup: shows recipient email, lets the user
resend the verification email (60s cooldown countdown), and exposes
a primary 'Continua' button that replaces to /(tabs). Also a 'Torna al
login' escape that signs out and replaces to /login.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the "Registrati" link on /login

Currently stubbed with `Alert.alert('Disponibile a breve')`. Replace with `router.push('/signup')`. Update the login screen test.

**Files:**
- Modify: `packages/mobile/app/login.tsx`
- Modify: `packages/mobile/tests/screens/login.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to the `describe('Login screen', ...)` block in `packages/mobile/tests/screens/login.test.tsx`:

```ts
  it('navigates to /signup when "Registrati" link tapped', () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push });
    renderLogin();
    fireEvent.press(screen.getByText(/Non hai un account/));
    expect(push).toHaveBeenCalledWith('/signup');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile test tests/screens/login.test.tsx`

Expected: the new test FAILS — push is not called because the current handler calls `Alert.alert`.

- [ ] **Step 3: Update login.tsx**

In `packages/mobile/app/login.tsx`:

Locate (around line 121-127):

```tsx
        <Pressable
          onPress={() => Alert.alert('Disponibile a breve')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Non hai un account? Registrati</Text>
        </Pressable>
```

Replace with:

```tsx
        <Pressable
          onPress={() => router.push('/signup')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Non hai un account? Registrati</Text>
        </Pressable>
```

(The `useRouter` hook is already imported and `router` is already defined in the component — no other change needed. The `Alert` import may become unused if "Hai dimenticato la password?" was the only other consumer — check: it still uses Alert.alert, so keep the import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test tests/screens/login.test.tsx`

Expected: all login tests PASS (6 existing + 1 new = 7).

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/app/login.tsx packages/mobile/tests/screens/login.test.tsx
git commit -m "feat(mobile): wire login 'Registrati' link to /signup

Replace the placeholder Alert with router.push('/signup'). The
'Hai dimenticato la password?' link stays stubbed (F-CLI-002, future slice).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full mobile suite gate

Run the full mobile test suite and typecheck to confirm no regressions.

- [ ] **Step 1: Run full mobile typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`

Expected: PASS, no errors.

- [ ] **Step 2: Run full mobile test suite**

Run: `pnpm --filter @garageos/mobile test`

Expected: all mobile tests PASS. New suites:
- `tests/lib/validators/signup.test.ts` — 8 tests
- `tests/queries/signup.test.ts` — 10 tests
- `tests/components/SignupForm.test.tsx` — 8 tests
- `tests/screens/signup.test.tsx` — 4 tests
- `tests/screens/verify-email-sent.test.tsx` — 5 tests
- `tests/lib/error-messages.test.ts` — 4 existing + 6 new = 10 tests
- `tests/screens/login.test.tsx` — 6 existing + 1 new = 7 tests

Approx 35 new tests + existing ~20-30 existing mobile = ~55-65 total PASS.

- [ ] **Step 3: If failures, diagnose and fix**

Common failure modes to watch for:
- Snapshot drift on `login.test.tsx` if any existing test asserted absence of the Registrati onPress behavior (unlikely — existing tests use `getByPlaceholderText` not snapshots).
- `act()` warnings around the cooldown timer in `verify-email-sent.test.tsx` — if any appear, wrap state updates in `act(() => jest.advanceTimersByTime(...))`.
- `expo-router` mock missing `useLocalSearchParams` in older tests — only `verify-email-sent` uses it; the existing `expo-router` mocks in `login.test.tsx` and `signup.test.tsx` only need `useRouter`. No cross-contamination expected because each file declares its own `jest.mock('expo-router', ...)`.

Fix in place, re-run, ensure green.

- [ ] **Step 4: No commit at this step** (gate-only).

---

## Task 9: Pre-push verification + push

- [ ] **Step 1: Confirm clean diff**

Run: `git status` and `git log --oneline main..HEAD`

Expected output of `git log --oneline main..HEAD`:
```
<sha> feat(mobile): wire login 'Registrati' link to /signup
<sha> feat(mobile): add /verify-email-sent screen
<sha> feat(mobile): add /signup screen route
<sha> feat(mobile): add SignupForm component
<sha> feat(mobile): add signupCustomer + resendVerification wrappers
<sha> feat(mobile): add signup form validator
<sha> feat(mobile): add signup domain error code mappings
fc28dc1 docs(mobile): spec mobile signup UI (F-CLI-001)
```

8 commits on the branch.

- [ ] **Step 2: Run repo-wide typecheck (pre-push hook will run this anyway)**

Run: `pnpm -r typecheck`

Expected: PASS for all workspaces.

- [ ] **Step 3: Push**

Run: `git push -u origin feat/mobile-signup-ui`

Expected: pre-push hook runs `pnpm -r typecheck` (~30s), exit 0, push succeeds.

- [ ] **Step 4: Open PR**

Use `gh pr create` with title `feat(mobile): signup UI + verify-email-sent (F-CLI-001)` and body following the CLAUDE.md PR template. Include:
- Link to spec `docs/superpowers/specs/2026-05-15-mobile-signup-ui-design.md`.
- Reference F-CLI-001 from GarageOS-Specifiche.
- Test summary (~35 new unit tests).
- Smoke runbook reference (spec §8).
- Note: backend zero changes; relies on /v1/auth/signup (PR #55) + /v1/auth/resend-verification (PR #57) + Lambda IAM fixes (PR #101).

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch` (or `gh run watch`).

Expected: all 11 checks green (Format, Lint, Typecheck, Mobile, CDK, CodeQL, Commitlint, Integration, ... — see existing PR #105 for the canonical list).

- [ ] **Step 6: Operator (Michele) smoke runbook**

Spec §8 details the Xiaomi 13T Pro smoke procedure. Until that's done, the PR is ready for review but not for merge. (Smoke runbook reference is documented in PR description, not a blocking task here.)

---

## Self-Review Checklist (done by author)

**Spec coverage:**
- §1 Goal → Tasks 1-9 collectively
- §3.1 Pure fetch wrapper → Task 3
- §3.2 Auto-login + fallback to /login → Task 5
- §3.3 Verify-email non gating → Task 6 (Continua → /(tabs))
- §3.4 Stack `push` from login + `replace` forward → Tasks 5, 6, 7
- §3.5 Cognito policy mirror → Task 2
- §4.1 Signup contract codes → Tasks 1, 3, 4
- §4.2 Resend contract → Tasks 1, 3, 6
- §5.1 + §5.2 File map → all task headers
- §6.1 Form layout → Task 4
- §6.2 Submit flow → Task 5
- §6.3 Verify screen → Task 6
- §6.4 No RHF → Task 4 (controlled state)
- §7 Test plan → embedded per-task test cases (cases breakdown matches exactly)
- §10 LOC estimate → distributed across tasks

**Placeholder scan:** No TBD/TODO/"similar to". Every code block is complete and self-contained.

**Type consistency:**
- `SignupFormPayload` defined in Task 4, consumed by Task 5 — same 4 fields (email, password, firstName, lastName).
- `SignupResult` defined in Task 3 — discriminated `{ok:true,customer}` | `{ok:false,code,message}`. Task 5 narrows on `result.ok`.
- `SignupFormErrors` defined in Task 2, consumed by Task 4.
- `validateSignupForm` signature: input shape `SignupFormInput` (5 fields including confirmPassword) → output `SignupFormErrors`. Consistent.

**Scope check:** 1 PR ~880 LOC. No sub-projects.

**Ambiguity check:** All decisions explicit:
- No RHF/Zod (controlled state, validators module).
- RFC 7807 problem+json shape (`code`, `detail`) — explicit in Task 3 implementation + tests.
- Auto-login failure → `/login` redirect (no toast — Tasks 5 + verifies in test).
- Email passed as `useLocalSearchParams` param (Task 6).
- Cooldown 60s via `setInterval` + cleanup on unmount (Task 6).
- `Alert` import in `login.tsx` stays because "forgot password" link still uses it (Task 7).

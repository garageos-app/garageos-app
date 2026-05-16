# F-CLI-002 Mobile Password Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mobile password recovery flow (forgot-password → reset-password) to the Expo client app, wired to Cognito Identity Provider client-side (no new API endpoint), replacing the placeholder Alert on the login screen.

**Architecture:** Two screens (`/forgot-password`, `/reset-password`) built as thin orchestrators on top of `amazon-cognito-identity-js` calls (`CognitoUser.forgotPassword` and `CognitoUser.confirmPassword`). Wrapper functions in `src/lib/cognito.ts` return discriminated unions (`{ok: true} | {ok: false, code}`); presentational form components mirror the SignupForm pattern from PR #106. `UserNotFoundException` is silenced wrapper-side as an anti-enumeration measure.

**Tech Stack:** Expo SDK 52, React Native 0.76.9, TypeScript strict, `amazon-cognito-identity-js@6.3.12`, jest + `@testing-library/react-native`, expo-router file-based routing.

**Branch:** `feat/mobile-password-recovery` (already created, spec committed at `b22ed5b`).

**Spec reference:** `docs/superpowers/specs/2026-05-16-f-cli-002-mobile-password-recovery-design.md`

---

## File map

**Create (11):**
- `packages/mobile/src/lib/validators/forgotPassword.ts`
- `packages/mobile/src/lib/validators/resetPassword.ts`
- `packages/mobile/src/components/auth/ForgotPasswordForm.tsx`
- `packages/mobile/src/components/auth/ResetPasswordForm.tsx`
- `packages/mobile/app/forgot-password.tsx`
- `packages/mobile/app/reset-password.tsx`
- `packages/mobile/tests/lib/validators/forgotPassword.test.ts`
- `packages/mobile/tests/lib/validators/resetPassword.test.ts`
- `packages/mobile/tests/lib/cognito-forgot-password.test.ts`
- `packages/mobile/tests/components/ForgotPasswordForm.test.tsx`
- `packages/mobile/tests/components/ResetPasswordForm.test.tsx`
- `packages/mobile/tests/screens/forgot-password.test.tsx`
- `packages/mobile/tests/screens/reset-password.test.tsx`

**Modify (4):**
- `packages/mobile/src/lib/cognito.ts` — add `forgotPasswordRequest` + `confirmForgotPassword`
- `packages/mobile/src/lib/error-messages.ts` — add Cognito reset codes
- `packages/mobile/tests/lib/error-messages.test.ts` — add new code assertions
- `packages/mobile/app/login.tsx` — replace Alert with navigation push

---

## Conventions reused

- **Discriminated result type:** `{ ok: true; … } | { ok: false; code: string; message?: string }` — mirror of `queries/signup.ts` (see `feedback_hook_return_result_not_state`).
- **Italian copy:** all user-facing strings IT, codice/comments EN.
- **Validator:** pure JS function returning `Partial<Record<keyof Input, string>>` — same shape as `validators/signup.ts`.
- **Component pattern:** presentational component takes `onSubmit: (...) => Promise<Result>` prop, manages local state, no router/cognito imports. Screen orchestrator wires router + cognito wrappers.
- **Test render:** screen tests use `renderWithAuth` helper to flush AuthProvider rehydration `act()` warning.
- **Test mocks:** `jest.mock('@/lib/cognito')` + `jest.mock('expo-router', () => ({ useRouter: jest.fn(), useLocalSearchParams: jest.fn(), Link: ... }))`.
- **Mobile typecheck/test:** `pnpm --filter @garageos/mobile typecheck` and `pnpm --filter @garageos/mobile test`. The local pre-push hook runs only `pnpm -r typecheck`; full test suite gated on CI.

---

## Task 1: Validators (forgot + reset password)

**Files:**
- Create: `packages/mobile/src/lib/validators/forgotPassword.ts`
- Create: `packages/mobile/src/lib/validators/resetPassword.ts`
- Test: `packages/mobile/tests/lib/validators/forgotPassword.test.ts`
- Test: `packages/mobile/tests/lib/validators/resetPassword.test.ts`

- [ ] **Step 1.1 — Write the failing test for forgotPassword validator**

Create `packages/mobile/tests/lib/validators/forgotPassword.test.ts`:

```ts
import { validateForgotPassword } from '@/lib/validators/forgotPassword';

describe('validateForgotPassword', () => {
  it('flags empty email', () => {
    expect(validateForgotPassword({ email: '' })).toEqual({ email: 'Email obbligatoria' });
  });

  it('flags malformed email', () => {
    expect(validateForgotPassword({ email: 'not-an-email' })).toEqual({ email: 'Email non valida' });
  });

  it('accepts a valid email', () => {
    expect(validateForgotPassword({ email: 'mario.rossi@example.com' })).toEqual({});
  });
});
```

- [ ] **Step 1.2 — Run the test, expect failure (module not found)**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/validators/forgotPassword.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validators/forgotPassword'`.

- [ ] **Step 1.3 — Implement forgotPassword validator**

Create `packages/mobile/src/lib/validators/forgotPassword.ts`:

```ts
// Pure validator for the forgot-password form. Mirrors validators/signup.ts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ForgotPasswordInput = { email: string };
export type ForgotPasswordErrors = Partial<Record<keyof ForgotPasswordInput, string>>;

export function validateForgotPassword(input: ForgotPasswordInput): ForgotPasswordErrors {
  const errors: ForgotPasswordErrors = {};
  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
  }
  return errors;
}
```

- [ ] **Step 1.4 — Run the test, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/validators/forgotPassword.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 1.5 — Write failing tests for resetPassword validator**

Create `packages/mobile/tests/lib/validators/resetPassword.test.ts`:

```ts
import { validateResetPassword } from '@/lib/validators/resetPassword';

const VALID = {
  email: 'mario.rossi@example.com',
  code: '123456',
  password: 'newpassword1',
  confirmPassword: 'newpassword1',
};

describe('validateResetPassword', () => {
  it('returns no errors for valid input', () => {
    expect(validateResetPassword(VALID)).toEqual({});
  });

  it('flags empty code', () => {
    expect(validateResetPassword({ ...VALID, code: '' })).toEqual({ code: 'Codice obbligatorio' });
  });

  it('flags non-numeric code', () => {
    expect(validateResetPassword({ ...VALID, code: 'abc123' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags code shorter than 6 digits', () => {
    expect(validateResetPassword({ ...VALID, code: '12345' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags code longer than 6 digits', () => {
    expect(validateResetPassword({ ...VALID, code: '1234567' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags empty password', () => {
    expect(validateResetPassword({ ...VALID, password: '', confirmPassword: '' })).toEqual({
      password: 'Password obbligatoria',
      confirmPassword: 'Conferma la password',
    });
  });

  it('flags password shorter than 8', () => {
    expect(validateResetPassword({ ...VALID, password: 'ab1', confirmPassword: 'ab1' })).toEqual({
      password: 'Almeno 8 caratteri',
    });
  });

  it('flags password without lowercase', () => {
    expect(
      validateResetPassword({ ...VALID, password: 'ABCDEFG1', confirmPassword: 'ABCDEFG1' }),
    ).toEqual({ password: 'Almeno una lettera minuscola' });
  });

  it('flags password without digit', () => {
    expect(
      validateResetPassword({ ...VALID, password: 'abcdefgh', confirmPassword: 'abcdefgh' }),
    ).toEqual({ password: 'Almeno un numero' });
  });

  it('flags mismatched confirmPassword', () => {
    expect(validateResetPassword({ ...VALID, confirmPassword: 'different1' })).toEqual({
      confirmPassword: 'Le password non coincidono',
    });
  });

  it('flags empty email', () => {
    expect(validateResetPassword({ ...VALID, email: '' })).toEqual({ email: 'Email obbligatoria' });
  });

  it('flags malformed email', () => {
    expect(validateResetPassword({ ...VALID, email: 'not-an-email' })).toEqual({
      email: 'Email non valida',
    });
  });
});
```

- [ ] **Step 1.6 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/validators/resetPassword.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.7 — Implement resetPassword validator**

Create `packages/mobile/src/lib/validators/resetPassword.ts`:

```ts
// Pure validator for the reset-password form. Mirrors validators/signup.ts
// password policy and adds 6-digit Cognito confirmation-code validation.
// The Cognito clienti pool policy is the authoritative gate (see
// infrastructure/lib/constructs/cognito.ts:86-91); this client-side check is
// best-effort UX. Server rejection surfaces as InvalidPasswordException.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_REGEX = /^\d{6}$/;

export type ResetPasswordInput = {
  email: string;
  code: string;
  password: string;
  confirmPassword: string;
};

export type ResetPasswordErrors = Partial<Record<keyof ResetPasswordInput, string>>;

export function validateResetPassword(input: ResetPasswordInput): ResetPasswordErrors {
  const errors: ResetPasswordErrors = {};

  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
  }

  if (!input.code) {
    errors.code = 'Codice obbligatorio';
  } else if (!CODE_REGEX.test(input.code)) {
    errors.code = 'Il codice deve essere di 6 cifre';
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

  return errors;
}
```

- [ ] **Step 1.8 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/validators`
Expected: PASS — both files green (15 tests total).

- [ ] **Step 1.9 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/src/lib/validators/forgotPassword.ts \
        packages/mobile/src/lib/validators/resetPassword.ts \
        packages/mobile/tests/lib/validators/forgotPassword.test.ts \
        packages/mobile/tests/lib/validators/resetPassword.test.ts
git commit -m "feat(mobile): F-CLI-002 add forgot/reset password validators"
```

---

## Task 2: Cognito SDK wrappers (forgotPasswordRequest + confirmForgotPassword)

**Files:**
- Modify: `packages/mobile/src/lib/cognito.ts`
- Test: `packages/mobile/tests/lib/cognito-forgot-password.test.ts`

- [ ] **Step 2.1 — Write the failing test**

Create `packages/mobile/tests/lib/cognito-forgot-password.test.ts`:

```ts
// Mocks amazon-cognito-identity-js at the module level so we can verify
// CognitoUser.forgotPassword + confirmPassword are wired to the right
// callbacks and that the wrapper resolves the discriminated union shape.

const forgotPasswordMock = jest.fn();
const confirmPasswordMock = jest.fn();

jest.mock('amazon-cognito-identity-js', () => ({
  __esModule: true,
  CognitoUserPool: jest.fn().mockImplementation(() => ({})),
  CognitoUser: jest.fn().mockImplementation(() => ({
    forgotPassword: forgotPasswordMock,
    confirmPassword: confirmPasswordMock,
  })),
  // Stubs not exercised by these tests but required so cognito.ts imports
  // type-check against the mocked module.
  AuthenticationDetails: jest.fn(),
}));

import { forgotPasswordRequest, confirmForgotPassword } from '@/lib/cognito';

describe('forgotPasswordRequest', () => {
  beforeEach(() => {
    forgotPasswordMock.mockReset();
  });

  it('resolves ok:true with deliveryMedium on success', async () => {
    forgotPasswordMock.mockImplementation((callbacks: { onSuccess: (data: unknown) => void }) => {
      callbacks.onSuccess({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
    });
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
  });

  it('resolves ok:true UNKNOWN delivery when payload missing', async () => {
    forgotPasswordMock.mockImplementation((callbacks: { onSuccess: (data: unknown) => void }) => {
      callbacks.onSuccess({});
    });
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'UNKNOWN',
    });
  });

  it('silences UserNotFoundException and resolves ok:true (anti-enumeration)', async () => {
    forgotPasswordMock.mockImplementation(
      (callbacks: { onFailure: (err: { code?: string; name?: string }) => void }) => {
        callbacks.onFailure({ code: 'UserNotFoundException', name: 'UserNotFoundException' });
      },
    );
    await expect(forgotPasswordRequest('nobody@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'UNKNOWN',
    });
  });

  it('resolves ok:false on LimitExceededException', async () => {
    forgotPasswordMock.mockImplementation(
      (callbacks: { onFailure: (err: { code?: string; name?: string }) => void }) => {
        callbacks.onFailure({ code: 'LimitExceededException', name: 'LimitExceededException' });
      },
    );
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: false,
      code: 'LimitExceededException',
    });
  });

  it('falls back to err.name when code is missing', async () => {
    forgotPasswordMock.mockImplementation(
      (callbacks: { onFailure: (err: { name?: string }) => void }) => {
        callbacks.onFailure({ name: 'NotAuthorizedException' });
      },
    );
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: false,
      code: 'NotAuthorizedException',
    });
  });
});

describe('confirmForgotPassword', () => {
  beforeEach(() => {
    confirmPasswordMock.mockReset();
  });

  it('resolves ok:true on success', async () => {
    confirmPasswordMock.mockImplementation(
      (_code: string, _pwd: string, callbacks: { onSuccess: () => void }) => {
        callbacks.onSuccess();
      },
    );
    await expect(
      confirmForgotPassword('u@example.com', '123456', 'newpassword1'),
    ).resolves.toEqual({ ok: true });
  });

  it('forwards code+password to the SDK', async () => {
    confirmPasswordMock.mockImplementation(
      (_code: string, _pwd: string, callbacks: { onSuccess: () => void }) => {
        callbacks.onSuccess();
      },
    );
    await confirmForgotPassword('u@example.com', '654321', 'newpassword2');
    expect(confirmPasswordMock).toHaveBeenCalledWith('654321', 'newpassword2', expect.any(Object));
  });

  it('resolves ok:false on CodeMismatchException', async () => {
    confirmPasswordMock.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({ code: 'CodeMismatchException', name: 'CodeMismatchException' });
      },
    );
    await expect(
      confirmForgotPassword('u@example.com', 'bad000', 'newpassword1'),
    ).resolves.toEqual({ ok: false, code: 'CodeMismatchException' });
  });

  it('resolves ok:false on ExpiredCodeException', async () => {
    confirmPasswordMock.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({ code: 'ExpiredCodeException', name: 'ExpiredCodeException' });
      },
    );
    await expect(
      confirmForgotPassword('u@example.com', '000000', 'newpassword1'),
    ).resolves.toEqual({ ok: false, code: 'ExpiredCodeException' });
  });

  it('resolves ok:false on InvalidPasswordException', async () => {
    confirmPasswordMock.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({
          code: 'InvalidPasswordException',
          name: 'InvalidPasswordException',
        });
      },
    );
    await expect(
      confirmForgotPassword('u@example.com', '123456', 'short'),
    ).resolves.toEqual({ ok: false, code: 'InvalidPasswordException' });
  });
});
```

- [ ] **Step 2.2 — Run the test, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/cognito-forgot-password.test.ts`
Expected: FAIL — `forgotPasswordRequest` / `confirmForgotPassword` not exported.

- [ ] **Step 2.3 — Add the wrappers to cognito.ts**

Append to `packages/mobile/src/lib/cognito.ts` (after the existing `refreshSession` export, before EOF):

```ts
export type ForgotPasswordResult =
  | { ok: true; deliveryMedium: 'EMAIL' | 'SMS' | 'UNKNOWN' }
  | { ok: false; code: string };

// Anti-enumeration: UserNotFoundException is treated as success so the UI
// flow is identical for registered vs unregistered emails. The user typing
// a wrong email will simply never receive a code and the next-screen confirm
// will fail with CodeMismatchException. See spec §2.2.
function extractDeliveryMedium(data: unknown): 'EMAIL' | 'SMS' | 'UNKNOWN' {
  if (typeof data === 'object' && data !== null) {
    const details = (data as { CodeDeliveryDetails?: { DeliveryMedium?: string } })
      .CodeDeliveryDetails;
    if (details?.DeliveryMedium === 'EMAIL') return 'EMAIL';
    if (details?.DeliveryMedium === 'SMS') return 'SMS';
  }
  return 'UNKNOWN';
}

function extractErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: string; name?: string };
    return e.code ?? e.name ?? 'UnknownError';
  }
  return 'UnknownError';
}

export function forgotPasswordRequest(email: string): Promise<ForgotPasswordResult> {
  return new Promise((resolve) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    user.forgotPassword({
      onSuccess: (data: unknown) => {
        resolve({ ok: true, deliveryMedium: extractDeliveryMedium(data) });
      },
      onFailure: (err: unknown) => {
        const code = extractErrorCode(err);
        if (code === 'UserNotFoundException') {
          resolve({ ok: true, deliveryMedium: 'UNKNOWN' });
          return;
        }
        resolve({ ok: false, code });
      },
    });
  });
}

export type ConfirmForgotPasswordResult = { ok: true } | { ok: false; code: string };

export function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<ConfirmForgotPasswordResult> {
  return new Promise((resolve) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    user.confirmPassword(code, newPassword, {
      onSuccess: () => resolve({ ok: true }),
      onFailure: (err: unknown) => resolve({ ok: false, code: extractErrorCode(err) }),
    });
  });
}
```

- [ ] **Step 2.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/cognito-forgot-password.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 2.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/src/lib/cognito.ts \
        packages/mobile/tests/lib/cognito-forgot-password.test.ts
git commit -m "feat(mobile): F-CLI-002 add forgot/confirm cognito wrappers"
```

---

## Task 3: Error-messages extension

**Files:**
- Modify: `packages/mobile/src/lib/error-messages.ts`
- Modify: `packages/mobile/tests/lib/error-messages.test.ts`

- [ ] **Step 3.1 — Add failing test cases**

Append to the bottom of the `describe('mapErrorToUserMessage', () => { … })` block in `packages/mobile/tests/lib/error-messages.test.ts`, just before the closing `});`:

```ts
  it('maps CodeMismatchException for password reset', () => {
    expect(mapErrorToUserMessage('CodeMismatchException')).toBe(
      "Codice non valido. Controlla l'email e riprova.",
    );
  });

  it('maps ExpiredCodeException for password reset', () => {
    expect(mapErrorToUserMessage('ExpiredCodeException')).toBe(
      'Il codice è scaduto. Richiedi un nuovo codice.',
    );
  });

  it('maps CodeDeliveryFailureException for password reset', () => {
    expect(mapErrorToUserMessage('CodeDeliveryFailureException')).toBe(
      "Errore nell'invio del codice. Riprova tra qualche minuto.",
    );
  });
```

NOTE: do NOT add a test for `InvalidPasswordException` here — its global mapping ("Email o password non corretti.") is shared with the login flow and must remain unchanged. The reset-password screen overrides this code inline (see Task 7).

- [ ] **Step 3.2 — Run, expect failures**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/error-messages.test.ts`
Expected: 3 new tests FAIL — fallback message returned instead.

- [ ] **Step 3.3 — Add the mappings**

In `packages/mobile/src/lib/error-messages.ts`, add these entries to the `MESSAGES` record (next to the other Cognito SDK errors at the top, after `InvalidPasswordException`):

```ts
  CodeMismatchException: "Codice non valido. Controlla l'email e riprova.",
  ExpiredCodeException: 'Il codice è scaduto. Richiedi un nuovo codice.',
  CodeDeliveryFailureException: "Errore nell'invio del codice. Riprova tra qualche minuto.",
```

- [ ] **Step 3.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/lib/error-messages.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 3.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/src/lib/error-messages.ts \
        packages/mobile/tests/lib/error-messages.test.ts
git commit -m "feat(mobile): F-CLI-002 map Cognito reset/code error codes"
```

---

## Task 4: ForgotPasswordForm component

**Files:**
- Create: `packages/mobile/src/components/auth/ForgotPasswordForm.tsx`
- Test: `packages/mobile/tests/components/ForgotPasswordForm.test.tsx`

- [ ] **Step 4.1 — Write the failing component test**

Create `packages/mobile/tests/components/ForgotPasswordForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';

describe('ForgotPasswordForm', () => {
  it('renders email input + submit button + back link', () => {
    render(<ForgotPasswordForm onSubmit={jest.fn()} onNavigateBack={jest.fn()} />);
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Invia codice' })).toBeOnTheScreen();
    expect(screen.getByText(/Torna al login/)).toBeOnTheScreen();
  });

  it('blocks submit and shows inline error when email empty', async () => {
    const onSubmit = jest.fn();
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText('Email obbligatoria')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit and shows inline error when email malformed', async () => {
    const onSubmit = jest.fn();
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'not-an-email');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText('Email non valida')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with trimmed lowercase email on valid input', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), '  Mario.Rossi@Example.com  ');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('mario.rossi@example.com');
    });
  });

  it('shows banner with mapped message when onSubmit returns ok:false', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'LimitExceededException' });
    render(<ForgotPasswordForm onSubmit={onSubmit} onNavigateBack={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText(/Troppi tentativi/)).toBeOnTheScreen();
    });
  });

  it('navigates back when "Torna al login" pressed', () => {
    const onBack = jest.fn();
    render(<ForgotPasswordForm onSubmit={jest.fn()} onNavigateBack={onBack} />);
    fireEvent.press(screen.getByText(/Torna al login/));
    expect(onBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4.2 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/components/ForgotPasswordForm.test.tsx`
Expected: FAIL — component module not found.

- [ ] **Step 4.3 — Implement ForgotPasswordForm**

Create `packages/mobile/src/components/auth/ForgotPasswordForm.tsx`:

```tsx
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  validateForgotPassword,
  type ForgotPasswordErrors,
} from '@/lib/validators/forgotPassword';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

export type ForgotPasswordFormResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

type Props = {
  onSubmit: (email: string) => Promise<ForgotPasswordFormResult>;
  onNavigateBack: () => void;
};

export function ForgotPasswordForm({ onSubmit, onNavigateBack }: Props) {
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<ForgotPasswordErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (submitting) return;
    const trimmed = email.trim();
    const v = validateForgotPassword({ email: trimmed });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const normalized = trimmed.toLowerCase();
      const result = await onSubmit(normalized);
      if (!result.ok) {
        setBanner(mapErrorToUserMessage(result.code));
      }
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

      <Text style={styles.h1}>Recupera la password</Text>
      <Text style={styles.body}>
        Inserisci l&apos;email del tuo account. Ti invieremo un codice per reimpostare la password.
      </Text>

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
          <Text style={styles.submitText}>Invia codice</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onNavigateBack}
        style={styles.linkRow}
        accessibilityRole="link"
        disabled={submitting}
      >
        <Text style={styles.linkText}>Torna al login</Text>
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
  h1: { fontSize: 22, fontWeight: '700', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 15, color: colors.muted, textAlign: 'center', lineHeight: 22 },
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

- [ ] **Step 4.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/components/ForgotPasswordForm.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 4.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/src/components/auth/ForgotPasswordForm.tsx \
        packages/mobile/tests/components/ForgotPasswordForm.test.tsx
git commit -m "feat(mobile): F-CLI-002 add ForgotPasswordForm component"
```

---

## Task 5: ResetPasswordForm component

**Files:**
- Create: `packages/mobile/src/components/auth/ResetPasswordForm.tsx`
- Test: `packages/mobile/tests/components/ResetPasswordForm.test.tsx`

- [ ] **Step 5.1 — Write the failing component test**

Create `packages/mobile/tests/components/ResetPasswordForm.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

const VALID = {
  email: 'mario.rossi@example.com',
  code: '123456',
  password: 'newpassword1',
  confirmPassword: 'newpassword1',
};

function fillValid(opts: { includeEmail: boolean }) {
  if (opts.includeEmail) {
    fireEvent.changeText(screen.getByPlaceholderText('Email'), VALID.email);
  }
  fireEvent.changeText(screen.getByPlaceholderText('Codice'), VALID.code);
  fireEvent.changeText(screen.getByPlaceholderText('Nuova password'), VALID.password);
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), VALID.confirmPassword);
}

describe('ResetPasswordForm', () => {
  it('hides email input when initialEmail is provided', () => {
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={jest.fn()}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText('Email')).toBeNull();
    expect(screen.getByPlaceholderText('Codice')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Nuova password')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Conferma password')).toBeOnTheScreen();
  });

  it('shows email input when initialEmail is null', () => {
    render(
      <ResetPasswordForm
        initialEmail={null}
        onSubmit={jest.fn()}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('blocks submit and shows inline errors when empty', async () => {
    const onSubmit = jest.fn();
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText('Codice obbligatorio')).toBeOnTheScreen();
    });
    expect(screen.getByText('Password obbligatoria')).toBeOnTheScreen();
    expect(screen.getByText('Conferma la password')).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit on password confirm mismatch', async () => {
    const onSubmit = jest.fn();
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'different1');
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with normalized payload on valid input', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: VALID.email,
        code: VALID.code,
        newPassword: VALID.password,
      });
    });
  });

  it('shows banner with mapped message on CodeMismatchException', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'CodeMismatchException' });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/Codice non valido/)).toBeOnTheScreen();
    });
  });

  it('routes InvalidPasswordException to inline password error (not banner)', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: false, code: 'InvalidPasswordException' });
    render(
      <ResetPasswordForm
        initialEmail={VALID.email}
        onSubmit={onSubmit}
        onResend={jest.fn()}
        onNavigateBack={jest.fn()}
      />,
    );
    fillValid({ includeEmail: false });
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/La password non rispetta i requisiti/)).toBeOnTheScreen();
    });
    // banner role=alert should not be on screen
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('resend cooldown', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('starts 60s cooldown on successful resend', async () => {
      const onResend = jest.fn().mockResolvedValue({ ok: true });
      render(
        <ResetPasswordForm
          initialEmail={VALID.email}
          onSubmit={jest.fn()}
          onResend={onResend}
          onNavigateBack={jest.fn()}
        />,
      );
      fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
      await waitFor(() => expect(onResend).toHaveBeenCalledWith(VALID.email));
      await waitFor(() => {
        expect(screen.getByText(/Invia di nuovo il codice \(60s\)/)).toBeOnTheScreen();
      });
    });

    it('decrements cooldown each second', async () => {
      const onResend = jest.fn().mockResolvedValue({ ok: true });
      render(
        <ResetPasswordForm
          initialEmail={VALID.email}
          onSubmit={jest.fn()}
          onResend={onResend}
          onNavigateBack={jest.fn()}
        />,
      );
      fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
      await waitFor(() => {
        expect(screen.getByText(/Invia di nuovo il codice \(60s\)/)).toBeOnTheScreen();
      });
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(screen.getByText(/Invia di nuovo il codice \(57s\)/)).toBeOnTheScreen();
    });
  });
});
```

- [ ] **Step 5.2 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/components/ResetPasswordForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5.3 — Implement ResetPasswordForm**

Create `packages/mobile/src/components/auth/ResetPasswordForm.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  validateResetPassword,
  type ResetPasswordErrors,
} from '@/lib/validators/resetPassword';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

const COOLDOWN_SECONDS = 60;

export type ResetPasswordPayload = {
  email: string;
  code: string;
  newPassword: string;
};

export type ResetPasswordFormResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

type Props = {
  initialEmail: string | null;
  onSubmit: (payload: ResetPasswordPayload) => Promise<ResetPasswordFormResult>;
  onResend: (email: string) => Promise<ResetPasswordFormResult>;
  onNavigateBack: () => void;
};

export function ResetPasswordForm({ initialEmail, onSubmit, onResend, onNavigateBack }: Props) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<ResetPasswordErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const emailHidden = initialEmail !== null;

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

  async function handleSubmit() {
    if (submitting) return;
    const trimmedEmail = (emailHidden ? (initialEmail ?? '') : email).trim().toLowerCase();
    const v = validateResetPassword({
      email: trimmedEmail,
      code: code.trim(),
      password,
      confirmPassword,
    });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const result = await onSubmit({
        email: trimmedEmail,
        code: code.trim(),
        newPassword: password,
      });
      if (result.ok) return;
      // InvalidPasswordException in reset context = policy violation under
      // the password field, NOT a banner (the global mapping is shared with
      // login and reads as "Email o password non corretti"). Mirror of the
      // signup `auth.signup.password_policy_violation` UX from PR #106.
      if (result.code === 'InvalidPasswordException') {
        setErrors({
          password:
            'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
        });
        return;
      }
      setBanner(mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (resending || cooldown > 0) return;
    const targetEmail = (emailHidden ? (initialEmail ?? '') : email).trim().toLowerCase();
    if (!targetEmail) {
      setResendFeedback('Inserisci prima la tua email.');
      return;
    }
    setResending(true);
    setResendFeedback(null);
    try {
      const result = await onResend(targetEmail);
      if (result.ok) {
        setResendFeedback('Codice inviato di nuovo.');
        startCooldown();
      } else {
        setResendFeedback(mapErrorToUserMessage(result.code));
      }
    } finally {
      setResending(false);
    }
  }

  const resendDisabled = resending || cooldown > 0;
  const resendLabel =
    cooldown > 0 ? `Invia di nuovo il codice (${cooldown}s)` : 'Invia di nuovo il codice';

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>G</Text>
        </View>
        <Text style={styles.wordmark}>GarageOS</Text>
      </View>

      <Text style={styles.h1}>Reimposta password</Text>
      <Text style={styles.body}>
        Inserisci il codice ricevuto via email e scegli una nuova password.
      </Text>

      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      {!emailHidden ? (
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
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Codice</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="Codice"
          keyboardType="number-pad"
          maxLength={6}
          autoComplete="one-time-code"
          editable={!submitting}
        />
        {errors.code ? <Text style={styles.fieldError}>{errors.code}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Nuova password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Nuova password"
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
          <Text style={styles.submitText}>Reimposta password</Text>
        )}
      </Pressable>

      {resendFeedback ? (
        <Text style={styles.feedback} accessibilityLiveRegion="polite">
          {resendFeedback}
        </Text>
      ) : null}

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
        {resending ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={styles.secondaryText}>{resendLabel}</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onNavigateBack}
        style={styles.linkRow}
        accessibilityRole="link"
        disabled={submitting}
      >
        <Text style={styles.linkText}>Torna al login</Text>
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
  h1: { fontSize: 22, fontWeight: '700', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 15, color: colors.muted, textAlign: 'center', lineHeight: 22 },
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
  feedback: { fontSize: 13, color: colors.muted, textAlign: 'center' },
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

- [ ] **Step 5.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/components/ResetPasswordForm.test.tsx`
Expected: PASS — 9 tests.

- [ ] **Step 5.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/src/components/auth/ResetPasswordForm.tsx \
        packages/mobile/tests/components/ResetPasswordForm.test.tsx
git commit -m "feat(mobile): F-CLI-002 add ResetPasswordForm component"
```

---

## Task 6: `/forgot-password` screen orchestrator

**Files:**
- Create: `packages/mobile/app/forgot-password.tsx`
- Test: `packages/mobile/tests/screens/forgot-password.test.tsx`

- [ ] **Step 6.1 — Write the failing screen test**

Create `packages/mobile/tests/screens/forgot-password.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ForgotPasswordScreen from '../../app/forgot-password';
import { renderWithAuth } from '../helpers/renderWithAuth';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useRouter } from 'expo-router';

jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;

async function renderScreen() {
  return renderWithAuth(<ForgotPasswordScreen />);
}

describe('/forgot-password screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
  });

  it('renders the ForgotPasswordForm', async () => {
    await renderScreen();
    expect(screen.getByRole('button', { name: 'Invia codice' })).toBeOnTheScreen();
  });

  it('calls forgotPasswordRequest and pushes /reset-password on ok', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push, back: jest.fn() });
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
    await renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(mockedCognito.forgotPasswordRequest).toHaveBeenCalledWith('mario.rossi@example.com');
    });
    expect(push).toHaveBeenCalledWith({
      pathname: '/reset-password',
      params: { email: 'mario.rossi@example.com' },
    });
  });

  it('does NOT navigate when forgotPasswordRequest fails', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push, back: jest.fn() });
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: false,
      code: 'LimitExceededException',
    });
    await renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText(/Troppi tentativi/)).toBeOnTheScreen();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('"Torna al login" goes back via router', async () => {
    const back = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back });
    await renderScreen();
    fireEvent.press(screen.getByText('Torna al login'));
    expect(back).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6.2 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/forgot-password.test.tsx`
Expected: FAIL — screen module not found.

- [ ] **Step 6.3 — Implement /forgot-password screen**

Create `packages/mobile/app/forgot-password.tsx`:

```tsx
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { forgotPasswordRequest } from '@/lib/cognito';
import { colors } from '@/theme/colors';

export default function ForgotPasswordScreen() {
  const router = useRouter();

  async function handleSubmit(email: string) {
    const result = await forgotPasswordRequest(email);
    if (!result.ok) return result;
    router.push({ pathname: '/reset-password', params: { email } });
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ForgotPasswordForm onSubmit={handleSubmit} onNavigateBack={() => router.back()} />
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

- [ ] **Step 6.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/forgot-password.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 6.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/app/forgot-password.tsx \
        packages/mobile/tests/screens/forgot-password.test.tsx
git commit -m "feat(mobile): F-CLI-002 add /forgot-password screen"
```

---

## Task 7: `/reset-password` screen orchestrator

**Files:**
- Create: `packages/mobile/app/reset-password.tsx`
- Test: `packages/mobile/tests/screens/reset-password.test.tsx`

- [ ] **Step 7.1 — Write the failing screen test**

Create `packages/mobile/tests/screens/reset-password.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ResetPasswordScreen from '../../app/reset-password';
import { renderWithAuth } from '../helpers/renderWithAuth';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';

jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useLocalSearchParams: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

async function renderScreen() {
  return renderWithAuth(<ResetPasswordScreen />);
}

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Codice'), '123456');
  fireEvent.changeText(screen.getByPlaceholderText('Nuova password'), 'newpassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'newpassword1');
}

describe('/reset-password screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
    mockedParams.mockReturnValue({ email: 'mario.rossi@example.com' });
  });

  it('renders ResetPasswordForm with email hidden when query param present', async () => {
    await renderScreen();
    expect(screen.queryByPlaceholderText('Email')).toBeNull();
    expect(screen.getByPlaceholderText('Codice')).toBeOnTheScreen();
  });

  it('shows email input when no query param (direct deep-link)', async () => {
    mockedParams.mockReturnValue({});
    await renderScreen();
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('calls confirmForgotPassword and redirects /login on success', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedCognito.confirmForgotPassword.mockResolvedValue({ ok: true });
    await renderScreen();
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(mockedCognito.confirmForgotPassword).toHaveBeenCalledWith(
        'mario.rossi@example.com',
        '123456',
        'newpassword1',
      );
    });
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('does NOT redirect when confirmForgotPassword fails', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedCognito.confirmForgotPassword.mockResolvedValue({
      ok: false,
      code: 'CodeMismatchException',
    });
    await renderScreen();
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/Codice non valido/)).toBeOnTheScreen();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('"Invia di nuovo il codice" calls forgotPasswordRequest with the email', async () => {
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
    await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
    await waitFor(() => {
      expect(mockedCognito.forgotPasswordRequest).toHaveBeenCalledWith('mario.rossi@example.com');
    });
  });

  it('"Torna al login" replaces to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    await renderScreen();
    fireEvent.press(screen.getByText('Torna al login'));
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
```

- [ ] **Step 7.2 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/reset-password.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7.3 — Implement /reset-password screen**

Create `packages/mobile/app/reset-password.tsx`:

```tsx
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ResetPasswordForm,
  type ResetPasswordPayload,
} from '@/components/auth/ResetPasswordForm';
import { confirmForgotPassword, forgotPasswordRequest } from '@/lib/cognito';
import { colors } from '@/theme/colors';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const initialEmail = typeof params.email === 'string' && params.email ? params.email : null;

  async function handleSubmit(payload: ResetPasswordPayload) {
    const result = await confirmForgotPassword(payload.email, payload.code, payload.newPassword);
    if (!result.ok) return result;
    router.replace('/login');
    return { ok: true as const };
  }

  async function handleResend(email: string) {
    const result = await forgotPasswordRequest(email);
    if (!result.ok) return result;
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ResetPasswordForm
            initialEmail={initialEmail}
            onSubmit={handleSubmit}
            onResend={handleResend}
            onNavigateBack={() => router.replace('/login')}
          />
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

- [ ] **Step 7.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/reset-password.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 7.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/app/reset-password.tsx \
        packages/mobile/tests/screens/reset-password.test.tsx
git commit -m "feat(mobile): F-CLI-002 add /reset-password screen"
```

---

## Task 8: Wire login link to /forgot-password

**Files:**
- Modify: `packages/mobile/app/login.tsx`
- Modify: `packages/mobile/tests/screens/login.test.tsx`

- [ ] **Step 8.1 — Add the failing test**

Open `packages/mobile/tests/screens/login.test.tsx` and append the following test inside the existing `describe('Login screen', () => { … })` block, just before its closing `});`:

```ts
  it('tapping "Hai dimenticato la password?" pushes /forgot-password', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push });
    await renderLogin();
    fireEvent.press(screen.getByText('Hai dimenticato la password?'));
    expect(push).toHaveBeenCalledWith('/forgot-password');
  });
```

- [ ] **Step 8.2 — Run, expect failure**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/login.test.tsx`
Expected: the new test FAILS — `push` not called (current code calls `Alert.alert`).

- [ ] **Step 8.3 — Rewire the link**

In `packages/mobile/app/login.tsx`:

1. Remove `Alert` from the `react-native` import (lines 2-12).
2. Replace lines 114-120 (the Pressable with the Alert):

```tsx
        <Pressable
          onPress={() => Alert.alert('Disponibile a breve')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Hai dimenticato la password?</Text>
        </Pressable>
```

with:

```tsx
        <Pressable
          onPress={() => router.push('/forgot-password')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Hai dimenticato la password?</Text>
        </Pressable>
```

Verify the resulting imports block on line 2-12 reads:

```tsx
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
```

- [ ] **Step 8.4 — Run, expect green**

Run: `pnpm --filter @garageos/mobile test -- tests/screens/login.test.tsx`
Expected: PASS — all tests including the new one.

- [ ] **Step 8.5 — Typecheck and commit**

```bash
pnpm --filter @garageos/mobile typecheck
git add packages/mobile/app/login.tsx \
        packages/mobile/tests/screens/login.test.tsx
git commit -m "feat(mobile): F-CLI-002 wire login link to /forgot-password"
```

---

## Task 9: Final mobile-wide checks

**Files:** none new

- [ ] **Step 9.1 — Run mobile test suite end-to-end**

Run: `pnpm --filter @garageos/mobile test`
Expected: PASS — full suite green; the 5 new validator/component/screen test files contribute ~30+ new assertions on top of the pre-existing baseline (88 tests from PR #109).

- [ ] **Step 9.2 — Repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (this is what the pre-push hook will run anyway).

- [ ] **Step 9.3 — Push branch and open PR**

```bash
git push -u origin feat/mobile-password-recovery
gh pr create --title "feat(mobile): F-CLI-002 mobile password recovery (forgot + reset)" --body "$(cat <<'EOF'
## What

Implements F-CLI-002 mobile password recovery: 2-screen flow (`/forgot-password` → `/reset-password`) wired to Cognito client-side, replacing the placeholder Alert on the login link. Cooldown 60s on resend, anti-enumeration on `UserNotFoundException`, inline policy-violation error for `InvalidPasswordException`.

## Why

Spec `docs/superpowers/specs/2026-05-16-f-cli-002-mobile-password-recovery-design.md` — sub-feature of F-CLI-002 (Login / logout / recupero password) in `docs/GarageOS-Specifiche.md:502`. Completes the mobile auth surface post-signup (PR #106).

## Implementation notes

- Pure client-side: `CognitoUser.forgotPassword` + `confirmPassword`. No new Fastify endpoint, no Lambda IAM change.
- Anti-enumeration: `UserNotFoundException` silenced at the wrapper layer (resolves `ok:true`), same UI as success. OWASP pattern.
- `InvalidPasswordException` is shared with the login mapping (means "wrong credentials" there); the reset screen handles it inline as a policy-violation under the password field instead of a banner.
- ResetPasswordForm exposes an editable email input only when arriving without the `?email=` query param (deep-link recovery path).
- Resend cooldown mirror of `verify-email-sent.tsx` (PR #106).

## Tests

- [x] Unit tests added/updated (validators × 2, cognito wrappers, error-messages)
- [x] Component tests added (ForgotPasswordForm, ResetPasswordForm including fake-timer cooldown)
- [x] Screen tests added (`/forgot-password`, `/reset-password`) + login link rewire test
- [x] BR-XXX rules verified — N/A (Cognito-side operation, no DB BR involved)
- [ ] Manual smoke runbook (post-merge, see spec §6.4)

## Checklist

- [x] Code follows conventions in CLAUDE.md
- [x] Types compile (`pnpm -r typecheck`)
- [x] Mobile test suite green
- [x] No new `console.log`, no commented-out code
- [x] Secrets not committed
- [x] Spec doc committed in same branch

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9.4 — Watch CI**

Run: `gh pr checks --watch`
Expected: all checks green (typecheck + lint + format:check + commitlint + mobile test).

If CI fails, fix the underlying issue and push a follow-up commit (never `--no-verify`, never `--amend` on pushed commits). Re-run `gh pr checks --watch`.

- [ ] **Step 9.5 — Wait for user (Michele) review + smoke runbook**

The user runs the smoke runbook in the spec §6.4 (Expo Go USB sideload, real Cognito clienti pool) and approves merge.

After merge, sync local main and delete the branch:

```bash
git checkout main
git pull origin main
git branch -D feat/mobile-password-recovery
```

---

## Self-review checklist

- **Spec §1 scope** → covered by Tasks 1-8.
- **Spec §2.1 user flow** → Task 6 (forgot screen → push reset), Task 7 (reset screen → confirm + replace login), Task 8 (login link wiring).
- **Spec §2.2 anti-enumeration** → Task 2 Step 2.3 wrapper silences `UserNotFoundException`; tested in Step 2.1 case 3.
- **Spec §2.3 deep-link guard** → Task 5 (`emailHidden` prop), Task 7 (initialEmail nullable from params).
- **Spec §3.1/3.2 file map** → Tasks 1-8 produce/edit every listed file. Note: spec lists `tests/lib/cognito-forgot-password.test.ts` (Task 2) — covered. Spec did NOT include screen tests under `tests/screens/`; we added them in Tasks 6-7 because the existing pattern (PR #106) tests screens (mirror of `screens/login.test.tsx`, `screens/signup.test.tsx`, `screens/verify-email-sent.test.tsx`). This expands the test surface beyond the spec's §6 enumeration but stays within "mirror PR #106 pattern" intent.
- **Spec §4.1 wrapper interface** → Task 2 (signature + discriminated union).
- **Spec §4.2 component interfaces** → Tasks 4 + 5.
- **Spec §4.3 validators** → Task 1.
- **Spec §5 error mapping** → Task 3 adds 3 codes (`CodeMismatchException`, `ExpiredCodeException`, `CodeDeliveryFailureException`); `InvalidPasswordException` overridden inline in Task 5 (resetPassword.tsx handler) as called out in spec §5.
- **Spec §6 test plan** → covered. Spec §6.1 mentions `lib/cognito-forgot-password.test.ts` with ~6 cases; Task 2 has 9 cases (more thorough — explicit name-vs-code fallback assertion + ForwardArgs assertion). Spec §6.2 component matrices covered in Tasks 4-5 with stated case counts.
- **Spec §6.4 smoke runbook** → Task 9 Step 9.5 (operator post-merge).
- **Placeholder scan** → no TODO/TBD; every code block complete; signatures consistent across tasks (`forgotPasswordRequest`, `confirmForgotPassword`, `ResetPasswordPayload`).
- **Type consistency** → `ForgotPasswordResult`, `ConfirmForgotPasswordResult`, `ForgotPasswordFormResult`, `ResetPasswordFormResult`, `ResetPasswordPayload` all match between definition and consumer.

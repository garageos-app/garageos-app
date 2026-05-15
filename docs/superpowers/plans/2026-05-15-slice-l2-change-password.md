# Slice L2 — Change Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere a `/settings` la possibilità per ogni utente officina di cambiare la propria password via Cognito SDK client-side.

**Architecture:** Frontend-only. Nuovo tab `Sicurezza` in Settings.tsx con form RHF+Zod (3 campi). Wrapper + hook `useChangePassword` su `CognitoUser.changePassword` ritornano discriminated result `{ ok: true } | { ok: false, code }` (pattern PR #103 `feedback_hook_return_result_not_state`). Zero modifiche backend.

**Tech Stack:** React 19 + TypeScript strict, React Hook Form 7, Zod v4, amazon-cognito-identity-js 6, shadcn/ui (Tabs, Button, Input, Label), sonner toast, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-15-l2-change-password-design.md`

**Branch (già creata):** `feat/change-password`

---

## File Structure

**Nuovi file:**

| Path | Responsabilità | LOC stim. |
|---|---|---|
| `packages/web/src/lib/validators/password.ts` | Zod schemas: `passwordPolicySchema` (riusabile) + `changePasswordFormSchema` (cross-field refines) | 30 |
| `packages/web/src/lib/validators/password.test.ts` | Unit del Zod schema (8 case) | 60 |
| `packages/web/src/queries/changePassword.ts` | Wrapper `changePassword(old, new)` su CognitoUser + hook `useChangePassword()` ritorna `{ mutate, isPending }`. Bundled in unico file mirror di `avatarUpload.ts` | 90 |
| `packages/web/src/queries/changePassword.test.tsx` | Unit del wrapper (5 branch codici) + hook (lifecycle isPending, return propagation) | 130 |
| `packages/web/src/components/settings/PasswordForm.tsx` | Form RHF+Zod 3-fields, helper text statico, error inline, dirty-tab `formRef` lift | 80 |
| `packages/web/src/components/settings/PasswordForm.test.tsx` | Render, validation, submit success/error mapping (mock `useChangePassword`) | 130 |

**File modificati:**

| Path | Cambio | LOC stim. |
|---|---|---|
| `packages/web/src/pages/Settings.tsx` | Aggiunge `'security'` a TabId union, `<TabsTrigger>` + `<TabsContent>`, `passwordFormRef` in dirty-tab guard | 25 |
| `packages/web/src/pages/Settings.test.tsx` | 3 nuovi case (tab visible per entrambi i ruoli, dirty guard include password form, discardChangesAndSwitch resetta anche passwordFormRef) | 40 |

**Totale**: ~225 LOC code + ~360 LOC test ≈ **585 LOC**.

> **Nota deviazione spec:** lo spec proponeva separare `lib/auth/change-password.ts` da `hooks/useChangePassword.ts`. Durante self-review file-structure ho consolidato in `queries/changePassword.ts` per mirror del pattern esistente `queries/avatarUpload.ts` (wrapper + hook bundled). Niente directory `hooks/` o `lib/auth/` esiste nel repo. Same semantics, meno file overhead.

---

## Task 1: Password policy validator (Zod schema)

**Files:**
- Create: `packages/web/src/lib/validators/password.ts`
- Test: `packages/web/src/lib/validators/password.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/validators/password.test.ts
import { describe, it, expect } from 'vitest';
import { passwordPolicySchema, changePasswordFormSchema } from './password';

describe('passwordPolicySchema', () => {
  it('rejects strings shorter than 10 chars', () => {
    const r = passwordPolicySchema.safeParse('Abc123de');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno 10 caratteri');
    }
  });

  it('rejects strings missing a lowercase letter', () => {
    const r = passwordPolicySchema.safeParse('ABCDEFG123');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno una lettera minuscola');
    }
  });

  it('rejects strings missing an uppercase letter', () => {
    const r = passwordPolicySchema.safeParse('abcdefg123');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno una lettera maiuscola');
    }
  });

  it('rejects strings missing a digit', () => {
    const r = passwordPolicySchema.safeParse('Abcdefghij');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Almeno un numero');
    }
  });

  it('accepts a policy-compliant password', () => {
    const r = passwordPolicySchema.safeParse('Abcdefg123');
    expect(r.success).toBe(true);
  });
});

describe('changePasswordFormSchema', () => {
  it('rejects mismatched newPassword and confirmPassword', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'OldPass123',
      newPassword: 'NewPass456',
      confirmPassword: 'Different789',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path.includes('confirmPassword'))?.message;
      expect(msg).toBe('Le password non coincidono');
    }
  });

  it('rejects newPassword equal to oldPassword', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'SamePass123',
      newPassword: 'SamePass123',
      confirmPassword: 'SamePass123',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path.includes('newPassword'))?.message;
      expect(msg).toBe('La nuova password deve essere diversa dalla precedente');
    }
  });

  it('accepts a valid payload', () => {
    const r = changePasswordFormSchema.safeParse({
      oldPassword: 'OldPass123',
      newPassword: 'NewPass456',
      confirmPassword: 'NewPass456',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test src/lib/validators/password.test.ts`
Expected: FAIL with module not found (`./password`).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/lib/validators/password.ts
import { z } from 'zod';

// Policy mirror of the Cognito officine user pool: see
// infrastructure/lib/constructs/cognito.ts:51-57.
// minLength: 10, requireLowercase: true, requireUppercase: true,
// requireDigits: true, requireSymbols: false.
// If the CDK construct changes, update this schema in lockstep —
// Cognito remains the ultimate authority; this is client-side first line.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test src/lib/validators/password.test.ts`
Expected: PASS, 8/8 green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/validators/password.ts packages/web/src/lib/validators/password.test.ts
git commit -m "feat(web): password policy + change-password form Zod schemas"
```

---

## Task 2: changePassword wrapper + useChangePassword hook

**Files:**
- Create: `packages/web/src/queries/changePassword.ts`
- Test: `packages/web/src/queries/changePassword.test.tsx`

- [ ] **Step 1: Write the failing test (wrapper branches)**

```tsx
// packages/web/src/queries/changePassword.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock @/lib/cognito — control getCurrentUser per test
// ---------------------------------------------------------------------------

const getCurrentUserMock = vi.fn();

vi.mock('@/lib/cognito', () => ({
  officineUserPool: {
    getCurrentUser: () => getCurrentUserMock(),
  },
}));

// Subject under test (imported after vi.mock setup)
import { changePassword, useChangePassword } from './changePassword';

interface FakeCognitoUser {
  getSession: (cb: (err: Error | null, session: { isValid: () => boolean } | null) => void) => void;
  changePassword: (
    oldPwd: string,
    newPwd: string,
    cb: (err: (Error & { name?: string }) | null) => void,
  ) => void;
}

function makeFakeUser(opts: {
  sessionValid?: boolean;
  sessionErr?: Error | null;
  cpErrName?: string;
  cpErrSucceeds?: boolean;
}): FakeCognitoUser {
  const sessionValid = opts.sessionValid ?? true;
  return {
    getSession: (cb) => {
      if (opts.sessionErr) {
        cb(opts.sessionErr, null);
        return;
      }
      cb(null, { isValid: () => sessionValid });
    },
    changePassword: (_o, _n, cb) => {
      if (opts.cpErrSucceeds) {
        cb(null);
        return;
      }
      const e = new Error('cognito') as Error & { name?: string };
      e.name = opts.cpErrName ?? 'UnexpectedException';
      cb(e);
    },
  };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
});

describe('changePassword (wrapper)', () => {
  it('returns not_authenticated when no current user', async () => {
    getCurrentUserMock.mockReturnValue(null);
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'not_authenticated' });
  });

  it('returns not_authenticated when session is invalid', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ sessionValid: false }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'not_authenticated' });
  });

  it('returns not_authenticated when getSession returns error', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ sessionErr: new Error('expired') }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'not_authenticated' });
  });

  it('maps NotAuthorizedException to wrong_old_password', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'NotAuthorizedException' }));
    const r = await changePassword('Wrong', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'wrong_old_password' });
  });

  it('maps InvalidPasswordException to password_too_weak', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'InvalidPasswordException' }));
    const r = await changePassword('OldPass123', 'weak');
    expect(r).toEqual({ ok: false, code: 'password_too_weak' });
  });

  it('maps LimitExceededException to rate_limited', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'LimitExceededException' }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'rate_limited' });
  });

  it('maps TooManyRequestsException to rate_limited', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'TooManyRequestsException' }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'rate_limited' });
  });

  it('maps unknown Cognito name to unknown', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'SomethingElseException' }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: false, code: 'unknown' });
  });

  it('returns ok: true on success', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrSucceeds: true }));
    const r = await changePassword('OldPass123', 'NewPass456');
    expect(r).toEqual({ ok: true });
  });
});

describe('useChangePassword (hook)', () => {
  it('isPending toggles true during mutate, false after resolve', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrSucceeds: true }));
    const { result } = renderHook(() => useChangePassword());
    expect(result.current.isPending).toBe(false);

    let resolved: { ok: boolean } | null = null;
    await act(async () => {
      const promise = result.current.mutate('OldPass123', 'NewPass456');
      // During the awaited resolution, isPending should be true at some point.
      // We can't directly observe sync flip without flushing; assert post-resolve.
      resolved = await promise;
    });
    expect(resolved).toEqual({ ok: true });
    expect(result.current.isPending).toBe(false);
  });

  it('propagates the wrapper result on error', async () => {
    getCurrentUserMock.mockReturnValue(makeFakeUser({ cpErrName: 'NotAuthorizedException' }));
    const { result } = renderHook(() => useChangePassword());
    let r: { ok: boolean; code?: string } | null = null;
    await act(async () => {
      r = await result.current.mutate('Wrong', 'NewPass456');
    });
    expect(r).toEqual({ ok: false, code: 'wrong_old_password' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test src/queries/changePassword.test.tsx`
Expected: FAIL with module not found (`./changePassword`).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/queries/changePassword.ts
import { useCallback, useState } from 'react';
import { type CognitoUserSession } from 'amazon-cognito-identity-js';

import { officineUserPool } from '@/lib/cognito';

// Cognito SDK error names mapped to our domain codes.
// SDK reference: amazon-cognito-identity-js v6 — CognitoUser.changePassword
// (for authenticated users) is distinct from CognitoUser.confirmPassword
// (which is the reset-via-code flow).
export type ChangePasswordCode =
  | 'wrong_old_password' // NotAuthorizedException
  | 'password_too_weak' // InvalidPasswordException (server-side policy fail)
  | 'rate_limited' // LimitExceededException, TooManyRequestsException
  | 'not_authenticated' // no current user OR session invalid OR getSession error
  | 'unknown';

export type ChangePasswordResult = { ok: true } | { ok: false; code: ChangePasswordCode };

const COGNITO_ERROR_TO_CODE: Record<string, ChangePasswordCode> = {
  NotAuthorizedException: 'wrong_old_password',
  InvalidPasswordException: 'password_too_weak',
  LimitExceededException: 'rate_limited',
  TooManyRequestsException: 'rate_limited',
};

/**
 * Pure wrapper around CognitoUser.changePassword.
 * - getCurrentUser() returns null → not_authenticated
 * - getSession() returns error or invalid session → not_authenticated
 * - changePassword callback errors mapped by name → domain code
 * - changePassword callback success → ok: true
 *
 * Does NOT touch React state. The hook (useChangePassword) wraps this
 * with a setState-driven isPending. Pattern: PR #103
 * feedback_hook_return_result_not_state — caller branches on the result
 * value, never on stale state after await.
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const user = officineUserPool.getCurrentUser();
  if (!user) return { ok: false, code: 'not_authenticated' };

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

export interface UseChangePasswordResult {
  mutate: (oldPassword: string, newPassword: string) => Promise<ChangePasswordResult>;
  isPending: boolean;
}

export function useChangePassword(): UseChangePasswordResult {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test src/queries/changePassword.test.tsx`
Expected: PASS, 11/11 green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/changePassword.ts packages/web/src/queries/changePassword.test.tsx
git commit -m "feat(web): changePassword wrapper + useChangePassword hook"
```

---

## Task 3: PasswordForm component

**Files:**
- Create: `packages/web/src/components/settings/PasswordForm.tsx`
- Test: `packages/web/src/components/settings/PasswordForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/settings/PasswordForm.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PasswordForm } from './PasswordForm';
import * as changePasswordModule from '@/queries/changePassword';

// Stub sonner to avoid ESM imports in JSDOM.
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccessMock(msg),
    error: (msg: string) => toastErrorMock(msg),
  },
}));

describe('PasswordForm', () => {
  let mutate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mutate = vi.fn();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    vi.spyOn(changePasswordModule, 'useChangePassword').mockReturnValue({
      mutate,
      isPending: false,
    });
  });

  it('renders 3 password fields and helper text', () => {
    render(<PasswordForm />);
    expect(screen.getByLabelText('Password attuale')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Nuova password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Conferma nuova password')).toHaveAttribute('type', 'password');
    expect(
      screen.getByText('Almeno 10 caratteri, una maiuscola, una minuscola, un numero.'),
    ).toBeInTheDocument();
  });

  it('Submit button disabled when pristine', () => {
    render(<PasswordForm />);
    expect(screen.getByRole('button', { name: 'Cambia password' })).toBeDisabled();
  });

  it('shows inline error when newPassword fails policy', async () => {
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'weak');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'weak');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Almeno 10 caratteri')).toBeInTheDocument();
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows inline error when new and confirm mismatch', async () => {
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'Different789');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeInTheDocument();
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('success path: calls mutate, shows toast, resets form', async () => {
    mutate.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('OldPass123', 'NewPass456');
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Password aggiornata.');
    });
    // After reset, oldPassword should be cleared
    expect(screen.getByLabelText('Password attuale')).toHaveValue('');
  });

  it('wrong_old_password: sets inline error on oldPassword', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'wrong_old_password' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'Wrong12345');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Password attuale non corretta')).toBeInTheDocument();
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('password_too_weak from Cognito: sets inline error on newPassword', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'password_too_weak' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('La password non rispetta i requisiti')).toBeInTheDocument();
    });
  });

  it('rate_limited: shows toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'rate_limited' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Troppi tentativi, riprova tra qualche minuto.',
      );
    });
  });

  it('not_authenticated: shows toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'not_authenticated' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Sessione scaduta. Effettua di nuovo l'accesso.",
      );
    });
  });

  it('unknown error: shows generic toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'unknown' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Impossibile contattare il server. Riprova.');
    });
  });

  it('button shows pending label and disabled when isPending', () => {
    vi.spyOn(changePasswordModule, 'useChangePassword').mockReturnValue({
      mutate,
      isPending: true,
    });
    render(<PasswordForm />);
    const btn = screen.getByRole('button', { name: 'Aggiornamento...' });
    expect(btn).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test src/components/settings/PasswordForm.test.tsx`
Expected: FAIL with module not found (`./PasswordForm`).

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/web/src/components/settings/PasswordForm.tsx
import { useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  changePasswordFormSchema,
  type ChangePasswordFormValues,
} from '@/lib/validators/password';
import { useChangePassword, type ChangePasswordCode } from '@/queries/changePassword';

interface Props {
  // Lift the form API to the parent (Settings page) so it can read
  // formState.isDirty to gate the cross-tab dirty AlertDialog.
  formRef?: (form: UseFormReturn<ChangePasswordFormValues>) => void;
}

const TOAST_FOR_CODE: Partial<Record<ChangePasswordCode, string>> = {
  rate_limited: 'Troppi tentativi, riprova tra qualche minuto.',
  not_authenticated: "Sessione scaduta. Effettua di nuovo l'accesso.",
  unknown: 'Impossibile contattare il server. Riprova.',
};

export function PasswordForm({ formRef }: Props) {
  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    formRef?.(form);
  }, [form, formRef]);

  const { mutate, isPending } = useChangePassword();

  async function onSubmit(values: ChangePasswordFormValues) {
    const result = await mutate(values.oldPassword, values.newPassword);
    if (result.ok) {
      toast.success('Password aggiornata.');
      form.reset();
      return;
    }
    if (result.code === 'wrong_old_password') {
      form.setError('oldPassword', { message: 'Password attuale non corretta' });
      return;
    }
    if (result.code === 'password_too_weak') {
      form.setError('newPassword', { message: 'La password non rispetta i requisiti' });
      return;
    }
    toast.error(TOAST_FOR_CODE[result.code] ?? 'Impossibile contattare il server. Riprova.');
  }

  const { isDirty } = form.formState;

  return (
    <div className="max-w-xl">
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="oldPassword">Password attuale</Label>
          <Input id="oldPassword" type="password" {...form.register('oldPassword')} />
          {form.formState.errors.oldPassword && (
            <p className="text-sm text-red-600">{form.formState.errors.oldPassword.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="newPassword">Nuova password</Label>
          <Input id="newPassword" type="password" {...form.register('newPassword')} />
          <p className="text-xs text-muted-foreground">
            Almeno 10 caratteri, una maiuscola, una minuscola, un numero.
          </p>
          {form.formState.errors.newPassword && (
            <p className="text-sm text-red-600">{form.formState.errors.newPassword.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Conferma nuova password</Label>
          <Input id="confirmPassword" type="password" {...form.register('confirmPassword')} />
          {form.formState.errors.confirmPassword && (
            <p className="text-sm text-red-600">
              {form.formState.errors.confirmPassword.message}
            </p>
          )}
        </div>

        <Button type="submit" disabled={!isDirty || isPending}>
          {isPending ? 'Aggiornamento...' : 'Cambia password'}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test src/components/settings/PasswordForm.test.tsx`
Expected: PASS, 11/11 green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/settings/PasswordForm.tsx packages/web/src/components/settings/PasswordForm.test.tsx
git commit -m "feat(web): PasswordForm component (3-field RHF + Zod)"
```

---

## Task 4: Wire Sicurezza tab into Settings page

**Files:**
- Modify: `packages/web/src/pages/Settings.tsx`
- Test: `packages/web/src/pages/Settings.test.tsx` (add 3 new cases)

- [ ] **Step 1: Write the failing test (add cases to existing Settings.test.tsx)**

Append the following inside the `describe('Settings page', ...)` block in `packages/web/src/pages/Settings.test.tsx`. Also extend the module-level mocks for the PasswordForm and add a captured ref. Add this just below the existing `vi.mock('@/components/settings/TenantForm', ...)` block:

```tsx
// Mock PasswordForm — capture formRef just like ProfileForm.
let capturedPasswordFormRef: ((f: ProfileFormRef) => void) | undefined;
vi.mock('@/components/settings/PasswordForm', () => ({
  PasswordForm: ({ formRef }: { formRef?: (f: ProfileFormRef) => void }) => {
    capturedPasswordFormRef = formRef;
    return (
      <form>
        <label htmlFor="oldPassword">Password attuale</label>
        <input id="oldPassword" type="password" />
      </form>
    );
  },
}));
```

And in `beforeEach` add: `capturedPasswordFormRef = undefined;`

Then append the 3 new test cases:

```tsx
  it('renders Sicurezza tab for both super_admin and mechanic', () => {
    mockAuthRole('mechanic');
    render(wrap(<Settings />));
    expect(screen.getByRole('tab', { name: 'Sicurezza' })).toBeInTheDocument();
  });

  it('dirty password form triggers AlertDialog on tab switch', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    // Switch first to Sicurezza so the form mounts and captures the ref
    await user.click(screen.getByRole('tab', { name: 'Sicurezza' }));
    await waitFor(() => {
      expect(capturedPasswordFormRef).toBeDefined();
    });
    // Inject a dirty password form ref
    capturedPasswordFormRef?.(makeFakeFormRef(true));

    // Now try to switch back to Profilo — should open dialog
    await user.click(screen.getByRole('tab', { name: 'Profilo' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });
  });

  it('discardChangesAndSwitch resets the password form too', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    await user.click(screen.getByRole('tab', { name: 'Sicurezza' }));
    await waitFor(() => {
      expect(capturedPasswordFormRef).toBeDefined();
    });
    const fakePasswordForm = makeFakeFormRef(true) as ProfileFormRef & {
      reset: ReturnType<typeof vi.fn>;
    };
    capturedPasswordFormRef?.(fakePasswordForm);

    // Switch to Profilo — dialog opens
    await user.click(screen.getByRole('tab', { name: 'Profilo' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });
    // Click "Continua senza salvare"
    await user.click(screen.getByRole('button', { name: 'Continua senza salvare' }));
    await waitFor(() => {
      expect(screen.queryByText('Modifiche non salvate')).not.toBeInTheDocument();
    });
    expect(fakePasswordForm.reset).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify they fail**

Run: `pnpm --filter @garageos/web test src/pages/Settings.test.tsx`
Expected: FAIL — `tab Sicurezza` not in document; `capturedPasswordFormRef` never defined.

- [ ] **Step 3: Modify Settings.tsx**

Apply the following changes to `packages/web/src/pages/Settings.tsx`:

a) Add the import after the existing `TenantForm` import:

```ts
import { PasswordForm } from '@/components/settings/PasswordForm';
```

b) Add the `ChangePasswordFormValues` type import after the existing validator imports:

```ts
import type { ChangePasswordFormValues } from '@/lib/validators/password';
```

c) Replace the `TabId` type union:

Replace:
```ts
type TabId = 'profile' | 'tenant';
```

With:
```ts
type TabId = 'profile' | 'security' | 'tenant';
```

d) Add a `passwordFormRef` declaration right after the existing `tenantFormRef`:

```ts
const passwordFormRef = useRef<UseFormReturn<ChangePasswordFormValues> | null>(null);
```

e) Update `anyDirty()`:

Replace:
```ts
function anyDirty(): boolean {
  return (
    profileFormRef.current?.formState.isDirty === true ||
    tenantFormRef.current?.formState.isDirty === true
  );
}
```

With:
```ts
function anyDirty(): boolean {
  return (
    profileFormRef.current?.formState.isDirty === true ||
    passwordFormRef.current?.formState.isDirty === true ||
    tenantFormRef.current?.formState.isDirty === true
  );
}
```

f) Update `discardChangesAndSwitch()`:

Replace:
```ts
function discardChangesAndSwitch() {
  if (!pendingTab) return;
  profileFormRef.current?.reset();
  tenantFormRef.current?.reset();
  setActiveTab(pendingTab);
  setPendingTab(null);
}
```

With:
```ts
function discardChangesAndSwitch() {
  if (!pendingTab) return;
  profileFormRef.current?.reset();
  passwordFormRef.current?.reset();
  tenantFormRef.current?.reset();
  setActiveTab(pendingTab);
  setPendingTab(null);
}
```

g) Add the new `TabsTrigger` and `TabsContent`. Replace the `<TabsList>...</TabsList>` block:

Replace:
```tsx
<TabsList>
  <TabsTrigger value="profile">Profilo</TabsTrigger>
  {isSuperAdmin && <TabsTrigger value="tenant">Officina</TabsTrigger>}
</TabsList>
```

With:
```tsx
<TabsList>
  <TabsTrigger value="profile">Profilo</TabsTrigger>
  <TabsTrigger value="security">Sicurezza</TabsTrigger>
  {isSuperAdmin && <TabsTrigger value="tenant">Officina</TabsTrigger>}
</TabsList>
```

Then add a new `<TabsContent value="security">` after the existing `<TabsContent value="profile">` block:

```tsx
<TabsContent value="security" className="mt-6">
  <PasswordForm
    formRef={(f) => {
      passwordFormRef.current = f;
    }}
  />
</TabsContent>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test src/pages/Settings.test.tsx`
Expected: PASS, including the 3 new cases (existing 5 + 3 new = 8 total).

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @garageos/web test`
Expected: PASS, no regressions in other suites.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/pages/Settings.tsx packages/web/src/pages/Settings.test.tsx
git commit -m "feat(web): add Sicurezza tab with change password in /settings"
```

---

## Task 5: Repo-wide typecheck + push branch

- [ ] **Step 1: Full monorepo typecheck (pre-push gate per CLAUDE.md)**

Run: `pnpm -r typecheck`
Expected: PASS across all packages. This is the only mandatory local gate per CLAUDE.md (other checks run on CI).

- [ ] **Step 2: Verify clean status**

Run: `git status`
Expected: 8 commits ahead of origin/main (1 docs spec from earlier + 4 feature commits from this plan + N for cleanup), nothing untracked or staged besides `.claude/` and plans/specs (pattern stabilito).

Run: `git log --oneline origin/main..HEAD`
Expected output (commits in order):
```
<sha> feat(web): add Sicurezza tab with change password in /settings
<sha> feat(web): PasswordForm component (3-field RHF + Zod)
<sha> feat(web): changePassword wrapper + useChangePassword hook
<sha> feat(web): password policy + change-password form Zod schemas
<sha> docs: slice L2 change password design spec
```

- [ ] **Step 3: Push branch**

Run: `git push -u origin feat/change-password`
Expected: branch pushed, PR creation URL printed.

- [ ] **Step 4: Open PR via gh CLI**

```bash
gh pr create --title "feat(web): F-OFF-007 L2 change password (Cognito SDK client-side)" --body "$(cat <<'EOF'
## What

Slice L2 della famiglia F-OFF-007 (Profilo utente): aggiunge a `/settings` un nuovo tab `Sicurezza` con form di cambio password client-side via Cognito SDK. Nessun cambio backend.

## Why

Completa il MUST F-OFF-007 — `docs/GarageOS-Specifiche.md:413` — dopo slice L (#102) e L1 avatar (#103+#104).
Demo polish, slice indipendente. Spec: `docs/superpowers/specs/2026-05-15-l2-change-password-design.md`.

## Implementation notes

- Wrapper + hook bundled in `packages/web/src/queries/changePassword.ts` (mirror del pattern `avatarUpload.ts`).
- Discriminated result `{ ok: true } | { ok: false, code }` — niente reliance su state post-await (pattern PR #103 `feedback_hook_return_result_not_state`).
- Zod policy mirror della Cognito officine user pool policy (`infrastructure/lib/constructs/cognito.ts:51-57`). Cognito rimane authoritative.
- Tab `Sicurezza` visibile a TUTTI gli utenti (super_admin + mechanic).
- Dirty-tab guard esteso al `passwordFormRef`.
- Sessione mantenuta dopo cambio password (Cognito default — no global signOut).

## Tests

- [x] Unit Zod schema (8 case)
- [x] Unit wrapper `changePassword` (9 case copre tutti i code branch)
- [x] Unit hook `useChangePassword` (2 case lifecycle + propagation)
- [x] Unit `PasswordForm` (11 case: render, validation, submit success/error mapping, pending state)
- [x] Update `Settings.test.tsx` (3 nuovi case: tab visible, dirty guard, reset)
- [ ] Manual smoke runbook post-deploy (vedi spec §8)

## Screenshots

(da allegare post-deploy)

## Checklist

- [x] Code follows conventions
- [x] Types compile (`pnpm -r typecheck`)
- [ ] Linter clean (delegato a CI per regola `feedback_skip_local_integration_tests`)
- [ ] Tests pass (delegato a CI)
- [x] No new `console.log`, no commented-out code
- [x] No secrets in diff
- [x] Doc updated: spec doc committed
EOF
)"
```

Expected: PR creata, URL printed.

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: all checks green. If any fails, diagnose root cause and push a follow-up commit (no `--no-verify`).

---

## Self-Review Notes

Verifica spec coverage (eseguita pre-commit):

| Spec section | Task |
|---|---|
| §3.1 Tab placement | Task 4 (Settings.tsx wiring) |
| §3.2 PasswordForm layout | Task 3 (PasswordForm.tsx) |
| §3.3 Submit lifecycle (toast + reset + error mapping) | Task 3 |
| §3.4 Dirty-tab guard | Task 4 |
| §4.1 validators/password.ts | Task 1 |
| §4.2 changePassword wrapper (consolidato in queries/) | Task 2 |
| §4.3 useChangePassword hook (consolidato in queries/) | Task 2 |
| §4.4 PasswordForm | Task 3 |
| §4.5 Settings.tsx update | Task 4 |
| §5.1 validators/password.test.ts | Task 1 |
| §5.2 changePassword wrapper test | Task 2 |
| §5.3 useChangePassword hook test | Task 2 |
| §5.4 PasswordForm.test.tsx | Task 3 |
| §5.5 Settings.test.tsx extension | Task 4 |
| §10 Acceptance criteria | Task 5 PR body checklist |

Tutte le sezioni spec coperte. Una sola deviazione dichiarata: wrapper + hook consolidati in unico file `queries/changePassword.ts` invece di `lib/auth/change-password.ts` + `hooks/useChangePassword.ts`. Stesso comportamento, pattern coerente con `queries/avatarUpload.ts`.

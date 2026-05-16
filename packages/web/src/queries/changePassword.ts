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
      const name = (err as { name?: string }).name ?? '';
      const code: ChangePasswordCode = COGNITO_ERROR_TO_CODE[name] ?? 'unknown';
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
    // changePassword is module-scope; mutate captures only setIsPending (stable setter).
    [],
  );

  return { mutate, isPending };
}

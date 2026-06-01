import { useCallback, useState } from 'react';
import { CognitoUser } from 'amazon-cognito-identity-js';

import { officineUserPool } from '@/lib/cognito';

// Mirrors queries/changePassword.ts: module-scope async wrappers returning a
// discriminated result; thin hooks own isPending (PR #103,
// feedback_hook_return_result_not_state — branch on the returned value).
//
// Anti-enumeration (PR #110, feedback_cognito_anti_enumeration_completeness):
// the initiate step must NOT reveal whether an email exists. UserNotFound +
// InvalidParameter (unverified email) are silenced to { ok: true }.

export type RequestResetCode = 'rate_limited' | 'unknown';
export type RequestResetResult = { ok: true } | { ok: false; code: RequestResetCode };

export type ConfirmResetCode =
  | 'code_invalid' // CodeMismatchException
  | 'code_expired' // ExpiredCodeException
  | 'password_too_weak' // InvalidPasswordException
  | 'rate_limited' // LimitExceededException / TooManyRequestsException
  | 'unknown';
export type ConfirmResetResult = { ok: true } | { ok: false; code: ConfirmResetCode };

const SILENCED_REQUEST_ERRORS = new Set(['UserNotFoundException', 'InvalidParameterException']);
const RATE_LIMIT_ERRORS = new Set(['LimitExceededException', 'TooManyRequestsException']);

const CONFIRM_ERROR_TO_CODE: Record<string, ConfirmResetCode> = {
  CodeMismatchException: 'code_invalid',
  ExpiredCodeException: 'code_expired',
  InvalidPasswordException: 'password_too_weak',
  LimitExceededException: 'rate_limited',
  TooManyRequestsException: 'rate_limited',
};

function cognitoUserFor(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: officineUserPool });
}

export async function requestPasswordReset(email: string): Promise<RequestResetResult> {
  return new Promise<RequestResetResult>((resolve) => {
    cognitoUserFor(email).forgotPassword({
      onSuccess: () => resolve({ ok: true }),
      onFailure: (err) => {
        const name = (err as { name?: string }).name ?? '';
        if (SILENCED_REQUEST_ERRORS.has(name)) return resolve({ ok: true });
        if (RATE_LIMIT_ERRORS.has(name)) return resolve({ ok: false, code: 'rate_limited' });
        resolve({ ok: false, code: 'unknown' });
      },
    });
  });
}

export async function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<ConfirmResetResult> {
  return new Promise<ConfirmResetResult>((resolve) => {
    cognitoUserFor(email).confirmPassword(code, newPassword, {
      onSuccess: () => resolve({ ok: true }),
      onFailure: (err) => {
        const name = (err as { name?: string }).name ?? '';
        resolve({ ok: false, code: CONFIRM_ERROR_TO_CODE[name] ?? 'unknown' });
      },
    });
  });
}

export function useRequestPasswordReset() {
  const [isPending, setIsPending] = useState(false);
  const mutate = useCallback(async (email: string): Promise<RequestResetResult> => {
    setIsPending(true);
    try {
      return await requestPasswordReset(email);
    } finally {
      setIsPending(false);
    }
  }, []);
  return { mutate, isPending };
}

export function useConfirmPasswordReset() {
  const [isPending, setIsPending] = useState(false);
  const mutate = useCallback(
    async (email: string, code: string, newPassword: string): Promise<ConfirmResetResult> => {
      setIsPending(true);
      try {
        return await confirmPasswordReset(email, code, newPassword);
      } finally {
        setIsPending(false);
      }
    },
    [],
  );
  return { mutate, isPending };
}

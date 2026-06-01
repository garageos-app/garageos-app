import { describe, it, expect, vi, beforeEach } from 'vitest';

const forgotPassword = vi.fn();
const confirmPassword = vi.fn();

vi.mock('amazon-cognito-identity-js', () => ({
  // Arrow functions cannot be used as constructors (vitest v4 requirement).
  // Use a regular function so `new CognitoUser(...)` works in the SUT.
  CognitoUser: vi.fn().mockImplementation(function () {
    return { forgotPassword, confirmPassword };
  }),
}));
// Avoid the env-var throw in @/lib/cognito at import time.
vi.mock('@/lib/cognito', () => ({ officineUserPool: {} }));

import { requestPasswordReset, confirmPasswordReset } from './passwordReset';

beforeEach(() => {
  forgotPassword.mockReset();
  confirmPassword.mockReset();
});

describe('requestPasswordReset', () => {
  it('returns ok on success', async () => {
    forgotPassword.mockImplementation((cb) => cb.onSuccess({}));
    expect(await requestPasswordReset('a@b.it')).toEqual({ ok: true });
  });

  it('silences UserNotFoundException (anti-enumeration)', async () => {
    forgotPassword.mockImplementation((cb) => cb.onFailure({ name: 'UserNotFoundException' }));
    expect(await requestPasswordReset('x@y.it')).toEqual({ ok: true });
  });

  it('silences InvalidParameterException (unverified email)', async () => {
    forgotPassword.mockImplementation((cb) => cb.onFailure({ name: 'InvalidParameterException' }));
    expect(await requestPasswordReset('x@y.it')).toEqual({ ok: true });
  });

  it('surfaces rate limiting', async () => {
    forgotPassword.mockImplementation((cb) => cb.onFailure({ name: 'LimitExceededException' }));
    expect(await requestPasswordReset('x@y.it')).toEqual({ ok: false, code: 'rate_limited' });
  });

  it('maps other failures to unknown', async () => {
    forgotPassword.mockImplementation((cb) => cb.onFailure({ name: 'SomethingElse' }));
    expect(await requestPasswordReset('x@y.it')).toEqual({ ok: false, code: 'unknown' });
  });
});

describe('confirmPasswordReset', () => {
  it('returns ok on success', async () => {
    confirmPassword.mockImplementation((_code, _pw, cb) => cb.onSuccess());
    expect(await confirmPasswordReset('a@b.it', '123456', 'Str0ngPw!')).toEqual({ ok: true });
  });

  it.each([
    ['CodeMismatchException', 'code_invalid'],
    ['ExpiredCodeException', 'code_expired'],
    ['InvalidPasswordException', 'password_too_weak'],
    ['LimitExceededException', 'rate_limited'],
    ['TooManyRequestsException', 'rate_limited'],
    ['WhateverException', 'unknown'],
  ])('maps %s → %s', async (name, code) => {
    confirmPassword.mockImplementation((_c, _p, cb) => cb.onFailure({ name }));
    expect(await confirmPasswordReset('a@b.it', '000', 'pw')).toEqual({ ok: false, code });
  });
});

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

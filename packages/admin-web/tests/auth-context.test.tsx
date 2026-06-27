import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Module-level mock for amazon-cognito-identity-js. Each test configures
// behaviour by mutating the returned mock objects.
//
// vi.mock is hoisted above any top-level `const` declarations, so the
// mock fns must be created via vi.hoisted() to be available when the
// factory runs. Vitest 4 also requires `function` (not arrow) bodies
// for mocks invoked with `new`.
const {
  getCurrentUserMock,
  cognitoUserGetSessionMock,
  cognitoUserSignOutMock,
  authenticateUserMock,
  completeNewPasswordChallengeMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  cognitoUserGetSessionMock: vi.fn(),
  cognitoUserSignOutMock: vi.fn(),
  authenticateUserMock: vi.fn(),
  completeNewPasswordChallengeMock: vi.fn(),
}));

vi.mock('amazon-cognito-identity-js', () => {
  return {
    CognitoUserPool: vi.fn(function () {
      return { getCurrentUser: getCurrentUserMock };
    }),
    CognitoUser: vi.fn(function () {
      return {
        getSession: cognitoUserGetSessionMock,
        signOut: cognitoUserSignOutMock,
        authenticateUser: authenticateUserMock,
        completeNewPasswordChallenge: completeNewPasswordChallengeMock,
      };
    }),
    AuthenticationDetails: vi.fn(function () {
      return {};
    }),
  };
});

// Env stubs are pre-seeded in setup.ts; no need to re-stub here.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/auth/AuthContext';
import { useAuth } from '@/auth/useAuth';

// AuthProvider calls useQueryClient() to clear the React Query cache on
// signOut. Tests must wrap AuthProvider with QueryClientProvider.
const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  getCurrentUserMock.mockReset();
  cognitoUserGetSessionMock.mockReset();
  cognitoUserSignOutMock.mockReset();
  authenticateUserMock.mockReset();
  completeNewPasswordChallengeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Rehydrate
// ---------------------------------------------------------------------------

describe('AuthProvider rehydrate', () => {
  it('REHYDRATE_NONE → unauthenticated when no current user', async () => {
    getCurrentUserMock.mockReturnValue(null);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));
  });

  it('REHYDRATE_OK → authenticated when getSession succeeds', async () => {
    const fakeUser = {
      getSession: (cb: (err: unknown, session: unknown) => void) => {
        cb(null, {
          isValid: () => true,
          getIdToken: () => ({
            payload: { email: 'admin@garageos.it', given_name: 'Admin' },
          }),
        });
      },
      signOut: vi.fn(),
    };
    getCurrentUserMock.mockReturnValue(fakeUser);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('authenticated'));
    if (result.current.state.status === 'authenticated') {
      expect(result.current.state.user.email).toBe('admin@garageos.it');
    }
  });

  it('REHYDRATE_NONE when getSession errors', async () => {
    const fakeUser = {
      getSession: (cb: (err: unknown, session: unknown) => void) =>
        cb(new Error('session expired'), null),
      signOut: vi.fn(),
    };
    getCurrentUserMock.mockReturnValue(fakeUser);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));
  });
});

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

describe('AuthProvider signIn', () => {
  it('transitions authenticating → authenticated on success', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: Record<string, (arg: unknown) => void>) => {
        callbacks.onSuccess({
          getIdToken: () => ({
            payload: { email: 'admin@garageos.it' },
          }),
        });
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('admin@garageos.it', 'pwd123');
    });

    expect(result.current.state.status).toBe('authenticated');
  });

  it('transitions authenticating → unauthenticated on failure with mapped error', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: Record<string, (arg: unknown) => void>) => {
        callbacks.onFailure({ name: 'NotAuthorizedException' });
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('admin@garageos.it', 'wrong');
    });

    expect(result.current.state.status).toBe('unauthenticated');
    if (result.current.state.status === 'unauthenticated') {
      expect(result.current.state.error).toBe('Email o password non corretti');
    }
  });

  it('transitions authenticating → new_password_required when challenge fires', async () => {
    getCurrentUserMock.mockReturnValue(null);
    // Cognito passes userAttributes including email_verified and email;
    // the implementation must delete those immutable attrs before storing the user.
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: Record<string, (arg: unknown) => void>) => {
        callbacks.newPasswordRequired({ email: 'admin@garageos.it', email_verified: 'true' });
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('admin@garageos.it', 'TempPwd1!');
    });

    expect(result.current.state.status).toBe('new_password_required');
  });
});

// ---------------------------------------------------------------------------
// completeNewPassword  — the novel path absent from officine-web
// ---------------------------------------------------------------------------

describe('AuthProvider completeNewPassword', () => {
  it('transitions new_password_required → authenticated on success', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: Record<string, (arg: unknown) => void>) => {
        callbacks.newPasswordRequired({});
      },
    );
    completeNewPasswordChallengeMock.mockImplementation(
      (
        _newPwd: unknown,
        _requiredAttrs: unknown,
        callbacks: Record<string, (arg: unknown) => void>,
      ) => {
        callbacks.onSuccess({
          getIdToken: () => ({
            payload: { email: 'admin@garageos.it', given_name: 'Admin' },
          }),
        });
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('admin@garageos.it', 'TempPwd1!');
    });
    expect(result.current.state.status).toBe('new_password_required');

    await act(async () => {
      await result.current.completeNewPassword('NewPwd1!$');
    });
    expect(result.current.state.status).toBe('authenticated');
    if (result.current.state.status === 'authenticated') {
      expect(result.current.state.user.email).toBe('admin@garageos.it');
    }
  });

  it('transitions new_password_required → unauthenticated on failure', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: Record<string, (arg: unknown) => void>) => {
        callbacks.newPasswordRequired({});
      },
    );
    completeNewPasswordChallengeMock.mockImplementation(
      (
        _newPwd: unknown,
        _requiredAttrs: unknown,
        callbacks: Record<string, (arg: unknown) => void>,
      ) => {
        callbacks.onFailure({ name: 'NotAuthorizedException' });
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('admin@garageos.it', 'TempPwd1!');
    });
    expect(result.current.state.status).toBe('new_password_required');

    await act(async () => {
      await result.current.completeNewPassword('bad');
    });
    expect(result.current.state.status).toBe('unauthenticated');
  });

  it('resolves immediately when pendingUserRef is null (no-op guard)', async () => {
    getCurrentUserMock.mockReturnValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    // completeNewPassword without a prior signIn challenge — must not throw
    await act(async () => {
      await result.current.completeNewPassword('SomePassword1!');
    });

    // State is still unauthenticated; no crash
    expect(result.current.state.status).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe('AuthProvider signOut', () => {
  it('clears session and transitions to unauthenticated', async () => {
    const signOutFn = vi.fn();
    const fakeUser = {
      getSession: (cb: (err: unknown, session: unknown) => void) => {
        cb(null, {
          isValid: () => true,
          getIdToken: () => ({
            payload: { email: 'admin@garageos.it' },
          }),
        });
      },
      signOut: signOutFn,
    };
    getCurrentUserMock.mockReturnValue(fakeUser);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('authenticated'));

    act(() => {
      result.current.signOut();
    });

    expect(signOutFn).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('unauthenticated');
  });

  it('clears React Query cache to avoid cross-session bleed', async () => {
    const signOutFn = vi.fn();
    const fakeUser = {
      getSession: (cb: (err: unknown, session: unknown) => void) => {
        cb(null, {
          isValid: () => true,
          getIdToken: () => ({
            payload: { email: 'admin@garageos.it' },
          }),
        });
      },
      signOut: signOutFn,
    };
    getCurrentUserMock.mockReturnValue(fakeUser);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['admin-me'], { name: 'PreviousAdmin' });
    expect(qc.getQueryData(['admin-me'])).toBeDefined();

    const localWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper: localWrapper });
    await waitFor(() => expect(result.current.state.status).toBe('authenticated'));

    act(() => {
      result.current.signOut();
    });

    expect(qc.getQueryData(['admin-me'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// useAuth outside provider
// ---------------------------------------------------------------------------

describe('useAuth outside provider', () => {
  it('throws helpful error', () => {
    const TestNoProvider = () => {
      useAuth();
      return null;
    };
    expect(() => render(<TestNoProvider />)).toThrow(/useAuth must be used within AuthProvider/);
  });
});

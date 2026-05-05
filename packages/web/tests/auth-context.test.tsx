import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Module-level mock for amazon-cognito-identity-js. Each test sets
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
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  cognitoUserGetSessionMock: vi.fn(),
  cognitoUserSignOutMock: vi.fn(),
  authenticateUserMock: vi.fn(),
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
      };
    }),
    AuthenticationDetails: vi.fn(function () {
      return {};
    }),
  };
});

// Stub the env so cognito.ts module-init does not throw.
vi.stubEnv('VITE_COGNITO_OFFICINE_POOL_ID', 'eu-central-1_test');
vi.stubEnv('VITE_COGNITO_OFFICINE_CLIENT_ID', 'test-client-id');

import { AuthProvider } from '@/auth/AuthContext';
import { useAuth } from '@/auth/useAuth';

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

beforeEach(() => {
  getCurrentUserMock.mockReset();
  cognitoUserGetSessionMock.mockReset();
  cognitoUserSignOutMock.mockReset();
  authenticateUserMock.mockReset();
});

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
            payload: { email: 'giuseppe@officina-bianchi.it', given_name: 'Giuseppe' },
          }),
        });
      },
      signOut: vi.fn(),
    };
    getCurrentUserMock.mockReturnValue(fakeUser);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('authenticated'));
    if (result.current.state.status === 'authenticated') {
      expect(result.current.state.user.email).toBe('giuseppe@officina-bianchi.it');
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

describe('AuthProvider signIn', () => {
  it('transitions authenticating → authenticated on success', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation((_details, callbacks) => {
      callbacks.onSuccess({
        getIdToken: () => ({
          payload: { email: 'giuseppe@officina-bianchi.it' },
        }),
      });
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('giuseppe@officina-bianchi.it', 'pwd123');
    });

    expect(result.current.state.status).toBe('authenticated');
  });

  it('transitions authenticating → unauthenticated on failure with mapped error', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation((_details, callbacks) => {
      callbacks.onFailure({ name: 'NotAuthorizedException' });
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('a@b.it', 'wrong');
    });

    expect(result.current.state.status).toBe('unauthenticated');
    if (result.current.state.status === 'unauthenticated') {
      expect(result.current.state.error).toBe('Email o password non corretti');
    }
  });

  it('transitions authenticating → unauthenticated with explicit MFA-not-supported message', async () => {
    getCurrentUserMock.mockReturnValue(null);
    authenticateUserMock.mockImplementation((_details, callbacks) => {
      callbacks.mfaRequired?.('SMS_MFA', {});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn('a@b.it', 'pwd');
    });

    if (result.current.state.status === 'unauthenticated') {
      expect(result.current.state.error).toContain('MFA');
    }
  });
});

describe('AuthProvider signOut', () => {
  it('clears session and transitions to unauthenticated', async () => {
    const signOutFn = vi.fn();
    const fakeUser = {
      getSession: (cb: (err: unknown, session: unknown) => void) => {
        cb(null, {
          isValid: () => true,
          getIdToken: () => ({
            payload: { email: 'giuseppe@officina-bianchi.it' },
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
});

describe('useAuth outside provider', () => {
  it('throws helpful error', () => {
    const TestNoProvider = () => {
      useAuth();
      return null;
    };
    expect(() => render(<TestNoProvider />)).toThrow(/useAuth must be used within AuthProvider/);
  });
});

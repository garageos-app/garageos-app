import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AuthenticationDetails,
  CognitoUser,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { platformAdminsUserPool } from '@/lib/cognito';
import { mapCognitoError } from '@/lib/auth-errors';

// Platform-admins pool has no custom:role or custom:tenant_id claims —
// only the standard OIDC claims are present.
export interface AuthenticatedUser {
  email: string;
  givenName?: string;
  familyName?: string;
}

export type AuthState =
  | { status: 'idle' }
  | { status: 'authenticating' }
  | { status: 'authenticated'; user: AuthenticatedUser }
  | { status: 'unauthenticated'; error?: string }
  // Cognito NEW_PASSWORD_REQUIRED challenge: admin signed in with a temporary
  // password and must set a permanent one before the session is established.
  | { status: 'new_password_required' };

type AuthAction =
  | { type: 'REHYDRATE_OK'; user: AuthenticatedUser }
  | { type: 'REHYDRATE_NONE' }
  | { type: 'SIGNIN_START' }
  | { type: 'SIGNIN_OK'; user: AuthenticatedUser }
  | { type: 'SIGNIN_ERROR'; message: string }
  | { type: 'NEW_PASSWORD_REQUIRED' }
  | { type: 'SIGNOUT' };

function reducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'REHYDRATE_OK':
      if (state.status === 'idle') return { status: 'authenticated', user: action.user };
      return state;
    case 'REHYDRATE_NONE':
      if (state.status === 'idle') return { status: 'unauthenticated' };
      return state;
    case 'SIGNIN_START':
      if (state.status === 'unauthenticated' || state.status === 'idle') {
        return { status: 'authenticating' };
      }
      return state;
    case 'SIGNIN_OK':
      // Accept SIGNIN_OK from both authenticating (normal flow) and
      // new_password_required (after completeNewPassword succeeds).
      if (state.status === 'authenticating' || state.status === 'new_password_required') {
        return { status: 'authenticated', user: action.user };
      }
      return state;
    case 'SIGNIN_ERROR':
      if (state.status === 'authenticating' || state.status === 'new_password_required') {
        return { status: 'unauthenticated', error: action.message };
      }
      return state;
    case 'NEW_PASSWORD_REQUIRED':
      if (state.status === 'authenticating') return { status: 'new_password_required' };
      return state;
    case 'SIGNOUT':
      return { status: 'unauthenticated' };
  }
}

export interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  getIdToken: () => Promise<string | null>;
  /** Finish the NEW_PASSWORD_REQUIRED Cognito challenge. */
  completeNewPassword: (newPassword: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function userFromIdToken(idToken: { payload: Record<string, unknown> }): AuthenticatedUser {
  const email = String(idToken.payload.email ?? '');
  const givenName = idToken.payload.given_name ? String(idToken.payload.given_name) : undefined;
  const familyName = idToken.payload.family_name ? String(idToken.payload.family_name) : undefined;
  return { email, givenName, familyName };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' });
  const queryClient = useQueryClient();

  // Holds the CognitoUser instance between signIn (newPasswordRequired) and
  // completeNewPassword so the challenge can be completed without a second
  // authentication round-trip. See BR-N/A — challenge flow is Cognito-native.
  const pendingUserRef = useRef<CognitoUser | null>(null);

  // Rehydrate session from local storage on mount.
  useEffect(() => {
    const current = platformAdminsUserPool.getCurrentUser();
    if (!current) {
      dispatch({ type: 'REHYDRATE_NONE' });
      return;
    }
    current.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        dispatch({ type: 'REHYDRATE_NONE' });
        return;
      }
      dispatch({ type: 'REHYDRATE_OK', user: userFromIdToken(session.getIdToken()) });
    });
  }, []);

  const signIn = useCallback(
    (email: string, password: string) =>
      new Promise<void>((resolve) => {
        dispatch({ type: 'SIGNIN_START' });
        const cognitoUser = new CognitoUser({
          Username: email,
          Pool: platformAdminsUserPool,
        });
        const details = new AuthenticationDetails({ Username: email, Password: password });
        cognitoUser.authenticateUser(details, {
          onSuccess: (session) => {
            dispatch({ type: 'SIGNIN_OK', user: userFromIdToken(session.getIdToken()) });
            resolve();
          },
          onFailure: (err) => {
            dispatch({ type: 'SIGNIN_ERROR', message: mapCognitoError(err) });
            resolve();
          },
          mfaRequired: () => {
            dispatch({
              type: 'SIGNIN_ERROR',
              message: 'Utente con MFA non supportato in questa versione. Contatta il supporto.',
            });
            resolve();
          },
          // Platform admins are bootstrapped with a temporary password (Task 11
          // CLI). When Cognito issues the NEW_PASSWORD_REQUIRED challenge, store
          // the in-progress CognitoUser so completeNewPassword can finish it.
          newPasswordRequired: (userAttributes: Record<string, unknown>) => {
            // Cognito forbids re-submitting these read-only attributes.
            delete userAttributes.email_verified;
            delete userAttributes.email;
            pendingUserRef.current = cognitoUser;
            dispatch({ type: 'NEW_PASSWORD_REQUIRED' });
            resolve();
          },
        });
      }),
    [],
  );

  const completeNewPassword = useCallback(
    (newPassword: string) =>
      new Promise<void>((resolve) => {
        const user = pendingUserRef.current;
        if (!user) {
          resolve();
          return;
        }
        user.completeNewPasswordChallenge(
          newPassword,
          {},
          {
            onSuccess: (session) => {
              pendingUserRef.current = null;
              dispatch({ type: 'SIGNIN_OK', user: userFromIdToken(session.getIdToken()) });
              resolve();
            },
            onFailure: (err) => {
              dispatch({ type: 'SIGNIN_ERROR', message: mapCognitoError(err) });
              resolve();
            },
          },
        );
      }),
    [],
  );

  const signOut = useCallback(() => {
    platformAdminsUserPool.getCurrentUser()?.signOut();
    dispatch({ type: 'SIGNOUT' });
    // Clear the React Query cache so the next session does not see the
    // previous admin's cached data.
    queryClient.clear();
  }, [queryClient]);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    return new Promise((resolve) => {
      const current = platformAdminsUserPool.getCurrentUser();
      if (!current) return resolve(null);
      current.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session || !session.isValid()) return resolve(null);
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn, signOut, getIdToken, completeNewPassword }),
    [state, signIn, signOut, getIdToken, completeNewPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

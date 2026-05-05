import { createContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { officineUserPool } from '@/lib/cognito';
import { mapCognitoError } from '@/lib/auth-errors';

export interface AuthenticatedUser {
  email: string;
  givenName?: string;
  familyName?: string;
}

export type AuthState =
  | { status: 'idle' }
  | { status: 'authenticating' }
  | { status: 'authenticated'; user: AuthenticatedUser }
  | { status: 'unauthenticated'; error?: string };

type AuthAction =
  | { type: 'REHYDRATE_OK'; user: AuthenticatedUser }
  | { type: 'REHYDRATE_NONE' }
  | { type: 'SIGNIN_START' }
  | { type: 'SIGNIN_OK'; user: AuthenticatedUser }
  | { type: 'SIGNIN_ERROR'; message: string }
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
      if (state.status === 'authenticating') return { status: 'authenticated', user: action.user };
      return state;
    case 'SIGNIN_ERROR':
      if (state.status === 'authenticating') {
        return { status: 'unauthenticated', error: action.message };
      }
      return state;
    case 'SIGNOUT':
      return { status: 'unauthenticated' };
  }
}

export interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

function userFromIdToken(idToken: { payload: Record<string, unknown> }): AuthenticatedUser {
  const email = String(idToken.payload.email ?? '');
  const givenName = idToken.payload.given_name ? String(idToken.payload.given_name) : undefined;
  const familyName = idToken.payload.family_name ? String(idToken.payload.family_name) : undefined;
  return { email, givenName, familyName };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' });

  useEffect(() => {
    const current = officineUserPool.getCurrentUser();
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

  const signIn = (email: string, password: string) =>
    new Promise<void>((resolve) => {
      dispatch({ type: 'SIGNIN_START' });
      const cognitoUser = new CognitoUser({ Username: email, Pool: officineUserPool });
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
        newPasswordRequired: () => {
          dispatch({
            type: 'SIGNIN_ERROR',
            message: 'Devi reimpostare la password. Contatta il supporto.',
          });
          resolve();
        },
      });
    });

  const signOut = () => {
    officineUserPool.getCurrentUser()?.signOut();
    dispatch({ type: 'SIGNOUT' });
  };

  return <AuthContext.Provider value={{ state, signIn, signOut }}>{children}</AuthContext.Provider>;
}

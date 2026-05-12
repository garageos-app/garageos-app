import { createContext, useCallback, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { officineUserPool } from '@/lib/cognito';
import { mapCognitoError } from '@/lib/auth-errors';

export type UserRole = 'super_admin' | 'mechanic';

// Officine pool roles, mirrored from
// packages/api/src/middleware/tenant-context.ts (z.enum source of truth).
// Duplicated here on purpose: importing the backend Zod schema would
// pull @garageos/api (and its transitive deps) into the Vite bundle.
// When backend adds a role, add it here too — see ALLOWED_ROLES below.
const ALLOWED_ROLES: readonly UserRole[] = ['super_admin', 'mechanic'];

export interface AuthenticatedUser {
  email: string;
  givenName?: string;
  familyName?: string;
  // Pre-emptive UI gating only — backend remains authoritative via
  // 403 on each request. Undefined when claim missing or unknown.
  role?: UserRole;
  // Tenant id surfaced for future logging / error breadcrumbs.
  // No client-side UUID parse — backend Zod validates on every request.
  tenantId?: string;
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
  getIdToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function userFromIdToken(idToken: { payload: Record<string, unknown> }): AuthenticatedUser {
  const email = String(idToken.payload.email ?? '');
  const givenName = idToken.payload.given_name ? String(idToken.payload.given_name) : undefined;
  const familyName = idToken.payload.family_name ? String(idToken.payload.family_name) : undefined;

  const roleRaw = idToken.payload['custom:role'];
  let role: UserRole | undefined;
  if (typeof roleRaw === 'string' && (ALLOWED_ROLES as readonly string[]).includes(roleRaw)) {
    role = roleRaw as UserRole;
  } else if (roleRaw !== undefined) {
    console.warn('AuthContext: unknown custom:role claim, ignoring', { raw: roleRaw });
  }

  const tenantRaw = idToken.payload['custom:tenant_id'];
  const tenantId = typeof tenantRaw === 'string' && tenantRaw.length > 0 ? tenantRaw : undefined;

  return { email, givenName, familyName, role, tenantId };
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

  const signIn = useCallback(
    (email: string, password: string) =>
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
      }),
    [],
  );

  const signOut = useCallback(() => {
    officineUserPool.getCurrentUser()?.signOut();
    dispatch({ type: 'SIGNOUT' });
  }, []);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    return new Promise((resolve) => {
      const current = officineUserPool.getCurrentUser();
      if (!current) return resolve(null);
      current.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session || !session.isValid()) return resolve(null);
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn, signOut, getIdToken }),
    [state, signIn, signOut, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

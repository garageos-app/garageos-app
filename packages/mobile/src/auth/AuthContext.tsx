import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { signInSrp, refreshSession } from '@/lib/cognito';
import { clearTokens, readTokens, writeTokens, type StoredTokens } from '@/lib/secure-storage';

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

type AuthenticatedFields = {
  idToken: string;
  refreshToken: string;
  customerId: string;
  email: string;
};

export type AuthContextValue = {
  status: AuthStatus;
  customerId: string | null;
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => string | null;
  refresh: () => Promise<string>; // returns new idToken
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  // tokensRef holds current tokens. We intentionally use a ref (not useState) so
  // that downstream consumers (e.g. api-client closure in Task 8) reading via
  // getIdToken() always observe the latest value after refresh, without forcing
  // a re-render on every token swap.
  const tokensRef = useRef<AuthenticatedFields | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readTokens();
      if (cancelled) return;
      if (!stored) {
        setStatus('unauthenticated');
        return;
      }
      tokensRef.current = {
        idToken: stored.idToken,
        refreshToken: stored.refreshToken,
        customerId: stored.customerId,
        email: stored.email,
      };
      setStatus('authenticated');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
    const result = await signInSrp(email, password);
    const payload: StoredTokens = {
      idToken: result.idToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      customerId: result.customerId,
      email: result.email,
    };
    await writeTokens(payload);
    tokensRef.current = {
      idToken: result.idToken,
      refreshToken: result.refreshToken,
      customerId: result.customerId,
      email: result.email,
    };
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await clearTokens();
    tokensRef.current = null;
    setStatus('unauthenticated');
  }, []);

  const getIdToken = useCallback((): string | null => tokensRef.current?.idToken ?? null, []);

  const refresh = useCallback(async (): Promise<string> => {
    const current = tokensRef.current;
    if (!current) throw new Error('refresh called without active session');
    const result = await refreshSession(current.email, current.refreshToken);
    const payload: StoredTokens = {
      idToken: result.idToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      customerId: result.customerId,
      email: result.email,
    };
    await writeTokens(payload);
    tokensRef.current = {
      idToken: result.idToken,
      refreshToken: result.refreshToken,
      customerId: result.customerId,
      email: result.email,
    };
    return result.idToken;
  }, []);

  // value depends only on `status` (refs don't trigger re-renders); customerId
  // and email read from tokensRef inside the factory so they're fresh whenever
  // status transitions cause a re-render.
  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      customerId: tokensRef.current?.customerId ?? null,
      email: tokensRef.current?.email ?? null,
      signIn,
      signOut,
      getIdToken,
      refresh,
    }),
    [status, signIn, signOut, getIdToken, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

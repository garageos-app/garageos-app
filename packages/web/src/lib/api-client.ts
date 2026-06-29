import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/useAuth';
import { ACCOUNT_INACTIVE_MESSAGE } from '@/lib/error-messages';

// Backend code (APPENDICE_G §3.2) for a terminal post-auth denial: officine
// user disabled or tenant suspended. Kept as a single named constant so the
// 401 dispatch below cannot silently drift from a typo.
export const ACCOUNT_INACTIVE_CODE = 'auth.session.inactive';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ApiClientDeps {
  getIdToken: () => Promise<string | null>;
  onAuthExpired: () => void;
  // Called on a 401 whose body code is `auth.session.inactive` (officine user
  // disabled or tenant suspended — a terminal denial that re-login cannot
  // clear). Distinct from onAuthExpired so the app shows a terminal screen
  // instead of bouncing back to /login.
  onAccountInactive: () => void;
  baseUrl: string;
}

export function createApiFetch(deps: ApiClientDeps) {
  return async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await deps.getIdToken();
    if (!token) {
      throw new ApiError('auth.no_token', 401, 'Non sei autenticato');
    }

    const url = deps.baseUrl + path;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...init?.headers,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new ApiError('network.offline', 0, 'Errore di connessione. Verifica la rete.');
    }

    // Parse the RFC-7807 body once and dispatch on it (the 401 branch needs
    // the `code`, the generic error branch needs `detail`/`name`). An empty or
    // unparseable body becomes {} so both branches fall back gracefully.
    const body = (await res.json().catch(() => ({}))) as {
      code?: unknown;
      detail?: unknown;
      // Legacy/non-RFC-7807 fallbacks
      name?: unknown;
      message?: unknown;
    };

    if (res.status === 401) {
      // A terminal account/tenant denial (auth.session.inactive — re-login
      // won't help) is told apart from a plain expired/invalid token
      // (UNAUTHORIZED — re-login is the fix) by the body code. A bodyless 401
      // has no code and falls through to the expired path. The thrown message
      // is the centralized Italian copy, never the server's English detail
      // (which would surface untranslated via translateError on mutations).
      if (body.code === ACCOUNT_INACTIVE_CODE) {
        deps.onAccountInactive();
        throw new ApiError(ACCOUNT_INACTIVE_CODE, 401, ACCOUNT_INACTIVE_MESSAGE);
      }
      deps.onAuthExpired();
      throw new ApiError('auth.expired', 401, 'Sessione scaduta');
    }

    if (!res.ok) {
      const code =
        typeof body?.code === 'string'
          ? body.code
          : typeof body?.name === 'string'
            ? body.name
            : `http.${res.status}`;
      const message =
        typeof body?.detail === 'string'
          ? body.detail
          : typeof body?.message === 'string'
            ? body.message
            : `Errore ${res.status}: servizio temporaneamente non disponibile`;
      throw new ApiError(code, res.status, message);
    }
    return body as T;
  };
}

export function useApiFetch() {
  const { getIdToken, signOut, markAccountInactive } = useAuth();
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
  return useCallback(
    createApiFetch({
      getIdToken,
      onAuthExpired: () => {
        toast.error('Sessione scaduta. Effettua nuovamente il login.');
        signOut();
      },
      // No toast: the terminal screen (ProtectedRoute → AccountInactive)
      // carries the message. signOut is intentionally not called here so the
      // Cognito session survives a reload and re-lands on the terminal screen.
      onAccountInactive: markAccountInactive,
      baseUrl,
    }),
    [getIdToken, signOut, markAccountInactive, baseUrl],
  );
}

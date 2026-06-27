import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/useAuth';

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

    if (res.status === 401) {
      deps.onAuthExpired();
      throw new ApiError('auth.expired', 401, 'Sessione scaduta');
    }

    const body = (await res.json().catch(() => ({}))) as {
      code?: unknown;
      detail?: unknown;
      // Legacy/non-RFC-7807 fallbacks
      name?: unknown;
      message?: unknown;
    };
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
  const { getIdToken, signOut } = useAuth();
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
  return useCallback(
    createApiFetch({
      getIdToken,
      onAuthExpired: () => {
        toast.error('Sessione scaduta. Effettua nuovamente il login.');
        signOut();
      },
      baseUrl,
    }),
    [getIdToken, signOut, baseUrl],
  );
}

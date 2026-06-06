// api-client — factory returning a typed fetch wrapper with:
// - Bearer token injection (from getIdToken callback)
// - 401 single-retry after refreshTokens()
// - onAuthLost fired when refresh fails or second attempt still 401
// - ApiError.network() on fetch throw (DNS / offline / TypeError)
// - ApiError.fromResponse on non-ok responses (parses RFC 7807 code/detail)
// See plan 2026-05-14-mobile-b2c-scaffold §Task 5 and memory feedback_fastify_empty_body_under_json_content_type:
// Content-Type must NOT be set when body is undefined (Fastify rejects empty JSON body with 400).

import { ApiError } from './api-error';

type RequestOpts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

type ClientDeps = {
  getIdToken: () => string | null;
  refreshTokens: () => Promise<string>; // returns new idToken; throws on failure
  onAuthLost: () => void;
};

export type ApiClient = {
  fetch: <T = unknown>(path: string, opts?: RequestOpts) => Promise<T>;
};

export function createApiClient(deps: ClientDeps): ApiClient {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not set');
  }

  async function doFetch(path: string, opts: RequestOpts, idToken: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${idToken}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body,
        signal: opts.signal,
      });
    } catch {
      // Network throw (DNS, offline, TypeError from fetch)
      throw ApiError.network();
    }
  }

  async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const idToken = deps.getIdToken();
    if (!idToken) {
      deps.onAuthLost();
      throw new ApiError(
        'auth.session_expired',
        401,
        "Sessione scaduta. Effettua di nuovo l'accesso.",
      );
    }

    let res = await doFetch(path, opts, idToken);

    if (res.status === 401) {
      let newToken: string;
      try {
        newToken = await deps.refreshTokens();
      } catch {
        deps.onAuthLost();
        throw new ApiError(
          'auth.session_expired',
          401,
          "Sessione scaduta. Effettua di nuovo l'accesso.",
        );
      }
      res = await doFetch(path, opts, newToken);
      if (res.status === 401) {
        deps.onAuthLost();
        throw new ApiError(
          'auth.session_expired',
          401,
          "Sessione scaduta. Effettua di nuovo l'accesso.",
        );
      }
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw ApiError.fromResponse(res.status, body);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return { fetch: apiFetch };
}

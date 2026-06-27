import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApiFetch } from '@/lib/api-client';

// createApiFetch is a pure factory with injected deps — no React or Cognito
// needed; we test it in isolation.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApiFetch', () => {
  it('calls onAuthExpired and throws ApiError(auth.no_token) when getIdToken returns null', async () => {
    const onAuthExpired = vi.fn();
    const apiFetch = createApiFetch({
      getIdToken: () => Promise.resolve(null),
      onAuthExpired,
      baseUrl: 'https://api.example.com',
    });

    await expect(apiFetch('/v1/admin/me')).rejects.toMatchObject({
      code: 'auth.no_token',
      status: 401,
    });
    // onAuthExpired must fire so the caller can sign the user out.
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('calls onAuthExpired and throws ApiError(auth.expired) on a 401 response', async () => {
    const onAuthExpired = vi.fn();
    const apiFetch = createApiFetch({
      getIdToken: () => Promise.resolve('valid-token'),
      onAuthExpired,
      baseUrl: 'https://api.example.com',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        json: () => Promise.resolve({}),
      }),
    );

    await expect(apiFetch('/v1/admin/me')).rejects.toMatchObject({
      code: 'auth.expired',
      status: 401,
    });
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('resolves with the parsed body on a successful response', async () => {
    const onAuthExpired = vi.fn();
    const apiFetch = createApiFetch({
      getIdToken: () => Promise.resolve('valid-token'),
      onAuthExpired,
      baseUrl: 'https://api.example.com',
    });

    const payload = {
      sub: 'abc',
      email: 'admin@garageos.it',
      firstName: 'Mario',
      lastName: 'Rossi',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve(payload),
      }),
    );

    const result = await apiFetch('/v1/admin/me');
    expect(result).toEqual(payload);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});

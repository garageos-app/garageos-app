import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiFetch } from './api-client';

const baseDeps = () => ({
  getIdToken: vi.fn().mockResolvedValue('FAKE_JWT'),
  onAuthExpired: vi.fn(),
  baseUrl: 'https://api.example.com',
});

describe('createApiFetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('200: returns parsed JSON, includes Authorization header', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = baseDeps();
    const apiFetch = createApiFetch(deps);
    const result = await apiFetch<{ ok: boolean }>('/v1/test');
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/v1/test',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer FAKE_JWT' }),
      }),
    );
  });

  it('401: triggers onAuthExpired + throws ApiError(auth.expired)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const deps = baseDeps();
    const apiFetch = createApiFetch(deps);
    await expect(apiFetch('/v1/test')).rejects.toMatchObject({
      code: 'auth.expired',
      status: 401,
    });
    expect(deps.onAuthExpired).toHaveBeenCalledOnce();
  });

  it('404 with RFC 7807 body: parses code+detail from server', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'https://api.garageos.it/errors/NOT_FOUND',
          title: 'Resource not found',
          status: 404,
          code: 'NOT_FOUND',
          detail: 'The requested resource does not exist or is not accessible.',
          instance: '/v1/vehicles/abc',
          request_id: 'req-1',
        }),
        { status: 404 },
      ),
    );
    const apiFetch = createApiFetch(baseDeps());
    await expect(apiFetch('/v1/vehicles/abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: 'The requested resource does not exist or is not accessible.',
    });
  });

  it('4xx with legacy name+message body: falls back to those fields', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'legacy.code', message: 'Legacy message.' }), {
        status: 422,
      }),
    );
    const apiFetch = createApiFetch(baseDeps());
    await expect(apiFetch('/v1/test')).rejects.toMatchObject({
      code: 'legacy.code',
      status: 422,
      message: 'Legacy message.',
    });
  });

  it('500: throws ApiError fallback', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    const apiFetch = createApiFetch(baseDeps());
    await expect(apiFetch('/v1/test')).rejects.toBeInstanceOf(ApiError);
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(apiFetch('/v1/test')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('network failure: throws ApiError(network.offline, 0)', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const apiFetch = createApiFetch(baseDeps());
    await expect(apiFetch('/v1/test')).rejects.toMatchObject({
      code: 'network.offline',
      status: 0,
    });
  });

  it('no token: throws ApiError(auth.no_token, 401) without calling fetch', async () => {
    const deps = { ...baseDeps(), getIdToken: vi.fn().mockResolvedValue(null) };
    const apiFetch = createApiFetch(deps);
    await expect(apiFetch('/v1/test')).rejects.toMatchObject({
      code: 'auth.no_token',
      status: 401,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('init.headers merge: caller headers preserved', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const apiFetch = createApiFetch(baseDeps());
    await apiFetch('/v1/test', { headers: { 'X-Custom': 'value' } });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom': 'value',
          Authorization: 'Bearer FAKE_JWT',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('POST with body: forwards body in init', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const apiFetch = createApiFetch(baseDeps());
    await apiFetch('/v1/test', { method: 'POST', body: '{"x":1}' });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST', body: '{"x":1}' }),
    );
  });
});

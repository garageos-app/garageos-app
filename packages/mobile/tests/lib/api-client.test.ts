import { createApiClient } from '@/lib/api-client';

describe('createApiClient', () => {
  const apiUrl = 'https://api.test.example.com';
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = apiUrl;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('injects Bearer token + base URL', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    const client = createApiClient({
      getIdToken: () => 'idtok',
      refreshTokens: jest.fn(),
      onAuthLost: jest.fn(),
    });
    await client.fetch('/v1/me/vehicles');
    expect(fetch).toHaveBeenCalledWith(
      `${apiUrl}/v1/me/vehicles`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer idtok' }),
      }),
    );
  });

  it('retries once on 401 after successful refresh', async () => {
    const refresh = jest.fn(async () => 'newtok');
    let call = 0;
    (fetch as unknown as jest.Mock).mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    const client = createApiClient({
      getIdToken: () => 'old',
      refreshTokens: refresh,
      onAuthLost: jest.fn(),
    });
    const res = await client.fetch<{ data: unknown[] }>('/v1/me/vehicles');
    expect(res.data).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondCall = (fetch as unknown as jest.Mock).mock.calls[1][1];
    expect(secondCall.headers.Authorization).toBe('Bearer newtok');
  });

  it('triggers onAuthLost and throws when refresh fails', async () => {
    const onAuthLost = jest.fn();
    const refresh = jest.fn(async () => {
      throw new Error('refresh failed');
    });
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const client = createApiClient({
      getIdToken: () => 'old',
      refreshTokens: refresh,
      onAuthLost,
    });
    await expect(client.fetch('/v1/me/vehicles')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'auth.session_expired',
    });
    expect(onAuthLost).toHaveBeenCalled();
  });

  it('throws ApiError.network on fetch throw', async () => {
    (fetch as unknown as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
    const client = createApiClient({
      getIdToken: () => 'tok',
      refreshTokens: jest.fn(),
      onAuthLost: jest.fn(),
    });
    await expect(client.fetch('/v1/me/vehicles')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'network.unreachable',
      status: 0,
    });
  });

  it('triggers onAuthLost and throws when getIdToken returns null upfront', async () => {
    const onAuthLost = jest.fn();
    const refresh = jest.fn();
    const client = createApiClient({
      getIdToken: () => null,
      refreshTokens: refresh,
      onAuthLost,
    });
    await expect(client.fetch('/v1/me/vehicles')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'auth.session_expired',
      status: 401,
    });
    expect(onAuthLost).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('triggers onAuthLost when retry after refresh also returns 401', async () => {
    const onAuthLost = jest.fn();
    const refresh = jest.fn(async () => 'newtok');
    (fetch as unknown as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const client = createApiClient({
      getIdToken: () => 'old',
      refreshTokens: refresh,
      onAuthLost,
    });
    await expect(client.fetch('/v1/me/vehicles')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'auth.session_expired',
      status: 401,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onAuthLost).toHaveBeenCalled();
  });

  it('parses RFC 7807 code + detail from 4xx body (the real API error envelope)', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        type: 'https://api.garageos.it/errors/me.vehicle.claim.code_not_found',
        title: 'Not Found',
        status: 404,
        code: 'me.vehicle.claim.code_not_found',
        detail: 'Nessun veicolo trovato per questo codice.',
        instance: '/v1/me/vehicles/claim',
        request_id: 'abc',
      }),
    });
    const client = createApiClient({
      getIdToken: () => 'tok',
      refreshTokens: jest.fn(),
      onAuthLost: jest.fn(),
    });
    const promise = client.fetch('/v1/me/vehicles/claim', { method: 'POST', body: {} });
    await expect(promise).rejects.toMatchObject({
      code: 'me.vehicle.claim.code_not_found',
      status: 404,
    });
    await expect(promise).rejects.toHaveProperty(
      'message',
      'Nessun veicolo trovato per questo codice.',
    );
  });

  it('falls back to legacy error_code + error_message when present', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error_code: 'me.vehicle.not_found',
        error_message: 'Veicolo non trovato',
      }),
    });
    const client = createApiClient({
      getIdToken: () => 'tok',
      refreshTokens: jest.fn(),
      onAuthLost: jest.fn(),
    });
    await expect(client.fetch('/v1/me/vehicles/abc')).rejects.toMatchObject({
      code: 'me.vehicle.not_found',
      status: 404,
    });
  });

  it('does not set Content-Type when body undefined', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const client = createApiClient({
      getIdToken: () => 'tok',
      refreshTokens: jest.fn(),
      onAuthLost: jest.fn(),
    });
    await client.fetch('/v1/me/vehicles');
    const headers = (fetch as unknown as jest.Mock).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Content-Type']).toBeUndefined();
  });
});

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

  it('parses error_code + error_message from 4xx body', async () => {
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

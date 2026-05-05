import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

describe('CORS integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('preflight from app.<domain> is allowed (echoes Origin, allows POST)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me/vehicles',
      headers: {
        origin: 'https://app.garageos.aifollyadvisor.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.garageos.aifollyadvisor.com',
    );
    const allowMethods = String(res.headers['access-control-allow-methods'] ?? '');
    expect(allowMethods).toContain('POST');
  });

  it('preflight from a disallowed origin is not echoed back', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me/vehicles',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });

    // @fastify/cors returns 204 for OPTIONS but omits the
    // Access-Control-Allow-Origin header → browser blocks the request.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET /health from app.<domain> includes CORS response headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'https://app.garageos.aifollyadvisor.com',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.garageos.aifollyadvisor.com',
    );
    const exposed = String(res.headers['access-control-expose-headers'] ?? '');
    expect(exposed).toContain('X-Request-ID');
  });
});

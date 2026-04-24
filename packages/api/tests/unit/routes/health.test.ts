import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';

// Plugin options hook — buildServer() accepts an optional Prisma
// override routed through to the database plugin. Unit tests rely on
// this to avoid opening a real connection. Integration tests register
// the plugin with no override (default singleton → real Postgres).
function buildApp(overrides: { prisma?: { $queryRaw: (...args: unknown[]) => Promise<unknown> } }) {
  return buildServer({
    database: {
      prisma: {
        $queryRaw: overrides.prisma?.$queryRaw ?? (() => Promise.resolve([{ '?column?': 1 }])),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      } as never,
      withContext: ((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})) as never,
    },
  });
}

describe('GET /health', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status ok, ISO timestamp, version, services.database=ok', async () => {
    app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      timestamp: string;
      version: string;
      services: { database: string };
    };
    expect(body).toMatchObject({
      status: 'ok',
      version: expect.any(String) as unknown,
      services: { database: 'ok' },
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it('returns 503 degraded when the DB query throws', async () => {
    app = await buildApp({
      prisma: {
        $queryRaw: () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; services: { database: string } };
    expect(body).toMatchObject({
      status: 'degraded',
      services: { database: 'error' },
    });
    // The underlying error detail must not leak to the client.
    expect(JSON.stringify(body)).not.toContain('connection refused');
  });

  it('returns 503 degraded when the DB query times out (>2s)', async () => {
    app = await buildApp({
      prisma: {
        // Never resolves — the route's 2 s timeout races it.
        $queryRaw: () => new Promise(() => undefined),
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      services: { database: 'error' },
    });
  }, 10_000);

  it('auto-generates x-request-id when the client omits it', async () => {
    app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/health' });

    const rid = res.headers['x-request-id'];
    expect(rid).toBeTypeOf('string');
    expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('preserves client-supplied x-request-id', async () => {
    app = await buildApp({});
    const clientId = '01HKXN5A-MOCK-4BE3-9DCB-test00000001';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': clientId },
    });

    expect(res.headers['x-request-id']).toBe(clientId);
  });
});

describe('unknown route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({});
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 in RFC 7807 Problem Details format', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/NOT_FOUND',
      title: 'Resource not found',
      status: 404,
      instance: '/does-not-exist',
      request_id: expect.any(String) as unknown,
    });
  });
});

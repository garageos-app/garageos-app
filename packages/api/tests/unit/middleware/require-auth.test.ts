import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';
import { requireAuth } from '../../../src/middleware/require-auth.js';
import type { JwtVerifier, VerifyResult } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

// The verifier is the unit under test's dependency — we swap it with a
// fake via `app.decorate('jwtVerifier', fake)`. The real plugin's
// fp wrapping is covered in tests/unit/plugins/auth.test.ts.

function makeFakeVerifier(impl: (token: string) => Promise<VerifyResult>): JwtVerifier {
  return { verify: vi.fn(impl) };
}

async function buildApp(verifier: JwtVerifier): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.decorate('jwtVerifier', verifier);
  app.get('/_probe', { preHandler: requireAuth }, async (request) => ({
    pool: request.authPool,
    sub: request.jwt?.sub,
  }));
  return app;
}

describe('requireAuth middleware', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 Problem Details when Authorization header is missing', async () => {
    app = await buildApp(makeFakeVerifier(() => Promise.reject(new Error('unreachable'))));

    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      title: 'Unauthorized',
      status: 401,
      instance: '/_probe',
    });
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    app = await buildApp(makeFakeVerifier(() => Promise.reject(new Error('unreachable'))));

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Bearer token is empty', async () => {
    app = await buildApp(makeFakeVerifier(() => Promise.reject(new Error('unreachable'))));

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer ' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when verifier throws (invalid signature)', async () => {
    const verifier = makeFakeVerifier(() => {
      throw new Error('signature verification failed');
    });
    app = await buildApp(verifier);

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer bogus.jwt.token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: 401, title: 'Unauthorized' });
    // Body detail is generic — never leaks the underlying reason
    expect((res.json() as { detail: string }).detail).not.toContain('signature');
  });

  it('returns 401 when verifier throws (expired)', async () => {
    const verifier = makeFakeVerifier(() => {
      const err = new Error('token is expired');
      err.name = 'JwtExpiredError';
      throw err;
    });
    app = await buildApp(verifier);

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer expired.jwt.token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('populates request.jwt and request.authPool on success (officine)', async () => {
    const verifier = makeFakeVerifier(async () => ({
      pool: 'officine',
      payload: { sub: 'cognito-sub-123', token_use: 'id' },
    }));
    app = await buildApp(verifier);

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer valid.jwt.token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pool: 'officine', sub: 'cognito-sub-123' });
  });

  it('populates request.authPool=clienti when verifier reports clienti pool', async () => {
    const verifier = makeFakeVerifier(async () => ({
      pool: 'clienti',
      payload: { sub: 'cognito-sub-456', token_use: 'id' },
    }));
    app = await buildApp(verifier);

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer valid.jwt.token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pool: 'clienti', sub: 'cognito-sub-456' });
  });

  it('accepts `bearer` (lowercase) as scheme — case-insensitive', async () => {
    const verifier = makeFakeVerifier(async () => ({
      pool: 'officine',
      payload: { sub: 'x', token_use: 'id' },
    }));
    app = await buildApp(verifier);

    const res = await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'bearer token' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('invokes verifier exactly once with the bare token (no scheme prefix)', async () => {
    const spy = vi.fn(async () => ({
      pool: 'officine' as const,
      payload: { sub: 'x', token_use: 'id' as const },
    }));
    const verifier: JwtVerifier = { verify: spy };
    app = await buildApp(verifier);

    await app.inject({
      method: 'GET',
      url: '/_probe',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('abc.def.ghi');
  });
});

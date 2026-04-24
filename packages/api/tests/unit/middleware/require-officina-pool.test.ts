import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';
import { requireOfficinaPool } from '../../../src/middleware/require-officina-pool.js';
import type { AuthPool } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

// Standalone middleware tests: no requireAuth upstream, we set
// request.authPool manually via an inline preHandler so we can exercise
// requireOfficinaPool's branches in isolation.

async function buildApp(authPool: AuthPool | undefined): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.get(
    '/_probe',
    {
      preHandler: [
        async (request) => {
          request.authPool = authPool;
        },
        requireOfficinaPool,
      ],
    },
    async () => ({ ok: true }),
  );
  return app;
}

describe('requireOfficinaPool middleware', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('passes through when authPool === officine', async () => {
    app = await buildApp('officine');
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 403 Forbidden Problem Details when authPool === clienti', async () => {
    app = await buildApp('clienti');
    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      title: 'Forbidden',
      status: 403,
      instance: '/_probe',
    });
    expect((res.json() as { detail: string }).detail).toMatch(/customer/i);
  });

  it('returns 403 when authPool is undefined (defensive — requireAuth must run first)', async () => {
    app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(403);
  });
});

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';
import { requirePlatformAdminsPool } from '../../../src/middleware/require-platform-admins-pool.js';
import type { AuthPool } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

// Standalone middleware tests: no requireAuth upstream, we set
// request.authPool manually via an inline preHandler so we can exercise
// requirePlatformAdminsPool's branches in isolation.

async function buildApp(authPool: AuthPool | undefined): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.get(
    '/_probe',
    {
      preHandler: [
        async (request) => {
          // exactOptionalPropertyTypes: assign only when defined so the
          // `undefined` test case exercises the "property never set" path.
          if (authPool !== undefined) {
            request.authPool = authPool;
          }
        },
        requirePlatformAdminsPool,
      ],
    },
    async () => ({ ok: true }),
  );
  return app;
}

describe('requirePlatformAdminsPool middleware', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('passes through when authPool === platform-admins', async () => {
    app = await buildApp('platform-admins');
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 403 Forbidden Problem Details when authPool === officine', async () => {
    app = await buildApp('officine');
    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      title: 'Forbidden',
      status: 403,
      instance: '/_probe',
    });
    expect((res.json() as { detail: string }).detail).toMatch(/platform administrator/i);
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
    expect((res.json() as { detail: string }).detail).toMatch(/platform administrator/i);
  });

  it('returns 403 when authPool is undefined (defensive — requireAuth must run first)', async () => {
    app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(403);
  });
});

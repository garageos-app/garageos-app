import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dualPoolContext } from '../../../src/middleware/dual-pool-context.js';
import type { AuthPool, CognitoIdTokenPayload } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

const TENANT_ID = '00000000-0000-4000-8000-00000000000a';
const CUSTOMER_ID = '00000000-0000-4000-8000-00000000000b';
const COGNITO_SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface SetupOpts {
  authPool: AuthPool | undefined;
  jwt: Partial<CognitoIdTokenPayload> | undefined;
}

async function buildApp(opts: SetupOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.get(
    '/_probe',
    {
      preHandler: [
        async (request) => {
          if (opts.authPool !== undefined) request.authPool = opts.authPool;
          if (opts.jwt !== undefined) request.jwt = opts.jwt as CognitoIdTokenPayload;
        },
        dualPoolContext,
      ],
    },
    async (request) => ({
      authPool: request.authPool,
      tenantId: request.tenantId ?? null,
      customerId: request.customerId ?? null,
      userId: request.userId ?? null,
    }),
  );
  return app;
}

describe('dualPoolContext middleware', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('routes officine tokens through tenantContext', async () => {
    app = await buildApp({
      authPool: 'officine',
      jwt: {
        sub: COGNITO_SUB,
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
      },
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authPool: 'officine',
      tenantId: TENANT_ID,
      customerId: null,
      userId: COGNITO_SUB,
    });
  });

  it('routes clienti tokens through clientiContext', async () => {
    app = await buildApp({
      authPool: 'clienti',
      jwt: {
        sub: COGNITO_SUB,
        'custom:customer_id': CUSTOMER_ID,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authPool: 'clienti',
      tenantId: null,
      customerId: CUSTOMER_ID,
      userId: COGNITO_SUB,
    });
  });

  it('returns 401 when authPool is undefined', async () => {
    app = await buildApp({ authPool: undefined, jwt: undefined });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when officine claims fail validation', async () => {
    app = await buildApp({
      authPool: 'officine',
      jwt: { sub: COGNITO_SUB }, // missing custom:tenant_id
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when clienti claims fail validation', async () => {
    app = await buildApp({
      authPool: 'clienti',
      jwt: { sub: COGNITO_SUB }, // missing custom:customer_id
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });
});

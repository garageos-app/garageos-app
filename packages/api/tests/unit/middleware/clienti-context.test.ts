import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';
import { clientiContext } from '../../../src/middleware/clienti-context.js';
import type { CognitoIdTokenPayload } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

const CUSTOMER_ID = '00000000-0000-4000-8000-00000000000d';
const COGNITO_SUB = 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd';

type JwtStub = Partial<CognitoIdTokenPayload> | undefined;

async function buildApp(jwt: JwtStub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.get(
    '/_probe',
    {
      preHandler: [
        async (request) => {
          if (jwt !== undefined) {
            request.jwt = jwt as CognitoIdTokenPayload;
          }
        },
        clientiContext,
      ],
    },
    async (request) => ({
      userId: request.userId,
      customerId: request.customerId,
    }),
  );
  return app;
}

describe('clientiContext middleware (JWT-backed)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('populates userId/customerId from clienti claims', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:customer_id': CUSTOMER_ID,
    });

    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: COGNITO_SUB,
      customerId: CUSTOMER_ID,
    });
  });

  it('returns 401 Problem Details when request.jwt is missing', async () => {
    app = await buildApp(undefined);

    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      title: 'Unauthorized',
      status: 401,
    });
  });

  it('returns 401 when sub is missing', async () => {
    app = await buildApp({
      'custom:customer_id': CUSTOMER_ID,
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:customer_id is missing', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:customer_id is not a valid UUID', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:customer_id': 'not-a-uuid',
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('does not interfere with routes that do not register it', async () => {
    app = await buildApp(undefined);
    app.get('/_public', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/_public' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

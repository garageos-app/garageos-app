import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tenantContext } from '../../../src/middleware/tenant-context.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';

// Hard-coded UUIDs below carry the v4 nibble (4xxx) and the RFC 4122
// variant bits (8/9/a/b in the third-from-last group) so `z.uuid()`
// accepts them. Prefer crypto.randomUUID() in tests that do not need
// determinism — see the "auto-generated" case.
const TENANT_ID_A = '00000000-0000-4000-8000-00000000000a';
const USER_ID_A = '00000000-0000-4000-8000-00000000000b';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);

  app.get('/_tenant-probe', { preHandler: tenantContext }, async (request) => ({
    tenantId: request.tenantId,
    userId: request.userId,
  }));

  return app;
}

describe('tenantContext middleware', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('decorates request with tenantId and userId when both headers are valid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_tenant-probe',
      headers: { 'x-tenant-id': TENANT_ID_A, 'x-user-id': USER_ID_A },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: TENANT_ID_A, userId: USER_ID_A });
  });

  it('returns 401 RFC 7807 when X-Tenant-ID is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_tenant-probe',
      headers: { 'x-user-id': USER_ID_A },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      title: 'Unauthorized',
      status: 401,
      instance: '/_tenant-probe',
    });
  });

  it('returns 401 when X-User-ID is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_tenant-probe',
      headers: { 'x-tenant-id': TENANT_ID_A },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 401 when X-Tenant-ID is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_tenant-probe',
      headers: { 'x-tenant-id': 'not-a-uuid', 'x-user-id': USER_ID_A },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: 401 });
  });

  it('returns 401 when X-User-ID is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_tenant-probe',
      headers: { 'x-tenant-id': TENANT_ID_A, 'x-user-id': 'nope' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('does not interfere with routes that do not register it', async () => {
    app.get('/_public', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/_public' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

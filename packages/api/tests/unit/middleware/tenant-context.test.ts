import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';
import { tenantContext } from '../../../src/middleware/tenant-context.js';
import type { CognitoIdTokenPayload } from '../../../src/plugins/auth.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';

// Hard-coded UUIDs below carry the v4 nibble + RFC 4122 variant bits so
// `z.uuid()` accepts them. Matches the convention in
// packages/api/tests/integration/helpers.ts.
const TENANT_ID = '00000000-0000-4000-8000-00000000000a';
const LOCATION_ID = '00000000-0000-4000-8000-00000000000c';
const COGNITO_SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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
        tenantContext,
      ],
    },
    async (request) => ({
      tenantId: request.tenantId,
      userId: request.userId,
      userRole: request.userRole,
      locationId: request.locationId ?? null,
    }),
  );
  return app;
}

describe('tenantContext middleware (JWT-backed)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('populates tenantId/userId/userRole from officine claims', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'mechanic',
    });

    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tenantId: TENANT_ID,
      userId: COGNITO_SUB,
      userRole: 'mechanic',
      locationId: null,
    });
  });

  it('populates locationId when custom:location_id is present', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'super_admin',
      'custom:location_id': LOCATION_ID,
    });

    const res = await app.inject({ method: 'GET', url: '/_probe' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      locationId: LOCATION_ID,
      userRole: 'super_admin',
    });
  });

  it('accepts super_admin without custom:location_id (BR-204)', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'super_admin',
    });

    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userRole: 'super_admin', locationId: null });
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
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'mechanic',
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:tenant_id is missing', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:role': 'mechanic',
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:tenant_id is not a valid UUID', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': 'not-a-uuid',
      'custom:role': 'mechanic',
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:role is not a known value', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'intruder' as 'mechanic',
    });
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when custom:location_id is present but not a UUID', async () => {
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'super_admin',
      'custom:location_id': 'not-a-uuid',
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

  it('treats custom:location_id empty string as absent (F-OFF-004 clear)', async () => {
    // updateOfficineUserRoleAndLocation sets custom:location_id='' to
    // "clear" the attribute (Cognito does not support unsetting attrs).
    // The middleware must accept '' and leave request.locationId undefined.
    app = await buildApp({
      sub: COGNITO_SUB,
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'super_admin',
      'custom:location_id': '',
    });

    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userRole: 'super_admin', locationId: null });
  });
});

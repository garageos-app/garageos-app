import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// Security boundary tests for GET /v1/admin/me.
//
// This file is the per-task review gate for Slice 0: the requirePlatformAdminsPool
// guard must reject both officine and clienti tokens with 403 and must never
// admit an unauthenticated request. A leaky guard here re-exposes cross-tenant
// surface on every subsequent /v1/admin/* route.
//
// Test matrix:
//   (a) officine token         → 403 FORBIDDEN
//   (b) clienti token          → 403 FORBIDDEN
//   (c) platform-admins token  → 200 with echoed identity
//   (d) no Authorization       → 401 UNAUTHORIZED

describe('GET /v1/admin/me — auth isolation (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 FORBIDDEN when a valid officine token is used', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 FORBIDDEN when a valid clienti token is used', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 200 with echoed identity for a valid platform-admins token', async () => {
    const sub = crypto.randomUUID();
    const token = await signTestToken({
      pool: 'platform-admins',
      sub,
      email: 'admin@garageos.internal',
      extraClaims: {
        given_name: 'Luca',
        family_name: 'Bianchi',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sub,
      email: 'admin@garageos.internal',
      firstName: 'Luca',
      lastName: 'Bianchi',
    });
  });
});

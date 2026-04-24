import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { getTestKey, signTestToken } from '../helpers/jwt.js';

// End-to-end Cognito-auth chain: JWKS mock HTTP server + aws-jwt-verify
// HTTP verifier + full Fastify request pipeline. /v1/users/me is the
// canary endpoint — this file covers failure paths and pool routing;
// the actual RLS scoping lives in users-me.test.ts.

describe('Cognito auth chain (integration)', () => {
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

  it('returns 401 Problem Details when Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 401 when the token is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer not.a.valid.jwt.structure' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the token is expired', async () => {
    const token = await signTestToken({ pool: 'officine', expSecondsFromNow: -60 });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the audience does not match the client id', async () => {
    const token = await signTestToken({
      pool: 'officine',
      audience: 'wrong-client-id',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the issuer is not a known pool', async () => {
    const token = await signTestToken({
      pool: 'officine',
      poolId: 'eu-central-1_OTHERPOOL',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token_use is access (not id)', async () => {
    const token = await signTestToken({ pool: 'officine', tokenUse: 'access' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the token is signed by the wrong pool key', async () => {
    // Claims say officine but signed with the clienti private key —
    // cross-pool replay.
    const token = await signTestToken({
      pool: 'officine',
      signingKey: getTestKey('clienti'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when a valid clienti token hits an officine-only endpoint', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 200 for a valid officine token (user exists in DB)', async () => {
    const { tenantId } = await createTenantWithLocation('auth-ok');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenantId, role: 'mechanic' });
  });

  it('returns 401 when a valid token claims tenant_id = not-a-uuid', async () => {
    // JWT signature is valid but the tenant-context Zod schema rejects
    // the claim — the auth layer passes, tenant-context fails with 401.
    const token = await signTestToken({
      pool: 'officine',
      tenantId: 'not-a-uuid' as string,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

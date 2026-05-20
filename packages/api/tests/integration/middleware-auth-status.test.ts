// Integration test for Item 1 reactive (tenant-context status lookup).
// Verifica end-to-end che dopo soft-delete o status=inactive l'utente
// disattivato riceve 401 al prossimo request anche con JWT valido.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

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

describe('tenant-context — user status reactive lookup', () => {
  const TEST_IP = '10.20.50.1';

  it('rejects authenticated requests after target is soft-deleted (status=inactive + deletedAt)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('mw-soft');

    // Two super_admin so we can soft-delete one safely (no BR-203 issue).
    const otherSub = `sa-keep-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: otherSub,
      email: 'keep@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-target-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-target@test.it',
      role: 'mechanic',
      locationId,
    });

    const targetToken = await signTestToken({
      pool: 'officine',
      sub: targetSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    // Pre-soft-delete: request works.
    const okRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(okRes.statusCode).toBe(200);

    // Soft-delete via DB (bypass admin endpoint to keep the test focused).
    await pgAdmin.query(`UPDATE users SET status = 'inactive', deleted_at = now() WHERE id = $1`, [
      targetId,
    ]);

    // Post-soft-delete: same valid JWT now fails with 401.
    const koRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(koRes.statusCode).toBe(401);
  });

  it('rejects authenticated requests after PATCH status=inactive (no deletedAt)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('mw-inact');

    const otherSub = `sa-other-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: otherSub,
      email: 'other@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-inact-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-inact@test.it',
      role: 'mechanic',
      locationId,
    });

    const targetToken = await signTestToken({
      pool: 'officine',
      sub: targetSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    // Inactivate via direct DB update (sim PATCH status=inactive effect).
    await pgAdmin.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [targetId]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(401);
  });

  it('active users continue to authenticate normally (regression check)', async () => {
    const { tenantId } = await createTenantWithLocation('mw-ok');

    const sub = `sa-ok-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'ok@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(200);
  });
});

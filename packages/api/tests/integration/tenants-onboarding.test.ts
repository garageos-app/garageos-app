import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('POST /v1/tenants/me/onboarding/complete (integration)', () => {
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

  async function setup(suffix: string, role: 'super_admin' | 'mechanic' = 'super_admin') {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `${suffix}-sub-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub, role });
    const token = await signTestToken({ pool: 'officine', sub: cognitoSub, tenantId, role });
    return { tenantId, token };
  }

  function getMe(token: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/tenants/me',
      headers: { authorization: `Bearer ${token}` },
    });
  }
  function complete(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/tenants/me/onboarding/complete',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('GET reports null onboardingCompletedAt before completion', async () => {
    const { token } = await setup('ob-pre');
    const res = await getMe(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().onboardingCompletedAt).toBeNull();
  });

  it('super_admin completes → 204 and GET then reports a timestamp', async () => {
    const { token } = await setup('ob-ok');
    const res = await complete(token);
    expect(res.statusCode).toBe(204);
    const me = await getMe(token);
    expect(typeof me.json().onboardingCompletedAt).toBe('string');
  });

  it('mechanic is forbidden (403) and does not complete', async () => {
    const { token } = await setup('ob-mech', 'mechanic');
    const res = await complete(token);
    expect(res.statusCode).toBe(403);
  });
});

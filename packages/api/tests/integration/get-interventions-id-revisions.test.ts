import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

describe('GET /v1/interventions/:id/revisions (integration)', () => {
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

  it('404 when intervention id does not exist', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-404');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const bogus = randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${bogus}/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('401 when no token is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${randomUUID()}/revisions`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 when id is not a UUID', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('rev-400');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/not-a-uuid/revisions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

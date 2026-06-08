import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, createPushToken, getPushTokens, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-302 PR1 — POST/DELETE /v1/me/push-tokens.
const TEST_IP = '10.20.40.11';

describe('Customer push tokens (F-CLI-302)', () => {
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

  async function authCustomer() {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({
      cognitoSub: sub,
      firstName: 'Mario',
      lastName: 'Rossi',
    });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, token };
  }

  function post(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload,
    });
  }
  function del(token: string, id: string) {
    return app.inject({
      method: 'DELETE',
      url: `/v1/me/push-tokens/${id}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
  }

  it('registers a token under role:user RLS and flips appInstalled', async () => {
    const { customerId, token } = await authCustomer();
    const res = await post(token, {
      expoPushToken: 'ExpoPushToken[int-new]',
      platform: 'android',
      deviceName: 'Pixel 7',
    });
    expect(res.statusCode).toBe(201);
    const rows = await getPushTokens(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expo_push_token).toBe('ExpoPushToken[int-new]');
    expect(rows[0]!.active).toBe(true);
  });

  it('BR-254: re-posting the same token is idempotent (no duplicate row)', async () => {
    const { customerId, token } = await authCustomer();
    await post(token, { expoPushToken: 'ExpoPushToken[int-same]', platform: 'ios' });
    await post(token, { expoPushToken: 'ExpoPushToken[int-same]', platform: 'ios' });
    expect(await getPushTokens(customerId)).toHaveLength(1);
  });

  it('BR-254: a rotated token on the same device replaces the row', async () => {
    const { customerId, token } = await authCustomer();
    await post(token, {
      expoPushToken: 'ExpoPushToken[int-old]',
      platform: 'android',
      deviceName: 'Pixel 7',
    });
    await post(token, {
      expoPushToken: 'ExpoPushToken[int-rot]',
      platform: 'android',
      deviceName: 'Pixel 7',
    });
    const rows = await getPushTokens(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expo_push_token).toBe('ExpoPushToken[int-rot]');
  });

  it("DELETE removes the caller's token (204)", async () => {
    const { customerId, token } = await authCustomer();
    const { id } = await createPushToken({
      customerId,
      expoPushToken: 'ExpoPushToken[int-del]',
    });
    expect((await del(token, id)).statusCode).toBe(204);
    expect(await getPushTokens(customerId)).toHaveLength(0);
  });

  it("DELETE of another customer's token returns 404 (RLS-hidden)", async () => {
    const { token } = await authCustomer();
    const other = await createCustomer({ cognitoSub: `cust-${randomUUID().slice(0, 8)}` });
    const { id } = await createPushToken({
      customerId: other.customerId,
      expoPushToken: 'ExpoPushToken[int-other]',
    });
    expect((await del(token, id)).statusCode).toBe(404);
    expect(await getPushTokens(other.customerId)).toHaveLength(1); // untouched
  });
});

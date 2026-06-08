import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-005 PR1 — GET/PATCH /v1/me/notification-preferences.
const TEST_IP = '10.20.40.9';
const DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
  marketing: false,
};

describe('Customer notification preferences (F-CLI-005)', () => {
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

  async function authCustomer(notificationPreferences?: object) {
    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({
      cognitoSub: customerSub,
      firstName: 'Mario',
      lastName: 'Rossi',
      ...(notificationPreferences ? { notificationPreferences } : {}),
    });
    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });
    return { customerId, token };
  }

  function get(token: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/me/notification-preferences',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
  }
  function patch(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload,
    });
  }

  it('GET returns the 4 effective defaults for an empty stored object', async () => {
    const { token } = await authCustomer({});
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { email: unknown }).email).toEqual(DEFAULTS);
  });

  it('GET reflects a partial stored override', async () => {
    const { token } = await authCustomer({ email: { intervention_updates: false } });
    const res = await get(token);
    expect((res.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      intervention_updates: false,
    });
  });

  it('PATCH updates two keys and GET reflects both', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { email: { deadline_reminder: false, marketing: true } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      deadline_reminder: false,
      marketing: true,
    });
  });

  it('PATCH merges onto existing stored prefs (does not clobber)', async () => {
    // Seed with intervention_updates already off; PATCH only marketing.
    // If PATCH replaced instead of merged, intervention_updates would revert
    // to the default (true). Asserting it stays false proves the merge.
    const { token } = await authCustomer({
      email: { intervention_updates: false, transfer_invitation: true },
    });
    const patchRes = await patch(token, { email: { marketing: true } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      intervention_updates: false,
      marketing: true,
    });
  });

  it('PATCH with empty body returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, {})).statusCode).toBe(422);
  });

  it('PATCH with {email:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: {} })).statusCode).toBe(422);
  });

  it('PATCH with a non-editable key (transfer_invitation) returns 422 (BR-260)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: { transfer_invitation: true } })).statusCode).toBe(422);
  });

  it('PATCH with a push.* key returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { intervention_updates: false } })).statusCode).toBe(422);
  });

  it('PATCH with a non-boolean value returns 400 (ZodError)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: { marketing: 'yes' } })).statusCode).toBe(400);
  });
});

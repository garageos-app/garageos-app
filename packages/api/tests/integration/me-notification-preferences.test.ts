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
  personal_deadline_reminder: true,
  ownership_transfer: true,
  marketing: false,
};
const PUSH_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  personal_deadline_reminder: true,
  ownership_transfer: true,
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

  it('GET returns push effective defaults too', async () => {
    const { token } = await authCustomer({});
    const res = await get(token);
    expect((res.json() as { push: unknown }).push).toEqual(PUSH_DEFAULTS);
  });

  it('PATCH updates a push key and GET reflects it', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { push: { deadline_reminder: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { push: unknown }).push).toEqual({
      ...PUSH_DEFAULTS,
      deadline_reminder: false,
    });
  });

  it('PATCH merges push onto existing prefs and preserves non-editable push keys', async () => {
    // dispute_response is a stored push key outside the editable surface; it must
    // survive the merge. intervention_updates seeded off proves merge (not replace).
    const { token } = await authCustomer({
      push: { intervention_updates: false, dispute_response: true },
    });
    const patchRes = await patch(token, { push: { ownership_transfer: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { push: unknown }).push).toEqual({
      ...PUSH_DEFAULTS,
      intervention_updates: false,
      ownership_transfer: false,
    });
  });

  it('PATCH can update email and push in one body', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, {
      email: { marketing: true },
      push: { intervention_updates: false },
    });
    expect(patchRes.statusCode).toBe(200);
    const body = patchRes.json() as {
      email: Record<string, boolean>;
      push: Record<string, boolean>;
    };
    expect(body.email.marketing).toBe(true);
    expect(body.push.intervention_updates).toBe(false);
  });

  it('PATCH with an unknown push key returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { marketing: true } })).statusCode).toBe(422);
  });

  it('PATCH with {push:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: {} })).statusCode).toBe(422);
  });

  it('PATCH with {email:{},push:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: {}, push: {} })).statusCode).toBe(422);
  });

  it('PATCH with a non-boolean value returns 400 (ZodError)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: { marketing: 'yes' } })).statusCode).toBe(400);
  });

  it('PATCH with a non-boolean push value returns 400 (ZodError)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { deadline_reminder: 'yes' } })).statusCode).toBe(400);
  });

  it('PATCH personal_deadline_reminder on email and GET reflects it (BR-297)', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { email: { personal_deadline_reminder: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect(
      (getRes.json() as { email: Record<string, boolean> }).email.personal_deadline_reminder,
    ).toBe(false);
  });

  it('PATCH personal_deadline_reminder on push and GET reflects it (BR-297)', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { push: { personal_deadline_reminder: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect(
      (getRes.json() as { push: Record<string, boolean> }).push.personal_deadline_reminder,
    ).toBe(false);
  });
});

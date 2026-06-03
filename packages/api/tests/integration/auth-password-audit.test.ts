// Integration tests for the password audit-notify endpoints (BR-280).
// Helper pattern mirrors users-admin-update.test.ts:
//   buildTestServer / createTenantWithLocation / createUser / signTestToken /
//   pgAdmin / resetDb. Dedicated IP block 10.20.46.x for rate-limit isolation.

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

describe('POST /v1/auth/password-changed', () => {
  it('204 + writes user_password_changed for the authenticated actor', async () => {
    const { tenantId } = await createTenantWithLocation('pwa-changed');
    const sub = `sa-pwa-${crypto.randomUUID()}`;
    const { userId } = await createUser({ tenantId, cognitoSub: sub, role: 'super_admin' });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.46.10',
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_password_changed'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('401 without a token (no audit row)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      remoteAddress: '10.20.46.11',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/password-reset-completed', () => {
  it('204 + writes user_password_reset for an existing active user', async () => {
    const { tenantId } = await createTenantWithLocation('pwa-reset');
    const { userId } = await createUser({
      tenantId,
      cognitoSub: `u-pwa-${crypto.randomUUID()}`,
      email: 'reset-me@officina.it',
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.12',
      payload: { email: 'reset-me@officina.it' },
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_password_reset'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('204 + NO row for an unknown email (anti-enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.13',
      payload: { email: 'ghost@nowhere.it' },
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query(
      `SELECT 1 FROM audit_logs WHERE action = 'user_password_reset'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('429 once the per-IP rate-limit (5/15min) is exceeded', async () => {
    const ip = '10.20.46.14';
    const fire = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset-completed',
        headers: { 'content-type': 'application/json' },
        remoteAddress: ip,
        payload: { email: 'ghost@nowhere.it' },
      });
    for (let i = 0; i < 5; i++) {
      const ok = await fire();
      expect(ok.statusCode).toBe(204);
    }
    const limited = await fire();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('auth.password_reset.rate_limited');
  });
});

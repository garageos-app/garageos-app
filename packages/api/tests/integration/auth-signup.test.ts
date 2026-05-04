// packages/api/tests/integration/auth-signup.test.ts
//
// Integration tests for POST /v1/auth/signup (F-CLI-001).
// Exercises the full 3-phase handler against a real Testcontainers
// PostgreSQL instance; Cognito is stubbed with aws-sdk-client-mock.
//
// BR-220 — new customer signup (no existing row)
// BR-221 — promote shadow customer (officina-created, no cognito_sub)
// BR-224 — customer status transitions
// BR-225 — rate-limit wiring (not tested here — covered by unit suite)

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';
import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

const cognito = mockClient(CognitoIdentityProviderClient);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  cognito.reset();
  _resetCognitoClientForTests();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('POST /v1/auth/signup — integration', () => {
  const TEST_IP = '10.20.30.1';

  it('creates a Customer row + AuditLog row, returns 201 (BR-220)', async () => {
    // See BR-220 for the new-customer signup flow.
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-int-1' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'integration1@example.it',
        password: 'Strong123',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: '+393331234567',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { customer: { email: string; status: string } };
    expect(body.customer.email).toBe('integration1@example.it');
    expect(body.customer.status).toBe('active');

    const { rows } = await pgAdmin.query<{
      id: string;
      first_name: string;
      last_name: string;
      phone: string;
      app_installed: boolean;
      status: string;
      cognito_sub: string;
      notification_preferences: unknown;
    }>(
      `SELECT id, first_name, last_name, phone, app_installed, status, cognito_sub,
              notification_preferences
         FROM customers
        WHERE email = $1`,
      ['integration1@example.it'],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.first_name).toBe('Mario');
    expect(row.last_name).toBe('Rossi');
    expect(row.phone).toBe('+393331234567');
    expect(row.app_installed).toBe(true);
    expect(row.status).toBe('active');
    expect(row.cognito_sub).toBe('cog-int-1');
    // DEFAULT_NOTIFICATION_PREFERENCES — email.marketing defaults to false (BR-226).
    const prefs = row.notification_preferences as { email: { marketing: boolean } };
    expect(prefs.email.marketing).toBe(false);

    const { rows: auditRows } = await pgAdmin.query<{
      actor_type: string;
      metadata: unknown;
    }>(
      `SELECT actor_type, metadata
         FROM audit_logs
        WHERE entity_type = 'customer'
          AND entity_id = $1
          AND action = 'customer_signup'`,
      [row.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actor_type).toBe('customer');
    const meta = auditRows[0]!.metadata as { promoted: boolean };
    expect(meta.promoted).toBe(false);
  });
});

// ─── Promote shadow customer ─────────────────────────────────────────────────

describe('POST /v1/auth/signup — promote shadow customer', () => {
  const TEST_IP = '10.20.30.2';

  it('updates the shadow row + sets cognito_sub, no duplicate (BR-221)', async () => {
    // Seed a shadow customer (officina-created, no cognito_sub).
    // See BR-221 for the promote flow.
    const { rows: seedRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, $1, $2, $3, NULL,
         'active'::"CustomerStatus", false, '{}', NOW(), NOW())
       RETURNING id`,
      ['promo@example.it', 'Mario', 'R'],
    );
    const shadowId = seedRows[0]!.id;

    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-int-2' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'promo@example.it',
        password: 'Strong123',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: '+393339999999',
      },
    });
    expect(res.statusCode).toBe(201);

    const { rows: all } = await pgAdmin.query<{
      id: string;
      last_name: string;
      phone: string;
      cognito_sub: string;
      app_installed: boolean;
      notification_preferences: unknown;
    }>(
      `SELECT id, last_name, phone, cognito_sub, app_installed, notification_preferences
         FROM customers
        WHERE email = $1`,
      ['promo@example.it'],
    );
    expect(all).toHaveLength(1); // no duplicate row
    expect(all[0]!.id).toBe(shadowId); // same row, promoted
    expect(all[0]!.last_name).toBe('Rossi'); // overwritten by promote
    expect(all[0]!.phone).toBe('+393339999999');
    expect(all[0]!.cognito_sub).toBe('cog-int-2');
    expect(all[0]!.app_installed).toBe(true);
    // BR-226: PROMOTE must also apply the default notification preferences —
    // shadow rows seeded by an officina carry an empty {} prefs object.
    const promoPrefs = all[0]!.notification_preferences as { email: { marketing: boolean } };
    expect(promoPrefs.email.marketing).toBe(false);

    // AdminCreateUser was invoked with the shadow's existing id.
    const adminCreateCall = cognito.commandCalls(AdminCreateUserCommand)[0];
    expect(adminCreateCall?.args[0]?.input?.UserAttributes).toEqual(
      expect.arrayContaining([{ Name: 'custom:customer_id', Value: shadowId }]),
    );

    const { rows: auditRows } = await pgAdmin.query<{ metadata: unknown }>(
      `SELECT metadata
         FROM audit_logs
        WHERE entity_type = 'customer'
          AND entity_id = $1
          AND action = 'customer_signup'`,
      [shadowId],
    );
    expect(auditRows).toHaveLength(1);
    const meta = auditRows[0]!.metadata as { promoted: boolean };
    expect(meta.promoted).toBe(true);
  });
});

// ─── Already active (409) ────────────────────────────────────────────────────

describe('POST /v1/auth/signup — already active', () => {
  const TEST_IP = '10.20.30.3';

  it('returns 409 when an active customer exists (cognitoSub set)', async () => {
    await pgAdmin.query(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'A', 'B', NULL,
         'active'::"CustomerStatus", true, '{}', NOW(), NOW())`,
      ['cog-prev', 'already@example.it'],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'already@example.it',
        password: 'Strong123',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('auth.signup.email_already_active');
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

// ─── BR-220 race condition ────────────────────────────────────────────────────

describe('POST /v1/auth/signup — BR-220 race', () => {
  const TEST_IP = '10.20.30.4';

  it('two concurrent signups same email: one 201, one 409, exactly one Customer row', async () => {
    // See BR-220: concurrent CREATE race must resolve to exactly one row.
    // The loser hits the P2002 catch-and-rethrow-as-409 branch.
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-race-1' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});

    const payload = {
      type: 'customer',
      email: 'race@example.it',
      password: 'Strong123',
      firstName: 'A',
      lastName: 'B',
    };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: TEST_IP, payload }),
      app.inject({ method: 'POST', url: '/v1/auth/signup', remoteAddress: TEST_IP, payload }),
    ]);

    const codes = [a!.statusCode, b!.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([201, 409]);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers WHERE email = $1`,
      ['race@example.it'],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

// ─── Phase 2 rollback ────────────────────────────────────────────────────────

describe('POST /v1/auth/signup — Phase 2 rollback', () => {
  const TEST_IP = '10.20.30.5';

  it('on AdminSetUserPassword failure, AdminDeleteUser is invoked + 502', async () => {
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-rb' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).rejects(new Error('throttled'));
    cognito.on(AdminDeleteUserCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'rb@example.it',
        password: 'Strong123',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('auth.signup.cognito_unavailable');
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);

    // Customer row is retained by design — Phase 1 DB tx committed.
    // Phase 3 never ran, so cognito_sub is still NULL.
    const { rows } = await pgAdmin.query<{ id: string; cognito_sub: string | null }>(
      `SELECT id, cognito_sub FROM customers WHERE email = $1`,
      ['rb@example.it'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cognito_sub).toBeNull(); // Phase 3 never ran
  });
});

// ─── Phase 3 success path ─────────────────────────────────────────────────────

describe('POST /v1/auth/signup — Phase 3 success path', () => {
  const TEST_IP = '10.20.30.6';

  it('writes cognito_sub on Phase 3 success', async () => {
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-p3' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'p3@example.it',
        password: 'Strong123',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await pgAdmin.query<{ cognito_sub: string | null }>(
      `SELECT cognito_sub FROM customers WHERE email = $1`,
      ['p3@example.it'],
    );
    expect(rows[0]!.cognito_sub).toBe('cog-p3'); // Phase 3 wrote the sub
  });
});

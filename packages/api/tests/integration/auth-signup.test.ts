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
  it('creates a Customer row + AuditLog row, returns 201 (BR-220)', async () => {
    // See BR-220 for the new-customer signup flow.
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-int-1' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
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

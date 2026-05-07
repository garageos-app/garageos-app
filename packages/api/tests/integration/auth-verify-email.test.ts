// packages/api/tests/integration/auth-verify-email.test.ts
//
// Integration tests for the verify-email cluster (cluster G):
//   POST /v1/auth/signup            — Phase 1 persists email_verifications
//                                     row + Phase 4 invokes SES.
//   POST /v1/auth/verify-email      — happy / expired / consumed paths.
//   POST /v1/auth/resend-verification — invalidates previous unconsumed
//                                       tokens; anti-enumeration 200 for
//                                       unknown emails.
//
// Drives the full handlers against a real Testcontainers PostgreSQL
// (RLS active under app_test) and stubs Cognito + SES via
// aws-sdk-client-mock. See also auth-signup.test.ts for the surrounding
// signup-route patterns this file mirrors.

import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';
import { hashToken } from '../../src/lib/email-verification.js';
import { _resetSesClientForTests } from '../../src/lib/ses-client.js';
import { buildTestServer } from './fixtures.js';
import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

const cognito = mockClient(CognitoIdentityProviderClient);
const ses = mockClient(SESv2Client);

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
  ses.reset();
  _resetCognitoClientForTests();
  _resetSesClientForTests();
});

// Helper: seed a customer row via pgAdmin (bypasses RLS). Mirrors
// helpers.createCustomer but with knobs we need here (emailVerified flag).
async function seedCustomer(params: {
  email: string;
  firstName?: string;
  cognitoSub?: string | null;
  emailVerified?: boolean;
}): Promise<{ customerId: string; email: string }> {
  const { email, firstName = 'Mario', cognitoSub = null, emailVerified = false } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customers
       (id, cognito_sub, email, first_name, last_name, phone, status,
        app_installed, email_verified, notification_preferences,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Rossi', NULL,
       'active'::"CustomerStatus", true, $4, '{}', NOW(), NOW())
     RETURNING id`,
    [cognitoSub, email, firstName, emailVerified],
  );
  return { customerId: rows[0]!.id, email };
}

async function seedVerificationToken(params: {
  customerId: string;
  plaintextToken: string;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<{ id: string; tokenHash: string }> {
  const { customerId, plaintextToken, expiresAt, consumedAt = null } = params;
  const tokenHash = hashToken(plaintextToken);
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO email_verifications
       (id, customer_id, token_hash, expires_at, consumed_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
     RETURNING id`,
    [customerId, tokenHash, expiresAt, consumedAt],
  );
  return { id: rows[0]!.id, tokenHash };
}

// ─── 1) signup creates verification row + triggers SES ───────────────────────

describe('POST /v1/auth/signup — verify-email side effects', () => {
  const TEST_IP = '10.20.30.51';

  it('persists email_verifications row + invokes SES once', async () => {
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-vrfy-1' }] },
    });
    cognito.on(AdminSetUserPasswordCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: TEST_IP,
      payload: {
        type: 'customer',
        email: 'verify1@example.it',
        password: 'Strong123',
        firstName: 'Mario',
        lastName: 'Rossi',
      },
    });
    expect(res.statusCode).toBe(201);

    // Look up the newly-created customer + verify the email_verifications
    // row exists with a hex sha256 hash.
    const { rows: custRows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM customers WHERE email = $1`,
      ['verify1@example.it'],
    );
    expect(custRows).toHaveLength(1);
    const customerId = custRows[0]!.id;

    const { rows: tokenRows } = await pgAdmin.query<{
      id: string;
      token_hash: string;
      consumed_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, token_hash, consumed_at, expires_at
         FROM email_verifications
        WHERE customer_id = $1`,
      [customerId],
    );
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenRows[0]!.consumed_at).toBeNull();
    // 24h TTL — allow a generous window to absorb test-execution latency.
    const expiresMs = new Date(tokenRows[0]!.expires_at).getTime();
    expect(expiresMs).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    // SES SendEmailCommand invoked once.
    const sesCalls = ses.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);
    expect(sesCalls[0]?.args[0]?.input?.Destination?.ToAddresses).toEqual(['verify1@example.it']);
  });
});

// ─── 2) verify-email happy path ──────────────────────────────────────────────

describe('POST /v1/auth/verify-email — happy path', () => {
  it('flips customer.email_verified=true + email_verifications.consumed_at', async () => {
    const { customerId } = await seedCustomer({
      email: 'happy@example.it',
      cognitoSub: 'cog-happy',
      emailVerified: false,
    });
    const plaintext = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedVerificationToken({
      customerId,
      plaintextToken: plaintext,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // +1h
    });
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: plaintext },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customerId: string; email: string };
    expect(body.customerId).toBe(customerId);
    expect(body.email).toBe('happy@example.it');

    const { rows: custRows } = await pgAdmin.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM customers WHERE id = $1`,
      [customerId],
    );
    expect(custRows[0]!.email_verified).toBe(true);

    const { rows: tokenRows } = await pgAdmin.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM email_verifications WHERE customer_id = $1`,
      [customerId],
    );
    expect(tokenRows[0]!.consumed_at).not.toBeNull();
  });
});

// ─── 3) verify-email expired token ───────────────────────────────────────────

describe('POST /v1/auth/verify-email — expired token', () => {
  it('returns 410 with auth.verify_email.token_expired', async () => {
    const { customerId } = await seedCustomer({
      email: 'expired@example.it',
    });
    const plaintext = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await seedVerificationToken({
      customerId,
      plaintextToken: plaintext,
      expiresAt: new Date(Date.now() - 60 * 1000), // -1min (expired)
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: plaintext },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('auth.verify_email.token_expired');

    // Token row stays unconsumed (expired path is a no-op on consumed_at).
    const { rows } = await pgAdmin.query<{
      consumed_at: Date | null;
      email_verified: boolean;
    }>(
      `SELECT ev.consumed_at AS consumed_at, c.email_verified AS email_verified
         FROM email_verifications ev
         JOIN customers c ON c.id = ev.customer_id
        WHERE ev.customer_id = $1`,
      [customerId],
    );
    expect(rows[0]!.consumed_at).toBeNull();
    expect(rows[0]!.email_verified).toBe(false);
  });
});

// ─── 4) verify-email already-consumed token ──────────────────────────────────

describe('POST /v1/auth/verify-email — already consumed', () => {
  it('returns 410 with auth.verify_email.token_consumed', async () => {
    const { customerId } = await seedCustomer({
      email: 'consumed@example.it',
    });
    const plaintext = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await seedVerificationToken({
      customerId,
      plaintextToken: plaintext,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // future
      consumedAt: new Date(Date.now() - 60 * 1000), // already consumed
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: plaintext },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('auth.verify_email.token_consumed');
  });
});

// ─── 5) resend-verification invalidates prior unconsumed tokens ──────────────

describe('POST /v1/auth/resend-verification — invalidates prior tokens', () => {
  const TEST_IP = '10.20.30.52';

  it('marks the old unconsumed token consumed + creates a new row', async () => {
    const { customerId } = await seedCustomer({
      email: 'resend@example.it',
      firstName: 'Mario',
    });
    const oldPlaintext = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const { id: oldRowId } = await seedVerificationToken({
      customerId,
      plaintextToken: oldPlaintext,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-resend' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      remoteAddress: TEST_IP,
      payload: { email: 'resend@example.it' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });

    // The old row is now consumed; a new row exists too. Total = 2.
    const { rows: all } = await pgAdmin.query<{
      id: string;
      consumed_at: Date | null;
    }>(
      `SELECT id, consumed_at FROM email_verifications
        WHERE customer_id = $1
        ORDER BY created_at ASC`,
      [customerId],
    );
    expect(all).toHaveLength(2);
    const oldRow = all.find((r) => r.id === oldRowId);
    expect(oldRow?.consumed_at).not.toBeNull();
    const newRow = all.find((r) => r.id !== oldRowId);
    expect(newRow?.consumed_at).toBeNull();

    // SES invoked once for the resend.
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });
});

// ─── 6) resend-verification anti-enumeration for unknown email ───────────────

describe('POST /v1/auth/resend-verification — anti-enumeration', () => {
  const TEST_IP = '10.20.30.53';

  it('returns 200, creates no row, never calls SES for unknown email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      remoteAddress: TEST_IP,
      payload: { email: 'unknown@example.it' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM email_verifications`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

// packages/api/tests/integration/customer-provisioning.test.ts
//
// Direct integration tests for provisionCustomer() — the shared find-or-
// create-or-promote helper extracted from POST /v1/auth/signup so the Cognito
// Google-federation trigger (PR 2) can reuse it. Run against Testcontainers.
//
// BR-220 (create), BR-221 (promote shadow), BR-224 (active predicate),
// BR-226 (default notification preferences). The 'already_active' outcome is
// the new behaviour the trigger depends on (account merge) — the signup route
// still maps it to 409.

import { withContext } from '@garageos/database';
import { beforeEach, describe, expect, it } from 'vitest';

import { provisionCustomer } from '../../src/lib/customer-provisioning.js';
import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('provisionCustomer — created', () => {
  it('creates a Customer + audit log for a brand-new email (BR-220, BR-226)', async () => {
    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'new@example.it', firstName: 'Mario', lastName: 'Rossi', phone: '+393331234567' },
        { ip: '10.0.0.1' },
      ),
    );

    expect(result.outcome).toBe('created');
    expect(result.customer.email).toBe('new@example.it');
    expect(result.customer.status).toBe('active');

    const { rows } = await pgAdmin.query<{
      app_installed: boolean;
      notification_preferences: { email: { marketing: boolean } };
    }>(`SELECT app_installed, notification_preferences FROM customers WHERE email = $1`, [
      'new@example.it',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app_installed).toBe(true);
    expect(rows[0]!.notification_preferences.email.marketing).toBe(false);

    const { rows: audit } = await pgAdmin.query<{ metadata: { promoted: boolean } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'customer_signup' AND entity_id = $1`,
      [result.customer.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata.promoted).toBe(false);
  });
});

describe('provisionCustomer — promoted', () => {
  it('promotes a shadow row in place, no duplicate (BR-221, BR-226)', async () => {
    const { rows: seed } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, $1, 'Old', 'Name', NULL,
         'active'::"CustomerStatus", false, '{}', NOW(), NOW())
       RETURNING id`,
      ['shadow@example.it'],
    );
    const shadowId = seed[0]!.id;

    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'shadow@example.it', firstName: 'Mario', lastName: 'Rossi' },
        { ip: '10.0.0.2' },
      ),
    );

    expect(result.outcome).toBe('promoted');
    expect(result.customer.id).toBe(shadowId);

    const { rows } = await pgAdmin.query<{
      id: string;
      last_name: string;
      app_installed: boolean;
      notification_preferences: { email: { marketing: boolean } };
    }>(
      `SELECT id, last_name, app_installed, notification_preferences
         FROM customers WHERE email = $1`,
      ['shadow@example.it'],
    );
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0]!.id).toBe(shadowId);
    expect(rows[0]!.last_name).toBe('Rossi'); // overwritten by promote
    expect(rows[0]!.app_installed).toBe(true);
    expect(rows[0]!.notification_preferences.email.marketing).toBe(false);
  });
});

describe('provisionCustomer — already_active', () => {
  it('returns already_active without writing or auditing when the row is active', async () => {
    const { rows: seed } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), 'cog-existing', $1, 'Keep', 'Me', NULL,
         'active'::"CustomerStatus", true, '{}', NOW(), NOW())
       RETURNING id`,
      ['active@example.it'],
    );
    const existingId = seed[0]!.id;

    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'active@example.it', firstName: 'Changed', lastName: 'Name' },
        { ip: '10.0.0.3' },
      ),
    );

    expect(result.outcome).toBe('already_active');
    expect(result.customer.id).toBe(existingId);

    // No mutation of the existing row.
    const { rows } = await pgAdmin.query<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM customers WHERE id = $1`,
      [existingId],
    );
    expect(rows[0]!.first_name).toBe('Keep');
    expect(rows[0]!.last_name).toBe('Me');

    // No audit row written for the merge case.
    const { rows: audit } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE entity_id = $1`,
      [existingId],
    );
    expect(Number(audit[0]!.count)).toBe(0);
  });

  it('is idempotent: a second call on a now-active row adds no duplicate row or audit', async () => {
    const input = { email: 'idem@example.it', firstName: 'Mario', lastName: 'Rossi' };

    const first = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(tx, input, { ip: '10.0.0.4' }),
    );
    expect(first.outcome).toBe('created');

    // Mark active the way signup/the trigger would (cognito_sub set).
    await pgAdmin.query(`UPDATE customers SET cognito_sub = 'cog-idem' WHERE email = $1`, [
      'idem@example.it',
    ]);

    const second = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(tx, input, { ip: '10.0.0.4' }),
    );
    expect(second.outcome).toBe('already_active');

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers WHERE email = $1`,
      ['idem@example.it'],
    );
    expect(Number(rows[0]!.count)).toBe(1);

    const { rows: audit } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs
         WHERE action = 'customer_signup' AND entity_id = $1`,
      [first.customer.id],
    );
    expect(Number(audit[0]!.count)).toBe(1); // only the create wrote audit
  });
});

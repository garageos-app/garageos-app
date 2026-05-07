import { createHash, randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { resetDb } from './helpers.js';

// BR-220 verify-email storage. The email_verifications table is
// append-only-ish (admin-only INSERT/UPDATE/DELETE), with a self-only
// SELECT path for the customer who owns the row. Tokens are hashed
// (SHA-256 hex) and 24h TTL. See migration
// 20260507120000_add_email_verifications/migration.sql.

const HOUR_MS = 60 * 60 * 1000;

function freshHash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

describe('email_verifications RLS + schema', () => {
  let customerId: string;

  beforeAll(async () => {
    // resetDb() also re-seeds system intervention types; we don't
    // need them here but it's the project's idempotent reset path.
    await resetDb();
  });

  beforeEach(async () => {
    await withContext({ role: 'admin' }, async (tx) => {
      // Wipe rows in dependency order. ON DELETE CASCADE on
      // email_verifications.customer_id would cascade for us, but
      // an explicit delete keeps the test self-documenting.
      await tx.emailVerification.deleteMany({});
      await tx.customer.deleteMany({});
      const c = await tx.customer.create({
        data: {
          email: `verify-rls-${randomUUID()}@example.com`,
          firstName: 'Test',
          lastName: 'User',
          status: 'active',
        },
      });
      customerId = c.id;
    });
  });

  // No afterAll: the Prisma client is a worker-wide singleton. The
  // global teardown stops the testcontainer, which closes sockets.
  // (Matches the convention of triggers.test.ts and rls.test.ts.)

  it('admin role: INSERT succeeds and produces a row with token_hash + expires_at', async () => {
    const hash = freshHash();
    const expires = new Date(Date.now() + 24 * HOUR_MS);
    const row = await withContext({ role: 'admin' }, async (tx) =>
      tx.emailVerification.create({
        data: { customerId, tokenHash: hash, expiresAt: expires },
      }),
    );
    expect(row.tokenHash).toBe(hash);
    expect(row.expiresAt.getTime()).toBeCloseTo(expires.getTime(), -3);
    expect(row.consumedAt).toBeNull();
    expect(row.customerId).toBe(customerId);
  });

  it('tenant role: INSERT fails (RLS deny on WITH CHECK)', async () => {
    // No admin role and no customer match → email_verifications_insert_admin
    // WITH CHECK is_admin_role() rejects the row.
    await expect(
      withContext({ tenantId: randomUUID() }, async (tx) =>
        tx.emailVerification.create({
          data: {
            customerId,
            tokenHash: freshHash(),
            expiresAt: new Date(Date.now() + HOUR_MS),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it('SELECT self via app.current_customer reads only own rows', async () => {
    await withContext({ role: 'admin' }, async (tx) => {
      await tx.emailVerification.create({
        data: { customerId, tokenHash: freshHash(), expiresAt: new Date(Date.now() + HOUR_MS) },
      });
    });

    // withContext({ customerId }) sets app.current_customer; the
    // email_verifications_select_self policy reads it via
    // current_customer_id() and lets the customer see their own row.
    const rows = await withContext({ customerId }, async (tx) =>
      tx.emailVerification.findMany({ where: { customerId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('SELECT cross-customer is empty (RLS isolation)', async () => {
    const otherCustomerId = await withContext({ role: 'admin' }, async (tx) => {
      const c = await tx.customer.create({
        data: {
          email: `other-${randomUUID()}@example.com`,
          firstName: 'Other',
          lastName: 'User',
          status: 'active',
        },
      });
      // Insert a verification for the FIRST customer (not `c`); the
      // assertion below checks the OTHER customer can't see it.
      await tx.emailVerification.create({
        data: { customerId, tokenHash: freshHash(), expiresAt: new Date(Date.now() + HOUR_MS) },
      });
      return c.id;
    });

    const rows = await withContext({ customerId: otherCustomerId }, async (tx) =>
      tx.emailVerification.findMany({}),
    );
    expect(rows).toHaveLength(0);
  });

  it('admin role: UPDATE consumed_at succeeds', async () => {
    const created = await withContext({ role: 'admin' }, async (tx) =>
      tx.emailVerification.create({
        data: { customerId, tokenHash: freshHash(), expiresAt: new Date(Date.now() + HOUR_MS) },
      }),
    );

    const updated = await withContext({ role: 'admin' }, async (tx) =>
      tx.emailVerification.update({
        where: { id: created.id },
        data: { consumedAt: new Date() },
      }),
    );
    expect(updated.consumedAt).not.toBeNull();
  });

  it('tenant role: UPDATE fails (USING filters row, P2025 not found)', async () => {
    const created = await withContext({ role: 'admin' }, async (tx) =>
      tx.emailVerification.create({
        data: { customerId, tokenHash: freshHash(), expiresAt: new Date(Date.now() + HOUR_MS) },
      }),
    );

    // email_verifications_update_admin USING (is_admin_role()) hides
    // the row from non-admin contexts. Prisma's `update` (not
    // `updateMany`) raises when the where clause matches 0 rows.
    await expect(
      withContext({ tenantId: randomUUID() }, async (tx) =>
        tx.emailVerification.update({
          where: { id: created.id },
          data: { consumedAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('unique index on token_hash rejects duplicates', async () => {
    const hash = freshHash();
    await withContext({ role: 'admin' }, async (tx) => {
      await tx.emailVerification.create({
        data: { customerId, tokenHash: hash, expiresAt: new Date(Date.now() + HOUR_MS) },
      });
    });

    await expect(
      withContext({ role: 'admin' }, async (tx) =>
        tx.emailVerification.create({
          data: { customerId, tokenHash: hash, expiresAt: new Date(Date.now() + HOUR_MS) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('ON DELETE CASCADE: hard-delete customer cascades to email_verifications', async () => {
    await withContext({ role: 'admin' }, async (tx) => {
      await tx.emailVerification.create({
        data: { customerId, tokenHash: freshHash(), expiresAt: new Date(Date.now() + HOUR_MS) },
      });
      await tx.customer.delete({ where: { id: customerId } });
    });

    const rows = await withContext({ role: 'admin' }, async (tx) =>
      tx.emailVerification.findMany({ where: { customerId } }),
    );
    expect(rows).toHaveLength(0);
  });
});

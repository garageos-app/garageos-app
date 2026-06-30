import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { createCustomerWithRelation, createTenant, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-151 write gate — the `customers_write_by_related_tenant` RLS
// policy (migration 20260424100000_rls_triggers_checks line 377) lets a
// tenant UPDATE a customer row only when a matching
// `customer_tenant_relation` exists, or when the caller runs as admin.
// This suite verifies that policy. The read-side redaction (BR-151 in
// APPENDICE_F) is explicitly application-layer — see the comment at
// line 367 of the same migration — so it lands in a service-layer
// test in a later PR.

describe('BR-151 — customer PII write gate (RLS)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('allows UPDATE when the tenant has an active customer_tenant_relation', async () => {
    const { tenantId } = await createTenant();
    const { customerId } = await createCustomerWithRelation(tenantId);

    await expect(
      withContext({ tenantId }, async (tx) => {
        return tx.customer.update({
          where: { id: customerId },
          data: { firstName: 'Giovanni' },
        });
      }),
    ).resolves.toMatchObject({ firstName: 'Giovanni' });
  });

  it('rejects UPDATE when the tenant has no customer_tenant_relation', async () => {
    // tenantA creates the relation; tenantB has none. The RLS policy
    // returns zero rows to tenantB, which Prisma surfaces as a not-
    // found error on update-by-unique.
    const { tenantId: tenantA } = await createTenant();
    const { tenantId: tenantB } = await createTenant();
    const { customerId } = await createCustomerWithRelation(tenantA);

    await expect(
      withContext({ tenantId: tenantB }, async (tx) => {
        return tx.customer.update({
          where: { id: customerId },
          data: { firstName: 'Hacked' },
        });
      }),
    ).rejects.toThrow();

    // Verify the data was not changed (admin-level check).
    const { rows } = await pgAdmin.query<{ first_name: string }>(
      `SELECT first_name FROM customers WHERE id = $1`,
      [customerId],
    );
    expect(rows[0]!.first_name).toBe('Mario');
  });

  it('admin role bypasses the policy', async () => {
    const { tenantId: tenantA } = await createTenant();
    const { customerId } = await createCustomerWithRelation(tenantA);

    await expect(
      withContext({ role: 'admin' }, async (tx) => {
        return tx.customer.update({
          where: { id: customerId },
          data: { firstName: 'AdminRewrite' },
        });
      }),
    ).resolves.toMatchObject({ firstName: 'AdminRewrite' });
  });

  it("deleting the relation removes the tenant's write access", async () => {
    const { tenantId } = await createTenant();
    const { customerId, relationId } = await createCustomerWithRelation(tenantId);

    // Confirm the relation initially opens the write path.
    await withContext({ tenantId }, async (tx) => {
      await tx.customer.update({
        where: { id: customerId },
        data: { firstName: 'FirstWrite' },
      });
    });

    // Drop the relation — superuser, so RLS doesn't interfere.
    await pgAdmin.query(`DELETE FROM customer_tenant_relations WHERE id = $1`, [relationId]);

    await expect(
      withContext({ tenantId }, async (tx) => {
        return tx.customer.update({
          where: { id: customerId },
          data: { firstName: 'SecondWrite' },
        });
      }),
    ).rejects.toThrow();
  });
});

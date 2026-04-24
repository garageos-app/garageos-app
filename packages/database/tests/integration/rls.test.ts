import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Smoke tests for tenant isolation via Row Level Security. Fixtures
// are inserted with the superuser pool (bypasses RLS); the actual
// isolation assertions run through the app_test role via
// `withContext` so the policies genuinely filter. The full BR-coverage
// suite (cross-tenant vehicle visibility, customer PII redaction,
// customer-scoped policies) lands in PR 4d.

describe('RLS — tenant isolation (smoke)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedTwoTenants(): Promise<{ tenantAId: string; tenantBId: string }> {
    const { rows: a } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina A', '11111111111', 'a@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const { rows: b } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Officina B', '22222222222', 'b@test.it', NOW(), NOW())
       RETURNING id`,
    );
    const tenantAId = a[0]!.id;
    const tenantBId = b[0]!.id;

    await pgAdmin.query(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede A', 'Via A 1', 'Milano', 'MI', '20100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())`,
      [tenantAId],
    );
    await pgAdmin.query(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Sede B', 'Via B 1', 'Roma', 'RM', '00100', 'IT',
          true, 'active'::"LocationStatus", NOW(), NOW())`,
      [tenantBId],
    );
    return { tenantAId, tenantBId };
  }

  it('isolates locations between tenants', async () => {
    const { tenantAId, tenantBId } = await seedTwoTenants();

    const locationsA = await withContext({ tenantId: tenantAId }, (tx) => tx.location.findMany());
    expect(locationsA).toHaveLength(1);
    expect(locationsA[0]?.tenantId).toBe(tenantAId);

    const locationsB = await withContext({ tenantId: tenantBId }, (tx) => tx.location.findMany());
    expect(locationsB).toHaveLength(1);
    expect(locationsB[0]?.tenantId).toBe(tenantBId);
  });

  it('hides tenant rows from other tenants', async () => {
    const { tenantAId, tenantBId } = await seedTwoTenants();

    const seenByA = await withContext({ tenantId: tenantAId }, (tx) => tx.tenant.findMany());
    expect(seenByA.map((t) => t.id)).toEqual([tenantAId]);

    const seenByB = await withContext({ tenantId: tenantBId }, (tx) => tx.tenant.findMany());
    expect(seenByB.map((t) => t.id)).toEqual([tenantBId]);
  });

  it('admin role bypasses tenant filtering', async () => {
    await seedTwoTenants();

    const all = await withContext({ role: 'admin' }, (tx) => tx.tenant.findMany());
    expect(all.length).toBeGreaterThanOrEqual(2);

    const allLocations = await withContext({ role: 'admin' }, (tx) => tx.location.findMany());
    expect(allLocations.length).toBeGreaterThanOrEqual(2);
  });

  it('customers are readable cross-tenant (BR-150 + customers_read policy)', async () => {
    const { tenantAId } = await seedTwoTenants();
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'pii@test.it', 'Mario', 'Rossi', NOW(), NOW())
       RETURNING id`,
    );
    const customerId = rows[0]!.id;

    // tenantA sees the customer (BR-150 policy allows read).
    const seenByA = await withContext({ tenantId: tenantAId }, (tx) =>
      tx.customer.findUnique({ where: { id: customerId } }),
    );
    expect(seenByA?.id).toBe(customerId);

    // An unrelated tenant also sees the row — PII redaction for
    // non-related tenants is an application-layer concern per BR-151
    // and lands alongside the vehicle detail service in a later PR.
    const seenByOther = await withContext(
      { tenantId: '00000000-0000-0000-0000-000000000001' },
      (tx) => tx.customer.findUnique({ where: { id: customerId } }),
    );
    expect(seenByOther?.id).toBe(customerId);
  });
});

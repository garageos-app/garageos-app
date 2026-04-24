import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-201 — one primary location per tenant. Enforcement: partial unique
// index `uq_locations_tenant_primary` keyed on tenant_id WHERE
// is_primary = true AND status = 'active' AND deleted_at IS NULL.
// A tenant may have multiple secondary or deactivated rows; only the
// "active primary" slot is exclusive.

describe('BR-201 — single primary location per tenant', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function createTenant(): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'tenant@test.local', NOW(), NOW())
       RETURNING id`,
      [
        `Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        String(Math.floor(Math.random() * 1e11)).padStart(11, '0'),
      ],
    );
    return rows[0]!.id;
  }

  async function insertLocation(
    tenantId: string,
    opts: { isPrimary?: boolean; status?: 'active' | 'inactive'; softDeleted?: boolean } = {},
  ): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code, country,
          is_primary, status, deleted_at, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'Via Test 1', 'Milano', 'MI', '20100', 'IT',
          $3, $4::"LocationStatus", $5, NOW(), NOW())
       RETURNING id`,
      [
        tenantId,
        `Sede-${Math.random().toString(36).slice(2, 8)}`,
        opts.isPrimary ?? true,
        opts.status ?? 'active',
        opts.softDeleted ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  }

  it('allows a single active primary location per tenant', async () => {
    const tenantId = await createTenant();
    await expect(
      insertLocation(tenantId, { isPrimary: true, status: 'active' }),
    ).resolves.toBeTruthy();
  });

  it('rejects a second active primary for the same tenant', async () => {
    const tenantId = await createTenant();
    await insertLocation(tenantId, { isPrimary: true, status: 'active' });

    await expect(insertLocation(tenantId, { isPrimary: true, status: 'active' })).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });

  it('allows a new active primary once the previous one is deactivated', async () => {
    // BR-201 text ("Se il Super Admin disattiva la location primaria,
    // deve prima designare un'altra location come primaria") describes
    // the UX requirement; the partial unique index permits the DB
    // transition in any order. Verify the permissive direction.
    const tenantId = await createTenant();
    const firstPrimary = await insertLocation(tenantId, { isPrimary: true, status: 'active' });

    await pgAdmin.query(
      `UPDATE locations SET status = 'inactive'::"LocationStatus" WHERE id = $1`,
      [firstPrimary],
    );

    await expect(
      insertLocation(tenantId, { isPrimary: true, status: 'active' }),
    ).resolves.toBeTruthy();
  });

  it('allows a new active primary once the previous one is soft-deleted', async () => {
    const tenantId = await createTenant();
    const firstPrimary = await insertLocation(tenantId, { isPrimary: true, status: 'active' });

    await pgAdmin.query(`UPDATE locations SET deleted_at = NOW() WHERE id = $1`, [firstPrimary]);

    await expect(
      insertLocation(tenantId, { isPrimary: true, status: 'active' }),
    ).resolves.toBeTruthy();
  });

  it('scopes the uniqueness to tenant — two tenants may each have one primary', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();

    await insertLocation(tenantA, { isPrimary: true, status: 'active' });
    await expect(
      insertLocation(tenantB, { isPrimary: true, status: 'active' }),
    ).resolves.toBeTruthy();
  });
});

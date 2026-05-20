import { describe, expect, it } from 'vitest';

import { pgAdmin } from './setup.js';

// Migration 20260520120000 — invitations token hashing.
// PR2 spec §4.3.
// This test verifies the resulting schema state (post-migration), not
// the migration DML (which acts on data present at migration-application
// time only and is verified via the operator smoke runbook §1).

describe('Migration 0016 — invitations token_hash', () => {
  it('drops the legacy token column', async () => {
    const { rows } = await pgAdmin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'invitations' AND column_name = 'token'`,
    );
    expect(rows).toEqual([]);
  });

  it('adds token_hash column (nullable, varchar(64))', async () => {
    const { rows } = await pgAdmin.query<{
      column_name: string;
      is_nullable: 'YES' | 'NO';
      character_maximum_length: number;
    }>(
      `SELECT column_name, is_nullable, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'invitations' AND column_name = 'token_hash'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('YES');
    expect(rows[0]!.character_maximum_length).toBe(64);
  });

  it('creates partial unique index invitations_token_hash_key on (token_hash) WHERE NOT NULL', async () => {
    const { rows } = await pgAdmin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'invitations' AND indexname = 'invitations_token_hash_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef.toLowerCase()).toMatch(/where.*token_hash is not null/);
    expect(rows[0]!.indexdef.toLowerCase()).toMatch(/unique/);
  });

  it('allows multiple invitations with NULL token_hash (partial uniqueness)', async () => {
    const { rows: tenantRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test 0016 ${Date.now()}`, '00000000016', `t0016-${Date.now()}@test.local`],
    );
    const tenantId = tenantRows[0]!.id;

    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, expires_at, accepted_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [tenantId, 'a@example.test'],
    );
    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, expires_at, accepted_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [tenantId, 'b@example.test'],
    );

    const { rows: count } = await pgAdmin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM invitations WHERE token_hash IS NULL AND tenant_id = $1`,
      [tenantId],
    );
    expect(parseInt(count[0]!.c, 10)).toBe(2);
  });

  it('rejects two invitations with the same non-null token_hash', async () => {
    const { rows: tenantRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test 0016b ${Date.now()}`, '00000000017', `t0016b-${Date.now()}@test.local`],
    );
    const tenantId = tenantRows[0]!.id;
    const hash = 'a'.repeat(64);

    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, token_hash, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, $3, NOW() + INTERVAL '7 days', NOW())`,
      [tenantId, 'c@example.test', hash],
    );

    await expect(
      pgAdmin.query(
        `INSERT INTO invitations
           (id, tenant_id, invitation_type, target_email, token_hash, expires_at, created_at)
         VALUES (gen_random_uuid(), $1, 'internal_user', $2, $3, NOW() + INTERVAL '7 days', NOW())`,
        [tenantId, 'd@example.test', hash],
      ),
    ).rejects.toThrow(/invitations_token_hash_key|unique constraint/i);
  });
});

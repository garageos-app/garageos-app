import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

describe('DB triggers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('set_updated_at', () => {
    it('bumps updated_at on UPDATE even when no app-layer @updatedAt runs', async () => {
      const { rows } = await pgAdmin.query<{ id: string; updated_at: Date }>(
        `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
         VALUES (gen_random_uuid(), 'Trigger Test', '33333333333', 'trigger@test.it', NOW(), NOW())
         RETURNING id, updated_at`,
      );
      const { id, updated_at: originalUpdatedAt } = rows[0]!;

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Raw UPDATE does not touch updated_at; the trigger must do it.
      await pgAdmin.query(
        `UPDATE tenants SET business_name = 'Trigger Test (renamed)' WHERE id = $1`,
        [id],
      );

      const { rows: reloadedRows } = await pgAdmin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM tenants WHERE id = $1`,
        [id],
      );
      const reloadedUpdatedAt = reloadedRows[0]!.updated_at;

      expect(reloadedUpdatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });

  describe('BR-282 audit immutability', () => {
    async function insertAuditLog(): Promise<string> {
      const { rows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO audit_logs
           (id, actor_type, action, entity_type, entity_id, created_at)
         VALUES
           (gen_random_uuid(), 'system'::"AuditActorType", 'test_action',
            'Tenant', '00000000-0000-0000-0000-000000000000', NOW())
         RETURNING id`,
      );
      return rows[0]!.id;
    }

    it('rejects UPDATE on audit_logs', async () => {
      const id = await insertAuditLog();

      // Superuser bypasses RLS, so the UPDATE reaches the trigger,
      // which raises the BR-282 error.
      await expect(
        pgAdmin.query(`UPDATE audit_logs SET action = 'mutated' WHERE id = $1`, [id]),
      ).rejects.toThrow(/BR-282/);
    });

    it('rejects DELETE on audit_logs', async () => {
      const id = await insertAuditLog();

      await expect(pgAdmin.query(`DELETE FROM audit_logs WHERE id = $1`, [id])).rejects.toThrow(
        /BR-282/,
      );
    });
  });
});

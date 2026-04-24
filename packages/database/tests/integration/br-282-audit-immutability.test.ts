import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../src/index.js';

import { createTenantWithLocation, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-282 extended coverage — the smoke cases (UPDATE/DELETE on
// audit_logs) live in triggers.test.ts. This file covers the
// companion table `access_logs` and two boundary behaviors worth
// pinning down for future reviewers: the trigger fires regardless of
// the RLS role that reached it, and TRUNCATE is intentionally not
// blocked by the trigger (it is BEFORE UPDATE OR DELETE — TRUNCATE
// bypasses per-row triggers).

describe('BR-282 — audit immutability (access_logs + admin + TRUNCATE)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedAccessLog(): Promise<string> {
    // access_logs requires vehicle_id + tenant_id + user_id FKs.
    const { tenantId, locationId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId });

    const { rows: userRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO users
         (id, tenant_id, location_id, cognito_sub, email, first_name, last_name,
          role, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'u@test.local', 'U', 'T',
          'super_admin'::"UserRole", 'active'::"UserStatus", NOW(), NOW())
       RETURNING id`,
      [tenantId, locationId, `cognito-${Date.now()}`],
    );
    const userId = userRows[0]!.id;

    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO access_logs
         (id, vehicle_id, tenant_id, location_id, user_id, action, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, 'view'::"AccessLogAction", NOW())
       RETURNING id`,
      [vehicleId, tenantId, locationId, userId],
    );
    return rows[0]!.id;
  }

  it('rejects UPDATE on access_logs', async () => {
    const id = await seedAccessLog();

    await expect(
      pgAdmin.query(`UPDATE access_logs SET action = 'update' WHERE id = $1`, [id]),
    ).rejects.toThrow(/BR-282/);
  });

  it('rejects DELETE on access_logs', async () => {
    const id = await seedAccessLog();

    await expect(pgAdmin.query(`DELETE FROM access_logs WHERE id = $1`, [id])).rejects.toThrow(
      /BR-282/,
    );
  });

  it('trigger fires for admin role too — RLS policy reaches it but the row mutation is still blocked', async () => {
    // The `audit_logs_admin_ops` policy exists specifically so the
    // BR-282 trigger evaluates on the admin path (without it, RLS
    // default-denies and the trigger never fires, producing a silent
    // zero-row UPDATE instead of the mandated error). Verify the
    // end-to-end: admin → policy passes → trigger rejects.
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO audit_logs
         (id, actor_type, action, entity_type, entity_id, created_at)
       VALUES
         (gen_random_uuid(), 'admin'::"AuditActorType", 'test_action',
          'Tenant', gen_random_uuid(), NOW())
       RETURNING id`,
    );
    const auditId = rows[0]!.id;

    await expect(
      withContext({ role: 'admin' }, async (tx) => {
        return tx.auditLog.update({
          where: { id: auditId },
          data: { action: 'mutated_by_admin' },
        });
      }),
    ).rejects.toThrow(/BR-282/);
  });

  it('TRUNCATE on audit_logs is NOT blocked by the trigger — documented behavior', async () => {
    // prevent_audit_modification is a BEFORE UPDATE OR DELETE row-
    // level trigger. TRUNCATE is a statement-level operation and
    // skips per-row triggers entirely. This is intentional: the
    // per-test resetDb() helper relies on TRUNCATE to reset state
    // between tests. If this behavior ever changes (e.g. adding a
    // BEFORE TRUNCATE trigger), this test catches the regression.
    await pgAdmin.query(
      `INSERT INTO audit_logs
         (id, actor_type, action, entity_type, entity_id, created_at)
       VALUES
         (gen_random_uuid(), 'system'::"AuditActorType", 'will_be_truncated',
          'Tenant', gen_random_uuid(), NOW())`,
    );

    await expect(pgAdmin.query(`TRUNCATE TABLE audit_logs`)).resolves.toBeDefined();

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs`,
    );
    expect(rows[0]!.count).toBe('0');
  });
});

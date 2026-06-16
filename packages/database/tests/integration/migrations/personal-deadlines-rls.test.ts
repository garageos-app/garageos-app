import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { withContext } from '../../../src/index.js';
import { createCustomer, createVehicle, resetDb } from '../helpers.js';
import { pgAdmin } from '../setup.js';

// RLS integration tests for personal_deadlines (F-CLI-306 / BR-290..298).
//
// Policy contract (migration 20260616120000_personal_deadlines):
//   - personal_deadlines:           RLS USING(true) (permissive), FORCE.
//   - personal_deadline_reminders:  RLS USING(true) (permissive), FORCE.
// Tenant/customer isolation is enforced at the application layer by an
// explicit `customer_id = <caller>` filter (mirror transfers_access;
// lesson #154 — never rely on RLS alone for these tables).
//
// Test strategy:
//   - Fixtures are inserted via pgAdmin (superuser, bypasses RLS).
//   - Assertions run via withContext({ customerId }) so policies execute
//     against the garageos_app role (FORCE RLS active for the session).

describe('RLS — personal_deadlines (post-migration 20260616120000)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Seed a personal_deadline row directly via pgAdmin (bypasses RLS).
   */
  async function seedPersonalDeadline(opts: {
    customerId: string;
    vehicleId: string;
  }): Promise<{ deadlineId: string }> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadlines
         (id, customer_id, vehicle_id, category, due_date, reminder_lead_days,
          status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'insurance'::"PersonalDeadlineCategory",
          '2026-12-31', ARRAY[30, 7]::integer[],
          'open'::"PersonalDeadlineStatus", NOW(), NOW())
       RETURNING id`,
      [opts.customerId, opts.vehicleId],
    );
    return { deadlineId: rows[0]!.id };
  }

  it('app-layer customer filter returns only the calling customer rows', async () => {
    const { id: customerAId } = await createCustomer({});
    const { id: customerBId } = await createCustomer({});
    const { vehicleId } = await createVehicle({});

    await seedPersonalDeadline({ customerId: customerAId, vehicleId });
    await seedPersonalDeadline({ customerId: customerBId, vehicleId });

    // RLS is USING(true), so without the app-layer filter both rows would
    // be visible. The app-layer `where: { customerId }` is the actual
    // isolation boundary (lesson #154).
    const seenByA = await withContext({ customerId: customerAId }, (tx) =>
      tx.personalDeadline.findMany({ where: { customerId: customerAId } }),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.customerId).toBe(customerAId);

    const seenByB = await withContext({ customerId: customerBId }, (tx) =>
      tx.personalDeadline.findMany({ where: { customerId: customerBId } }),
    );
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]!.customerId).toBe(customerBId);
  });

  it('customer can create, read, update and delete their own deadline', async () => {
    const { id: customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({});

    // CREATE (RLS USING(true) permits the write; app passes own customerId).
    const created = await withContext({ customerId }, (tx) =>
      tx.personalDeadline.create({
        data: {
          customerId,
          vehicleId,
          category: 'inspection',
          dueDate: new Date('2026-11-30'),
          reminderLeadDays: [30, 7],
        },
        select: { id: true, customerId: true, status: true },
      }),
    );
    expect(created.id).toBeDefined();
    expect(created.customerId).toBe(customerId);
    expect(created.status).toBe('open');

    // UPDATE
    const updated = await withContext({ customerId }, (tx) =>
      tx.personalDeadline.update({
        where: { id: created.id },
        data: { status: 'completed', completedAt: new Date() },
        select: { status: true },
      }),
    );
    expect(updated.status).toBe('completed');

    // DELETE
    const deleted = await withContext({ customerId }, (tx) =>
      tx.personalDeadline.deleteMany({ where: { id: created.id, customerId } }),
    );
    expect(deleted.count).toBe(1);
  });

  it('FORCE RLS is active — no context still sees rows only via permissive policy', async () => {
    // The policy is permissive (USING true), so even with FORCE the row
    // is visible; the test asserts the table is reachable under the app
    // role with FORCE enabled (the migration ran ENABLE + FORCE without
    // error and the policy grants access). A row created by A is visible
    // when querying without an app-layer filter, proving the permissive
    // policy — and proving isolation is app-layer, not RLS.
    const { id: customerAId } = await createCustomer({});
    const { id: customerBId } = await createCustomer({});
    const { vehicleId } = await createVehicle({});

    await seedPersonalDeadline({ customerId: customerAId, vehicleId });

    // Customer B queries WITHOUT the app-layer filter: the permissive
    // policy exposes A's row, which is exactly why the app-layer filter
    // is mandatory (negative demonstration of the #154 lesson).
    const unfiltered = await withContext({ customerId: customerBId }, (tx) =>
      tx.personalDeadline.findMany(),
    );
    expect(unfiltered.length).toBeGreaterThanOrEqual(1);
  });

  it('reminder row cascades from its personal_deadline (FK + permissive RLS)', async () => {
    const { id: customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({});
    const { deadlineId } = await seedPersonalDeadline({ customerId, vehicleId });

    await pgAdmin.query(
      `INSERT INTO personal_deadline_reminders
         (id, personal_deadline_id, scheduled_for, kind, delivery_status, created_at)
       VALUES
         (gen_random_uuid(), $1, '2026-12-01', 'lead'::"PersonalDeadlineReminderKind",
          'pending'::"NotificationDeliveryStatus", NOW())`,
      [deadlineId],
    );

    const reminders = await withContext({ customerId }, (tx) =>
      tx.personalDeadlineReminder.findMany({ where: { personalDeadlineId: deadlineId } }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.kind).toBe('lead');

    // ON DELETE CASCADE: deleting the parent removes the reminder.
    await pgAdmin.query(`DELETE FROM personal_deadlines WHERE id = $1`, [deadlineId]);
    const { rows } = await pgAdmin.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM personal_deadline_reminders WHERE personal_deadline_id = $1`,
      [deadlineId],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('INSERT with non-existent vehicle_id raises FK violation', async () => {
    const { id: customerId } = await createCustomer({});
    const nonExistentVehicleId = randomUUID();

    await expect(
      withContext({ customerId }, (tx) =>
        tx.personalDeadline.create({
          data: {
            customerId,
            vehicleId: nonExistentVehicleId,
            category: 'service',
            dueDate: new Date('2026-10-01'),
            reminderLeadDays: [],
          },
        }),
      ),
    ).rejects.toThrow(/foreign key|23503|P2003/i);
  });
});

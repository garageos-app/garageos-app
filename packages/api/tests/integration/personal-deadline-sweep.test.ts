import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';

// Mock the email seam so no real provider HTTP leaves the test and we can
// assert the recipient address. dispatchNotification -> dispatchEmail calls
// sendEmail from email-channel.js (see dispatcher.ts / email-channel.ts).
const sendEmailMock = vi.fn();
vi.mock('../../src/lib/notifications/email-channel.js', () => ({
  sendEmail: (input: { toAddress: string }) => sendEmailMock(input),
}));

// Mock the Expo seam too — the sweep passes its tx so push is attempted; we
// don't want real HTTP and these cases assert on email + delivery_status.
const sendPushMock = vi.fn();
vi.mock('../../src/lib/notifications/expo-client.js', () => ({
  sendExpoPushChunks: (msgs: unknown[]) => sendPushMock(msgs),
  isValidExpoPushToken: (t: string) => t.startsWith('ExpoPushToken['),
}));

import { processPersonalDeadlineSweep } from '../../src/lib/personal-deadlines/sweep.js';

// F-CLI-306 PR2 — processPersonalDeadlineSweep end-to-end against real Postgres.
describe('Personal deadline sweep (F-CLI-306 PR2)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    sendEmailMock.mockReset();
    sendPushMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);
    sendPushMock.mockResolvedValue([]);
    // Email path reads SES env defensively; ensure it exists.
    process.env.SES_FROM_ADDRESS ??= 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET ??= 'test-config-set';
  });

  // Thin AppLike adapter (same pattern as transfer-expiry.test.ts).
  function sweepApp() {
    return { withContext: app.withContext.bind(app), log: app.log };
  }

  async function ownedVehicle(customerId: string) {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    return { vehicleId };
  }

  // Direct insert of a personal_deadlines row (bypasses RLS via pgAdmin).
  async function createPersonalDeadline(params: {
    customerId: string;
    vehicleId: string;
    dueDate: string; // YYYY-MM-DD
    status?: 'open' | 'overdue' | 'completed' | 'cancelled';
    notifyEmail?: boolean;
    notifyPush?: boolean;
    category?: string;
  }): Promise<{ deadlineId: string }> {
    const {
      customerId,
      vehicleId,
      dueDate,
      status = 'open',
      notifyEmail = true,
      notifyPush = true,
      category = 'insurance',
    } = params;
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadlines
         (id, customer_id, vehicle_id, category, due_date, notify_email, notify_push,
          status, reminder_lead_days, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::"PersonalDeadlineCategory", $4::date, $5, $6,
          $7::"PersonalDeadlineStatus", '{}', NOW(), NOW())
       RETURNING id`,
      [customerId, vehicleId, category, dueDate, notifyEmail, notifyPush, status],
    );
    return { deadlineId: rows[0]!.id };
  }

  // Direct insert of a pending personal_deadline_reminders row.
  async function createReminder(params: {
    deadlineId: string;
    scheduledFor: string; // YYYY-MM-DD
    kind?: 'lead' | 'tail';
  }): Promise<{ reminderId: string }> {
    const { deadlineId, scheduledFor, kind = 'lead' } = params;
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO personal_deadline_reminders
         (id, personal_deadline_id, scheduled_for, kind, delivery_status, created_at)
       VALUES (gen_random_uuid(), $1, $2::date, $3::"PersonalDeadlineReminderKind", 'pending', NOW())
       RETURNING id`,
      [deadlineId, scheduledFor, kind],
    );
    return { reminderId: rows[0]!.id };
  }

  async function reminderRow(id: string) {
    const { rows } = await pgAdmin.query<{
      delivery_status: string;
      failure_reason: string | null;
      scheduled_for: string;
    }>(
      `SELECT delivery_status, failure_reason, to_char(scheduled_for, 'YYYY-MM-DD') AS scheduled_for
         FROM personal_deadline_reminders WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function deadlineStatus(id: string): Promise<string> {
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM personal_deadlines WHERE id = $1`,
      [id],
    );
    return rows[0]!.status;
  }

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function shiftDays(days: number): string {
    const base = new Date(`${today()}T00:00:00Z`);
    return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  }

  it('Seed A: due open reminder, both channels on -> sent + email to the owner', async () => {
    const email = `owner-${randomUUID().slice(0, 8)}@test.it`;
    const { customerId } = await createCustomer({ email, cognitoSub: null });
    const { vehicleId } = await ownedVehicle(customerId);
    const { deadlineId } = await createPersonalDeadline({
      customerId,
      vehicleId,
      dueDate: today(),
    });
    const { reminderId } = await createReminder({ deadlineId, scheduledFor: today() });

    const result = await processPersonalDeadlineSweep({ app: sweepApp() });

    expect(result.sent).toBe(1);
    const row = await reminderRow(reminderId);
    expect(row.delivery_status).toBe('sent');
    // The recipient IS the deadline's owning customer.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].toAddress).toBe(email);
  });

  it('Seed B: deadline due yesterday flips to overdue; its reminder is excluded from delivery', async () => {
    const { customerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await ownedVehicle(customerId);
    const { deadlineId } = await createPersonalDeadline({
      customerId,
      vehicleId,
      dueDate: shiftDays(-1),
      status: 'open',
    });
    // A pending reminder scheduled in the past on the now-overdue deadline.
    const { reminderId } = await createReminder({ deadlineId, scheduledFor: shiftDays(-1) });

    const result = await processPersonalDeadlineSweep({ app: sweepApp() });

    expect(result.overdueFlipped).toBe(1);
    expect(await deadlineStatus(deadlineId)).toBe('overdue');

    // The reminder must NOT be delivered (parent no longer open). It is either
    // left pending (within stale window) or stale-cancelled — never 'sent'.
    const row = await reminderRow(reminderId);
    expect(row.delivery_status).not.toBe('sent');
    expect(result.sent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('stale-cancels a pending reminder scheduled beyond the stale window', async () => {
    const { customerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await ownedVehicle(customerId);
    // Keep the parent open by giving it a future due date; only the orphan
    // reminder is old. (Real overdue parents are covered by Seed B.)
    const { deadlineId } = await createPersonalDeadline({
      customerId,
      vehicleId,
      dueDate: shiftDays(30),
    });
    const { reminderId } = await createReminder({ deadlineId, scheduledFor: shiftDays(-5) });

    const result = await processPersonalDeadlineSweep({ app: sweepApp() });

    expect(result.staleCancelled).toBe(1);
    const row = await reminderRow(reminderId);
    expect(row.delivery_status).toBe('cancelled');
    expect(row.failure_reason).toBe('stale');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('channels_off: deadline with both notify flags false -> cancelled, no email', async () => {
    const { customerId } = await createCustomer({ cognitoSub: null });
    const { vehicleId } = await ownedVehicle(customerId);
    const { deadlineId } = await createPersonalDeadline({
      customerId,
      vehicleId,
      dueDate: today(),
      notifyEmail: false,
      notifyPush: false,
    });
    const { reminderId } = await createReminder({ deadlineId, scheduledFor: today() });

    const result = await processPersonalDeadlineSweep({ app: sweepApp() });

    expect(result.channelsOffCancelled).toBe(1);
    const row = await reminderRow(reminderId);
    expect(row.delivery_status).toBe('cancelled');
    expect(row.failure_reason).toBe('channels_off');
    // scheduled_for round-trips as a bare date (feedback_db_date_serialized_as_iso).
    expect(row.scheduled_for).toBe(today());
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

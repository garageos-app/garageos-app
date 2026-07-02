import { randomUUID } from 'node:crypto';

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { _resetSchedulerClientForTests } from '../../src/lib/scheduler-client.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-405 — POST /v1/deadlines/:id/complete.
//
// Tenant-scoped completion of an open deadline. Three side effects:
//   1. cancelPendingReminders → DeleteSchedule × pending +
//      deliveryStatus='cancelled' (sent rows preserved).
//   2. deadline.status='completed' + completedAt + optional
//      completedByInterventionId.
//   3. If isRecurring=true && recurringMonths > 0 → createNextRecurringDeadline
//      (anniversary semantic: oldDueDate + recurringMonths) + 3 new schedules.
//
// recurringKm-only recurrence (recurringMonths=null) is intentionally
// skipped per BR-103.
//
// 200 — happy path. Body { completed, next }.
// 409 — status != 'open' (already completed/cancelled).
// 422 — completedByInterventionId from another vehicle / tenant.
// 404 — RLS-as-404 (cross-tenant or unknown id).
//
// See feedback_integration_test_rate_limit_isolation.md — TEST_IP is
// describe-scoped to keep the @fastify/rate-limit bucket isolated.
const TEST_IP = '10.20.31.5';

// Direct pgAdmin seed mirroring deadlines-update/delete test patterns:
// bypasses RLS so cross-tenant fixtures and non-`open` statuses can be
// inserted without driving the public POST path. Includes recurring
// fields so the auto-create-next branch can be exercised directly.
async function seedDeadline(params: {
  tenantId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string; // YYYY-MM-DD
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
  description?: string | null;
  isRecurring?: boolean;
  recurringMonths?: number | null;
  recurringKm?: number | null;
  dueOdometerKm?: number | null;
}): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    vehicleId,
    interventionTypeId,
    dueDate,
    status = 'open',
    description = null,
    isRecurring = false,
    recurringMonths = null,
    recurringKm = null,
    dueOdometerKm = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines
       (id, tenant_id, vehicle_id, intervention_type_id,
        due_date, due_odometer_km, description,
        is_recurring, recurring_months, recurring_km,
        status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, $6,
        $7, $8, $9,
        $10::"DeadlineStatus", NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      vehicleId,
      interventionTypeId,
      dueDate,
      dueOdometerKm,
      description,
      isRecurring,
      recurringMonths,
      recurringKm,
      status,
    ],
  );
  return { deadlineId: rows[0]!.id };
}

async function seedNotification(params: {
  deadlineId: string;
  scheduledFor: Date;
  reminderType: 't_minus_30' | 't_minus_7' | 't_zero';
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'cancelled';
  eventbridgeScheduleArn?: string | null;
  sentAt?: Date | null;
}): Promise<{ notificationId: string }> {
  const {
    deadlineId,
    scheduledFor,
    reminderType,
    deliveryStatus = 'pending',
    eventbridgeScheduleArn = null,
    sentAt = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadline_notifications
       (id, deadline_id, scheduled_for, reminder_type,
        eventbridge_schedule_arn, sent_at, delivery_status,
        created_at)
     VALUES (gen_random_uuid(), $1, $2, $3::"DeadlineReminderType",
        $4, $5, $6::"NotificationDeliveryStatus", NOW())
     RETURNING id`,
    [deadlineId, scheduledFor, reminderType, eventbridgeScheduleArn, sentAt, deliveryStatus],
  );
  return { notificationId: rows[0]!.id };
}

describe('POST /v1/deadlines/:id/complete (F-OFF-405)', () => {
  let app: FastifyInstance;

  process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';
  process.env.SCHEDULER_GROUP_NAME = 'garageos-deadlines-test';
  process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/test-scheduler';
  process.env.LAMBDA_FUNCTION_ARN =
    'arn:aws:lambda:eu-central-1:123456789012:function:garageos-api';

  const schedulerMock = mockClient(SchedulerClient);

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    schedulerMock.reset();
    _resetSchedulerClientForTests();
    schedulerMock.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-central-1:123456789012:schedule/garageos-deadlines-test/deadline-test',
    });
    schedulerMock.on(DeleteScheduleCommand).resolves({});
  });

  // dueDate ~120 days out keeps all 3 reminder windows in the future
  // so the seeded pending-set is realistic and the post-completion
  // anniversary date (12mo for the recurring case) lands well in the future.
  function farFutureDueDateIso(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  // YYYY-MM-DD for `daysFromNow` days into the future. Used by the
  // past-anniversary edge case to engineer a dueDate where +12mo is in
  // the past, so createReminders silently produces zero schedules.
  function inPastDueDateIso(daysAgo: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  async function seedOpenDeadlineWithReminders(opts: {
    tenantSuffix: string;
    isRecurring?: boolean;
    recurringMonths?: number | null;
    recurringKm?: number | null;
    dueOdometerKm?: number | null;
    dueDate?: string;
  }): Promise<{
    tenantId: string;
    cognitoSub: string;
    userId: string;
    vehicleId: string;
    deadlineId: string;
    notificationIds: string[];
    typeId: string;
  }> {
    const { tenantId } = await createTenantWithLocation(opts.tenantSuffix);
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const dueDate = opts.dueDate ?? farFutureDueDateIso();
    const { deadlineId } = await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate,
      description: 'iniziale',
      isRecurring: opts.isRecurring ?? false,
      recurringMonths: opts.recurringMonths ?? null,
      recurringKm: opts.recurringKm ?? null,
      dueOdometerKm: opts.dueOdometerKm ?? null,
    });

    const due = new Date(`${dueDate}T08:00:00Z`);
    const t30 = new Date(due);
    t30.setUTCDate(t30.getUTCDate() - 30);
    const t7 = new Date(due);
    t7.setUTCDate(t7.getUTCDate() - 7);
    const n1 = await seedNotification({
      deadlineId,
      scheduledFor: t30,
      reminderType: 't_minus_30',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-existing-1',
    });
    const n2 = await seedNotification({
      deadlineId,
      scheduledFor: t7,
      reminderType: 't_minus_7',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-existing-2',
    });
    const n3 = await seedNotification({
      deadlineId,
      scheduledFor: due,
      reminderType: 't_zero',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-existing-3',
    });

    return {
      tenantId,
      cognitoSub,
      userId,
      vehicleId,
      deadlineId,
      typeId: type.id,
      notificationIds: [n1.notificationId, n2.notificationId, n3.notificationId],
    };
  }

  it('200 + status=completed + DeleteSchedule × pending + next=null for non-recurring', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'complete-happy' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      completed: { id: string; status: string; completedAt: string | null };
      next: unknown;
    };
    expect(body.completed.id).toBe(seed.deadlineId);
    expect(body.completed.status).toBe('completed');
    expect(body.completed.completedAt).not.toBeNull();
    expect(body.next).toBeNull();

    // 3 DeleteSchedule (one per pending reminder); zero CreateSchedule
    // because the deadline is non-recurring.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(3);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);

    // All 3 pending notifications flipped to cancelled.
    const { rows: notifRows } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [seed.deadlineId],
    );
    expect(notifRows).toHaveLength(3);
    expect(notifRows.every((r) => r.delivery_status === 'cancelled')).toBe(true);
  });

  it('200 recurring → next is the new deadline + 3 new schedules + old pending cancelled', async () => {
    const seed = await seedOpenDeadlineWithReminders({
      tenantSuffix: 'complete-recurring',
      isRecurring: true,
      recurringMonths: 12,
      recurringKm: 15_000,
      dueOdometerKm: 60_000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      completed: { id: string; status: string };
      next: {
        id: string;
        status: string;
        isRecurring: boolean;
        recurringMonths: number;
        recurringKm: number;
        dueOdometerKm: number | null;
        dueDate: string | null;
      } | null;
    };
    expect(body.completed.status).toBe('completed');
    expect(body.next).not.toBeNull();
    expect(body.next!.id).not.toBe(seed.deadlineId);
    expect(body.next!.status).toBe('open');
    expect(body.next!.isRecurring).toBe(true);
    expect(body.next!.recurringMonths).toBe(12);
    expect(body.next!.recurringKm).toBe(15_000);
    expect(body.next!.dueOdometerKm).toBe(75_000); // 60_000 + 15_000

    // 3 DeleteSchedule for the cancelled-pending set + 3 CreateSchedule
    // for the freshly-anchored anniversary cycle.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(3);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(3);

    // Old deadline: 3 cancelled rows.
    const { rows: oldNotif } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [seed.deadlineId],
    );
    expect(oldNotif).toHaveLength(3);
    expect(oldNotif.every((r) => r.delivery_status === 'cancelled')).toBe(true);

    // New deadline: 3 pending rows.
    const { rows: newNotif } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [body.next!.id],
    );
    expect(newNotif).toHaveLength(3);
    expect(newNotif.every((r) => r.delivery_status === 'pending')).toBe(true);
  });

  it('200 recurring with past-anniversary new dueDate → next exists with 0 notifications', async () => {
    // Engineer dueDate 400 days in the past so dueDate + 12mo is still
    // ~35 days in the past — createReminders skips all 3 reminder
    // instants (they are all elapsed) and the new row is created
    // without any DeadlineNotification companions.
    const pastDue = inPastDueDateIso(400);
    const seed = await seedOpenDeadlineWithReminders({
      tenantSuffix: 'complete-past-anniv',
      isRecurring: true,
      recurringMonths: 12,
      dueDate: pastDue,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { next: { id: string } | null };
    expect(body.next).not.toBeNull();

    // New cycle exists with 0 schedules — past instants are silently dropped.
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    const { rows: newNotif } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [body.next!.id],
    );
    expect(newNotif).toHaveLength(0);
  });

  it('200 + completedByInterventionId set on the completed row', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'complete-with-ix' });

    const { interventionId } = await createIntervention({
      tenantId: seed.tenantId,
      userId: seed.userId,
      vehicleId: seed.vehicleId,
      interventionTypeId: seed.typeId,
      interventionDate: new Date().toISOString().slice(0, 10),
      odometerKm: 50_000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { completedByInterventionId: interventionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      completed: { completedByInterventionId: string | null };
    };
    expect(body.completed.completedByInterventionId).toBe(interventionId);

    const { rows } = await pgAdmin.query<{ completed_by_intervention_id: string | null }>(
      `SELECT completed_by_intervention_id FROM deadlines WHERE id = $1`,
      [seed.deadlineId],
    );
    expect(rows[0]!.completed_by_intervention_id).toBe(interventionId);
  });

  it('409 deadline.complete.not_open when status is already completed', async () => {
    const { tenantId } = await createTenantWithLocation('complete-already-completed');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
      status: 'completed',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'deadline.complete.not_open',
      status: 409,
    });
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it('409 deadline.complete.not_open when status is cancelled', async () => {
    const { tenantId } = await createTenantWithLocation('complete-cancelled');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
      status: 'cancelled',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'deadline.complete.not_open' });
  });

  it('422 deadline.complete.intervention_invalid when intervention is from another vehicle', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'complete-other-vehicle' });
    // Same tenant, DIFFERENT vehicle.
    const { vehicleId: otherVehicleId } = await createVehicle({
      createdByTenantId: seed.tenantId,
    });
    const { interventionId } = await createIntervention({
      tenantId: seed.tenantId,
      userId: seed.userId,
      vehicleId: otherVehicleId,
      interventionTypeId: seed.typeId,
      interventionDate: new Date().toISOString().slice(0, 10),
      odometerKm: 50_000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { completedByInterventionId: interventionId },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'deadline.complete.intervention_invalid',
      status: 422,
    });

    // Deadline left untouched.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [seed.deadlineId],
    );
    expect(rows[0]!.status).toBe('open');
    // No AWS work.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
  });

  it('422 deadline.complete.intervention_invalid when intervention is from another tenant', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'complete-other-tenant' });
    // DIFFERENT tenant — fully separate fixture set.
    const other = await createTenantWithLocation('complete-other-tenant-b');
    const { userId: otherUserId } = await createUser({
      tenantId: other.tenantId,
      cognitoSub: `office-other-${randomUUID().slice(0, 8)}`,
      role: 'super_admin',
    });
    const { vehicleId: otherVehicleId } = await createVehicle({
      createdByTenantId: other.tenantId,
    });
    const { interventionId } = await createIntervention({
      tenantId: other.tenantId,
      userId: otherUserId,
      vehicleId: otherVehicleId,
      interventionTypeId: seed.typeId,
      interventionDate: new Date().toISOString().slice(0, 10),
      odometerKm: 50_000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { completedByInterventionId: interventionId },
    });

    // Cross-tenant intervention is not visible to the caller's RLS scope
    // (Intervention has its own tenant-isolation policy), so findUnique
    // returns null → 422 intervention_invalid (NOT 404 from the deadline
    // findUniqueOrThrow, which already passed).
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'deadline.complete.intervention_invalid',
    });
  });

  it('404 cross-tenant deadline: deadlines_tenant_isolation RLS-as-404', async () => {
    const a = await createTenantWithLocation('complete-xt-a');
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId: a.tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
    });

    const b = await createTenantWithLocation('complete-xt-b');
    const bSub = `office-b-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: b.tenantId,
      cognitoSub: bSub,
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: bSub,
      tenantId: b.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });

    // Tenant A's deadline untouched.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(rows[0]!.status).toBe('open');
  });

  it('200 with no body: optional completedByInterventionId, completion succeeds with NULL', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'complete-no-body' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    // Deliberately omit payload — the route accepts an empty/absent body.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      completed: { completedByInterventionId: string | null; status: string };
    };
    expect(body.completed.status).toBe('completed');
    expect(body.completed.completedByInterventionId).toBeNull();
  });

  it('200 isRecurring=true with recurringMonths=null → no auto-create (km-only intentionally skipped)', async () => {
    // BR-103: reminders are date-driven only. A recurring deadline with
    // only recurringKm set is accepted at create time (forward-compat)
    // but does NOT trigger anniversary auto-create on completion.
    const seed = await seedOpenDeadlineWithReminders({
      tenantSuffix: 'complete-km-only',
      isRecurring: true,
      recurringMonths: null,
      recurringKm: 15_000,
      dueOdometerKm: 60_000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${seed.deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { next: unknown };
    expect(body.next).toBeNull();

    // Pending DeleteSchedule × 3 happens unconditionally; CreateSchedule
    // is zero because no anniversary cycle was created.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(3);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);

    // Only the original deadline exists.
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM deadlines WHERE vehicle_id = $1`,
      [seed.vehicleId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('200 preserves already-sent reminder rows across completion (audit append-only)', async () => {
    // Sent rows must NEVER be touched by cancelPendingReminders. Seed
    // 1 sent + 2 pending, complete the deadline, verify the sent row is
    // intact and only the 2 pending rows got DeleteSchedule.
    const { tenantId } = await createTenantWithLocation('complete-sent-preserved');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
    });

    const sentAt = new Date();
    const sent = await seedNotification({
      deadlineId,
      scheduledFor: new Date(Date.now() - 24 * 60 * 60 * 1000),
      reminderType: 't_minus_30',
      deliveryStatus: 'sent',
      sentAt,
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-sent-1',
    });
    const pending1 = await seedNotification({
      deadlineId,
      scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      reminderType: 't_minus_7',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-pending-1',
    });
    const pending2 = await seedNotification({
      deadlineId,
      scheduledFor: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      reminderType: 't_zero',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-pending-2',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/deadlines/${deadlineId}/complete`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(200);

    // Only the 2 pending rows triggered DeleteSchedule.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(2);

    // Sent row preserved untouched.
    const { rows: sentCheck } = await pgAdmin.query<{
      delivery_status: string;
      sent_at: Date | null;
    }>(`SELECT delivery_status, sent_at FROM deadline_notifications WHERE id = $1`, [
      sent.notificationId,
    ]);
    expect(sentCheck[0]!.delivery_status).toBe('sent');
    expect(sentCheck[0]!.sent_at).not.toBeNull();

    // Pending rows flipped to cancelled.
    const { rows: pending1Check } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE id = $1`,
      [pending1.notificationId],
    );
    expect(pending1Check[0]!.delivery_status).toBe('cancelled');
    const { rows: pending2Check } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE id = $1`,
      [pending2.notificationId],
    );
    expect(pending2Check[0]!.delivery_status).toBe('cancelled');

    // Deadline row flipped to completed.
    const { rows: deadlineRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(deadlineRows[0]!.status).toBe('completed');
  });
});

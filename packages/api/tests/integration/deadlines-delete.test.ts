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
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { _resetSchedulerClientForTests } from '../../src/lib/scheduler-client.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-401 — DELETE /v1/deadlines/:id.
//
// Tenant-scoped soft delete on a deadline:
//   1. cancelPendingReminders → for each pending DeadlineNotification
//      issue a DeleteSchedule + flip deliveryStatus='cancelled' (sent
//      rows preserved untouched, audit append-only invariant).
//   2. flip deadline.status='cancelled'.
//
// 204 — happy path.
// 204 — idempotent on already-cancelled (no AWS calls, no DB churn).
// 409 — when status='completed' (audit lock; completed deadlines
//        cannot be retroactively erased).
// 404 — RLS-as-404 via deadlines_tenant_isolation (cross-tenant /
//        unknown id raise P2025 from findUniqueOrThrow).
// 401 — missing Bearer token.
// 403 — clienti-pool token rejected by requireOfficinaPool.
//
// See feedback_integration_test_rate_limit_isolation.md — TEST_IP is
// describe-scoped to keep the rate-limit bucket isolated.
const TEST_IP = '10.20.31.4';

// Direct pgAdmin seed mirroring deadlines-update.test.ts: bypasses
// RLS so cross-tenant fixtures and non-`open` statuses can be inserted
// without driving the public POST path.
async function seedDeadline(params: {
  tenantId: string;
  locationId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string; // YYYY-MM-DD
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
  description?: string | null;
}): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    locationId,
    vehicleId,
    interventionTypeId,
    dueDate,
    status = 'open',
    description = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines
       (id, tenant_id, location_id, vehicle_id, intervention_type_id,
        due_date, description, is_recurring,
        status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::date, $6, false,
        $7::"DeadlineStatus", NOW(), NOW())
     RETURNING id`,
    [tenantId, locationId, vehicleId, interventionTypeId, dueDate, description, status],
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
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3::"DeadlineReminderType",
        $4, $5, $6::"NotificationDeliveryStatus", NOW(), NOW())
     RETURNING id`,
    [deadlineId, scheduledFor, reminderType, eventbridgeScheduleArn, sentAt, deliveryStatus],
  );
  return { notificationId: rows[0]!.id };
}

describe('DELETE /v1/deadlines/:id (F-OFF-401)', () => {
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

  function farFutureDueDateIso(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  // Builds the standard scenario: tenant + user + vehicle + open
  // deadline + 3 pending reminders.
  async function seedOpenDeadlineWithReminders(opts: { tenantSuffix: string }): Promise<{
    tenantId: string;
    locationId: string;
    cognitoSub: string;
    vehicleId: string;
    deadlineId: string;
    notificationIds: string[];
  }> {
    const { tenantId, locationId } = await createTenantWithLocation(opts.tenantSuffix);
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
      description: 'iniziale',
    });

    const due = new Date(`${farFutureDueDateIso()}T08:00:00Z`);
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
      locationId,
      cognitoSub,
      vehicleId,
      deadlineId,
      notificationIds: [n1.notificationId, n2.notificationId, n3.notificationId],
    };
  }

  it('204 happy path: cancels pending reminders + DeleteSchedule × 3 + status=cancelled', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'delete-happy' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // 3 DeleteSchedule calls (one per pending reminder); zero CreateSchedule.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(3);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);

    // Deadline row flipped to cancelled.
    const { rows: deadlineRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [seed.deadlineId],
    );
    expect(deadlineRows[0]!.status).toBe('cancelled');

    // All 3 pending notifications flipped to cancelled (audit-preserving:
    // rows still exist).
    const { rows: notifRows } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [seed.deadlineId],
    );
    expect(notifRows).toHaveLength(3);
    expect(notifRows.every((r) => r.delivery_status === 'cancelled')).toBe(true);
  });

  it('204 idempotent on already-cancelled deadline: no AWS calls, status unchanged', async () => {
    // When the deadline is already cancelled, DELETE is a no-op: 204
    // returned without touching the scheduler or rewriting the row.
    const { tenantId, locationId } = await createTenantWithLocation('delete-idempotent');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      locationId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
      status: 'cancelled',
    });
    // A pre-existing cancelled notification with sent_at set.
    const previouslyCancelled = await seedNotification({
      deadlineId,
      scheduledFor: new Date(`${farFutureDueDateIso()}T08:00:00Z`),
      reminderType: 't_minus_30',
      deliveryStatus: 'cancelled',
      eventbridgeScheduleArn: null,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // No AWS work whatsoever.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);

    // Status still 'cancelled', not rewritten.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(rows[0]!.status).toBe('cancelled');

    // Pre-existing cancelled notification untouched.
    const { rows: notifRows } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE id = $1`,
      [previouslyCancelled.notificationId],
    );
    expect(notifRows[0]!.delivery_status).toBe('cancelled');
  });

  it('409 deadline.delete.completed when status is completed', async () => {
    // Completed deadlines preserve audit and cannot be retroactively
    // erased — the operator can complete-with-undo within the BR
    // window but not delete.
    const { tenantId, locationId } = await createTenantWithLocation('delete-completed');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      locationId,
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
      locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'deadline.delete.completed',
      status: 409,
    });

    // Status still 'completed', not flipped.
    const { rows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(rows[0]!.status).toBe('completed');

    // No AWS work.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
  });

  it('404 cross-tenant deadline: deadlines_tenant_isolation RLS-as-404', async () => {
    const a = await createTenantWithLocation('delete-xt-a');
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId: a.tenantId,
      locationId: a.locationId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
    });

    const b = await createTenantWithLocation('delete-xt-b');
    const bSub = `office-b-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: b.tenantId,
      cognitoSub: bSub,
      role: 'super_admin',
      locationId: b.locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: bSub,
      tenantId: b.tenantId,
      role: 'super_admin',
      locationId: b.locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
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

  it('404 unknown deadline id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('delete-unknown');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
  });

  it('204 preserves already-sent reminder rows (audit append-only)', async () => {
    // Sent rows must NEVER be touched by cancelPendingReminders. Seed
    // 1 sent + 2 pending, DELETE the deadline, verify the sent row is
    // intact and only the 2 pending rows got DeleteSchedule.
    const { tenantId, locationId } = await createTenantWithLocation('delete-sent');
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin', locationId });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId,
      locationId,
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
      locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(204);

    // Only the 2 pending rows triggered DeleteSchedule.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(2);

    // Sent row preserved untouched (delivery_status still 'sent', sent_at intact).
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

    // Deadline row flipped to cancelled.
    const { rows: deadlineRows } = await pgAdmin.query<{ status: string }>(
      `SELECT status FROM deadlines WHERE id = $1`,
      [deadlineId],
    );
    expect(deadlineRows[0]!.status).toBe('cancelled');
  });

  it('401 unauthenticated: missing Bearer is rejected', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'delete-noauth' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(401);
  });

  it('403 clienti-pool token rejected by requireOfficinaPool', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'delete-clienti' });

    const clientToken = await signTestToken({
      pool: 'clienti',
      sub: `cust-${randomUUID().slice(0, 8)}`,
      customerId: randomUUID(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        'x-forwarded-for': TEST_IP,
      },
    });

    expect(res.statusCode).toBe(403);
  });
});

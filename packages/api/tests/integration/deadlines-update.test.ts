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

// F-OFF-401 — PATCH /v1/deadlines/:id.
//
// Two write paths under test:
//   - dueDate change → replaceReminders (cancel pending + recreate)
//   - non-date update → DB only, zero scheduler calls.
//
// 409 deadline.update.not_open when the row is not in `open` state
// (cancelled / completed / overdue are all immutable).
//
// Cross-tenant access is filtered by deadlines_tenant_isolation RLS,
// so cross-tenant PATCH returns 404 (RLS-as-404).
//
// See feedback_integration_test_rate_limit_isolation.md — TEST_IP is
// describe-scoped to keep the @fastify/rate-limit bucket isolated even
// though this route doesn't currently opt in to rate limiting.
const TEST_IP = '10.20.31.3';

// Direct pgAdmin seed mirroring deadlines-list-vehicle.test.ts: bypasses
// RLS so cross-tenant fixtures + non-`open` statuses can be inserted
// without driving the public POST path. createdByTenantId / locationId
// must match the row's intended owner.
async function seedDeadline(params: {
  tenantId: string;
  locationId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string; // YYYY-MM-DD
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
  description?: string | null;
  dueOdometerKm?: number | null;
  isRecurring?: boolean;
  recurringMonths?: number | null;
  recurringKm?: number | null;
}): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    locationId,
    vehicleId,
    interventionTypeId,
    dueDate,
    status = 'open',
    description = null,
    dueOdometerKm = null,
    isRecurring = false,
    recurringMonths = null,
    recurringKm = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines
       (id, tenant_id, location_id, vehicle_id, intervention_type_id,
        due_date, due_odometer_km, description, is_recurring,
        recurring_months, recurring_km, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::date, $6, $7, $8,
        $9, $10, $11::"DeadlineStatus", NOW(), NOW())
     RETURNING id`,
    [
      tenantId,
      locationId,
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

// Direct pgAdmin insert for a pending DeadlineNotification (mirrors the
// state after a successful POST /deadlines + CreateSchedule). Used to
// verify cancel-and-replace semantics on dueDate change.
async function seedNotification(params: {
  deadlineId: string;
  scheduledFor: Date;
  reminderType: 't_minus_30' | 't_minus_7' | 't_zero';
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'cancelled';
  eventbridgeScheduleArn?: string | null;
}): Promise<{ notificationId: string }> {
  const {
    deadlineId,
    scheduledFor,
    reminderType,
    deliveryStatus = 'pending',
    eventbridgeScheduleArn = null,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadline_notifications
       (id, deadline_id, scheduled_for, reminder_type,
        eventbridge_schedule_arn, delivery_status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3::"DeadlineReminderType",
        $4, $5::"NotificationDeliveryStatus", NOW(), NOW())
     RETURNING id`,
    [deadlineId, scheduledFor, reminderType, eventbridgeScheduleArn, deliveryStatus],
  );
  return { notificationId: rows[0]!.id };
}

describe('PATCH /v1/deadlines/:id (F-OFF-401)', () => {
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
  // when computeReminderSchedule slots them at 08:00 Europe/Rome.
  function farFutureDueDateIso(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  // Builds the fully-seeded scenario most tests need: tenant + user +
  // vehicle + intervention type + open deadline + 3 pending reminders.
  async function seedOpenDeadlineWithReminders(opts: { tenantSuffix: string }): Promise<{
    tenantId: string;
    locationId: string;
    cognitoSub: string;
    vehicleId: string;
    deadlineId: string;
    notificationIds: string[];
    typeId: string;
  }> {
    const { tenantId, locationId } = await createTenantWithLocation(opts.tenantSuffix);
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
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
      typeId: type.id,
      notificationIds: [n1.notificationId, n2.notificationId, n3.notificationId],
    };
  }

  // Computes a dueDate that is `daysFromNow` days in the future and
  // returns it as the YYYY-MM-DD slice that the API accepts.
  function inFutureDueDateIso(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }

  it('200 dueDate change: cancels pending + recreates reminders + DeleteSchedule × 3 + CreateSchedule × 3', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-date-1' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const newDueIso = inFutureDueDateIso(150);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: newDueIso },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      dueDate: string;
      status: string;
      notifications: Array<{ id: string; reminderType: string; deliveryStatus: string }>;
    };
    expect(body.id).toBe(seed.deadlineId);
    expect(body.dueDate.slice(0, 10)).toBe(newDueIso);
    // 3 fresh notifications (T-30 / T-7 / T-0) all pending after recreate.
    const pending = body.notifications.filter((n) => n.deliveryStatus === 'pending');
    expect(pending).toHaveLength(3);
    expect(pending.map((n) => n.reminderType).sort()).toEqual([
      't_minus_30',
      't_minus_7',
      't_zero',
    ]);
    // Original 3 cancelled rows are still present (audit-preserving).
    const cancelled = body.notifications.filter((n) => n.deliveryStatus === 'cancelled');
    expect(cancelled).toHaveLength(3);

    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(3);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(3);

    // X-GarageOS-Warning is absent on a clean recreate.
    expect(res.headers['x-garageos-warning']).toBeUndefined();
  });

  it('200 description-only update: zero scheduler calls', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-desc' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { description: 'descrizione aggiornata' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      description: string;
      notifications: Array<{ id: string; deliveryStatus: string }>;
    };
    expect(body.description).toBe('descrizione aggiornata');
    // The 3 pending rows pass through untouched.
    expect(body.notifications).toHaveLength(3);
    expect(body.notifications.every((n) => n.deliveryStatus === 'pending')).toBe(true);

    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
  });

  it('200 same dueDate (no actual change): does not trigger replaceReminders', async () => {
    // Idempotent PATCH: passing the same dueDate must NOT cancel + recreate.
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-samedate' });

    // Read the current dueDate so we can echo it back unchanged.
    const { rows } = await pgAdmin.query<{ due_date: Date }>(
      `SELECT due_date FROM deadlines WHERE id = $1`,
      [seed.deadlineId],
    );
    const currentDueIso = rows[0]!.due_date.toISOString().slice(0, 10);

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: currentDueIso, description: 'roundtrip' },
    });

    expect(res.statusCode).toBe(200);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
  });

  it('409 deadline.update.not_open when status is cancelled', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('patch-cancelled');
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

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: inFutureDueDateIso(150) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'deadline.update.not_open',
      status: 409,
    });
  });

  it('409 deadline.update.not_open when status is completed', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('patch-completed');
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
      method: 'PATCH',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { description: 'tentativo' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'deadline.update.not_open',
      status: 409,
    });
  });

  it('400 dueDate in the past: Zod refuses', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-past' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: '2020-01-01' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('400 empty body: refine guard rejects', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-empty' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('404 cross-tenant deadline: deadlines_tenant_isolation RLS-as-404', async () => {
    // Tenant A owns a deadline; tenant B's user PATCHes it. RLS denies
    // both SELECT (findUniqueOrThrow → P2025) and any subsequent UPDATE.
    const a = await createTenantWithLocation('patch-xt-a');
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    const { deadlineId } = await seedDeadline({
      tenantId: a.tenantId,
      locationId: a.locationId,
      vehicleId,
      interventionTypeId: type.id,
      dueDate: farFutureDueDateIso(),
    });

    const b = await createTenantWithLocation('patch-xt-b');
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
      method: 'PATCH',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { description: 'tentativo cross-tenant' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404 unknown deadline id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('patch-unknown');
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
      method: 'PATCH',
      url: `/v1/deadlines/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { description: 'irrilevante' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('200 dueDate change with scheduler partial failure: header X-GarageOS-Warning + row state committed', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-partial' });

    // CreateSchedule rejects on every call → all 3 fresh rows flip to
    // failed. DeleteSchedule still succeeds (cancel-old branch).
    schedulerMock.on(CreateScheduleCommand).rejects(new Error('aws unavailable'));

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const newDueIso = inFutureDueDateIso(150);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: newDueIso },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-garageos-warning']).toBe('scheduler_partial');

    const body = res.json() as {
      dueDate: string;
      notifications: Array<{ deliveryStatus: string }>;
    };
    expect(body.dueDate.slice(0, 10)).toBe(newDueIso);

    // 3 cancelled (old set) + 3 failed (new set, scheduler rejected).
    const cancelled = body.notifications.filter((n) => n.deliveryStatus === 'cancelled');
    const failed = body.notifications.filter((n) => n.deliveryStatus === 'failed');
    expect(cancelled).toHaveLength(3);
    expect(failed).toHaveLength(3);

    // The deadline row itself committed at the new dueDate — verify directly.
    const { rows } = await pgAdmin.query<{ due_date: Date }>(
      `SELECT due_date FROM deadlines WHERE id = $1`,
      [seed.deadlineId],
    );
    expect(rows[0]!.due_date.toISOString().slice(0, 10)).toBe(newDueIso);
  });

  it('200 dueDate change preserves already-sent reminder rows (audit append-only)', async () => {
    // Sent rows must NEVER be touched by replaceReminders. We seed one
    // 'sent' row alongside 2 pending rows, change dueDate, and verify
    // the sent row is intact while the 2 pending rows are cancelled +
    // 3 fresh rows are created.
    const { tenantId, locationId } = await createTenantWithLocation('patch-sent');
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

    // 1 sent (T-30 already fired) + 2 pending (T-7 + T-0).
    const sentAt = new Date();
    const { rows: sentRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO deadline_notifications
         (id, deadline_id, scheduled_for, reminder_type,
          eventbridge_schedule_arn, sent_at, delivery_status,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, NOW() - INTERVAL '1 day',
          't_minus_30'::"DeadlineReminderType",
          'arn:aws:scheduler:::schedule/group/deadline-sent-1',
          $2, 'sent'::"NotificationDeliveryStatus", NOW(), NOW())
       RETURNING id`,
      [deadlineId, sentAt],
    );
    const sentNotificationId = sentRows[0]!.id;
    await seedNotification({
      deadlineId,
      scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      reminderType: 't_minus_7',
      eventbridgeScheduleArn: 'arn:aws:scheduler:::schedule/group/deadline-pending-1',
    });
    await seedNotification({
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

    const newDueIso = inFutureDueDateIso(150);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { dueDate: newDueIso },
    });

    expect(res.statusCode).toBe(200);

    // Only the 2 pending rows got DeleteSchedule.
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(2);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(3);

    // Sent row preserved untouched.
    const { rows: sentCheck } = await pgAdmin.query<{
      delivery_status: string;
      sent_at: Date | null;
    }>(`SELECT delivery_status, sent_at FROM deadline_notifications WHERE id = $1`, [
      sentNotificationId,
    ]);
    expect(sentCheck[0]!.delivery_status).toBe('sent');
    expect(sentCheck[0]!.sent_at).not.toBeNull();
  });

  it('response shape includes deadline + notifications array', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-shape' });

    const token = await signTestToken({
      pool: 'officine',
      sub: seed.cognitoSub,
      tenantId: seed.tenantId,
      role: 'super_admin',
      locationId: seed.locationId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: { description: 'verifica shape' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Full deadline shape (mirrors POST /deadlines + GET list response).
    expect(body).toMatchObject({
      id: seed.deadlineId,
      tenantId: seed.tenantId,
      locationId: seed.locationId,
      vehicleId: seed.vehicleId,
      interventionTypeId: seed.typeId,
      status: 'open',
      isRecurring: false,
      description: 'verifica shape',
    });
    expect(body.notifications).toBeInstanceOf(Array);
  });

  it('401 unauthenticated: missing Bearer is rejected', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-noauth' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: { 'x-forwarded-for': TEST_IP },
      payload: { description: 'irrilevante' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('403 clienti-pool token rejected by requireOfficinaPool', async () => {
    const seed = await seedOpenDeadlineWithReminders({ tenantSuffix: 'patch-clienti' });

    const clientToken = await signTestToken({
      pool: 'clienti',
      sub: `cust-${randomUUID().slice(0, 8)}`,
      customerId: randomUUID(),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/deadlines/${seed.deadlineId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { description: 'irrilevante' },
    });

    expect(res.statusCode).toBe(403);
  });
});

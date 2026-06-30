import { randomUUID } from 'node:crypto';

import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
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

// F-OFF-401 — POST /v1/vehicles/:vehicleId/deadlines.
//
// Officina creates a deadline on a vehicle and triggers the H3
// scheduler integration: up to 3 EventBridge schedules (T-30, T-7,
// T-0 in Europe/Rome 08:00) are created for forward-looking reminders.
//
// See feedback_integration_test_rate_limit_isolation.md — even though
// this route has no @fastify/rate-limit config today, we use a
// describe-scoped TEST_IP per the convention in interventions-cancel
// to keep buckets isolated if rate-limiting is added later.
const TEST_IP = '10.20.31.1';

describe('POST /v1/vehicles/:vehicleId/deadlines (F-OFF-401)', () => {
  let app: FastifyInstance;

  // SchedulerClient mock — replaces the AWS SDK client used by
  // src/lib/scheduler-client.ts. Required env vars are set so the
  // wrapper passes its pre-flight check before constructing the
  // CreateSchedule command.
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
    // Default: every CreateSchedule succeeds with a synthetic ARN. Tests
    // that need failure semantics override on a per-call basis.
    schedulerMock.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-central-1:123456789012:schedule/garageos-deadlines-test/deadline-test',
    });
  });

  // Helper: dueDate ~120 days in future ensures all 3 reminders (T-30,
  // T-7, T-0) are still in the future relative to "now", so the happy
  // path always gets 3 schedule + 3 notification rows.
  function farFutureDueDate(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  it('201 happy path: creates deadline + 3 notifications + 3 schedules', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
        description: 'Tagliando di prossima scadenza',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      vehicleId: string;
      interventionTypeId: string;
      status: string;
      notifications: Array<{
        id: string;
        scheduledFor: string;
        reminderType: string;
        deliveryStatus: string;
        eventbridgeScheduleArn: string | null;
      }>;
    };
    expect(body.id).toBeTruthy();
    expect(body.vehicleId).toBe(vehicleId);
    expect(body.interventionTypeId).toBe(type.id);
    expect(body.status).toBe('open');
    expect(body.notifications).toHaveLength(3);
    expect(body.notifications.every((n) => n.deliveryStatus === 'pending')).toBe(true);

    // Verify DB has the 3 rows persisted.
    const { rows } = await pgAdmin.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM deadline_notifications WHERE deadline_id = $1`,
      [body.id],
    );
    expect(rows).toHaveLength(3);

    // Verify SchedulerClient.CreateSchedule was invoked 3 times.
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(3);
  });

  it('422 past dueDate: Zod refuses', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: '2020-01-01',
      },
    });

    // Zod-thrown by handler → 400 VALIDATION_ERROR via shared error-handler.
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400 missing interventionTypeId: Zod refuses', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('404 unknown vehicle (RLS-as-404)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${randomUUID()}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('201 cross-tenant vehicle: BR-060 vehicles are globally visible (creates deadline scoped to caller tenant)', async () => {
    // BR-060 / vehicles_read RLS USING(true): any tenant can see any
    // vehicle. The pattern in routes/v1/interventions.ts mirrors this —
    // a workshop can register an intervention/deadline on any vehicle.
    // The deadline row carries tenant B's tenantId (caller tenant), not
    // tenant A's. This is the documented multi-tenant behavior.
    const a = await createTenantWithLocation('rls-a');
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });

    const b = await createTenantWithLocation('rls-b');
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
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { tenantId: string; vehicleId: string };
    expect(body.tenantId).toBe(b.tenantId);
    expect(body.vehicleId).toBe(vehicleId);
  });

  it('422 interventionType from another tenant: app-side filter rejects', async () => {
    // intervention_types SELECT is permissive (PR #60 migration) —
    // see feedback_rls_intervention_types_permissive_read.md. The
    // handler MUST filter app-side; cross-tenant tenant_id != null
    // rows must be rejected.
    const a = await createTenantWithLocation('it-a');
    const aSub = `office-a-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: a.tenantId,
      cognitoSub: aSub,
      role: 'super_admin',
    });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });

    // Seed a tenant-scoped intervention type owned by tenant B.
    const b = await createTenantWithLocation('it-b');
    const { rows: typeRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO intervention_types
         (id, tenant_id, code, name_it, category, suggests_deadline,
          default_deadline_months, default_deadline_km, active,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'CUSTOM_B', 'Custom B',
          'maintenance'::"InterventionTypeCategory", false, NULL, NULL, true,
          NOW(), NOW())
       RETURNING id`,
      [b.tenantId],
    );
    const otherTypeId = typeRows[0]!.id;

    const token = await signTestToken({
      pool: 'officine',
      sub: aSub,
      tenantId: a.tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: otherTypeId,
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string };
    expect(body.code).toBe('deadline.intervention_type.not_found');
  });

  it('201 accepts system intervention types (tenantId IS NULL)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    // ensureSystemInterventionType inserts with tenant_id = NULL.
    const type = await ensureSystemInterventionType('REVISIONE');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('422 sourceInterventionId from a different vehicle', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId: targetVehicleId } = await createVehicle({
      createdByTenantId: tenantId,
    });
    const { vehicleId: otherVehicleId } = await createVehicle({
      createdByTenantId: tenantId,
    });
    // Source intervention belongs to a DIFFERENT vehicle in the same tenant.
    const { interventionId } = await createIntervention({
      tenantId,
      userId,
      vehicleId: otherVehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-01',
      odometerKm: 30000,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${targetVehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
        sourceInterventionId: interventionId,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string };
    expect(body.code).toBe('deadline.source_intervention.invalid');
  });

  it('400 isRecurring=true requires recurringMonths or recurringKm (Zod refine)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
        isRecurring: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('201 partial: marks deliveryStatus=failed when scheduler.CreateSchedule throws (compensating action)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // Override default: every CreateSchedule call rejects.
    schedulerMock.on(CreateScheduleCommand).rejects(new Error('aws unavailable'));

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: farFutureDueDate(),
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['x-garageos-warning']).toBe('scheduler_partial');
    const body = res.json() as {
      id: string;
      notifications: Array<{ deliveryStatus: string }>;
    };
    expect(body.notifications).toHaveLength(3);
    expect(body.notifications.every((n) => n.deliveryStatus === 'failed')).toBe(true);

    // The deadline row itself still committed.
    const { rows } = await pgAdmin.query<{ id: string }>(
      `SELECT id FROM deadlines WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
  });

  it('201 creates only 1 notification when dueDate is 5 days away (T-30, T-7 in past)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    // 5 days from now: T-30 and T-7 windows have already elapsed,
    // so only T-0 should result in a row + a schedule call.
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 5);
    const dueIso = due.toISOString().slice(0, 10);

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload: {
        interventionTypeId: type.id,
        dueDate: dueIso,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      notifications: Array<{ reminderType: string }>;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]!.reminderType).toBe('t_zero');
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(1);
  });

  it('401 unauthenticated: missing Bearer is rejected', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: { 'x-forwarded-for': TEST_IP },
      payload: { interventionTypeId: randomUUID(), dueDate: farFutureDueDate() },
    });

    expect(res.statusCode).toBe(401);
  });

  it('403 clienti-pool token rejected by requireOfficinaPool', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const clientToken = await signTestToken({
      pool: 'clienti',
      sub: `cust-${randomUUID().slice(0, 8)}`,
      customerId: randomUUID(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${vehicleId}/deadlines`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { interventionTypeId: randomUUID(), dueDate: farFutureDueDate() },
    });

    expect(res.statusCode).toBe(403);
  });
});

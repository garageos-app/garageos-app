import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-306 — /v1/me/personal-deadlines CRUD + complete. Exercises the real
// Postgres testcontainer + withContext (role:'user') so the USING(true) RLS
// and the app-layer customerId scoping are verified end-to-end.
describe('Customer personal deadlines (F-CLI-306)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  // An authenticated customer who owns a certified vehicle.
  async function ownerWithVehicle() {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, vehicleId, token };
  }

  async function stranger() {
    const sub = `s-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, token };
  }

  function postDeadline(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/personal-deadlines',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
  }

  async function countReminders(deadlineId: string, deliveryStatus?: string): Promise<number> {
    const { rows } = await pgAdmin.query<{ n: string }>(
      deliveryStatus
        ? `SELECT COUNT(*)::text AS n FROM personal_deadline_reminders
             WHERE personal_deadline_id = $1 AND delivery_status = $2::"NotificationDeliveryStatus"`
        : `SELECT COUNT(*)::text AS n FROM personal_deadline_reminders
             WHERE personal_deadline_id = $1`,
      deliveryStatus ? [deadlineId, deliveryStatus] : [deadlineId],
    );
    return Number(rows[0]!.n);
  }

  it('creates a deadline and materializes reminder rows; dueDate round-trips as YYYY-MM-DD', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    // Far-future date so all three lead reminders (T-30/7/0) are still ahead.
    const res = await postDeadline(token, {
      vehicleId,
      category: 'insurance',
      dueDate: '2099-09-01',
      reminderLeadDays: [30, 7, 0],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.category).toBe('insurance');
    // @db.Date must serialize as a bare date, never a full ISO timestamp.
    expect(body.dueDate).toBe('2099-09-01');
    expect(body.status).toBe('open');

    expect(await countReminders(body.id)).toBe(3);

    // BR-295 (Tier-1): assert the persisted scheduled_for dates, not just the
    // row count. dueDate 2099-09-01 with lead [30,7,0] anchors at the Rome
    // calendar days T-30 / T-7 / T-0. @db.Date stores the calendar day only.
    const sched = await pgAdmin.query<{ d: string }>(
      `SELECT to_char(scheduled_for, 'YYYY-MM-DD') AS d
         FROM personal_deadline_reminders
        WHERE personal_deadline_id = $1
        ORDER BY scheduled_for ASC`,
      [body.id],
    );
    expect(sched.rows.map((r) => r.d)).toEqual(['2099-08-02', '2099-08-25', '2099-09-01']);
  });

  it('returns 403 when the vehicle is not owned by the caller (BR-290)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    const ownerSub = `o-${randomUUID().slice(0, 8)}`;
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    await createOwnership({ vehicleId, customerId: ownerId });

    const { token } = await stranger();
    const res = await postDeadline(token, {
      vehicleId,
      category: 'insurance',
      dueDate: '2099-09-01',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('personal_deadline.vehicle_not_owned');
  });

  it('does not leak another customer deadline via GET/PATCH/DELETE/complete (404)', async () => {
    const owner = await ownerWithVehicle();
    const created = await postDeadline(owner.token, {
      vehicleId: owner.vehicleId,
      category: 'insurance',
      dueDate: '2099-09-01',
    });
    const id = created.json().id;

    const other = await stranger();
    const auth = { authorization: `Bearer ${other.token}` };

    const get = await app.inject({
      method: 'GET',
      url: `/v1/me/personal-deadlines/${id}`,
      headers: auth,
    });
    expect(get.statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/me/personal-deadlines/${id}`,
      headers: auth,
      payload: { notes: 'hack' } as never,
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/me/personal-deadlines/${id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(404);

    const complete = await app.inject({
      method: 'POST',
      url: `/v1/me/personal-deadlines/${id}/complete`,
      headers: auth,
      payload: {} as never,
    });
    expect(complete.statusCode).toBe(404);
  });

  it('lists only the caller deadlines', async () => {
    const owner = await ownerWithVehicle();
    await postDeadline(owner.token, {
      vehicleId: owner.vehicleId,
      category: 'road_tax',
      dueDate: '2099-09-01',
    });

    const other = await stranger();
    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/personal-deadlines',
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(0);

    const ownList = await app.inject({
      method: 'GET',
      url: '/v1/me/personal-deadlines',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(ownList.json().data).toHaveLength(1);
  });

  it('PATCH dueDate regenerates pending reminders, leaving non-pending ones untouched', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    const created = await postDeadline(token, {
      vehicleId,
      category: 'inspection',
      dueDate: '2099-09-01',
      reminderLeadDays: [30, 7, 0],
    });
    const id = created.json().id;
    expect(await countReminders(id, 'pending')).toBe(3);

    // Mark one reminder as already sent — it must survive the regeneration.
    await pgAdmin.query(
      `UPDATE personal_deadline_reminders
         SET delivery_status = 'sent'::"NotificationDeliveryStatus", sent_at = NOW()
       WHERE id = (
         SELECT id FROM personal_deadline_reminders
          WHERE personal_deadline_id = $1 ORDER BY scheduled_for ASC LIMIT 1
       )`,
      [id],
    );
    expect(await countReminders(id, 'sent')).toBe(1);
    expect(await countReminders(id, 'pending')).toBe(2);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/me/personal-deadlines/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { dueDate: '2099-10-01' } as never,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().personalDeadline.dueDate).toBe('2099-10-01');

    // The two pending rows were deleted and re-created (still 2 lead rows for
    // the new date); the sent row is untouched.
    expect(await countReminders(id, 'sent')).toBe(1);
    expect(await countReminders(id, 'pending')).toBe(3);
  });

  it('complete with recurrence returns a renewal suggestion and clears pending reminders', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    const created = await postDeadline(token, {
      vehicleId,
      category: 'service',
      dueDate: '2099-09-01',
      recurrenceMonths: 12,
      reminderLeadDays: [30, 7, 0],
    });
    const id = created.json().id;
    expect(await countReminders(id, 'pending')).toBe(3);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/personal-deadlines/${id}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {} as never,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.personalDeadline.status).toBe('completed');
    expect(body.personalDeadline.completedAt).toBeDefined();
    expect(body.renewalSuggestion).toBeDefined();
    expect(body.renewalSuggestion.suggestedDueDate).toBe('2100-09-01');
    expect(body.renewalSuggestion.recurrenceMonths).toBe(12);

    // Pending reminders are removed on completion.
    expect(await countReminders(id, 'pending')).toBe(0);
  });

  it('complete on a non-open deadline returns 409', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    const created = await postDeadline(token, {
      vehicleId,
      category: 'insurance',
      dueDate: '2099-09-01',
    });
    const id = created.json().id;
    const auth = { authorization: `Bearer ${token}` };

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/me/personal-deadlines/${id}/complete`,
          headers: auth,
          payload: {} as never,
        })
      ).statusCode,
    ).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/me/personal-deadlines/${id}/complete`,
      headers: auth,
      payload: {} as never,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('personal_deadline.not_open');
  });

  it('DELETE cascades reminder rows', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    const created = await postDeadline(token, {
      vehicleId,
      category: 'tires',
      dueDate: '2099-09-01',
      reminderLeadDays: [30, 7, 0],
    });
    const id = created.json().id;
    expect(await countReminders(id)).toBe(3);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/me/personal-deadlines/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    expect(await countReminders(id)).toBe(0);
  });
});

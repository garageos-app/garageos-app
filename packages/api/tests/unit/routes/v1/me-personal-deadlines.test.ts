import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import mePersonalDeadlinesRoutes from '../../../../src/routes/v1/me-personal-deadlines.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const DEADLINE_ID = '44444444-4444-4444-8444-444444444444';

interface FakePrisma {
  vehicle: { findFirst: ReturnType<typeof vi.fn> };
  personalDeadline: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  personalDeadlineReminder: {
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
}

function ownedVehicle() {
  return {
    id: VEHICLE_ID,
    ownerships: [{ customerId: CUSTOMER_ID }],
  };
}

// A full PERSONAL_DEADLINE_SELECT-shaped row for serialize() to consume.
function deadlineRow(over: Record<string, unknown> = {}) {
  return {
    id: DEADLINE_ID,
    vehicleId: VEHICLE_ID,
    category: 'insurance',
    customLabel: null,
    dueDate: new Date('2026-09-01T00:00:00.000Z'),
    recurrenceMonths: null,
    reminderLeadDays: [30, 7, 0],
    reminderDailyTailDays: null,
    notifyPush: true,
    notifyEmail: true,
    status: 'open',
    notes: null,
    completedAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
    vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    ...over,
  };
}

// The minimal-field row the PATCH/complete handlers load for recompute/BR.
function patchLoadRow(over: Record<string, unknown> = {}) {
  return {
    id: DEADLINE_ID,
    category: 'insurance',
    customLabel: null,
    dueDate: new Date('2026-09-01T00:00:00.000Z'),
    reminderLeadDays: [30, 7, 0],
    reminderDailyTailDays: null,
    ...over,
  };
}

function completeLoadRow(over: Record<string, unknown> = {}) {
  return {
    id: DEADLINE_ID,
    status: 'open',
    dueDate: new Date('2026-09-01T00:00:00.000Z'),
    recurrenceMonths: null,
    category: 'insurance',
    customLabel: null,
    reminderLeadDays: [30, 7, 0],
    reminderDailyTailDays: null,
    notifyPush: true,
    notifyEmail: true,
    ...over,
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(ownedVehicle()),
      ...(overrides.vehicle ?? {}),
    },
    personalDeadline: {
      findFirst: vi.fn().mockResolvedValue(deadlineRow()),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
      update: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
      delete: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
      ...(overrides.personalDeadline ?? {}),
    },
    personalDeadlineReminder: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      ...(overrides.personalDeadlineReminder ?? {}),
    },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(mePersonalDeadlinesRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer valid.jwt' };

describe('POST /v1/me/personal-deadlines', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function post(payload: unknown) {
    return app!.inject({
      method: 'POST',
      url: '/v1/me/personal-deadlines',
      headers: AUTH,
      payload: payload as never,
    });
  }

  it('creates a deadline and materializes reminder rows (201)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await post({
      vehicleId: VEHICLE_ID,
      category: 'insurance',
      dueDate: '2026-09-01',
      reminderLeadDays: [30, 7, 0],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('insurance');
    expect(prisma.personalDeadline.create).toHaveBeenCalledTimes(1);
    // 3 lead reminders, all comfortably in the future → 3 rows.
    expect(prisma.personalDeadlineReminder.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.personalDeadlineReminder.createMany.mock.calls[0]![0];
    expect(arg.data).toHaveLength(3);
    expect(
      arg.data.every((r: { personalDeadlineId: string }) => r.personalDeadlineId === DEADLINE_ID),
    ).toBe(true);
    // Ownership/create are scoped to the caller.
    expect(prisma.personalDeadline.create.mock.calls[0]![0].data.customerId).toBe(CUSTOMER_ID);
  });

  it('returns 403 when the vehicle is not owned by the caller', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: VEHICLE_ID, ownerships: [{ customerId: 'someone-else' }] }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({
      vehicleId: VEHICLE_ID,
      category: 'insurance',
      dueDate: '2026-09-01',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('personal_deadline.vehicle_not_owned');
    expect(prisma.personalDeadline.create).not.toHaveBeenCalled();
  });

  it('returns 403 when the vehicle does not exist', async () => {
    const prisma = buildFakePrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    app = await buildApp(prisma);
    const res = await post({
      vehicleId: VEHICLE_ID,
      category: 'insurance',
      dueDate: '2026-09-01',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/personal-deadlines',
      payload: { vehicleId: VEHICLE_ID, category: 'insurance', dueDate: '2026-09-01' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/me/personal-deadlines', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lists the caller deadlines filtered by customerId', async () => {
    const findMany = vi.fn().mockResolvedValue([deadlineRow()]);
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn(),
        findMany,
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/personal-deadlines?status=open',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(findMany.mock.calls[0]![0].where).toEqual({ customerId: CUSTOMER_ID, status: 'open' });
  });
});

describe('GET /v1/me/personal-deadlines/:id', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 for a deadline of another customer', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('personal_deadline.not_found');
  });

  it('returns the deadline when owned', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().personalDeadline.id).toBe(DEADLINE_ID);
  });
});

describe('PATCH /v1/me/personal-deadlines/:id', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function patch(payload: unknown) {
    return app!.inject({
      method: 'PATCH',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}`,
      headers: AUTH,
      payload: payload as never,
    });
  }

  it('returns 422 empty_body for {}', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await patch({});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('personal_deadline.update.empty_body');
  });

  it('regenerates pending reminders when dueDate changes', async () => {
    // findFirst #1 = load minimal row; #2 = refetch full DTO row.
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(patchLoadRow())
      .mockResolvedValueOnce(deadlineRow({ dueDate: new Date('2026-10-01T00:00:00.000Z') }));
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await patch({ dueDate: '2026-10-01' });
    expect(res.statusCode).toBe(200);
    expect(prisma.personalDeadlineReminder.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.personalDeadlineReminder.deleteMany.mock.calls[0]![0].where).toEqual({
      personalDeadlineId: DEADLINE_ID,
      deliveryStatus: 'pending',
    });
    expect(prisma.personalDeadlineReminder.createMany).toHaveBeenCalledTimes(1);
  });

  it('returns 422 custom_label_required when category becomes other without a label', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(patchLoadRow());
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await patch({ category: 'other' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('personal_deadline.custom_label_required');
    expect(prisma.personalDeadline.update).not.toHaveBeenCalled();
  });

  it('returns 404 for another customer deadline', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await patch({ notes: 'ciao' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/me/personal-deadlines/:id', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('deletes and returns 204', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.personalDeadline.delete).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for another customer deadline', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.personalDeadline.delete).not.toHaveBeenCalled();
  });
});

describe('POST /v1/me/personal-deadlines/:id/complete', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function complete() {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/personal-deadlines/${DEADLINE_ID}/complete`,
      headers: AUTH,
      payload: {},
    });
  }

  it('returns 409 when the deadline is not open', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue(completeLoadRow({ status: 'completed' })),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('personal_deadline.not_open');
  });

  it('returns a renewalSuggestion when the deadline recurs', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(completeLoadRow({ recurrenceMonths: 12 }))
      .mockResolvedValueOnce(deadlineRow({ status: 'completed', completedAt: new Date() }));
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await complete();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.renewalSuggestion).toBeDefined();
    // 2026-09-01 + 12 months = 2027-09-01.
    expect(body.renewalSuggestion.suggestedDueDate).toBe('2027-09-01');
    expect(body.renewalSuggestion.recurrenceMonths).toBe(12);
    expect(prisma.personalDeadlineReminder.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('omits renewalSuggestion for a non-recurring deadline', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(completeLoadRow())
      .mockResolvedValueOnce(deadlineRow({ status: 'completed', completedAt: new Date() }));
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: DEADLINE_ID }),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await complete();
    expect(res.statusCode).toBe(200);
    expect(res.json().renewalSuggestion).toBeUndefined();
  });

  it('returns 404 for another customer deadline', async () => {
    const prisma = buildFakePrisma({
      personalDeadline: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await complete();
    expect(res.statusCode).toBe(404);
  });
});

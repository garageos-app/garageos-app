// packages/api/tests/unit/routes/v1/me-private-interventions.test.ts
//
// Stub-based unit tests for /v1/me/private-interventions*. Database is
// faked; goal is wiring smoke (correct withContext call, correct Prisma
// method+args, Zod refine logic). Behavioural coverage (RLS, rate-limit
// math, cursor semantics) lives in the integration suite.
//
// Harness mirrors me-vehicles.test.ts: a FakePrisma interface + a per-test
// buildApp() that injects the fake via databasePlugin options.

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import mePrivateInterventionRoutes from '../../../../src/routes/v1/me-private-interventions.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const PRIVATE_ID = '44444444-4444-4444-8444-444444444444';
const TYPE_ID = '00000000-0000-4000-8000-000000000099';
const CHECKLIST_ITEM_ID_1 = '55555555-5555-4555-8555-555555555501';
const CHECKLIST_ITEM_ID_2 = '55555555-5555-4555-8555-555555555502';

const PRIVATE_ROW = {
  id: PRIVATE_ID,
  vehicleId: VEHICLE_ID,
  interventionDate: new Date('2026-03-10T00:00:00.000Z'),
  odometerKm: 43500,
  customType: 'Olio fai-da-te',
  description: 'desc',
  createdAt: new Date('2026-03-10T12:34:56.000Z'),
  updatedAt: new Date('2026-03-10T12:34:56.000Z'),
  interventionType: null as { id: string; nameIt: string } | null,
  // Task 3: fake rows carry no checklist selections (Tasks 5-6 populate
  // them); serializeChecklistItems requires an array, not undefined.
  checklistSelections: [] as {
    checklistItemId: string | null;
    labelSnapshot: string;
    sortOrderSnapshot: number | null;
  }[],
};

const OWNERSHIP_ROW = { id: 'own-1' };

interface FakePrisma {
  privateIntervention: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  interventionType: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  // Task 5: validateChecklistSelection (called with no tenantId on this
  // customer path) only ever touches interventionChecklistItem.findMany —
  // the two tenant-exclusion tables are skipped when tenantId is absent.
  interventionChecklistItem: {
    findMany: ReturnType<typeof vi.fn>;
  };
  privateInterventionChecklistSelection: {
    createMany: ReturnType<typeof vi.fn>;
  };
}

// Default catalog rows backing interventionChecklistItem.findMany — proof
// that a fresh id in a test payload can be threaded through
// mockImplementation rather than hardcoding a fixed response shape
// (feedback_integration_test_mock_dynamic_input.md).
function buildChecklistItemRows(
  ids: string[],
): { id: string; nameIt: string; sortOrder: number }[] {
  return ids.map((id, idx) => ({ id, nameIt: `Voce ${idx}`, sortOrder: idx }));
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    privateIntervention: {
      findFirst: vi.fn().mockResolvedValue(PRIVATE_ROW),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(PRIVATE_ROW),
      update: vi.fn().mockResolvedValue(PRIVATE_ROW),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
    },
    interventionType: {
      findFirst: vi.fn().mockResolvedValue({ id: 'type-1' }),
    },
    interventionChecklistItem: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
          buildChecklistItemRows(args.where.id.in),
        ),
    },
    privateInterventionChecklistSelection: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
  withContext?: ReturnType<typeof vi.fn>;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const withContext = deps.withContext ?? vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = deps.verifier ?? {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:customer_id': CUSTOMER_ID,
      },
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
  await app.register(mePrivateInterventionRoutes);
  return app;
}

describe('mePrivateInterventionRoutes (unit)', () => {
  let app: FastifyInstance | undefined;
  const AUTH = { authorization: 'Bearer fake' };

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('GET detail calls withContext({ customerId, role: "user" }) + findFirst with scoped where', async () => {
    const prisma = buildFakePrisma();
    const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
    app = await buildApp({ prisma, withContext });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
    expect(prisma.privateIntervention.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PRIVATE_ID,
          customerId: CUSTOMER_ID,
          deletedAt: null,
        }),
      }),
    );
  });

  it('GET detail returns 404 private_intervention.not_found when findFirst returns null', async () => {
    const prisma = buildFakePrisma({
      privateIntervention: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });

  it('GET list calls findMany with compound orderBy and deletedAt filter', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    // Ownership guard must run before the list query — BR-082 on
    // list-per-vehicle. Pinning the call defends against an accidental
    // skip on refactor.
    expect(prisma.vehicleOwnership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
          endedAt: null,
        }),
      }),
    );
    expect(prisma.privateIntervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: CUSTOMER_ID,
          vehicleId: VEHICLE_ID,
          deletedAt: null,
        }),
        orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });

  it('POST refine — both null → 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: null,
        description: 'd',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST refine — both set → 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: '00000000-0000-0000-0000-000000000077',
        custom_type: 'X',
        description: 'd',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST happy path with custom_type returns 201 and calls create', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fai-da-te',
        description: 'd',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(prisma.privateIntervention.create).toHaveBeenCalledTimes(1);
    // Pin every snake_case → camelCase mapping so a typo in any one
    // field (e.g. intervention_type_id → interventionTypeId) is caught
    // at unit-test time, not in production.
    expect(prisma.privateIntervention.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: CUSTOMER_ID,
          vehicleId: VEHICLE_ID,
          interventionTypeId: null,
          customType: 'fai-da-te',
          interventionDate: expect.any(Date),
          odometerKm: null,
          description: 'd',
        }),
      }),
    );
  });

  it('POST catalog type + checklist_item_ids: 201, snapshots via createMany, response echoes checklist_items', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: TYPE_ID,
        custom_type: null,
        description: 'd',
        checklist_item_ids: [CHECKLIST_ITEM_ID_1, CHECKLIST_ITEM_ID_2],
      },
    });

    expect(res.statusCode).toBe(201);
    // interventionChecklistItem.findMany's mockImplementation threads the
    // requested ids back with dynamically-derived nameIt/sortOrder — proves
    // the response is built from that lookup, not a hardcoded fixture.
    expect(prisma.interventionChecklistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [CHECKLIST_ITEM_ID_1, CHECKLIST_ITEM_ID_2] },
          interventionTypeId: TYPE_ID,
          active: true,
        }),
      }),
    );
    expect(prisma.privateInterventionChecklistSelection.createMany).toHaveBeenCalledWith({
      data: [
        {
          privateInterventionId: PRIVATE_ID,
          customerId: CUSTOMER_ID,
          checklistItemId: CHECKLIST_ITEM_ID_1,
          labelSnapshot: 'Voce 0',
          sortOrderSnapshot: 0,
        },
        {
          privateInterventionId: PRIVATE_ID,
          customerId: CUSTOMER_ID,
          checklistItemId: CHECKLIST_ITEM_ID_2,
          labelSnapshot: 'Voce 1',
          sortOrderSnapshot: 1,
        },
      ],
    });
    const body = res.json() as { checklist_items: { id: string | null; label: string }[] };
    expect(body.checklist_items).toEqual([
      { id: CHECKLIST_ITEM_ID_1, label: 'Voce 0' },
      { id: CHECKLIST_ITEM_ID_2, label: 'Voce 1' },
    ]);
  });

  it('POST catalog type + empty checklist_item_ids → 400 intervention.creation.checklist_required (BR-300)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: TYPE_ID,
        custom_type: null,
        description: 'd',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_required' });
    expect(prisma.privateIntervention.create).not.toHaveBeenCalled();
  });

  it('POST catalog type + checklist item from a different type → 422 checklist_item_invalid (BR-301)', async () => {
    const prisma = buildFakePrisma({
      // Catalog lookup returns fewer rows than requested ids — proves the
      // route surfaces validateChecklistSelection's BR-301 membership check.
      interventionChecklistItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: TYPE_ID,
        custom_type: null,
        description: 'd',
        checklist_item_ids: [CHECKLIST_ITEM_ID_1],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    expect(prisma.privateIntervention.create).not.toHaveBeenCalled();
  });

  it('POST custom_type + non-empty checklist_item_ids → 400 (Zod refine)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/vehicles/${VEHICLE_ID}/private-interventions`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        intervention_date: '2026-03-10',
        odometer_km: null,
        intervention_type_id: null,
        custom_type: 'fai-da-te',
        description: 'd',
        checklist_item_ids: [CHECKLIST_ITEM_ID_1],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.privateIntervention.create).not.toHaveBeenCalled();
  });

  it('PATCH 200 calls update with merged data', async () => {
    // The PATCH handler's findFirst uses `select: { id, interventionTypeId,
    // customType }` for the merged-XOR check. The default PRIVATE_ROW omits
    // `interventionTypeId` (undefined), which would collide with the
    // customType-set state and trip the XOR guard → 422. Override the mock
    // findFirst to return a row shaped exactly like the handler's select.
    const prisma = buildFakePrisma({
      privateIntervention: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: PRIVATE_ID, interventionTypeId: null, customType: 'X' }),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(PRIVATE_ROW),
        update: vi.fn().mockResolvedValue(PRIVATE_ROW),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { description: 'updated' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.privateIntervention.findFirst).toHaveBeenCalled();
    expect(prisma.privateIntervention.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PRIVATE_ID },
        data: { description: 'updated' },
      }),
    );
  });

  it('PATCH 404 when findFirst returns null (cross-customer / soft-deleted)', async () => {
    const prisma = buildFakePrisma({
      privateIntervention: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { description: 'updated' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
    expect(prisma.privateIntervention.update).not.toHaveBeenCalled();
  });

  it('DELETE 204 calls updateMany with scoped where + count=1', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(204);
    expect(prisma.privateIntervention.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PRIVATE_ID,
          customerId: CUSTOMER_ID,
          deletedAt: null,
        }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('DELETE 404 when updateMany returns count=0 (idempotency)', async () => {
    const prisma = buildFakePrisma({
      privateIntervention: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/private-interventions/${PRIVATE_ID}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'private_intervention.not_found' });
  });
});

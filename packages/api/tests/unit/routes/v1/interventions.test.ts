import sensible from '@fastify/sensible';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionUpdateRoutes from '../../../../src/routes/v1/interventions-update.js';
import interventionRoutes from '../../../../src/routes/v1/interventions.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const INTERVENTION_TYPE_ID = '77777777-7777-4777-8777-777777777777';
const INTERVENTION_ID = '88888888-8888-4888-8888-888888888888';
const DEADLINE_ID = '99999999-9999-4999-8999-999999999999';
const CHECKLIST_ITEM_ID_1 = '66666666-6666-4666-8666-666666666601';
const CHECKLIST_ITEM_ID_2 = '66666666-6666-4666-8666-666666666602';

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  vehicle: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  tenant: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
  interventionType: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
  interventionChecklistItem: { findMany: ReturnType<typeof vi.fn> };
  tenantInterventionTypeExclusion: { findFirst: ReturnType<typeof vi.fn> };
  tenantChecklistItemExclusion: { findMany: ReturnType<typeof vi.fn> };
  intervention: {
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  interventionChecklistSelection: {
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  interventionRevision: { create: ReturnType<typeof vi.fn> };
  customerTenantRelation: { upsert: ReturnType<typeof vi.fn> };
  deadline: { create: ReturnType<typeof vi.fn> };
  accessLog: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
}

function buildVehicleRow(
  overrides: Partial<{
    status: 'pending' | 'certified' | 'archived';
    registrationDate: Date | null;
    ownerships: Array<{ id: string; customerId: string }>;
  }> = {},
) {
  return {
    id: VEHICLE_ID,
    registrationDate: null as Date | null,
    status: 'certified' as 'pending' | 'certified' | 'archived',
    plate: 'GG123ZZ',
    make: 'Fiat',
    model: 'Panda',
    ownerships: [{ id: 'own-1', customerId: CUSTOMER_ID }] as Array<{
      id: string;
      customerId: string;
    }>,
    ...overrides,
  };
}

function buildInterventionTypeRow(
  overrides: Partial<{
    suggestsDeadline: boolean;
    defaultDeadlineMonths: number | null;
    defaultDeadlineKm: number | null;
  }> = {},
) {
  return {
    id: INTERVENTION_TYPE_ID,
    code: 'MECCANICO',
    nameIt: 'Tagliando',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12 as number | null,
    defaultDeadlineKm: 15000 as number | null,
    ...overrides,
  };
}

function buildInterventionRow() {
  return {
    id: INTERVENTION_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    vehicleId: VEHICLE_ID,
    interventionTypeId: INTERVENTION_TYPE_ID,
    interventionDate: new Date('2026-04-21T00:00:00.000Z'),
    odometerKm: 45000,
    description: 'Sostituzione olio motore 5W30',
    partsReplaced: [],
    internalNotes: null,
    status: 'active' as const,
    kmAnomaly: false,
    wikiLockedAt: null,
    createdAt: new Date('2026-04-21T12:00:00.000Z'),
  };
}

// Default checklist item catalog rows backing
// `interventionChecklistItem.findMany` — deliberately out of sortOrder
// order (item 2 has the lower sortOrder) so tests can prove
// serializeChecklistItems actually reorders rather than passing through
// whatever order Prisma returned.
function buildChecklistItemRows(): { id: string; nameIt: string; sortOrder: number }[] {
  return [
    { id: CHECKLIST_ITEM_ID_1, nameIt: 'Controllo livelli', sortOrder: 1 },
    { id: CHECKLIST_ITEM_ID_2, nameIt: 'Sostituzione olio', sortOrder: 0 },
  ];
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID }),
      // F-OFF-004 follow-ups Item 1: tenant-context reactive status lookup.
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    vehicle: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(buildVehicleRow()),
    },
    vehicleOwnership: {
      // BR-064 dispatcher resolver: default to "no active owner" so the
      // dispatcher early-returns with no SES side effect in unit tests
      // that don't explicitly seed an owner.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    tenant: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: TENANT_ID, businessName: 'Test Tenant' }),
    },
    interventionType: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(buildInterventionTypeRow()),
    },
    interventionChecklistItem: {
      findMany: vi.fn().mockResolvedValue(buildChecklistItemRows()),
    },
    tenantInterventionTypeExclusion: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    tenantChecklistItemExclusion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    intervention: {
      aggregate: vi.fn().mockResolvedValue({ _max: { odometerKm: null } }),
      create: vi.fn().mockResolvedValue(buildInterventionRow()),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValueOnce({
          tenantId: TENANT_ID,
          status: 'active',
          vehicleId: VEHICLE_ID,
          createdAt: new Date(),
          wikiLockedAt: null,
          firstSeenByCustomerAt: null,
          interventionTypeId: INTERVENTION_TYPE_ID,
          title: null,
          description: 'X',
          partsReplaced: [],
          internalNotes: null,
        })
        .mockResolvedValue({
          ...buildInterventionRow(),
          firstSeenByCustomerAt: null,
          updatedAt: new Date(),
          interventionType: {
            id: INTERVENTION_TYPE_ID,
            code: 'MECCANICO',
            nameIt: 'Tagliando',
          },
          // PATCH's reload select (Task 4) always fetches checklistSelections
          // so the response can build `checklistItems`; empty here since the
          // default PATCH tests in this file never send checklistItemIds.
          checklistSelections: [] as { labelSnapshot: string; sortOrderSnapshot: number | null }[],
        }),
      update: vi.fn().mockResolvedValue({}),
    },
    interventionChecklistSelection: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    interventionRevision: {
      create: vi.fn().mockResolvedValue({
        id: 'rev-1',
        revisedAt: new Date(),
        changes: { description: { from: 'X', to: 'Y' } },
        reason: 'Test reason',
      }),
    },
    customerTenantRelation: {
      upsert: vi.fn().mockResolvedValue({ id: 'rel-id' }),
    },
    deadline: {
      create: vi.fn().mockResolvedValue({
        id: DEADLINE_ID,
        dueDate: new Date('2027-04-21'),
        dueOdometerKm: 60000,
        interventionTypeId: INTERVENTION_TYPE_ID,
        status: 'open',
      }),
    },
    accessLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = deps.verifier ?? {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
      },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(interventionRoutes);
  await app.register(interventionUpdateRoutes);
  return app;
}

const validBody = {
  interventionTypeId: INTERVENTION_TYPE_ID,
  interventionDate: '2026-04-21',
  odometerKm: 45000,
  checklistItemIds: [CHECKLIST_ITEM_ID_1, CHECKLIST_ITEM_ID_2],
  description: 'Sostituzione olio motore 5W30 + filtro olio + filtro aria',
  partsReplaced: [
    { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30', quantity: 4, notes: 'Litri' },
  ],
};

describe('POST /v1/vehicles/:id/interventions — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a clienti-pool token', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a non-UUID :id with 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles/not-a-uuid/interventions',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body missing interventionTypeId', async () => {
    app = await buildApp();
    const { interventionTypeId: _drop, ...rest } = validBody;
    void _drop;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
    });
  });

  it('rejects an interventionDate not in YYYY-MM-DD format', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, interventionDate: '21/04/2026' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects partsReplaced entries without a name (BR-071)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, partsReplaced: [{ quantity: 2 }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/vehicles/:id/interventions — preconditions', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 when the vehicle does not exist (Prisma P2025)', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.vehicle.findUniqueOrThrow.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 vehicle.modification.archived for an archived vehicle', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(buildVehicleRow({ status: 'archived' }));
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'vehicle.modification.archived' });
  });

  it('returns 400 date_before_registration when intervention_date < vehicle.registration_date (BR-070)', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(
      buildVehicleRow({ registrationDate: new Date('2026-05-01T00:00:00.000Z') }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, interventionDate: '2026-04-21' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'intervention.creation.date_before_registration',
    });
  });

  it('accepts any past date for historic vehicles (registration_date NULL, BR-070 exemption)', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(buildVehicleRow({ registrationDate: null }));
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, interventionDate: '1970-01-01' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 date_future for a future intervention_date (BR-069)', async () => {
    app = await buildApp({ prisma });
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, interventionDate: futureDate },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.date_future' });
  });

  it('returns 404 when the intervention type does not exist (P2025)', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.interventionType.findUniqueOrThrow.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/vehicles/:id/interventions — BR-068 km validation', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 409 odometer_decrease_warning when km < previous max and forceKmDecrease=false', async () => {
    prisma.intervention.aggregate.mockResolvedValue({ _max: { odometerKm: 50000 } });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, odometerKm: 45000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'intervention.creation.odometer_decrease_warning',
    });
    expect(prisma.intervention.create).not.toHaveBeenCalled();
  });

  it('creates the intervention with kmAnomaly=true when forceKmDecrease=true overrides the warning', async () => {
    prisma.intervention.aggregate.mockResolvedValue({ _max: { odometerKm: 50000 } });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, odometerKm: 45000, forceKmDecrease: true },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.intervention.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kmAnomaly: true }),
      }),
    );
  });

  it('BR-083: ignores private interventions when computing the previous max', async () => {
    // Pre-BR-083: officina max 30k + (mocked) private max 60k → request 25k
    // would have hit 409 odometer_decrease_warning. Post-BR-083: only
    // officina (30k) matters, request 35k > officina max 30k → 201.
    // FakePrisma no longer has `privateIntervention.aggregate`, so any
    // attempt to call it would throw — implicit proof of the BR-083 fix.
    prisma.intervention.aggregate.mockResolvedValue({ _max: { odometerKm: 30000 } });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, odometerKm: 35000 },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.intervention.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kmAnomaly: false }),
      }),
    );
  });

  it('accepts km equal to the previous max (BR-068 is non-decreasing, not strictly increasing)', async () => {
    prisma.intervention.aggregate.mockResolvedValue({ _max: { odometerKm: 45000 } });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, odometerKm: 45000 },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.intervention.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kmAnomaly: false }),
      }),
    );
  });
});

describe('POST /v1/vehicles/:id/interventions — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('inserts the intervention with tenant/user from the JWT and ownership context', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.intervention.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          userId: USER_ID,
          vehicleId: VEHICLE_ID,
          interventionTypeId: INTERVENTION_TYPE_ID,
          odometerKm: validBody.odometerKm,
          description: validBody.description,
        }),
      }),
    );
  });

  it('upserts customer_tenant_relation when the vehicle has a current owner (BR-152)', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_customerId: { tenantId: TENANT_ID, customerId: CUSTOMER_ID } },
        update: {},
        create: expect.objectContaining({ tenantId: TENANT_ID, customerId: CUSTOMER_ID }),
      }),
    );
  });

  it('skips the relation upsert when the vehicle has no active ownership', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(buildVehicleRow({ ownerships: [] }));
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.customerTenantRelation.upsert).not.toHaveBeenCalled();
  });

  it('writes an access_logs row with action=create (BR-154)', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.accessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          tenantId: TENANT_ID,
          userId: USER_ID,
          action: 'create',
        }),
      }),
    );
  });

  it('does not create a deadline when createDeadline is omitted', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.deadline.create).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ deadline: null });
  });

  it('does not create a deadline when createDeadline.enabled=false', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, createDeadline: { enabled: false } },
    });
    expect(prisma.deadline.create).not.toHaveBeenCalled();
  });

  it('creates a deadline with type defaults when createDeadline.enabled=true (BR-080)', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, createDeadline: { enabled: true } },
    });
    expect(prisma.deadline.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          vehicleId: VEHICLE_ID,
          interventionTypeId: INTERVENTION_TYPE_ID,
          sourceInterventionId: INTERVENTION_ID,
          // defaultDeadlineKm=15000 + odometerKm=45000 = 60000.
          dueOdometerKm: 60000,
        }),
      }),
    );
  });

  it('honours createDeadline overrides for monthsFromNow and kmIncrement', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: {
        ...validBody,
        createDeadline: { enabled: true, monthsFromNow: 6, kmIncrement: 8000 },
      },
    });
    const call = prisma.deadline.create.mock.calls[0]?.[0] as {
      data: { dueOdometerKm: number };
    };
    expect(call.data.dueOdometerKm).toBe(45000 + 8000);
  });

  it('skips the deadline insert when both due_date and due_odometer_km would be null', async () => {
    prisma.interventionType.findUniqueOrThrow.mockResolvedValue(
      buildInterventionTypeRow({
        suggestsDeadline: false,
        defaultDeadlineMonths: null,
        defaultDeadlineKm: null,
      }),
    );
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, createDeadline: { enabled: true } },
    });
    expect(prisma.deadline.create).not.toHaveBeenCalled();
  });

  it('returns 201 with intervention + interventionType + checklistItems + deadline:null, no title field', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      intervention: {
        id: string;
        vehicleId: string;
        interventionType: { id: string; code: string; nameIt: string };
        checklistItems: { label: string }[];
        title?: string;
      };
      deadline: unknown;
    };
    expect(body.intervention.id).toBe(INTERVENTION_ID);
    expect(body.intervention.vehicleId).toBe(VEHICLE_ID);
    expect(body.intervention.interventionType).toEqual({
      id: INTERVENTION_TYPE_ID,
      code: 'MECCANICO',
      nameIt: 'Tagliando',
    });
    // BR-303/serializeChecklistItems: sorted by sortOrderSnapshot asc — the
    // catalog rows are deliberately seeded out of order (item 2 has
    // sortOrder 0, item 1 has sortOrder 1) so this proves real reordering.
    expect(body.intervention.checklistItems).toEqual([
      { label: 'Sostituzione olio' },
      { label: 'Controllo livelli' },
    ]);
    expect(body.intervention.title).toBeUndefined();
    expect(body.deadline).toBeNull();
  });

  it('BR-300/BR-303: derives selection createMany label_snapshot/sort_order_snapshot from the catalog lookup, not a hardcoded fixture', async () => {
    // Thread a distinct, dynamically-generated catalog response through
    // interventionChecklistItem.findMany so the assertion below cannot
    // pass against a hardcoded expectation baked into the route
    // (feedback_integration_test_mock_dynamic_input.md).
    const dynamicItemId = '66666666-6666-4666-8666-666666666699';
    const dynamicName = `Voce dinamica ${Math.random().toString(36).slice(2, 8)}`;
    prisma.interventionChecklistItem.findMany.mockImplementation(
      async (args: { where: { id: { in: string[] } } }) => {
        return args.where.id.in.map((id) => ({ id, nameIt: dynamicName, sortOrder: 3 }));
      },
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, checklistItemIds: [dynamicItemId] },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.interventionChecklistSelection.createMany).toHaveBeenCalledWith({
      data: [
        {
          interventionId: INTERVENTION_ID,
          tenantId: TENANT_ID,
          checklistItemId: dynamicItemId,
          labelSnapshot: dynamicName,
          sortOrderSnapshot: 3,
        },
      ],
    });
  });

  it('BR-300: returns 400 checklist_required when checklistItemIds is empty, without creating the intervention', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, checklistItemIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_required' });
    expect(prisma.intervention.create).not.toHaveBeenCalled();
  });

  it('BR-301/302: returns 422 checklist_item_invalid when the catalog lookup does not return all requested ids', async () => {
    prisma.interventionChecklistItem.findMany.mockResolvedValue([
      { id: CHECKLIST_ITEM_ID_1, nameIt: 'Controllo livelli', sortOrder: 1 },
    ]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    expect(prisma.intervention.create).not.toHaveBeenCalled();
  });

  it('BR-302: returns 422 checklist_item_invalid when a selected item is excluded for the tenant', async () => {
    prisma.tenantChecklistItemExclusion.findMany.mockResolvedValue([
      { checklistItemId: CHECKLIST_ITEM_ID_1 },
    ]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    expect(prisma.intervention.create).not.toHaveBeenCalled();
  });

  it('returns 422 checklist_item_invalid when the intervention type itself is excluded for the tenant', async () => {
    prisma.tenantInterventionTypeExclusion.findFirst.mockResolvedValue({ tenantId: TENANT_ID });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'intervention.creation.checklist_item_invalid' });
    expect(prisma.intervention.create).not.toHaveBeenCalled();
  });

  it('dedups a repeated checklistItemId into a single selection row', async () => {
    prisma.interventionChecklistItem.findMany.mockResolvedValue([
      { id: CHECKLIST_ITEM_ID_1, nameIt: 'Controllo livelli', sortOrder: 1 },
    ]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, checklistItemIds: [CHECKLIST_ITEM_ID_1, CHECKLIST_ITEM_ID_1] },
    });
    expect(res.statusCode).toBe(201);
    // Dedup happens before the catalog lookup, so findMany (and thus
    // createMany) only ever sees the single deduped id — proof the
    // handler didn't just pass the raw (duplicated) array through.
    expect(prisma.interventionChecklistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [CHECKLIST_ITEM_ID_1] } }),
      }),
    );
    expect(prisma.interventionChecklistSelection.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ checklistItemId: CHECKLIST_ITEM_ID_1 })],
    });
  });
});

const validPatchBody = { description: 'Aggiornata' };

describe('PATCH /v1/interventions/:id (unit)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a clienti-pool token', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 ZodError when body is empty', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 intervention.modification.cancelled', async () => {
    const prisma = buildFakePrisma();
    prisma.intervention.findUniqueOrThrow = vi.fn().mockResolvedValueOnce({
      tenantId: TENANT_ID,
      status: 'cancelled',
      vehicleId: VEHICLE_ID,
      createdAt: new Date(),
      wikiLockedAt: null,
      firstSeenByCustomerAt: null,
      interventionTypeId: INTERVENTION_TYPE_ID,
      title: null,
      description: 'X',
      partsReplaced: [],
      internalNotes: null,
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('intervention.modification.cancelled');
  });

  it('returns 422 intervention.modification.disputed', async () => {
    const prisma = buildFakePrisma();
    prisma.intervention.findUniqueOrThrow = vi.fn().mockResolvedValueOnce({
      tenantId: TENANT_ID,
      status: 'disputed',
      vehicleId: VEHICLE_ID,
      createdAt: new Date(),
      wikiLockedAt: null,
      firstSeenByCustomerAt: null,
      interventionTypeId: INTERVENTION_TYPE_ID,
      title: null,
      description: 'X',
      partsReplaced: [],
      internalNotes: null,
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('intervention.modification.disputed');
  });

  it('returns 400 revision_reason_required when post-lock without reason', async () => {
    const prisma = buildFakePrisma();
    prisma.intervention.findUniqueOrThrow = vi.fn().mockResolvedValueOnce({
      tenantId: TENANT_ID,
      status: 'active',
      vehicleId: VEHICLE_ID,
      createdAt: new Date(Date.now() - 49 * 3600 * 1000),
      wikiLockedAt: null,
      firstSeenByCustomerAt: null,
      interventionTypeId: INTERVENTION_TYPE_ID,
      title: null,
      description: 'X',
      partsReplaced: [],
      internalNotes: null,
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe(
      'intervention.modification.revision_reason_required',
    );
  });

  it('returns 200 wiki window with no revision', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: validPatchBody,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revision: unknown }).revision).toBeNull();
  });

  it('returns 200 post-lock with reason and creates a revision row', async () => {
    const prisma = buildFakePrisma();
    prisma.intervention.findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce({
        tenantId: TENANT_ID,
        status: 'active',
        vehicleId: VEHICLE_ID,
        createdAt: new Date(Date.now() - 49 * 3600 * 1000),
        wikiLockedAt: null,
        firstSeenByCustomerAt: null,
        interventionTypeId: INTERVENTION_TYPE_ID,
        title: null,
        description: 'X',
        partsReplaced: [],
        internalNotes: null,
      })
      .mockResolvedValueOnce({
        ...buildInterventionRow(),
        firstSeenByCustomerAt: null,
        updatedAt: new Date(),
        interventionType: {
          id: INTERVENTION_TYPE_ID,
          code: 'MECCANICO',
          nameIt: 'Tagliando',
        },
        checklistSelections: [] as { labelSnapshot: string; sortOrderSnapshot: number | null }[],
      });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: { description: 'Y', reason: 'Sufficiently long reason' },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.interventionRevision.create).toHaveBeenCalledOnce();
    expect((res.json() as { revision: { reason: string } | null }).revision).not.toBeNull();
  });

  it('returns 400 checklist_required when changing interventionTypeId without checklistItemIds (Deviation #6)', async () => {
    app = await buildApp();
    const differentTypeId = '77777777-7777-4777-8777-777777777778';
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
      payload: { interventionTypeId: differentTypeId },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('intervention.creation.checklist_required');
  });
});

describe('POST /v1/vehicles/:id/interventions — BR-157 creation notification', () => {
  const sesMock = mockClient(SESv2Client);
  const ORIGINAL_ENV = { ...process.env };
  let app: FastifyInstance | undefined;

  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

  function buildOwnerRow() {
    return {
      customer: {
        id: CUSTOMER_ID,
        email: 'owner@test.it',
        firstName: 'Pippo',
        lastName: 'Baudo',
        isBusiness: false,
        businessName: null,
        notificationPreferences: { email: { intervention_updates: true } },
        status: 'active',
      },
    };
  }

  beforeEach(() => {
    app = undefined;
    sesMock.reset();
    _resetSesClientForTests();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    delete process.env.EMAIL_PROVIDER;
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...ORIGINAL_ENV };
  });

  it('dispatches the created email to the current owner', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm1' });
    const prisma = buildFakePrisma();
    prisma.vehicleOwnership.findFirst.mockResolvedValue(buildOwnerRow());
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0]!.input as {
      Destination?: { ToAddresses?: string[] };
      Content?: { Simple?: { Subject?: { Data?: string } } };
    };
    expect(input.Destination?.ToAddresses).toEqual(['owner@test.it']);
    expect(input.Content?.Simple?.Subject?.Data).toMatch(/nuovo intervento/i);
  });

  it('returns 201 even when the email transport fails (best-effort dispatch)', async () => {
    sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
    const prisma = buildFakePrisma();
    prisma.vehicleOwnership.findFirst.mockResolvedValue(buildOwnerRow());
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.intervention.create).toHaveBeenCalledOnce();
  });

  it('does not fetch the tenant when the vehicle has no active owner', async () => {
    const prisma = buildFakePrisma(); // vehicleOwnership.findFirst defaults to null
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${VEHICLE_ID}/interventions`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

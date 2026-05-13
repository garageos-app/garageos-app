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
};

const OWNERSHIP_ROW = { id: 'own-1' };

interface FakePrisma {
  privateIntervention: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  interventionType: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  attachment: {
    findMany: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    privateIntervention: {
      findFirst: vi.fn().mockResolvedValue(PRIVATE_ROW),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(PRIVATE_ROW),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
    },
    interventionType: {
      findFirst: vi.fn().mockResolvedValue({ id: 'type-1' }),
    },
    attachment: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
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
});

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meVehicleRoutes from '../../../../src/routes/v1/me-vehicles.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const OWNERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

const VEHICLE_ROW = {
  id: VEHICLE_ID,
  garageCode: 'GO-234-ABCD',
  vin: '1M8GDM9AXKP042788',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'car' as const,
  fuelType: 'petrol' as const,
  status: 'certified' as const,
};

const OWNERSHIP_ROW = {
  id: OWNERSHIP_ID,
  startedAt: new Date('2026-01-15T00:00:00Z'),
  vehicle: VEHICLE_ROW,
};

interface FakePrisma {
  vehicleOwnership: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicleOwnership: {
      findMany: vi.fn().mockResolvedValue([OWNERSHIP_ROW]),
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
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
  await app.register(meVehicleRoutes);
  return app;
}

describe('GET /v1/me/vehicles', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns the customer vehicles flattened from active ownerships', async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; currentOwnership: { id: string } }>;
      meta: { has_more: boolean };
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: VEHICLE_ID,
      garageCode: 'GO-234-ABCD',
      currentOwnership: { id: OWNERSHIP_ID },
    });
    expect(body.meta.has_more).toBe(false);
  });

  it('queries vehicle_ownerships filtered by customerId and active ownership', async () => {
    const findMany = vi.fn().mockResolvedValue([OWNERSHIP_ROW]);
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany, findFirst: vi.fn() },
    });
    app = await buildApp({ prisma });

    await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: CUSTOMER_ID, endedAt: null },
        orderBy: { id: 'asc' },
        take: 21,
      }),
    );
  });

  it('paginates with limit + cursor and emits a cursor when has_more is true', async () => {
    // Return 3 rows when limit=2 → has_more=true and the second row's id
    // becomes the next cursor.
    const rows = [
      { ...OWNERSHIP_ROW, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...OWNERSHIP_ROW, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { ...OWNERSHIP_ROW, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany, findFirst: vi.fn() },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles?limit=2',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: unknown[];
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body.data).toHaveLength(2);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeDefined();

    // Round-trip: pass the cursor back, expect prisma cursor + skip.
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles?limit=2&cursor=${body.meta.cursor!}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const lastCall = findMany.mock.calls.at(-1)?.[0] as {
      cursor?: { id: string };
      skip?: number;
    };
    expect(lastCall.cursor?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(lastCall.skip).toBe(1);
  });

  it('returns an empty list when the customer has no active ownerships', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany, findFirst: vi.fn() },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('rejects officine pool tokens with 403', async () => {
    const officineVerifier: JwtVerifier = {
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
    app = await buildApp({ verifier: officineVerifier });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/vehicles' });
    expect(res.statusCode).toBe(401);
  });

  it('invokes withContext with customerId + role: user', async () => {
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma()));
    app = await buildApp({ withContext });

    await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
  });
});

describe('GET /v1/me/vehicles/:id', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns the vehicle detail when the customer owns the vehicle', async () => {
    const detailedVehicle = {
      ...VEHICLE_ROW,
      version: null,
      registrationDate: null,
      engineDisplacement: 1242,
      powerKw: 51,
      color: 'rosso',
      certifiedAt: new Date('2026-01-10T00:00:00Z'),
      createdAt: new Date('2026-01-10T00:00:00Z'),
    };
    const findFirst = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      startedAt: new Date('2026-01-15T00:00:00Z'),
      vehicle: detailedVehicle,
    });
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany: vi.fn(), findFirst },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; engineDisplacement: number };
      currentOwnership: { id: string };
    };
    expect(body.vehicle.id).toBe(VEHICLE_ID);
    expect(body.vehicle.engineDisplacement).toBe(1242);
    expect(body.currentOwnership.id).toBe(OWNERSHIP_ID);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vehicleId: VEHICLE_ID, customerId: CUSTOMER_ID, endedAt: null },
      }),
    );
  });

  it('returns 404 me.vehicle.not_found when the customer does not own the vehicle', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany: vi.fn(), findFirst },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.not_found',
      status: 404,
    });
  });

  it('returns 400 when the path id is not a UUID', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles/not-a-uuid',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects officine pool tokens with 403', async () => {
    const officineVerifier: JwtVerifier = {
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
    app = await buildApp({ verifier: officineVerifier });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

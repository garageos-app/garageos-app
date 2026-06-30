import sensible from '@fastify/sensible';
import { Prisma } from '@garageos/database';
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

// A certified, currently-free vehicle as returned by the claim lookup
// (findFirst selects status + active ownerships for the decision).
const CLAIM_VEHICLE_FREE = {
  id: VEHICLE_ID,
  garageCode: 'GO-234-ABCD',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  plate: 'AB123CD',
  status: 'certified' as const,
  ownerships: [] as Array<{ id: string; customerId: string; startedAt: Date }>,
};

interface FakePrisma {
  vehicle: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  accessLog: {
    findMany: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: {
    findMany: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    vehicleOwnership: {
      findMany: vi.fn().mockResolvedValue([OWNERSHIP_ROW]),
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
      create: vi.fn().mockResolvedValue({
        id: OWNERSHIP_ID,
        startedAt: new Date('2026-06-05T00:00:00Z'),
      }),
    },
    accessLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue([]),
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
      vehicleOwnership: { findMany, findFirst: vi.fn(), create: vi.fn() },
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
      vehicleOwnership: { findMany, findFirst: vi.fn(), create: vi.fn() },
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
      vehicleOwnership: { findMany, findFirst: vi.fn(), create: vi.fn() },
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
      vehicleOwnership: { findMany: vi.fn(), findFirst, create: vi.fn() },
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
      vehicleOwnership: { findMany: vi.fn(), findFirst, create: vi.fn() },
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

describe('GET /v1/me/vehicles/:id/access-log', () => {
  let app: FastifyInstance | undefined;

  const ACCESS_ROW_VIEW = {
    id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    action: 'view',
    createdAt: new Date('2026-06-04T10:00:00.000Z'),
    tenant: { id: TENANT_ID, businessName: 'Officina Rossi' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
  };
  const ACCESS_ROW_CREATE = {
    id: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
    action: 'create',
    createdAt: new Date('2026-06-03T09:00:00.000Z'),
    tenant: { id: TENANT_ID, businessName: 'Officina Rossi' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
  };

  function accessPrisma(rows: unknown[], relations: Array<{ tenantId: string }> = []) {
    return buildFakePrisma({
      vehicleOwnership: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
        create: vi.fn(),
      },
      accessLog: { findMany: vi.fn().mockResolvedValue(rows) },
      customerTenantRelation: { findMany: vi.fn().mockResolvedValue(relations) },
    });
  }

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 me.vehicle.not_found when the customer does not own the vehicle', async () => {
    const prisma = buildFakePrisma({
      vehicleOwnership: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.not_found',
      status: 404,
    });
  });

  it('runs the reads in admin context', async () => {
    const withContext = vi.fn(async (_ctx, fn) => fn(accessPrisma([ACCESS_ROW_VIEW])));
    app = await buildApp({ withContext });
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
  });

  it('filters access_logs to view + create, newest first', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(prisma.accessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          action: { in: ['view', 'create'] },
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });

  it('maps actions and emits the redacted BR-155 shape with mechanicName when related', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW, ACCESS_ROW_CREATE], [{ tenantId: TENANT_ID }]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      action: 'view',
      tenantName: 'Officina Rossi',
      occurredAt: '2026-06-04T10:00:00.000Z',
      mechanicName: 'Mario Bianchi',
    });
    expect(body.data[1]!.action).toBe('new_intervention');
    expect(body.data[0]).not.toHaveProperty('ipAddress');
    expect(body.data[0]).not.toHaveProperty('userId');
    expect(body.data[0]).not.toHaveProperty('tenantId');
  });

  it('omits mechanicName when the customer has no relation with the tenant', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW], []); // empty relation set
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('mechanicName');
  });

  it('paginates with limit + cursor and emits a cursor when has_more is true', async () => {
    const rows = [
      {
        ...ACCESS_ROW_VIEW,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: new Date('2026-06-04T10:00:00.000Z'),
      },
      {
        ...ACCESS_ROW_VIEW,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        createdAt: new Date('2026-06-03T10:00:00.000Z'),
      },
      {
        ...ACCESS_ROW_VIEW,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        createdAt: new Date('2026-06-02T10:00:00.000Z'),
      },
    ];
    const prisma = accessPrisma(rows);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log?limit=2`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const body = res.json() as { data: unknown[]; meta: { has_more: boolean; cursor?: string } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeDefined();

    // Round-trip: the decoded cursor drives the "older than" where predicate.
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log?limit=2&cursor=${body.meta.cursor!}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const lastWhere = (
      prisma.accessLog.findMany.mock.calls.at(-1)?.[0] as { where: { OR?: unknown[] } }
    ).where;
    expect(lastWhere.OR).toBeDefined();
  });
});

describe('POST /v1/me/vehicles/claim', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function claimPrisma(vehicleRow: unknown) {
    return buildFakePrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue(vehicleRow) },
    });
  }

  it('returns 400 when the garage code is malformed', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-012-KXRI' }, // 0/1 digits + I letter: invalid per BR-020
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(401);
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
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 me.vehicle.claim.code_not_found for an unknown code', async () => {
    const prisma = claimPrisma(null);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.code_not_found',
      status: 404,
    });
  });

  it('normalizes the code (trim + uppercase) before the lookup', async () => {
    const prisma = claimPrisma(null);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: '  go-234-abcd  ' },
    });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { garageCode: 'GO-234-ABCD' } }),
    );
  });

  it('returns 422 me.vehicle.claim.pending for a pending vehicle', async () => {
    const prisma = claimPrisma({ ...CLAIM_VEHICLE_FREE, status: 'pending' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.pending',
      status: 422,
    });
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('returns 422 me.vehicle.claim.archived for an archived vehicle', async () => {
    const prisma = claimPrisma({ ...CLAIM_VEHICLE_FREE, status: 'archived' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.archived',
      status: 422,
    });
  });

  it('claims a free certified vehicle: creates ownership, returns status claimed', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE); // ownerships: []
    prisma.vehicleOwnership.create = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; garageCode: string; make: string; status?: string };
      ownership: { id: string; startedAt: string };
      status: string;
    };
    expect(body.status).toBe('claimed');
    expect(body.vehicle).toEqual({
      id: VEHICLE_ID,
      garageCode: 'GO-234-ABCD',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      plate: 'AB123CD',
    });
    // status + ownerships are decision-only, never serialized.
    expect(body.vehicle).not.toHaveProperty('status');
    expect(body.vehicle).not.toHaveProperty('ownerships');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(body.ownership.startedAt).toBe('2026-06-05T12:00:00.000Z');

    expect(prisma.vehicleOwnership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
        }),
        select: { id: true, startedAt: true },
      }),
    );
  });

  it('is idempotent when the caller already owns the vehicle (status already_owned, no create)', async () => {
    const prisma = claimPrisma({
      ...CLAIM_VEHICLE_FREE,
      ownerships: [
        {
          id: OWNERSHIP_ID,
          customerId: CUSTOMER_ID,
          startedAt: new Date('2026-01-15T00:00:00.000Z'),
        },
      ],
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ownership: { id: string; startedAt: string };
      status: string;
    };
    expect(body.status).toBe('already_owned');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(body.ownership.startedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('returns 409 me.vehicle.claim.owned_by_other when another customer owns it', async () => {
    const prisma = claimPrisma({
      ...CLAIM_VEHICLE_FREE,
      ownerships: [
        {
          id: OWNERSHIP_ID,
          customerId: '99999999-9999-4999-8999-999999999999',
          startedAt: new Date('2026-01-15T00:00:00.000Z'),
        },
      ],
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.owned_by_other',
      status: 409,
    });
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  function p2002(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  it('on a concurrent-claim P2002, refetches and returns already_owned if the caller won', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE); // ownerships: [] at read time
    prisma.vehicleOwnership.create = vi.fn().mockRejectedValue(p2002());
    // Refetch sees the now-active ownership belonging to the caller.
    prisma.vehicleOwnership.findFirst = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      customerId: CUSTOMER_ID,
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; ownership: { id: string } };
    expect(body.status).toBe('already_owned');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(prisma.vehicleOwnership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vehicleId: VEHICLE_ID, endedAt: null },
      }),
    );
  });

  it('on a concurrent-claim P2002, returns 409 owned_by_other if another customer won', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE);
    prisma.vehicleOwnership.create = vi.fn().mockRejectedValue(p2002());
    prisma.vehicleOwnership.findFirst = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      customerId: '99999999-9999-4999-8999-999999999999',
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.owned_by_other',
      status: 409,
    });
  });
});

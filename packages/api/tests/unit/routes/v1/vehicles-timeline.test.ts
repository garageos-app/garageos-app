import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleTimelineRoutes from '../../../../src/routes/v1/vehicles-timeline.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const COGNITO_SUB = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const SHOP_INT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP_INT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRIVATE_INT_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SHOP_ROW_1 = {
  id: SHOP_INT_1,
  interventionDate: new Date('2026-04-20T00:00:00Z'),
  odometerKm: 45000,
  title: 'Tagliando completo',
  description: 'Olio + filtri',
  partsReplaced: [{ name: 'olio' }, { name: 'filtro' }, { name: 'aria' }],
  status: 'active' as const,
  tenant: { businessName: 'Officina Rossi' },
  location: { city: 'Milano' },
  interventionType: { code: 'MECCANICO', nameIt: 'Tagliando' },
};
const SHOP_ROW_2_DISPUTED = {
  ...SHOP_ROW_1,
  id: SHOP_INT_2,
  interventionDate: new Date('2026-03-15T00:00:00Z'),
  status: 'disputed' as const,
};
const PRIVATE_ROW_1 = {
  id: PRIVATE_INT_1,
  interventionDate: new Date('2026-04-10T00:00:00Z'),
  odometerKm: 43500,
  customType: 'Rabbocco liquidi',
  description: 'Fai-da-te',
};

interface FakePrisma {
  vehicle: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  intervention: { findMany: ReturnType<typeof vi.fn> };
  privateIntervention: { findMany: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: VEHICLE_ID }) },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'owner-id' }),
    },
    intervention: { findMany: vi.fn().mockResolvedValue([SHOP_ROW_1, SHOP_ROW_2_DISPUTED]) },
    privateIntervention: { findMany: vi.fn().mockResolvedValue([PRIVATE_ROW_1]) },
    user: {
      // F-OFF-004 follow-ups Item 1: tenant-context reactive status lookup.
      findFirst: vi.fn().mockResolvedValue({ id: 'user-uuid' }),
    },
    ...overrides,
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
  withContext?: ReturnType<typeof vi.fn>;
}

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

const clientiVerifier: JwtVerifier = {
  verify: async (): Promise<VerifyResult> => ({
    pool: 'clienti',
    payload: {
      sub: COGNITO_SUB,
      token_use: 'id',
      'custom:customer_id': CUSTOMER_ID,
    },
  }),
};

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const withContext = deps.withContext ?? vi.fn(async (_ctx, fn) => fn(prisma));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', deps.verifier ?? officineVerifier);
  await app.register(vehicleTimelineRoutes);
  return app;
}

describe('GET /v1/vehicles/:id/timeline (officine pool)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns only shop_interventions with derived fields', async () => {
    app = await buildApp({ verifier: officineVerifier });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string; id: string; is_disputed: boolean; parts_replaced_count: number }>;
      meta: { shop_count: number; private_count: number; has_more: boolean };
    };
    expect(body.data.every((d) => d.kind === 'shop_intervention')).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.meta.shop_count).toBe(2);
    expect(body.meta.private_count).toBe(0);

    const disputed = body.data.find((d) => d.id === SHOP_INT_2);
    expect(disputed?.is_disputed).toBe(true);
    const active = body.data.find((d) => d.id === SHOP_INT_1);
    expect(active?.is_disputed).toBe(false);
    expect(active?.parts_replaced_count).toBe(3);
  });

  it('does not query private_interventions for officine pool', async () => {
    const privateFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildFakePrisma({
      privateIntervention: { findMany: privateFindMany },
    });
    app = await buildApp({ verifier: officineVerifier, prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(privateFindMany).not.toHaveBeenCalled();
  });

  it('uses pool-bound role: user (migration 0003 made cross-tenant SELECT permissive)', async () => {
    // Post-migration 0003, the SELECT side of interventions / tenants /
    // locations / intervention_types is cross-tenant readable, so the
    // handler runs with the pool's tenantId and role: 'user' — no admin
    // elevation required.
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma()));
    app = await buildApp({ verifier: officineVerifier, withContext });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', tenantId: expect.any(String) }),
      expect.any(Function),
    );
  });
});

describe('GET /v1/vehicles/:id/timeline (clienti pool)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns merged shop + private when current owner', async () => {
    app = await buildApp({ verifier: clientiVerifier });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ kind: string; id: string; intervention_date: string }>;
      meta: { shop_count: number; private_count: number };
    };
    expect(body.data).toHaveLength(3);
    expect(body.meta.shop_count).toBe(2);
    expect(body.meta.private_count).toBe(1);

    // Order check: 2026-04-20 shop > 2026-04-10 private > 2026-03-15 shop
    expect(body.data[0]!.id).toBe(SHOP_INT_1);
    expect(body.data[1]!.id).toBe(PRIVATE_INT_1);
    expect(body.data[2]!.id).toBe(SHOP_INT_2);
  });

  it('returns 403 vehicle.timeline.not_owner when not the active owner', async () => {
    const ownershipFind = vi.fn().mockResolvedValue(null);
    const prisma = buildFakePrisma({
      vehicleOwnership: { findFirst: ownershipFind },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.timeline.not_owner',
      status: 403,
    });
  });

  it('filters private query to own customerId and deletedAt: null', async () => {
    const privateFindMany = vi.fn().mockResolvedValue([PRIVATE_ROW_1]);
    const prisma = buildFakePrisma({
      privateIntervention: { findMany: privateFindMany },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    const call = privateFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      vehicleId: VEHICLE_ID,
      customerId: CUSTOMER_ID,
      deletedAt: null,
    });
  });

  it('respects type=shop_only — skips the private query', async () => {
    const privateFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildFakePrisma({
      privateIntervention: { findMany: privateFindMany },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?type=shop_only`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(privateFindMany).not.toHaveBeenCalled();
    const body = res.json() as { meta: { private_count: number } };
    expect(body.meta.private_count).toBe(0);
  });

  it('respects type=private_only — skips the intervention query', async () => {
    const shopFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildFakePrisma({
      intervention: { findMany: shopFindMany },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?type=private_only`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(shopFindMany).not.toHaveBeenCalled();
    const body = res.json() as { meta: { shop_count: number } };
    expect(body.meta.shop_count).toBe(0);
  });
});

describe('GET /v1/vehicles/:id/timeline (filters and pagination)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('passes from_date / to_date as a date range to the where clause', async () => {
    const shopFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildFakePrisma({
      intervention: { findMany: shopFindMany },
    });
    app = await buildApp({ verifier: officineVerifier, prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?from_date=2026-01-01&to_date=2026-04-30`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    const call = shopFindMany.mock.calls[0]?.[0] as {
      where: { interventionDate?: { gte?: Date; lte?: Date } };
    };
    expect(call.where.interventionDate?.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(call.where.interventionDate?.lte).toEqual(new Date('2026-04-30T00:00:00.000Z'));
  });

  it('rejects malformed from_date with 400', async () => {
    app = await buildApp({ verifier: officineVerifier });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?from_date=not-a-date`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('emits a cursor and round-trips it as a (date, id) bound', async () => {
    // Page 1: 3 rows from shop (limit=2). has_more = true.
    const rows = [
      { ...SHOP_ROW_1, id: SHOP_INT_1 },
      { ...SHOP_ROW_2_DISPUTED, id: SHOP_INT_2 },
      {
        ...SHOP_ROW_2_DISPUTED,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        interventionDate: new Date('2026-02-01T00:00:00Z'),
      },
    ];
    const shopFindMany = vi.fn().mockResolvedValue(rows);
    const prisma = buildFakePrisma({
      intervention: { findMany: shopFindMany },
    });
    app = await buildApp({ verifier: officineVerifier, prisma });

    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?limit=2`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as {
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.meta.has_more).toBe(true);
    expect(body1.meta.cursor).toBeDefined();

    // Page 2: pass the cursor, expect the where to include OR with
    // (date < lastDate) OR (date = lastDate AND id < lastId).
    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline?limit=2&cursor=${body1.meta.cursor!}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const lastCall = shopFindMany.mock.calls.at(-1)?.[0] as {
      where: { OR?: Array<Record<string, unknown>> };
    };
    expect(lastCall.where.OR).toBeDefined();
    expect(lastCall.where.OR).toHaveLength(2);
  });

  it('returns 404 when the vehicle id does not exist (P2025 from findUniqueOrThrow)', async () => {
    const { Prisma } = await import('@garageos/database');
    const notFound = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const prisma = buildFakePrisma({
      vehicle: { findUniqueOrThrow: vi.fn().mockRejectedValue(notFound) },
    });
    app = await buildApp({ verifier: officineVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/ffffffff-ffff-4fff-8fff-ffffffffffff/timeline',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when Authorization header is missing', async () => {
    app = await buildApp({ verifier: officineVerifier });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/timeline`,
    });
    expect(res.statusCode).toBe(401);
  });
});

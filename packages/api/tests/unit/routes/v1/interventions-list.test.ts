// packages/api/tests/unit/routes/v1/interventions-list.test.ts
//
// Stub-based unit tests for GET /v1/interventions ("Registro Interventi",
// PR-1 task 2 of 4). Database is faked; goal is wiring smoke (correct
// where/orderBy/select shapes, tenant isolation, paging math, response
// mapping). RLS + integration-level behaviour lives in the integration
// suite. Harness mirrors interventions-recent.test.ts.

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionsListRoutes from '../../../../src/routes/v1/interventions-list.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CHECKLIST_ITEM_ID_1 = '55555555-5555-4555-8555-555555555501';
const CHECKLIST_ITEM_ID_2 = '55555555-5555-4555-8555-555555555502';
const TYPE_ID = '00000000-0000-4000-8000-000000000099';

interface FakePrisma {
  user: { findFirst: ReturnType<typeof vi.fn> };
  intervention: {
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(rows: unknown[] = [], total = rows.length): FakePrisma {
  return {
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
      }),
    },
    intervention: {
      count: vi.fn().mockResolvedValue(total),
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const verifier: JwtVerifier = {
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
  const withContext = vi.fn(async (_ctx, fn: (tx: unknown) => unknown) => fn(prisma));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(interventionsListRoutes);
  await app.ready();
  return app;
}

function makeRow(over: {
  id: string;
  interventionDate?: Date;
  odometerKm?: number;
  status?: 'active' | 'disputed' | 'cancelled';
  typeName?: string;
  user?: { id: string; firstName: string | null; lastName: string | null } | null;
  userId?: string;
}): Record<string, unknown> {
  return {
    id: over.id,
    interventionDate: over.interventionDate ?? new Date('2026-03-10T00:00:00.000Z'),
    odometerKm: over.odometerKm ?? 43500,
    status: over.status ?? 'active',
    interventionType: { id: TYPE_ID, nameIt: over.typeName ?? 'Tagliando' },
    userId: over.userId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    vehicle: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
    },
    user:
      over.user === undefined
        ? { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', firstName: 'Giuseppe', lastName: 'Rossi' }
        : over.user,
  };
}

describe('GET /v1/interventions (unit)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('(a) where carries tenantId + default status in count and findMany', async () => {
    const prisma = buildFakePrisma([makeRow({ id: 'i1' })], 1);
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.intervention.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          status: { in: ['active', 'disputed'] },
        }),
      }),
    );
    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          status: { in: ['active', 'disputed'] },
        }),
      }),
    );
  });

  it('(b) checklistItemIds builds an AND array of `some` clauses', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: `/v1/interventions?typeId=${TYPE_ID}&checklistItemIds=${CHECKLIST_ITEM_ID_1},${CHECKLIST_ITEM_ID_2}`,
      headers: { authorization: 'Bearer test' },
    });

    const where = prisma.intervention.findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where['AND']).toEqual([
      { checklistSelections: { some: { checklistItemId: CHECKLIST_ITEM_ID_1 } } },
      { checklistSelections: { some: { checklistItemId: CHECKLIST_ITEM_ID_2 } } },
    ]);
  });

  it('(c) sort=operator orders by user.lastName then user.firstName then id desc', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/interventions?sort=operator&order=asc',
      headers: { authorization: 'Bearer test' },
    });

    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { id: 'desc' }],
      }),
    );
  });

  it('(d) response maps interventionDate to YYYY-MM-DD and falls back operator name to "Operatore"', async () => {
    const prisma = buildFakePrisma(
      [
        makeRow({
          id: 'i1',
          interventionDate: new Date('2026-03-10T00:00:00.000Z'),
          user: { id: 'u1', firstName: null, lastName: null },
        }),
      ],
      1,
    );
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        interventionDate: string;
        operator: { name: string };
      }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.items[0]!.interventionDate).toBe('2026-03-10');
    expect(body.items[0]!.operator.name).toBe('Operatore');
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
  });

  it('(e) page=2, pageSize=10 maps to skip=10, take=10', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/interventions?page=2&pageSize=10',
      headers: { authorization: 'Bearer test' },
    });

    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('(f) empty status="" falls back to the default set (not match-nothing)', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/interventions?status=',
      headers: { authorization: 'Bearer test' },
    });

    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['active', 'disputed'] },
        }),
      }),
    );
  });

  it('(g) q value is escaped for LIKE metacharacters before being passed to contains', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: `/v1/interventions?${new URLSearchParams({ q: '50%' }).toString()}`,
      headers: { authorization: 'Bearer test' },
    });

    const where = prisma.intervention.findMany.mock.calls[0]![0].where as {
      vehicle: { OR: Array<Record<string, { contains: string; mode: string }>> };
    };
    expect(where.vehicle.OR).toEqual([
      { plate: { contains: '50\\%', mode: 'insensitive' } },
      { make: { contains: '50\\%', mode: 'insensitive' } },
      { model: { contains: '50\\%', mode: 'insensitive' } },
    ]);
  });

  it('400 when checklistItemIds is used without exactly one typeId (Zod refine)', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions?checklistItemIds=${CHECKLIST_ITEM_ID_1}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

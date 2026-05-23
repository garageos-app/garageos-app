import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionRecentRoutes, {
  recentQuerySchema,
} from '../../../../src/routes/v1/interventions-recent.js';

describe('recentQuerySchema', () => {
  it('applies default limit=10 when omitted', () => {
    expect(recentQuerySchema.parse({}).limit).toBe(10);
  });

  it('coerces limit string to int', () => {
    expect(recentQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('rejects limit=0', () => {
    expect(() => recentQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above max=50', () => {
    expect(() => recentQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('rejects negative limit', () => {
    expect(() => recentQuerySchema.parse({ limit: -1 })).toThrow();
  });

  it('rejects non-numeric limit', () => {
    expect(() => recentQuerySchema.parse({ limit: 'abc' })).toThrow();
  });
});

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  intervention: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(rows: unknown[] = []): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        role: 'mechanic',
        locationId: '44444444-4444-4444-8444-444444444444',
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
      }),
    },
    intervention: { findMany: vi.fn().mockResolvedValue(rows) },
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
        'custom:location_id': '44444444-4444-4444-8444-444444444444',
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
  await app.register(interventionRecentRoutes);
  await app.ready();
  return app;
}

function makeRow(over: {
  id: string;
  createdAt?: Date;
  status?: 'active' | 'disputed' | 'cancelled';
  title?: string | null;
  description?: string;
  user?: { id: string; firstName: string | null; lastName: string | null } | null;
  userId?: string;
}): Record<string, unknown> {
  return {
    id: over.id,
    createdAt: over.createdAt ?? new Date('2026-05-23T10:00:00.000Z'),
    status: over.status ?? 'active',
    title: over.title ?? null,
    description: over.description ?? 'desc',
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

describe('GET /v1/interventions/recent (unit)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('200 returns items array with default limit=10 applied to take', async () => {
    const prisma = buildFakePrisma([makeRow({ id: 'i1' })]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe('i1');
    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          status: { in: ['active', 'disputed'] },
        }),
      }),
    );
  });

  it('200 honors limit query parameter', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?limit=25',
      headers: { authorization: 'Bearer test' },
    });
    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 }),
    );
  });

  it('400 when limit > 50', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?limit=51',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('summary derives from title when present', async () => {
    const prisma = buildFakePrisma([
      makeRow({ id: 'i1', title: 'Tagliando 60.000 km', description: 'long...' }),
    ]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items[0]!.summary).toBe('Tagliando 60.000 km');
  });

  it('summary derives from description first line (max 100) when title null', async () => {
    const prisma = buildFakePrisma([
      makeRow({
        id: 'i1',
        title: null,
        description: 'Sostituzione pastiglie freno anteriori\nDettagli aggiuntivi non visibili',
      }),
    ]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items[0]!.summary).toBe('Sostituzione pastiglie freno anteriori');
  });

  it('summary truncates description longer than 100 chars to 100 chars', async () => {
    const longText = 'A'.repeat(150);
    const prisma = buildFakePrisma([makeRow({ id: 'i1', title: null, description: longText })]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items[0]!.summary).toHaveLength(100);
  });

  it('operator.name composed from firstName + lastName', async () => {
    const prisma = buildFakePrisma([
      makeRow({
        id: 'i1',
        user: { id: 'u1', firstName: 'Giuseppe', lastName: 'Rossi' },
      }),
    ]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { items: Array<{ operator: { name: string } }> };
    expect(body.items[0]!.operator.name).toBe('Giuseppe Rossi');
  });

  it('operator.name falls back to "Operatore" when user relation is null', async () => {
    const prisma = buildFakePrisma([makeRow({ id: 'i1', user: null, userId: 'deleted-user-id' })]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as {
      items: Array<{ operator: { id: string; name: string } }>;
    };
    expect(body.items[0]!.operator.name).toBe('Operatore');
    expect(body.items[0]!.operator.id).toBe('deleted-user-id');
  });

  it('operator.name falls back to "Operatore" when both firstName and lastName are null', async () => {
    const prisma = buildFakePrisma([
      makeRow({
        id: 'i1',
        user: { id: 'u1', firstName: null, lastName: null },
      }),
    ]);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { items: Array<{ operator: { name: string } }> };
    expect(body.items[0]!.operator.name).toBe('Operatore');
  });

  it('select clause requests vehicle (id, plate, make, model) and user (id, firstName, lastName)', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const call = prisma.intervention.findMany.mock.calls[0]![0] as {
      select: { vehicle: { select: Record<string, true> }; user: { select: Record<string, true> } };
    };
    expect(call.select.vehicle.select).toEqual({
      id: true,
      plate: true,
      make: true,
      model: true,
    });
    expect(call.select.user.select).toEqual({
      id: true,
      firstName: true,
      lastName: true,
    });
  });
});

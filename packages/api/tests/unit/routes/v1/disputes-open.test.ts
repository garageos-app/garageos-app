import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import disputesOpenRoutes from '../../../../src/routes/v1/disputes-open.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '44444444-4444-4444-8444-444444444444';

type StatusFilter = 'open' | { in: Array<'responded' | 'escalated'> };

function whereStatus(args: unknown): StatusFilter {
  return (args as { where: { status: StatusFilter } }).where.status;
}

function isInProgressFilter(status: StatusFilter): boolean {
  return typeof status === 'object' && Array.isArray(status.in);
}

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  interventionDispute: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({
        id: USER_ID,
        role: 'mechanic',
      }),
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    interventionDispute: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    customerTenantRelation: { findMany: vi.fn().mockResolvedValue([]) },
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
        'custom:location_id': LOCATION_ID,
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
  await app.register(disputesOpenRoutes);
  await app.ready();
  return app;
}

describe('GET /v1/disputes/open (unit)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
  });

  it('returns empty groups with count=0 when no disputes exist', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      pendingResponse: { count: 0, items: [] },
      inProgress: { count: 0, items: [] },
    });
  });

  it('issues 2 findMany + 2 count queries (parallel)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });

    expect(prisma.interventionDispute.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.interventionDispute.count).toHaveBeenCalledTimes(2);
  });

  it('pendingResponse uses status = open filter', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });

    const calls = prisma.interventionDispute.findMany.mock.calls;
    const pendingCall = calls.find((c) => whereStatus(c[0]) === 'open');
    expect(pendingCall).toBeDefined();
    const arg = pendingCall![0] as {
      where: { intervention: { tenantId: string }; status: string };
      take: number;
      orderBy: unknown;
    };
    expect(arg.where.intervention.tenantId).toBe(TENANT_ID);
    expect(arg.take).toBe(20);
    expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('inProgress uses status IN (responded, escalated) filter', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);

    await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });

    const calls = prisma.interventionDispute.findMany.mock.calls;
    const inProgressCall = calls.find((c) => isInProgressFilter(whereStatus(c[0])));
    expect(inProgressCall).toBeDefined();
    const status = whereStatus(inProgressCall![0]);
    expect(typeof status === 'object' ? status.in.slice().sort() : null).toEqual([
      'escalated',
      'responded',
    ]);
  });

  it('composes customerName from firstName+lastName for persona-fisica when visible', async () => {
    const prisma = buildFakePrisma();
    const customerId = '55555555-5555-4555-8555-555555555555';
    prisma.interventionDispute.findMany.mockImplementation(async (args: unknown) => {
      if (whereStatus(args) === 'open') {
        return [
          {
            id: '66666666-6666-4666-8666-666666666666',
            interventionId: '77777777-7777-4777-8777-777777777777',
            customerId,
            createdAt: new Date('2026-05-22T09:15:00Z'),
            status: 'open',
            reasonCategory: 'not_performed',
            intervention: { vehicle: { plate: 'AB123CD' } },
            customer: {
              isBusiness: false,
              businessName: null,
              firstName: 'Mario',
              lastName: 'Rossi',
            },
          },
        ];
      }
      return [];
    });
    prisma.interventionDispute.count.mockImplementation(async (args: unknown) =>
      whereStatus(args) === 'open' ? 1 : 0,
    );
    prisma.customerTenantRelation.findMany.mockResolvedValue([{ customerId }]);

    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });

    const body = res.json() as {
      pendingResponse: { items: Array<{ customerName: string; vehicleTarga: string }> };
    };
    expect(body.pendingResponse.items[0]!.customerName).toBe('Mario Rossi');
    expect(body.pendingResponse.items[0]!.vehicleTarga).toBe('AB123CD');
  });

  it('uses businessName for isBusiness customer when visible', async () => {
    const prisma = buildFakePrisma();
    const customerId = '88888888-8888-4888-8888-888888888888';
    prisma.interventionDispute.findMany.mockImplementation(async (args: unknown) => {
      if (whereStatus(args) === 'open') {
        return [
          {
            id: '99999999-9999-4999-8999-999999999999',
            interventionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            customerId,
            createdAt: new Date('2026-05-22T09:15:00Z'),
            status: 'open',
            reasonCategory: 'wrong_data',
            intervention: { vehicle: { plate: 'XY999ZZ' } },
            customer: {
              isBusiness: true,
              businessName: 'Trasporti Bianchi SRL',
              firstName: 'Lucia',
              lastName: 'Bianchi',
            },
          },
        ];
      }
      return [];
    });
    prisma.interventionDispute.count.mockImplementation(async (args: unknown) =>
      whereStatus(args) === 'open' ? 1 : 0,
    );
    prisma.customerTenantRelation.findMany.mockResolvedValue([{ customerId }]);

    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as {
      pendingResponse: { items: Array<{ customerName: string }> };
    };
    expect(body.pendingResponse.items[0]!.customerName).toBe('Trasporti Bianchi SRL');
  });

  it('falls back to "Cliente" when CustomerTenantRelation is missing (BR-151 PII)', async () => {
    const prisma = buildFakePrisma();
    const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    prisma.interventionDispute.findMany.mockImplementation(async (args: unknown) => {
      if (whereStatus(args) === 'open') {
        return [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            interventionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            customerId,
            createdAt: new Date('2026-05-22T09:15:00Z'),
            status: 'open',
            reasonCategory: 'not_performed',
            intervention: { vehicle: { plate: 'AB123CD' } },
            customer: {
              isBusiness: false,
              businessName: null,
              firstName: 'Mario',
              lastName: 'Rossi',
            },
          },
        ];
      }
      return [];
    });
    prisma.interventionDispute.count.mockImplementation(async (args: unknown) =>
      whereStatus(args) === 'open' ? 1 : 0,
    );
    prisma.customerTenantRelation.findMany.mockResolvedValue([]);

    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as {
      pendingResponse: { items: Array<{ customerName: string }> };
    };
    expect(body.pendingResponse.items[0]!.customerName).toBe('Cliente');
  });

  it('exposes status in inProgress items (responded vs escalated)', async () => {
    const prisma = buildFakePrisma();
    prisma.interventionDispute.findMany.mockImplementation(async (args: unknown) => {
      if (isInProgressFilter(whereStatus(args))) {
        return [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            interventionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            customerId: '11111111-2222-4333-8444-555555555555',
            createdAt: new Date('2026-05-20T10:00:00Z'),
            status: 'responded',
            reasonCategory: 'other',
            intervention: { vehicle: { plate: 'ZZ000WW' } },
            customer: {
              isBusiness: false,
              businessName: null,
              firstName: 'Carla',
              lastName: 'Verdi',
            },
          },
        ];
      }
      return [];
    });
    prisma.interventionDispute.count.mockImplementation(async (args: unknown) =>
      isInProgressFilter(whereStatus(args)) ? 1 : 0,
    );

    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as {
      inProgress: { items: Array<{ status: string }> };
    };
    expect(body.inProgress.items[0]!.status).toBe('responded');
  });
});

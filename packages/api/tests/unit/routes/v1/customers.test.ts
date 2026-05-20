import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import customerRoutes from '../../../../src/routes/v1/customers.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

interface FakePrisma {
  customer: { findMany: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    customer: {
      findMany: vi.fn().mockResolvedValue([]),
    },
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
  await app.register(customerRoutes);
  return app;
}

describe('GET /v1/customers/search — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('rejects requests without q', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects q shorter than 2 chars', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=a',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects q longer than 60 chars', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=${'x'.repeat(61)}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit < 1', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar&limit=0',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit > 50', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar&limit=51',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/customers/search?q=mar' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for clienti-pool tokens', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/customers/search — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  function seedRow() {
    return {
      id: CUSTOMER_ID,
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'mario@example.it',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vatNumber: null,
      status: 'active' as const,
    };
  }

  it('returns the DTO shape on a valid query (empty page)', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('passes q + tenantId to the Prisma where clause', async () => {
    prisma.customer.findMany.mockResolvedValueOnce([seedRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    const call = prisma.customer.findMany.mock.calls[0]![0] as {
      where: {
        status: string;
        tenantRelations: { some: { tenantId: string; customerDeleted: boolean } };
        OR: Array<Record<string, unknown>>;
      };
    };
    expect(call.where.status).toBe('active');
    expect(call.where.tenantRelations).toEqual({
      some: { tenantId: TENANT_ID, customerDeleted: false },
    });
    expect(call.where.OR).toEqual([
      { firstName: { contains: 'mar', mode: 'insensitive' } },
      { lastName: { contains: 'mar', mode: 'insensitive' } },
      { businessName: { contains: 'mar', mode: 'insensitive' } },
    ]);
  });

  it('returns has_more=true and a cursor when rows exceed limit', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...seedRow(),
      id: `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    prisma.customer.findMany.mockResolvedValueOnce(rows);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      data: unknown[];
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body.data).toHaveLength(20);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeTruthy();
  });
});

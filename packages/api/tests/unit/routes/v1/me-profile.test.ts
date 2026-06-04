import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meProfileRoutes from '../../../../src/routes/v1/me-profile.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

const CUSTOMER_ROW = {
  id: CUSTOMER_ID,
  email: 'mario.rossi@example.com',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+393331112233',
  status: 'active' as const,
  createdAt: new Date('2026-01-10T00:00:00Z'),
};

interface FakePrisma {
  customer: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma['customer']> = {}): FakePrisma {
  return {
    customer: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(CUSTOMER_ROW),
      update: vi.fn().mockResolvedValue(CUSTOMER_ROW),
      ...overrides,
    },
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
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
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
  await app.register(meProfileRoutes);
  return app;
}

describe('GET /v1/me', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns the projected self profile', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: CUSTOMER_ID,
      email: 'mario.rossi@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+393331112233',
      status: 'active',
      createdAt: '2026-01-10T00:00:00.000Z',
    });
  });

  it('reads under withContext role: user scoped by customerId', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue(CUSTOMER_ROW);
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma({ findUniqueOrThrow })));
    app = await buildApp({ withContext });
    await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
    expect(findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID } }),
    );
  });

  it('rejects officine pool tokens with 403', async () => {
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
    app = await buildApp({ verifier });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /v1/me/profile', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('updates only provided fields under role: admin scoped by id', async () => {
    const update = vi.fn().mockResolvedValue({ ...CUSTOMER_ROW, firstName: 'Marco' });
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma({ update })));
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { firstName: 'Marco' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { firstName: string }).firstName).toBe('Marco');
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID }, data: { firstName: 'Marco' } }),
    );
  });

  it('clears phone when explicitly null', async () => {
    const update = vi.fn().mockResolvedValue({ ...CUSTOMER_ROW, phone: null });
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma({ update })));
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { phone: null },
    });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { phone: null } }));
  });

  it('rejects an empty body with 422 me.profile.update.empty_body', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.profile.update.empty_body',
    });
  });

  it('rejects an unknown field with 422 me.profile.update.unknown_field', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: 'new@example.com' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.profile.update.unknown_field',
    });
  });

  it('rejects an invalid phone with 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { phone: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects officine pool tokens with 403', async () => {
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
    app = await buildApp({ verifier });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { firstName: 'Marco' },
    });
    expect(res.statusCode).toBe(403);
  });
});

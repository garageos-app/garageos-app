import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import userRoutes from '../../../../src/routes/v1/users.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'mechanic@test.garageos.it',
  firstName: 'Giulio',
  lastName: 'Verdi',
  role: 'mechanic' as const,
  tenantId: TENANT_ID,
  locationId: null,
  avatarUrl: null,
  phone: null,
  status: 'active' as const,
  createdAt: new Date('2026-04-20T10:00:00Z'),
};

interface AppDeps {
  verifier?: JwtVerifier;
  findUniqueOrThrow?: ReturnType<typeof vi.fn>;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const findUniqueOrThrow = deps.findUniqueOrThrow ?? vi.fn().mockResolvedValue(USER_ROW);
  const fakePrisma = { user: { findUniqueOrThrow } };
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(fakePrisma));

  const defaultVerifier: JwtVerifier = {
    verify: vi.fn(
      async (): Promise<VerifyResult> => ({
        pool: 'officine',
        payload: {
          sub: COGNITO_SUB,
          token_use: 'id',
          'custom:tenant_id': TENANT_ID,
          'custom:role': 'mechanic',
        },
      }),
    ),
  };

  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: fakePrisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', deps.verifier ?? defaultVerifier);
  await app.register(userRoutes);
  return app;
}

describe('GET /v1/users/me', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns the current user looked up via cognitoSub', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue(USER_ROW);
    app = await buildApp({ findUniqueOrThrow });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(200);
    expect(findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cognitoSub: COGNITO_SUB },
      }),
    );
    expect(res.json()).toMatchObject({
      id: USER_ROW.id,
      email: USER_ROW.email,
      firstName: 'Giulio',
      lastName: 'Verdi',
      role: 'mechanic',
      tenantId: TENANT_ID,
    });
  });

  it('calls the Prisma select with a minimal safe projection', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue(USER_ROW);
    app = await buildApp({ findUniqueOrThrow });

    await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    const call = findUniqueOrThrow.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(call.select).toEqual({
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      tenantId: true,
      locationId: true,
      avatarUrl: true,
      phone: true,
      status: true,
      createdAt: true,
    });
    // Must NOT expose these fields
    expect(call.select).not.toHaveProperty('cognitoSub');
    expect(call.select).not.toHaveProperty('deletedAt');
    expect(call.select).not.toHaveProperty('updatedAt');
    expect(call.select).not.toHaveProperty('lastLoginAt');
  });

  it('returns 401 when Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token comes from clienti pool', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: vi.fn(
        async (): Promise<VerifyResult> => ({
          pool: 'clienti',
          payload: {
            sub: COGNITO_SUB,
            token_use: 'id',
            'custom:customer_id': TENANT_ID,
          },
        }),
      ),
    };
    app = await buildApp({ verifier: clientiVerifier });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('invokes withContext with the tenantId from the JWT', async () => {
    // Spy on the withContext argument — we need a fresh inline fake
    const findUniqueOrThrow = vi.fn().mockResolvedValue(USER_ROW);
    const fakePrisma = { user: { findUniqueOrThrow } };
    const withContextSpy = vi.fn(async (_ctx, fn) => fn(fakePrisma));

    const app2 = Fastify({ logger: false });
    await app2.register(sensible);
    registerErrorHandler(app2);
    await app2.register(databasePlugin, {
      prisma: fakePrisma as never,
      withContext: withContextSpy as never,
    });
    app2.decorate('jwtVerifier', {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'officine',
        payload: {
          sub: COGNITO_SUB,
          token_use: 'id',
          'custom:tenant_id': TENANT_ID,
          'custom:role': 'mechanic',
        },
      }),
    });
    await app2.register(userRoutes);
    app = app2;

    await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(withContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
      expect.any(Function),
    );
  });

  it('maps Prisma P2025 (user not found) to 404 NOT_FOUND', async () => {
    const { Prisma } = await import('@garageos/database');
    const notFoundError = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const findUniqueOrThrow = vi.fn().mockRejectedValue(notFoundError);
    app = await buildApp({ findUniqueOrThrow });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/NOT_FOUND',
      title: 'Resource not found',
      status: 404,
    });
  });
});

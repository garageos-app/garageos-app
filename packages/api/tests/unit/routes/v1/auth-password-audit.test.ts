// Unit tests for the password audit-notify endpoints.
// Pattern: inline FakePrisma + fake withContext + stub jwtVerifier,
// modeled on users-admin-reactivate.test.ts.

import sensible from '@fastify/sensible';
import rateLimitPlugin from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import { authPasswordAuditRoutes } from '../../../../src/routes/v1/auth-password-audit.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const ACTOR_DB_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  user: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(
  over: Partial<{
    findManyRows: Array<{ id: string; tenantId: string }>;
    actorLookupResult: { id: string } | null;
  }> = {},
): FakePrisma {
  const actorLookupResult =
    over.actorLookupResult === undefined ? { id: ACTOR_DB_ID } : over.actorLookupResult;
  return {
    user: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        // tenantContext live-lookup uses status:'active'; always succeeds.
        if (args.where['status'] === 'active') return { id: ACTOR_DB_ID };
        // route actor lookup (cognitoSub + tenantId, no status).
        return actorLookupResult;
      }),
      findMany: vi.fn(async () => over.findManyRows ?? []),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: ACTOR_COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'super_admin',
      },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(rateLimitPlugin, { global: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(authPasswordAuditRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/auth/password-changed', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('204 + writes user_password_changed audit row for the actor', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      headers: { authorization: 'Bearer x' },
      remoteAddress: '10.20.46.1',
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      tenantId: TENANT_ID,
      actorType: 'user',
      actorId: ACTOR_DB_ID,
      action: 'user_password_changed',
      entityType: 'user',
      entityId: ACTOR_DB_ID,
      ipAddress: '10.20.46.1',
    });
  });

  it('401 when no Authorization header', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/password-changed' });
    expect(res.statusCode).toBe(401);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('204 + skips audit row when actor DB row not found', async () => {
    const prisma = buildFakePrisma({ actorLookupResult: null });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      headers: { authorization: 'Bearer x' },
      remoteAddress: '10.20.46.5',
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/password-reset-completed', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('204 + writes one user_password_reset row per matching active user', async () => {
    const prisma = buildFakePrisma({
      findManyRows: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', tenantId: TENANT_ID },
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000002',
          tenantId: '99999999-9999-4999-8999-999999999999',
        },
      ],
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.2',
      payload: { email: 'Mario@Officina.IT' },
    });
    expect(res.statusCode).toBe(204);
    // email normalized to lowercase in the findMany where
    expect(prisma.user.findMany.mock.calls[0]![0].where.email).toBe('mario@officina.it');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const first = prisma.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(first).toMatchObject({
      tenantId: TENANT_ID,
      actorType: 'user',
      actorId: 'aaaaaaaa-0000-4000-8000-000000000001',
      action: 'user_password_reset',
      entityType: 'user',
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      ipAddress: '10.20.46.2',
    });
  });

  it('204 + writes NO rows when no active user matches (anti-enumeration constant response)', async () => {
    const prisma = buildFakePrisma({ findManyRows: [] });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.3',
      payload: { email: 'ghost@nowhere.it' },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('400 on malformed email body', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.4',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

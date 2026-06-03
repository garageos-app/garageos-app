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
  over: Partial<{ findManyRows: Array<{ id: string; tenantId: string }> }> = {},
): FakePrisma {
  return {
    user: {
      // tenantContext live-lookup (status active + deletedAt null) AND the
      // handler actor lookup (cognitoSub + tenantId) both return {id}.
      findFirst: vi.fn(async () => ({ id: ACTOR_DB_ID })),
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
    });
  });

  it('401 when no Authorization header', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/password-changed' });
    expect(res.statusCode).toBe(401);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

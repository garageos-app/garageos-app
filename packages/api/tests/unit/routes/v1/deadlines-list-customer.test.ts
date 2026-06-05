import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import deadlinesListCustomerRoutes from '../../../../src/routes/v1/deadlines-list-customer.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';

interface FakePrisma {
  deadline: { findMany: ReturnType<typeof vi.fn> };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
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
  await app.register(deadlinesListCustomerRoutes);
  return app;
}

describe('GET /v1/me/deadlines — app-layer customer scoping (defense-in-depth)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('filters deadlines to vehicles the customer actively owns, not RLS alone', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    app = await buildApp({ deadline: { findMany } });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const call = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    // The where MUST scope to the caller's active ownership — relying on RLS
    // alone leaked other customers' deadlines in prod (RLS not enforced).
    expect(call.where).toMatchObject({
      vehicle: { ownerships: { some: { customerId: CUSTOMER_ID, endedAt: null } } },
    });
  });

  it('keeps the default open+overdue status filter', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    app = await buildApp({ deadline: { findMany } });
    await app.inject({
      method: 'GET',
      url: '/v1/me/deadlines',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const call = findMany.mock.calls[0]?.[0] as { where: { status?: unknown } };
    expect(call.where.status).toEqual({ in: ['open', 'overdue'] });
  });
});

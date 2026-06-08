import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import tenantsOnboardingRoutes from '../../../../src/routes/v1/tenants-onboarding.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';

interface AppDeps {
  role?: 'super_admin' | 'mechanic';
  findUniqueOrThrow?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}

async function buildApp(
  deps: AppDeps = {},
): Promise<{ app: FastifyInstance; update: ReturnType<typeof vi.fn> }> {
  const findUniqueOrThrow =
    deps.findUniqueOrThrow ?? vi.fn().mockResolvedValue({ settings: { existing: true } });
  const update = deps.update ?? vi.fn().mockResolvedValue({ id: TENANT_ID });
  const fakePrisma = {
    tenant: { findUniqueOrThrow, update },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-uuid' }) },
  };
  const fakeWithContext = vi.fn(async (_ctx: unknown, fn: (p: typeof fakePrisma) => unknown) =>
    fn(fakePrisma),
  );

  const verifier: JwtVerifier = {
    verify: vi.fn(
      async (): Promise<VerifyResult> => ({
        pool: 'officine',
        payload: {
          sub: COGNITO_SUB,
          token_use: 'id',
          'custom:tenant_id': TENANT_ID,
          'custom:role': deps.role ?? 'super_admin',
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
  app.decorate('jwtVerifier', verifier);
  await app.register(tenantsOnboardingRoutes);
  return { app, update };
}

describe('POST /v1/tenants/me/onboarding/complete', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('204: super_admin sets onboardingCompletedAt, preserving existing settings', async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/onboarding/complete',
      // Mirror the browser wire (apiFetch: content-type json + body '{}').
      headers: { authorization: 'Bearer valid.jwt', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    const updateArg = built.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { settings: Record<string, unknown> };
    };
    expect(updateArg.where).toEqual({ id: TENANT_ID });
    expect(updateArg.data.settings.existing).toBe(true);
    expect(typeof updateArg.data.settings.onboardingCompletedAt).toBe('string');
  });

  it('403: mechanic is rejected by requireSuperAdmin', async () => {
    const built = await buildApp({ role: 'mechanic' });
    app = built.app;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/onboarding/complete',
      headers: { authorization: 'Bearer valid.jwt', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(built.update).not.toHaveBeenCalled();
  });

  it('401: missing Authorization header', async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/v1/tenants/me/onboarding/complete' });
    expect(res.statusCode).toBe(401);
  });
});

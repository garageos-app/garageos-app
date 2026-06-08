import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meNotificationPreferencesRoutes from '../../../../src/routes/v1/me-notification-preferences.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';

interface FakePrisma {
  customer: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma['customer']> = {}): FakePrisma {
  return {
    customer: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ notificationPreferences: {} }),
      update: vi.fn().mockResolvedValue({ notificationPreferences: {} }),
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
  await app.register(meNotificationPreferencesRoutes);
  return app;
}

describe('GET /v1/me/notification-preferences', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('projects effective defaults from an empty stored object under role: user', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ notificationPreferences: {} });
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma({ findUniqueOrThrow })));
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
    expect(findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID } }),
    );
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/notification-preferences' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /v1/me/notification-preferences', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('deep-merges supplied keys under role: admin, preserving non-editable keys', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      notificationPreferences: {
        email: { intervention_updates: true, transfer_invitation: true },
        push: { deadline_reminder: true },
      },
    });
    const update = vi.fn().mockResolvedValue({
      notificationPreferences: {
        email: { intervention_updates: true, transfer_invitation: true, marketing: true },
        push: { deadline_reminder: true },
      },
    });
    const withContext = vi.fn(async (_ctx, fn) =>
      fn(buildFakePrisma({ findUniqueOrThrow, update })),
    );
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { marketing: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
    const updateArg = update.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ id: CUSTOMER_ID });
    expect(updateArg.data.notificationPreferences).toEqual({
      email: { intervention_updates: true, transfer_invitation: true, marketing: true },
      push: { deadline_reminder: true },
    });
  });

  it('rejects an empty body with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects {email:{}} with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: {} },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-editable key (transfer_invitation) with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { transfer_invitation: true } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-boolean value with 400 (ZodError, not a business error)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { marketing: 'yes' } },
    });
    // invalid_type is NOT unrecognized_keys, so it falls through to
    // `throw parsed.error` -> error-handler maps ZodError to 400.
    expect(res.statusCode).toBe(400);
  });
});

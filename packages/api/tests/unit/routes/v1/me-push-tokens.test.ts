import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import mePushTokensRoutes from '../../../../src/routes/v1/me-push-tokens.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'ExpoPushToken[abc-123]';

interface FakePrisma {
  pushToken: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  customer: { update: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(over: Partial<FakePrisma['pushToken']> = {}): FakePrisma {
  return {
    pushToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'new-id' }),
      update: vi.fn().mockResolvedValue({ id: 'upd-id' }),
      delete: vi.fn().mockResolvedValue({ id: 'del-id' }),
      ...over,
    },
    customer: { update: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }) },
  };
}

interface AppDeps {
  prisma?: FakePrisma;
  withContext?: ReturnType<typeof vi.fn>;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const withContext = deps.withContext ?? vi.fn(async (_ctx, fn) => fn(prisma));
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
  await app.register(mePushTokensRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer valid.jwt' };

describe('POST /v1/me/push-tokens', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('creates a new token under role:admin and sets appInstalled', async () => {
    const prisma = buildFakePrisma();
    const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
    app = await buildApp({ prisma, withContext });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'android', deviceName: 'Pixel 7' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'new-id' });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
    const createArg = prisma.pushToken.create.mock.calls[0]![0];
    expect(createArg.data).toMatchObject({
      customerId: CUSTOMER_ID,
      expoPushToken: TOKEN,
      platform: 'android',
      deviceName: 'Pixel 7',
      active: true,
    });
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID }, data: { appInstalled: true } }),
    );
  });

  it('branch 1: refreshes and reassigns an existing token row (account switch)', async () => {
    const prisma = buildFakePrisma({
      findUnique: vi.fn().mockResolvedValue({ id: 'existing-token-id' }),
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'ios' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'existing-token-id' });
    const updArg = prisma.pushToken.update.mock.calls[0]![0];
    expect(updArg.where).toEqual({ id: 'existing-token-id' });
    expect(updArg.data).toMatchObject({ customerId: CUSTOMER_ID, active: true });
    expect(prisma.pushToken.create).not.toHaveBeenCalled();
  });

  it('branch 2: rotates the token for the same device (by deviceName)', async () => {
    const prisma = buildFakePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ id: 'device-row-id' }),
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'android', deviceName: 'Pixel 7' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'device-row-id' });
    expect(prisma.pushToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: CUSTOMER_ID, deviceName: 'Pixel 7', active: true },
      }),
    );
    expect(prisma.pushToken.create).not.toHaveBeenCalled();
  });

  it('does not run the device-rotation branch when deviceName is absent', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'ios' },
    });
    expect(prisma.pushToken.findFirst).not.toHaveBeenCalled();
    expect(prisma.pushToken.create).toHaveBeenCalled();
  });

  it('rejects a malformed token with 422 invalid_token', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: 'nope', platform: 'ios' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toContain('me.push-token.register.invalid_token');
  });

  it('rejects an unknown key with 422 unknown_field', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'ios', foo: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toContain('me.push-token.register.unknown_field');
  });

  it('rejects a bad platform with 400 (ZodError)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/push-tokens',
      headers: AUTH,
      payload: { expoPushToken: TOKEN, platform: 'web' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/me/push-tokens', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /v1/me/push-tokens/:id', () => {
  let app: FastifyInstance | undefined;
  const ID = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('deletes the caller-owned token under role:user (204)', async () => {
    const prisma = buildFakePrisma({
      findFirst: vi.fn().mockResolvedValue({ id: ID }),
    });
    const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
    app = await buildApp({ prisma, withContext });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/push-tokens/${ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
    expect(prisma.pushToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, customerId: CUSTOMER_ID } }),
    );
    expect(prisma.pushToken.delete).toHaveBeenCalledWith({ where: { id: ID } });
  });

  it("returns 404 when the token is not the caller's", async () => {
    const prisma = buildFakePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/me/push-tokens/${ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toContain('me.push-token.not_found');
    expect(prisma.pushToken.delete).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID id', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me/push-tokens/not-a-uuid',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });
});

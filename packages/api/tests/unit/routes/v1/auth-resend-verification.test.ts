import sensible from '@fastify/sensible';
import rateLimitPlugin from '@fastify/rate-limit';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';
import { authResendVerificationRoutes } from '../../../../src/routes/v1/auth-resend-verification.js';

const sesMock = mockClient(SESv2Client);

// SES env vars required by sendVerificationEmail. Set unconditionally so the
// post-tx best-effort send branch can resolve in unit tests.
process.env.SES_FROM_ADDRESS ??= 'noreply@garageos.test';
process.env.SES_CONFIGURATION_SET ??= 'test-config-set';

const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeTx {
  customer: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  emailVerification: {
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildFakeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    customer: {
      findFirst: vi.fn().mockResolvedValue({
        id: CUSTOMER_ID,
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
      }),
    },
    emailVerification: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'ev-new' }),
    },
    ...overrides,
  };
}

async function buildAppWithDb(tx: FakeTx): Promise<FastifyInstance> {
  const withContext = vi.fn(async (_ctx: unknown, fn: (t: FakeTx) => Promise<unknown>) => fn(tx));
  const app = Fastify({ logger: false });
  // Mirror server.ts: rate-limit registered with global: false so route opt-in
  // via config.rateLimit fires here. Without it the @fastify/rate-limit config
  // on the route would be a no-op.
  await app.register(rateLimitPlugin, { global: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: {} as never,
    withContext: withContext as never,
  });
  await app.register(authResendVerificationRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/auth/resend-verification — body validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sesMock.reset();
    _resetSesClientForTests();
    app = await buildAppWithDb(buildFakeTx());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 when email is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: {},
      remoteAddress: '10.20.30.1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'not-an-email' },
      remoteAddress: '10.20.30.2',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /v1/auth/resend-verification — anti-enumeration', () => {
  let app: FastifyInstance;
  let tx: FakeTx;

  beforeEach(async () => {
    sesMock.reset();
    _resetSesClientForTests();
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-default' });

    tx = buildFakeTx({
      customer: {
        // No row matching the email — anti-enum branch.
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });
    app = await buildAppWithDb(tx);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 { sent: true } for a non-existent email with no DB write or SES call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'unknown@example.com' },
      remoteAddress: '10.20.30.3',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });

    expect(tx.customer.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.emailVerification.updateMany).not.toHaveBeenCalled();
    expect(tx.emailVerification.create).not.toHaveBeenCalled();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

describe('POST /v1/auth/resend-verification — happy path', () => {
  let app: FastifyInstance;
  let tx: FakeTx;

  beforeEach(async () => {
    sesMock.reset();
    _resetSesClientForTests();
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-default' });

    tx = buildFakeTx();
    app = await buildAppWithDb(tx);
  });

  afterEach(async () => {
    await app.close();
  });

  it('invalidates previous unconsumed tokens before inserting a new one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'mario.rossi@example.com' },
      remoteAddress: '10.20.30.4',
    });

    expect(res.statusCode).toBe(200);

    // updateMany invalidates only consumedAt: null rows for this customer.
    expect(tx.emailVerification.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.emailVerification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: CUSTOMER_ID,
          consumedAt: null,
        }),
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      }),
    );

    // Then a fresh row is created.
    expect(tx.emailVerification.create).toHaveBeenCalledTimes(1);
    expect(tx.emailVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: CUSTOMER_ID,
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: expect.any(Date),
        }),
      }),
    );

    // Ordering: updateMany must precede create.
    const updateOrder = tx.emailVerification.updateMany.mock.invocationCallOrder[0];
    const createOrder = tx.emailVerification.create.mock.invocationCallOrder[0];
    expect(updateOrder).toBeDefined();
    expect(createOrder).toBeDefined();
    expect(updateOrder!).toBeLessThan(createOrder!);
  });

  it('sends the verification email after the DB commit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'mario.rossi@example.com' },
      remoteAddress: '10.20.30.5',
    });

    expect(res.statusCode).toBe(200);

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls).toHaveLength(1);
    const input = sendCalls[0]!.args[0]!.input as {
      Destination?: { ToAddresses?: string[] };
    };
    expect(input.Destination?.ToAddresses).toEqual(['mario.rossi@example.com']);
  });
});

describe('POST /v1/auth/resend-verification — rate limit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sesMock.reset();
    _resetSesClientForTests();
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'mid-default' });

    // Anti-enum branch on every hit (findFirst → null) keeps tests cheap and
    // independent of the happy-path DB flow. The rate limiter sees the route
    // hit regardless of business outcome.
    const tx = buildFakeTx({
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    app = await buildAppWithDb(tx);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 429 auth.resend_verification.rate_limited after 5 calls in 1 minute from same IP', async () => {
    // Memory feedback_integration_test_rate_limit_isolation: distinct IP per
    // describe block so sibling tests don't pollute the bucket.
    const TEST_IP = '10.20.30.99';

    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/resend-verification',
        payload: { email: `t${i}@example.com` },
        remoteAddress: TEST_IP,
      });
      expect(r.statusCode).toBe(200);
    }

    const sixth = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 't6@example.com' },
      remoteAddress: TEST_IP,
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe('auth.resend_verification.rate_limited');
  });
});

import sensible from '@fastify/sensible';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import { _resetCognitoClientForTests } from '../../../../src/lib/cognito.js';
import { hashToken } from '../../../../src/lib/email-verification.js';
import { authVerifyEmailRoutes } from '../../../../src/routes/v1/auth-verify-email.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

// Stable UUIDs reused across tests in this file. v4 / variant 8 to satisfy
// the Zod .uuid() guard on the body.
const TOKEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COGNITO_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_HASH = hashToken(TOKEN);

interface FakeTx {
  emailVerification: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildFakeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    emailVerification: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'ev-1',
        customerId: CUSTOMER_ID,
        tokenHash: TOKEN_HASH,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // +1h
        consumedAt: null,
        createdAt: new Date(Date.now() - 60 * 1000),
      }),
      update: vi.fn().mockResolvedValue({ id: 'ev-1' }),
    },
    customer: {
      findUnique: vi.fn().mockResolvedValue({
        id: CUSTOMER_ID,
        email: 'mario.rossi@example.com',
        cognitoSub: COGNITO_SUB,
      }),
      update: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
    },
    ...overrides,
  };
}

async function buildAppWithDb(tx: FakeTx): Promise<FastifyInstance> {
  const withContext = vi.fn(async (_ctx: unknown, fn: (t: FakeTx) => Promise<unknown>) => fn(tx));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: {} as never,
    withContext: withContext as never,
  });
  await app.register(authVerifyEmailRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/auth/verify-email — body validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
    app = await buildAppWithDb(buildFakeTx());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 when token is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when token is not a UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /v1/auth/verify-email — token lookup error branches', () => {
  let app: FastifyInstance;
  let tx: FakeTx;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 auth.verify_email.token_not_found when row is missing', async () => {
    tx = buildFakeTx({
      emailVerification: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    });
    app = await buildAppWithDb(tx);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: TOKEN },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('auth.verify_email.token_not_found');
    expect(tx.emailVerification.update).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  it('returns 410 auth.verify_email.token_consumed when consumedAt is set', async () => {
    tx = buildFakeTx({
      emailVerification: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ev-1',
          customerId: CUSTOMER_ID,
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          consumedAt: new Date(Date.now() - 60 * 1000),
          createdAt: new Date(Date.now() - 120 * 1000),
        }),
        update: vi.fn(),
      },
    });
    app = await buildAppWithDb(tx);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: TOKEN },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('auth.verify_email.token_consumed');
    expect(tx.emailVerification.update).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  it('returns 410 auth.verify_email.token_expired when expiresAt has passed', async () => {
    tx = buildFakeTx({
      emailVerification: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ev-1',
          customerId: CUSTOMER_ID,
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
          consumedAt: null,
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        }),
        update: vi.fn(),
      },
    });
    app = await buildAppWithDb(tx);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: TOKEN },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('auth.verify_email.token_expired');
    expect(tx.emailVerification.update).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });
});

describe('POST /v1/auth/verify-email — happy path', () => {
  let app: FastifyInstance;
  let tx: FakeTx;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    tx = buildFakeTx();
    app = await buildAppWithDb(tx);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200, marks consumed, flips email_verified, and calls Cognito', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: TOKEN },
    });

    expect(res.statusCode).toBe(200);

    // Token marked consumed
    expect(tx.emailVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ev-1' },
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      }),
    );

    // Customer.email_verified flipped to true
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER_ID },
        data: { emailVerified: true },
      }),
    );

    // Cognito AdminUpdateUserAttributes called with the right shape
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0]?.args[0]?.input).toMatchObject({
      Username: 'mario.rossi@example.com',
      UserAttributes: expect.arrayContaining([{ Name: 'email_verified', Value: 'true' }]),
    });
  });

  it('still returns 200 when Cognito AdminUpdateUserAttributes fails (best-effort)', async () => {
    cognitoMock.reset();
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error('cognito throttled'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: TOKEN },
    });

    expect(res.statusCode).toBe(200);

    // DB updates committed before the Cognito call.
    expect(tx.emailVerification.update).toHaveBeenCalledTimes(1);
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER_ID },
        data: { emailVerified: true },
      }),
    );

    // Cognito attempt was made (and failed silently).
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });
});

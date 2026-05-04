import sensible from '@fastify/sensible';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import { _resetCognitoClientForTests } from '../../../../src/lib/cognito.js';
import { authSignupRoutes } from '../../../../src/routes/v1/auth-signup.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

// ─── Minimal app factory used by validation/auth tests (no DB needed) ──────
let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(authSignupRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/auth/signup — body validation', () => {
  it('returns 400 when type is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'a@b.it', password: 'Secret123', firstName: 'M', lastName: 'R' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'not-an-email',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is shorter than 8 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'short',
        firstName: 'M',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when firstName is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: '',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 auth.signup.tenant_signup_not_supported for type=tenant_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { type: 'tenant_admin', businessName: 'X' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('auth.signup.tenant_signup_not_supported');
  });
});

// ─── Happy path — CREATE customer + Cognito provisioning ────────────────────

const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COGNITO_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface FakeTx {
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function buildFakeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    customer: {
      findUnique: vi.fn().mockResolvedValue(null), // no existing customer
      create: vi.fn().mockResolvedValue({
        id: CUSTOMER_ID,
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: null,
        status: 'active' as const,
        createdAt: new Date('2026-05-04T10:00:00Z'),
      }),
      update: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

async function buildAppWithDb(tx: FakeTx): Promise<FastifyInstance> {
  // withContext is called twice: Phase 1 (tx) + Phase 3 (update cognitoSub).
  // Both calls get the same tx stub.
  const withContext = vi.fn(async (_ctx: unknown, fn: (t: FakeTx) => Promise<unknown>) => fn(tx));
  const appInst = Fastify({ logger: false });
  await appInst.register(sensible);
  registerErrorHandler(appInst);
  await appInst.register(databasePlugin, {
    prisma: {} as never, // not used directly in the route
    withContext: withContext as never,
  });
  await appInst.register(authSignupRoutes);
  await appInst.ready();
  return appInst;
}

describe('POST /v1/auth/signup — CREATE happy path', () => {
  let happyApp: FastifyInstance;
  let tx: FakeTx;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();

    // Phase 2: AdminCreateUser → returns sub; AdminSetUserPassword → ok.
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: {
        Username: 'mario.rossi@example.com',
        Attributes: [
          { Name: 'sub', Value: COGNITO_SUB },
          { Name: 'email', Value: 'mario.rossi@example.com' },
          { Name: 'custom:customer_id', Value: CUSTOMER_ID },
        ],
      },
    });
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    tx = buildFakeTx();
    happyApp = await buildAppWithDb(tx);
  });

  afterEach(async () => {
    await happyApp.close();
  });

  it('returns 201 with customer projection (CREATE branch)', async () => {
    const res = await happyApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'mario.rossi@example.com',
        password: 'Secret123',
        firstName: 'Mario',
        lastName: 'Rossi',
      },
    });

    expect(res.statusCode).toBe(201);

    const body = res.json() as {
      customer: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        phone: string | null;
        status: string;
        createdAt: string;
      };
    };
    expect(body.customer.id).toBe(CUSTOMER_ID);
    expect(body.customer.email).toBe('mario.rossi@example.com');
    expect(body.customer.firstName).toBe('Mario');
    expect(body.customer.lastName).toBe('Rossi');
    expect(body.customer.phone).toBeNull();
    expect(body.customer.status).toBe('active');
    expect(typeof body.customer.createdAt).toBe('string');

    // Phase 1: customer.create called with the right shape
    expect(tx.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'mario.rossi@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          status: 'active',
          appInstalled: true,
        }),
      }),
    );

    // Phase 1: auditLog.create with promoted=false
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'customer',
          action: 'customer_signup',
          entityType: 'customer',
          metadata: expect.objectContaining({ promoted: false }),
        }),
      }),
    );

    // Phase 2: AdminCreateUser called with custom:customer_id matching the new id
    const createCall = cognitoMock.commandCalls(AdminCreateUserCommand)[0];
    expect(createCall?.args[0]?.input).toMatchObject({
      UserAttributes: expect.arrayContaining([{ Name: 'custom:customer_id', Value: CUSTOMER_ID }]),
    });

    // Phase 3: customer.update called with cognitoSub
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER_ID },
        data: { cognitoSub: COGNITO_SUB },
      }),
    );
  });
});

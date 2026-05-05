import sensible from '@fastify/sensible';
import rateLimitPlugin from '@fastify/rate-limit';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import { _resetCognitoClientForTests } from '../../../../src/lib/cognito.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../../../src/lib/notification-preferences.js';
import { authSignupRoutes } from '../../../../src/routes/v1/auth-signup.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

// ─── Minimal app factory used by validation/auth tests (no DB needed) ──────
let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  // Register rate-limit plugin with global: false so it only fires where
  // the route opts in via config.rateLimit. This matches server.ts behaviour.
  // Existing tests are unaffected because none of them opt in.
  await app.register(rateLimitPlugin, { global: false });
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
  // Phase 1 acquires pg_advisory_xact_lock via $queryRawUnsafe before
  // findUnique. The route awaits the call and discards the result, so
  // any settled value works; [] is the cheapest fixture matching the
  // route's <unknown[]> generic.
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
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
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function buildAppWithDb(tx: FakeTx): Promise<FastifyInstance> {
  // withContext is called twice: Phase 1 (tx) + Phase 3 (update cognitoSub).
  // Both calls get the same tx stub.
  const withContext = vi.fn(async (_ctx: unknown, fn: (t: FakeTx) => Promise<unknown>) => fn(tx));
  const appInst = Fastify({ logger: false });
  // Register rate-limit plugin with global: false so it only fires where
  // the route opts in via config.rateLimit. This matches server.ts behaviour.
  await appInst.register(rateLimitPlugin, { global: false });
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

    // Phase 1: customer.create called with the right shape including
    // BR-226 default notification preferences.
    expect(tx.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'mario.rossi@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          status: 'active',
          appInstalled: true,
          notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
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

  it('acquires pg_advisory_xact_lock(hashtext(signup:<email>)) before findUnique (BR-220)', async () => {
    // BR-220 race serialization: Phase 1 must hold an xact-scoped advisory
    // lock keyed on lower(email) BEFORE the findUnique-then-decide read.
    // Without this, two concurrent signups for the same email can both
    // observe a NULL row, both proceed to PROMOTE/CREATE, and produce two
    // 201 responses where one should be 409.
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

    // SQL shape — exact string match on the lock statement.
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))::text',
      'signup:mario.rossi@example.com',
    );

    // Ordering: lock MUST be acquired before findUnique. invocationCallOrder
    // gives a global monotonic sequence across all vi.fn calls in the test.
    const lockOrder = tx.$queryRawUnsafe.mock.invocationCallOrder[0];
    const findOrder = tx.customer.findUnique.mock.invocationCallOrder[0];
    expect(lockOrder).toBeDefined();
    expect(findOrder).toBeDefined();
    expect(lockOrder!).toBeLessThan(findOrder!);
  });
});

// ─── PROMOTE branch — shadow customer with cognitoSub=null ──────────────────

describe('POST /v1/auth/signup — promote shadow', () => {
  let promoteApp: FastifyInstance;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  afterEach(async () => {
    await promoteApp.close();
  });

  it('promotes a shadow customer (cognito_sub=null) and returns 201', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'shadow-uuid',
      email: 'mario@example.it',
      firstName: 'Mario',
      lastName: 'R',
      phone: null,
      status: 'active',
      createdAt: new Date('2026-05-04T09:00:00Z'),
      cognitoSub: null,
      appInstalled: false,
    });
    const update = vi.fn().mockResolvedValue({
      id: 'shadow-uuid',
      email: 'mario@example.it',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+393331111111',
      status: 'active',
      createdAt: new Date('2026-05-04T09:00:00Z'),
    });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-2' });
    const tx = {
      customer: { findUnique, create: vi.fn(), update },
      auditLog: { create: auditCreate },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    const withContext = vi.fn(async (_ctx: unknown, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    promoteApp = Fastify({ logger: false });
    await promoteApp.register(sensible);
    registerErrorHandler(promoteApp);
    await promoteApp.register(databasePlugin, {
      prisma: {} as never,
      withContext: withContext as never,
    });
    await promoteApp.register(authSignupRoutes);
    await promoteApp.ready();

    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: {
        Username: 'mario@example.it',
        Attributes: [{ Name: 'sub', Value: 'cog-sub-2' }],
      },
    });
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    const res = await promoteApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'mario@example.it',
        password: 'Secret123',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: '+393331111111',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shadow-uuid' },
        data: expect.objectContaining({
          firstName: 'Mario',
          lastName: 'Rossi',
          phone: '+393331111111',
          appInstalled: true,
          // BR-226: default notification preferences must be applied on PROMOTE
          // too — shadow rows seeded by an officina carry empty prefs.
          notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ promoted: true }),
        }),
      }),
    );
    // AdminCreateUser called with custom:customer_id pointing at the
    // existing shadow row, not a new uuid
    const adminCreateCall = cognitoMock.commandCalls(AdminCreateUserCommand)[0];
    expect(adminCreateCall?.args[0]?.input?.UserAttributes).toEqual(
      expect.arrayContaining([{ Name: 'custom:customer_id', Value: 'shadow-uuid' }]),
    );
  });
});

// ─── 409 already-active — cognitoSub already set ────────────────────────────

describe('POST /v1/auth/signup — already active', () => {
  let activeApp: FastifyInstance;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  afterEach(async () => {
    await activeApp.close();
  });

  it('returns 409 auth.signup.email_already_active when customer.cognito_sub is set', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'active-uuid',
      email: 'mario@example.it',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: null,
      status: 'active',
      createdAt: new Date('2026-05-04T08:00:00Z'),
      cognitoSub: 'cog-prev',
      appInstalled: true,
    });
    const create = vi.fn();
    const update = vi.fn();
    const auditCreate = vi.fn();
    const tx = {
      customer: { findUnique, create, update },
      auditLog: { create: auditCreate },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    const withContext = vi.fn(async (_ctx: unknown, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    activeApp = Fastify({ logger: false });
    await activeApp.register(sensible);
    registerErrorHandler(activeApp);
    await activeApp.register(databasePlugin, {
      prisma: {} as never,
      withContext: withContext as never,
    });
    await activeApp.register(authSignupRoutes);
    await activeApp.ready();

    const res = await activeApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'mario@example.it',
        password: 'Secret123',
        firstName: 'Mario',
        lastName: 'Rossi',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('auth.signup.email_already_active');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

// ─── 409 in-flight signup (BR-224 alignment) ────────────────────────────────

describe('POST /v1/auth/signup — in-flight signup (BR-224)', () => {
  let inFlightApp: FastifyInstance;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  afterEach(async () => {
    await inFlightApp.close();
  });

  it('returns 409 when existing.appInstalled=true with cognitoSub=null', async () => {
    // BR-224 predicate alignment: a "promotable shadow" requires both
    // cognito_sub IS NULL AND app_installed = false. A row with
    // app_installed=true and cognito_sub=null represents a signup that
    // committed Phase 1 elsewhere (in-flight) or rolled back from Phase 2/3
    // — NOT a shadow. The handler must reject with 409.
    const findUnique = vi.fn().mockResolvedValue({
      id: 'in-flight-uuid',
      email: 'mario@example.it',
      firstName: 'Mario',
      lastName: 'R',
      phone: null,
      status: 'active',
      createdAt: new Date('2026-05-06T10:00:00Z'),
      cognitoSub: null, // Phase 3 not yet committed (in-flight)
      appInstalled: true, // Phase 1 already committed
    });
    const create = vi.fn();
    const update = vi.fn();
    const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-race' });
    const tx = {
      customer: { findUnique, create, update },
      auditLog: { create: auditCreate },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    const withContext = vi.fn(async (_ctx: unknown, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    inFlightApp = Fastify({ logger: false });
    await inFlightApp.register(sensible);
    registerErrorHandler(inFlightApp);
    await inFlightApp.register(databasePlugin, {
      prisma: {} as never,
      withContext: withContext as never,
    });
    await inFlightApp.register(authSignupRoutes);
    await inFlightApp.ready();

    const res = await inFlightApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'mario@example.it',
        password: 'Secret123',
        firstName: 'Mario',
        lastName: 'Rossi',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('auth.signup.email_already_active');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);

    // No audit on 409 race-loss — emission is deferred to a separate PR
    // where it can be wired outside the rollback boundary. See route
    // comment + project_tech_debt.md.
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

// ─── Cognito error branches ──────────────────────────────────────────────────

describe('POST /v1/auth/signup — Cognito errors', () => {
  let cognitoErrApp: FastifyInstance;

  // Standard Prisma stub: no existing customer, create succeeds.
  // Reaches Phase 2 so Cognito mock behaviour determines the outcome.
  async function buildReachPhase2App(): Promise<{
    app: FastifyInstance;
    tx: FakeTx;
  }> {
    cognitoMock.reset();
    _resetCognitoClientForTests();
    const tx = buildFakeTx();
    const inst = await buildAppWithDb(tx);
    return { app: inst, tx };
  }

  afterEach(async () => {
    if (cognitoErrApp) await cognitoErrApp.close();
  });

  it('returns 422 password_policy_violation on AdminCreateUser InvalidPasswordException', async () => {
    const { app: inst } = await buildReachPhase2App();
    cognitoErrApp = inst;
    cognitoMock.on(AdminCreateUserCommand).rejects(
      new InvalidPasswordException({
        message: 'Password does not conform to policy',
        $metadata: {},
      }),
    );

    // Use a payload that passes Zod validation (≥8 chars) so the error
    // originates from Cognito, not from the application-layer schema check.
    const res = await cognitoErrApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'weakpass',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('auth.signup.password_policy_violation');
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  });

  it('returns 409 email_already_active on AdminCreateUser UsernameExistsException', async () => {
    const { app: inst } = await buildReachPhase2App();
    cognitoErrApp = inst;
    cognitoMock
      .on(AdminCreateUserCommand)
      .rejects(
        new UsernameExistsException({ message: 'User account already exists', $metadata: {} }),
      );

    const res = await cognitoErrApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('auth.signup.email_already_active');
  });

  it('rolls back Cognito user on AdminSetUserPassword failure', async () => {
    const { app: inst } = await buildReachPhase2App();
    cognitoErrApp = inst;
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Username: 'a@b.it', Attributes: [{ Name: 'sub', Value: 'cog-x' }] },
    });
    cognitoMock.on(AdminSetUserPasswordCommand).rejects(new Error('throttled'));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    const res = await cognitoErrApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('auth.signup.cognito_unavailable');
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
  });

  it('rolls back + returns 422 password_policy_violation on AdminSetUserPassword InvalidPasswordException', async () => {
    // Spec §7.1 row 8: AdminSetUserPassword fails with InvalidPasswordException
    // → 422 + AdminDeleteUser rollback.
    // Use password 'weakpass' (8 chars) so Zod min(8) passes and the error
    // originates from Cognito, not from the application-layer schema check.
    const { app: inst } = await buildReachPhase2App();
    cognitoErrApp = inst;
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Username: 'a@b.it', Attributes: [{ Name: 'sub', Value: 'cog-pwd-fail' }] },
    });
    cognitoMock
      .on(AdminSetUserPasswordCommand)
      .rejects(new InvalidPasswordException({ message: 'too weak', $metadata: {} }));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    const res = await cognitoErrApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'weakpass',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('auth.signup.password_policy_violation');
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
  });

  it('returns 502 cognito_unavailable on generic AdminCreateUser failure', async () => {
    const { app: inst } = await buildReachPhase2App();
    cognitoErrApp = inst;
    cognitoMock.on(AdminCreateUserCommand).rejects(new Error('throttled'));

    const res = await cognitoErrApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('auth.signup.cognito_unavailable');
  });
});

// ─── Phase 3 best-effort — cognito_sub update failure non-fatal ─────────────

describe('POST /v1/auth/signup — Phase 3 best-effort', () => {
  let phase3App: FastifyInstance;

  afterEach(async () => {
    if (phase3App) await phase3App.close();
  });

  it('returns 201 even when customer.cognito_sub update fails', async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();

    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({
      id: 'c-fail',
      email: 'a@b.it',
      firstName: 'M',
      lastName: 'R',
      phone: null,
      status: 'active' as const,
      createdAt: new Date('2026-05-04T11:00:00Z'),
    });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'a-2' });
    // Phase 3 update rejects — must be non-fatal.
    const update = vi.fn().mockRejectedValue(new Error('phase3 db hiccup'));

    const tx: FakeTx = {
      customer: { findUnique, create, update },
      auditLog: { create: auditCreate },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    phase3App = await buildAppWithDb(tx);

    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'cog-fail' }] },
    });
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    const res = await phase3App.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().customer.id).toBe('c-fail');
    // Phase 3 update was attempted (and failed silently).
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { cognitoSub: 'cog-fail' } }),
    );
  });
});

// ─── Rate limit — 5 calls / 15 minutes per IP ───────────────────────────────

describe('POST /v1/auth/signup — rate limit', () => {
  let rateLimitApp: FastifyInstance;

  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();

    // Use a customer with cognitoSub already set so Phase 1 always
    // returns 409 cheaply — no Cognito calls needed for the first 5 hits.
    const findUnique = vi.fn().mockResolvedValue({
      id: 'a',
      email: 'x@y.it',
      cognitoSub: 'taken',
      firstName: 'A',
      lastName: 'B',
      phone: null,
      status: 'active',
      createdAt: new Date(),
    });
    const tx = {
      customer: { findUnique, create: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };
    rateLimitApp = await buildAppWithDb(tx as unknown as FakeTx);
  });

  afterEach(async () => {
    if (rateLimitApp) await rateLimitApp.close();
  });

  it('returns 429 auth.signup.rate_limited after 5 calls in 15 minutes from same IP', async () => {
    // First 5 requests — rejected by business logic (409), not by rate limiter.
    for (let i = 0; i < 5; i++) {
      const r = await rateLimitApp.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          type: 'customer',
          email: `t${i}@y.it`,
          password: 'Secret123',
          firstName: 'A',
          lastName: 'B',
        },
        remoteAddress: '1.2.3.4',
      });
      expect(r.statusCode).toBe(409);
    }

    // 6th request from the same IP must be rate-limited.
    const sixth = await rateLimitApp.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 't6@y.it',
        password: 'Secret123',
        firstName: 'A',
        lastName: 'B',
      },
      remoteAddress: '1.2.3.4',
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe('auth.signup.rate_limited');
  });
});

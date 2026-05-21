// Unit tests for POST /v1/users/:id/reactivate — F-OFF-004 reactivation.
//
// Pattern: inline FakePrisma + module-mock Cognito via aws-sdk-client-mock,
// modeled on packages/api/tests/unit/routes/v1/customers.test.ts.
//
// Note on user.findFirst sequencing: the tenant-context middleware
// (packages/api/src/middleware/tenant-context.ts) performs a reactive
// `prisma.user.findFirst({where:{cognitoSub, tenantId, status:'active',
// deletedAt:null}})` BEFORE the route handler runs. Then the route makes
// TWO more findFirst calls inside `withContext`: the target lookup and
// the actor-DB-UUID lookup. Tests therefore mock user.findFirst with an
// implementation that branches on the where clause.

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import { _resetCognitoClientForTests } from '../../../../src/lib/cognito.js';
import { usersAdminReactivateRoutes } from '../../../../src/routes/v1/users-admin-reactivate.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const ACTOR_DB_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_ID = '44444444-4444-4444-8444-444444444444';
const LOCATION_ID = '55555555-5555-4555-8555-555555555555';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

interface SoftDeletedUserTarget {
  id: string;
  email: string;
  role: 'super_admin' | 'mechanic';
  locationId: string | null;
  status: 'active' | 'inactive';
  cognitoSub: string;
  deletedAt: Date;
}

interface UpdatedUserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  locationId: string | null;
  status: 'active' | 'inactive';
  phone: string | null;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface FakePrisma {
  user: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  location: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function baseTarget(overrides: Partial<SoftDeletedUserTarget> = {}): SoftDeletedUserTarget {
  return {
    id: TARGET_ID,
    email: 'target@officina.it',
    role: 'mechanic',
    locationId: LOCATION_ID,
    status: 'inactive',
    cognitoSub: 'target-cognito-sub',
    deletedAt: new Date('2026-05-10T12:00:00Z'),
    ...overrides,
  };
}

function baseUpdatedRow(overrides: Partial<UpdatedUserRow> = {}): UpdatedUserRow {
  return {
    id: TARGET_ID,
    email: 'target@officina.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'mechanic',
    locationId: LOCATION_ID,
    status: 'active',
    phone: null,
    avatarUrl: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-05-21T12:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

interface FakePrismaConfig {
  target?: SoftDeletedUserTarget | null;
  updatedRow?: UpdatedUserRow;
  location?: { id: string } | null;
}

function buildFakePrisma(config: FakePrismaConfig = {}): FakePrisma {
  const target = config.target === undefined ? baseTarget() : config.target;
  const updatedRow = config.updatedRow ?? baseUpdatedRow();
  const location = config.location === undefined ? { id: LOCATION_ID } : config.location;

  return {
    user: {
      // findFirst is called THREE times in a happy-path flow:
      //   1. tenantContext middleware: where.cognitoSub + status:'active' + deletedAt:null
      //      → must return {id} so the live-lookup auth check passes
      //   2. route target lookup: where.id + deletedAt: {not: null}
      //      → returns the soft-deleted target (or null for 404 path)
      //   3. route actor-UUID lookup: where.cognitoSub + tenantId (no status filter)
      //      → returns {id: ACTOR_DB_ID}
      // We branch on the shape of the where clause to keep tests robust.
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const where = args.where;
        // tenantContext: status filter present
        if (where['status'] === 'active' && where['deletedAt'] === null) {
          return { id: ACTOR_DB_ID };
        }
        // route target lookup: by id + deletedAt: {not: null}
        if (typeof where['id'] === 'string' && where['deletedAt'] !== undefined) {
          return target;
        }
        // route actor lookup: by cognitoSub + tenantId (no status/deletedAt)
        if (where['cognitoSub'] !== undefined && where['status'] === undefined) {
          return { id: ACTOR_DB_ID };
        }
        return null;
      }),
      update: vi.fn().mockResolvedValue(updatedRow),
    },
    location: {
      findFirst: vi.fn().mockResolvedValue(location),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = deps.verifier ?? {
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
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(usersAdminReactivateRoutes);
  return app;
}

describe('POST /v1/users/:id/reactivate', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  });

  afterEach(async () => {
    await app?.close();
  });

  it('happy path with empty body: 200 + DB update + audit + Cognito enable', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);

    // Verify DB update issued with deletedAt:null + status:'active'
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.user.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateCall.where).toEqual({ id: TARGET_ID });
    expect(updateCall.data).toMatchObject({ deletedAt: null, status: 'active' });
    // No role / locationId override fields present when body is empty
    expect(updateCall.data).not.toHaveProperty('role');
    expect(updateCall.data).not.toHaveProperty('locationId');

    // Verify Cognito AdminEnableUser fired exactly once
    const enableCalls = cognitoMock.commandCalls(AdminEnableUserCommand);
    expect(enableCalls).toHaveLength(1);

    // No attribute sync when no override
    const updateAttrCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(updateAttrCalls).toHaveLength(0);

    // Verify audit log row
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; actorId: string; metadata: Record<string, unknown> };
    };
    expect(auditCall.data.action).toBe('user_reactivated');
    expect(auditCall.data.actorId).toBe(ACTOR_DB_ID);
    expect(auditCall.data.metadata).toMatchObject({
      roleOverridden: false,
      locationOverridden: false,
    });
  });

  it('returns 404 when target is NOT soft-deleted (lookup miss)', async () => {
    const prisma = buildFakePrisma({ target: null });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'user.not_found' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminEnableUserCommand)).toHaveLength(0);
  });

  it('returns 422 user.location_required_for_mechanic when override locationId=null on mechanic', async () => {
    const prisma = buildFakePrisma({
      target: baseTarget({ role: 'mechanic', locationId: LOCATION_ID }),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: { locationId: null },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'user.location_required_for_mechanic' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 422 user.location_invalid when locationId stale (location.findFirst returns null)', async () => {
    const prisma = buildFakePrisma({
      target: baseTarget({ role: 'mechanic', locationId: LOCATION_ID }),
      location: null,
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'user.location_invalid' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('override role+locationId: 200, audit metadata flags, AdminUpdateUserAttributesCommand once', async () => {
    const prisma = buildFakePrisma({
      target: baseTarget({ role: 'mechanic', locationId: LOCATION_ID }),
      updatedRow: baseUpdatedRow({ role: 'super_admin', locationId: null }),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: { role: 'super_admin', locationId: null },
    });

    expect(res.statusCode).toBe(200);

    // The DB update includes both override fields
    const updateCall = prisma.user.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).toMatchObject({
      deletedAt: null,
      status: 'active',
      role: 'super_admin',
      locationId: null,
    });

    // Audit flags set
    const auditCall = prisma.auditLog.create.mock.calls[0]![0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(auditCall.data.metadata).toMatchObject({
      roleOverridden: true,
      locationOverridden: true,
      newRole: 'super_admin',
      newLocationId: null,
    });

    // Cognito attribute sync fired exactly once
    const attrCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(attrCalls).toHaveLength(1);
  });

  it('AdminEnableUser failing with UserNotFoundException still returns 200 (best-effort)', async () => {
    cognitoMock.reset();
    cognitoMock
      .on(AdminEnableUserCommand)
      .rejects(new UserNotFoundException({ message: 'gone', $metadata: {} }));
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: {},
    });

    // enableOfficineUser swallows UserNotFoundException internally
    // (idempotent helper), so no x-cognito-sync-failed header is set.
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when caller is not super_admin', async () => {
    const mechVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'officine',
        payload: {
          sub: ACTOR_COGNITO_SUB,
          token_use: 'id',
          'custom:tenant_id': TENANT_ID,
          'custom:role': 'mechanic',
        },
      }),
    };
    app = await buildApp({ verifier: mechVerifier });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'auth.forbidden.super_admin_required' });
  });
});

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import customerCreateRoutes from '../../../../src/routes/v1/customers-create.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

interface FakePrisma {
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: { upsert: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
}

// Detail row shape projectCustomerDetail expects (CTR filtered to tenant).
function detailRow(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    email: 'mario@example.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: null,
    taxCode: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    addressLine: null,
    city: null,
    province: null,
    postalCode: null,
    cognitoSub: null,
    status: 'active',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    tenantRelations: [
      {
        tenantNotes: null,
        interventionCount: 0,
        firstInterventionAt: null,
        lastInterventionAt: null,
      },
    ],
    ownerships: [],
    ...over,
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    customer: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      create: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      findFirst: vi.fn().mockResolvedValue(detailRow()),
    },
    customerTenantRelation: { upsert: vi.fn().mockResolvedValue({ id: 'ctr-1' }) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-uuid' }) },
    ...overrides,
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
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
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
  await app.register(customerCreateRoutes);
  return app;
}

const VALID = { firstName: 'Mario', lastName: 'Rossi', email: 'mario@example.it' };

function post(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    payload: body as object,
  });
}

describe('POST /v1/customers — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/customers', payload: VALID });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for clienti-pool tokens', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when a required field is missing', async () => {
    app = await buildApp();
    const res = await post(app, { firstName: 'Mario', lastName: 'Rossi' }); // no email
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a malformed email', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 unknown_field for unknown keys', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, status: 'deleted' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.create.unknown_field');
  });

  it('returns 422 when isBusiness is true without businessName', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, isBusiness: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.create.business_name_required');
  });
});

describe('POST /v1/customers — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('creates a new customer + CTR and returns 201 created:true', async () => {
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.id).toBe(CUSTOMER_ID);
    expect(body.email).toBe('mario@example.it');
    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.customerTenantRelation.upsert.mock.calls[0]![0] as {
      where: { tenantId_customerId: { tenantId: string; customerId: string } };
    };
    expect(upsertArg.where.tenantId_customerId).toEqual({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
    });
  });

  it('dedupes by email: existing customer is linked, created:false, no create', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce({ id: CUSTOMER_ID });
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(false);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
  });

  it('handles a P2002 race: refetch by email, link, created:false', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.customer.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(false);
    expect(prisma.customer.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
  });
});

import { Prisma } from '@garageos/database';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meTransfersRoutes from '../../../../src/routes/v1/me-transfers.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  vehicle: { findFirst: ReturnType<typeof vi.fn> };
  vehicleTransfer: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function ownedCertifiedVehicle() {
  return {
    id: VEHICLE_ID,
    status: 'certified',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    ownerships: [{ id: 'own-1', customerId: CUSTOMER_ID }],
  };
}

function createdRow() {
  return {
    id: 'tr-1',
    vehicleId: VEHICLE_ID,
    method: 'initiated_by_seller',
    status: 'pending_recipient',
    transferCode: 'TR-9K4M-7P2X',
    expiresAt: new Date('2026-06-16T00:00:00.000Z'),
    completedAt: null,
    rejectedReason: null,
    createdAt: new Date('2026-06-09T00:00:00.000Z'),
    vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(ownedCertifiedVehicle()),
      ...(overrides.vehicle ?? {}),
    },
    vehicleTransfer: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(createdRow()),
      ...(overrides.vehicleTransfer ?? {}),
    },
  };
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
  await app.register(meTransfersRoutes);
  return app;
}

describe('POST /v1/me/transfers', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function post(payload: unknown) {
    return app!.inject({
      method: 'POST',
      url: '/v1/me/transfers',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: payload as never,
    });
  }

  it('creates a pending_recipient transfer for the active owner', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending_recipient');
    expect(body.method).toBe('physical_code');
    expect(body.transferCode).toBe('TR-9K4M-7P2X');
    const createArg = prisma.vehicleTransfer.create.mock.calls[0]![0];
    expect(createArg.data.fromCustomerId).toBe(CUSTOMER_ID);
    expect(createArg.data.method).toBe('initiated_by_seller');
    expect(createArg.data.status).toBe('pending_recipient');
    expect(createArg.data.expiresAt).toBeInstanceOf(Date);
    const daysOut = (createArg.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('returns 404 when the vehicle does not exist', async () => {
    const prisma = buildFakePrisma({ vehicle: { findFirst: vi.fn().mockResolvedValue(null) } });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the caller is not the active owner', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({
          ...ownedCertifiedVehicle(),
          ownerships: [{ id: 'own-1', customerId: 'someone-else' }],
        }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when the vehicle has no active owner', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ ...ownedCertifiedVehicle(), ownerships: [] }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 422 when the vehicle is not certified', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ ...ownedCertifiedVehicle(), status: 'pending' }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(422);
  });

  it('returns 409 when an active transfer already exists', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an unknown method with 400', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await post({ vehicleId: VEHICLE_ID, method: 'email_invitation' });
    expect(res.statusCode).toBe(400);
  });

  it('retries code generation on a transfer_code P2002 collision', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: ['transfer_code'] },
        }),
      )
      .mockResolvedValueOnce(createdRow());
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when the vehicle is archived', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ ...ownedCertifiedVehicle(), status: 'archived' }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(409);
  });

  it('maps a uq_transfer_vehicle_active P2002 race to 409 without retrying', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('race', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['uq_transfer_vehicle_active'] },
      }),
    );
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('GET /v1/me/transfers', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lists transfers filtered by fromCustomerId', async () => {
    const findMany = vi.fn().mockResolvedValue([createdRow()]);
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn(), findMany, create: vi.fn() },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(findMany.mock.calls[0]![0].where).toEqual({ fromCustomerId: CUSTOMER_ID });
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({ method: 'GET', url: '/v1/me/transfers' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/me/transfers/:id', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns the transfer when owned by the caller', async () => {
    const findFirst = vi.fn().mockResolvedValue(createdRow());
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn() },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers/44444444-4444-4444-8444-444444444444',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.id).toBe('tr-1');
    expect(findFirst.mock.calls[0]![0].where).toEqual(
      expect.objectContaining({ fromCustomerId: CUSTOMER_ID }),
    );
  });

  it('returns 404 for a transfer the caller did not initiate', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers/44444444-4444-4444-8444-444444444444',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
  });
});

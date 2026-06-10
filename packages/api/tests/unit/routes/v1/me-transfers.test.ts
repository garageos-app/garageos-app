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
    updateMany: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    updateMany: ReturnType<typeof vi.fn>;
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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      ...(overrides.vehicleTransfer ?? {}),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'own-new' }),
      ...(overrides.vehicleOwnership ?? {}),
    },
  };
}

function pendingRow(
  over: Partial<ReturnType<typeof createdRow>> & {
    fromCustomerId?: string;
    toCustomerId?: string | null;
  } = {},
) {
  // Default seller is a stranger so a test only triggers the self-accept
  // path when it explicitly sets fromCustomerId to CUSTOMER_ID.
  return {
    ...createdRow(),
    fromCustomerId: 'seller-default',
    toCustomerId: null,
    vehicleId: VEHICLE_ID,
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    ...over,
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
        updateMany: vi.fn(),
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
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create,
        updateMany: vi.fn(),
      },
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
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create,
        updateMany: vi.fn(),
      },
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
      vehicleTransfer: { findFirst: vi.fn(), findMany, create: vi.fn(), updateMany: vi.fn() },
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
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
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
        updateMany: vi.fn(),
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

describe('POST /v1/me/transfers/:code/accept', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function accept(code: string) {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${code}/accept`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
  }

  it('accepts a pending_recipient transfer initiated by another customer', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(
        pendingRow({ fromCustomerId: 'seller-x', status: 'pending_recipient' }),
      )
      .mockResolvedValueOnce({ ...createdRow(), status: 'pending_seller_confirmation' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany },
    });
    app = await buildApp(prisma);
    const res = await accept('TR-9K4M-7P2X');
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('pending_seller_confirmation');
    const arg = updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'tr-1', status: 'pending_recipient' });
    expect(arg.data.toCustomerId).toBe(CUSTOMER_ID);
    expect(arg.data.status).toBe('pending_seller_confirmation');
    const daysOut = (arg.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('returns 404 when the code is unknown', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-0000-0000')).statusCode).toBe(404);
  });

  it('returns 403 when the caller initiated the transfer (self-accept)', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(pendingRow({ fromCustomerId: CUSTOMER_ID })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(403);
  });

  it('returns 409 when the transfer is already completed', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(pendingRow({ fromCustomerId: 'seller-x', status: 'completed' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(409);
  });

  it('returns 422 when the transfer is not pending_recipient', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            pendingRow({ fromCustomerId: 'seller-x', status: 'pending_seller_confirmation' }),
          ),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(422);
  });

  it('returns 410 when the transfer has expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(
          pendingRow({
            fromCustomerId: 'seller-x',
            status: 'pending_recipient',
            expiresAt: new Date(Date.now() - 1000),
          }),
        ),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(410);
  });

  it('returns 410 when the status is already expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(pendingRow({ fromCustomerId: 'seller-x', status: 'expired' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(410);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/transfers/TR-9K4M-7P2X/accept',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 422 when the CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            pendingRow({ fromCustomerId: 'seller-x', status: 'pending_recipient' }),
          ),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(422);
  });
});

describe('POST /v1/me/transfers/:id/confirm', () => {
  const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function confirm() {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/confirm`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
  }

  // Row at pending_seller_confirmation owned by the caller, recipient set.
  function awaitingConfirm(over: Record<string, unknown> = {}) {
    return {
      id: 'tr-1',
      vehicleId: VEHICLE_ID,
      fromCustomerId: CUSTOMER_ID,
      toCustomerId: 'buyer-1',
      status: 'pending_seller_confirmation',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      ...over,
    };
  }

  it('confirms and swaps ownership', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(awaitingConfirm())
      .mockResolvedValueOnce({ ...createdRow(), status: 'completed', completedAt: new Date() });
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    app = await buildApp(prisma);
    const res = await confirm();
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('completed');
    expect(prisma.vehicleOwnership.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleOwnership.create).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the transfer does not exist', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(404);
  });

  it('returns 403 when the caller is not the seller', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ fromCustomerId: 'seller-x' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(403);
  });

  it('returns 422 when the transfer is not pending_seller_confirmation', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ status: 'pending_recipient' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(422);
  });

  it('returns 410 when the transfer has expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(awaitingConfirm({ expiresAt: new Date(Date.now() - 1000) })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(410);
  });

  it('returns 410 when the status is already expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ status: 'expired' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(410);
  });

  it('returns 422 when the recipient slot is empty (data invariant)', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ toCustomerId: null })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(422);
  });

  it('returns 422 when the swap CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(awaitingConfirm()),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(422);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/me/transfers/:id/reject', () => {
  const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function reject(payload: unknown = {}) {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/reject`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: payload as never,
    });
  }

  function rejectable(over: Record<string, unknown> = {}) {
    return {
      id: 'tr-1',
      fromCustomerId: CUSTOMER_ID,
      toCustomerId: null,
      status: 'pending_recipient',
      ...over,
    };
  }

  it('lets the seller reject and stores the reason', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(rejectable())
      .mockResolvedValueOnce({
        ...createdRow(),
        status: 'rejected',
        rejectedReason: 'cambiato idea',
      });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany },
    });
    app = await buildApp(prisma);
    const res = await reject({ reason: 'cambiato idea' });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('rejected');
    expect(updateMany.mock.calls[0]![0].data.rejectedReason).toBe('cambiato idea');
  });

  it('lets the recipient reject (no reason)', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(
        rejectable({
          fromCustomerId: 'seller-x',
          toCustomerId: CUSTOMER_ID,
          status: 'pending_seller_confirmation',
        }),
      )
      .mockResolvedValueOnce({ ...createdRow(), status: 'rejected' });
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst,
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(200);
  });

  it('returns 404 when the transfer does not exist', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(404);
  });

  it('returns 403 when the caller is neither party', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi
          .fn()
          .mockResolvedValue(rejectable({ fromCustomerId: 'seller-x', toCustomerId: 'buyer-y' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(403);
  });

  it('returns 409 when the transfer is already terminal', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(rejectable({ status: 'completed' })),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(409);
  });

  it('returns 409 when the CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(rejectable()),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(409);
  });

  it('rejects an unknown body field with 400', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(rejectable()),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await reject({ foo: 'bar' })).statusCode).toBe(400);
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/reject`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

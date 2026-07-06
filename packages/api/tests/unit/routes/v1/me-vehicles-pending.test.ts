import sensible from '@fastify/sensible';
import { Prisma } from '@garageos/database';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meVehiclesPendingRoutes from '../../../../src/routes/v1/me-vehicles-pending.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const OWNERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

// Checksum-valid VIN (ISO 3779 check digit X at position 9).
const VALID_VIN = '1M8GDM9AXKP042788';
// Same VIN with the check digit corrupted (X -> 1): valid alphabet/shape,
// fails the ISO 3779 checksum.
const INVALID_CHECKSUM_VIN = '1M8GDM9A1KP042788';

const VALID_BODY = {
  vin: VALID_VIN,
  plate: 'AB123CD',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'car',
  fuelType: 'petrol',
};

// Row returned by vehicle.create with the route's response select.
const CREATED_VEHICLE_ROW = {
  id: VEHICLE_ID,
  garageCode: null,
  vin: VALID_VIN,
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'car' as const,
  fuelType: 'petrol' as const,
  status: 'pending' as const,
};

interface FakePrisma {
  vehicle: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    create: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      // No duplicate VIN by default.
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(CREATED_VEHICLE_ROW),
    },
    vehicleOwnership: {
      create: vi.fn().mockResolvedValue({
        id: OWNERSHIP_ID,
        startedAt: new Date('2026-06-10T00:00:00.000Z'),
      }),
    },
    ...overrides,
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
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:customer_id': CUSTOMER_ID,
      },
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
  await app.register(meVehiclesPendingRoutes);
  return app;
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('POST /v1/me/vehicles/pending', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('creates a pending vehicle owned by the caller and returns 201 with the exact envelope', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      vehicle: {
        id: VEHICLE_ID,
        garageCode: null,
        vin: VALID_VIN,
        plate: 'AB123CD',
        plateCountry: 'IT',
        make: 'Fiat',
        model: 'Panda',
        year: 2021,
        vehicleType: 'car',
        fuelType: 'petrol',
        status: 'pending',
      },
      ownership: {
        id: OWNERSHIP_ID,
        startedAt: '2026-06-10T00:00:00.000Z',
      },
    });

    // The caller pin is the security boundary: createdByCustomerId comes
    // from the token, never from the body, and status is pinned to pending.
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vin: VALID_VIN,
          status: 'pending',
          createdByCustomerId: CUSTOMER_ID,
        }),
      }),
    );
    const createData = (
      prisma.vehicle.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(createData).not.toHaveProperty('garageCode');
    expect(createData).not.toHaveProperty('certifiedByTenantId');
    expect(createData).not.toHaveProperty('certifiedAt');

    expect(prisma.vehicleOwnership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
        }),
        select: { id: true, startedAt: true },
      }),
    );
  });

  it('forwards the optional technical fields to vehicle.create, converting the date', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {
        ...VALID_BODY,
        version: '1.2 Easy',
        registrationDate: '2020-06-15',
        engineDisplacement: 1242,
        powerKw: 51,
        color: 'Bianco',
      },
    });

    expect(res.statusCode).toBe(201);
    const createData = (
      prisma.vehicle.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(createData.version).toBe('1.2 Easy');
    expect(createData.registrationDate).toBeInstanceOf(Date);
    expect((createData.registrationDate as Date).toISOString().slice(0, 10)).toBe('2020-06-15');
    expect(createData.engineDisplacement).toBe(1242);
    expect(createData.powerKw).toBe(51);
    expect(createData.color).toBe('Bianco');
  });

  it('omits absent optional technical fields from vehicle.create (no empty writes)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });

    const createData = (
      prisma.vehicle.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(createData).not.toHaveProperty('version');
    expect(createData).not.toHaveProperty('registrationDate');
    expect(createData).not.toHaveProperty('engineDisplacement');
    expect(createData).not.toHaveProperty('powerKw');
    expect(createData).not.toHaveProperty('color');
  });

  it('invokes withContext with customerId + role: user', async () => {
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma()));
    app = await buildApp({ withContext });

    await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });

    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
  });

  // BR-001: the ISO 3779 checksum is advisory and NOT enforced on the
  // customer surface (most EU VINs fail it and the VIN is re-verified at
  // certification). A shape-valid VIN that fails the checksum must still
  // create the pending vehicle.
  it('accepts a VIN failing ISO 3779 and creates the pending vehicle', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { ...VALID_BODY, vin: INVALID_CHECKSUM_VIN },
    });

    expect(res.statusCode).toBe(201);
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vin: INVALID_CHECKSUM_VIN }),
      }),
    );
    expect(prisma.vehicleOwnership.create).toHaveBeenCalled();
  });

  it('returns 409 duplicate_vin_certified when a vehicle with the same VIN already exists', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
        create: vi.fn(),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.pending.duplicate_vin_certified',
      status: 409,
    });
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vin: VALID_VIN },
        select: { id: true },
      }),
    );
  });

  it('returns 409 duplicate_vin_certified when the insert loses a P2002 race', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(p2002()),
      },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/vehicle.pending.duplicate_vin_certified',
      status: 409,
    });
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing fuelType',
      Object.fromEntries(Object.entries(VALID_BODY).filter(([k]) => k !== 'fuelType')),
    ],
    ['year below 1900', { ...VALID_BODY, year: 1899 }],
    ['malformed plate', { ...VALID_BODY, plate: 'XX99' }],
    ['unknown key status (strict schema)', { ...VALID_BODY, status: 'certified' }],
    [
      'unknown key createdByCustomerId (strict schema)',
      { ...VALID_BODY, createdByCustomerId: '5b5fb6db-94a8-4f0c-a4f2-8e7f3a1b2c3d' },
    ],
  ])('returns 400 on invalid body: %s', async (_label, payload) => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects officine pool tokens with 403', async () => {
    const officineVerifier: JwtVerifier = {
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
    app = await buildApp({ verifier: officineVerifier });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/pending',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
  });
});

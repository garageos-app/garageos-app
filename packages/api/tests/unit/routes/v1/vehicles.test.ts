import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleRoutes from '../../../../src/routes/v1/vehicles.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const LOCATION_ID = '66666666-6666-4666-8666-666666666666';

interface FakePrisma {
  user: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
  location: { findUnique: ReturnType<typeof vi.fn> };
  vehicle: {
    findMany: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: { create: ReturnType<typeof vi.fn> };
  invitation: { create: ReturnType<typeof vi.fn> };
  accessLog: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  // Tagged-template variants (garage-code.ts uses these after Task 3 fix).
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, locationId: LOCATION_ID }),
    },
    location: {
      findUnique: vi.fn().mockResolvedValue({ id: LOCATION_ID, tenantId: TENANT_ID }),
    },
    vehicle: {
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
    },
    customer: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: CUSTOMER_ID, email: 'mario.rossi@example.com' }),
    },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    vehicleOwnership: {
      create: vi.fn().mockResolvedValue({
        id: '77777777-7777-4777-8777-777777777777',
        vehicleId: VEHICLE_ID,
        customerId: CUSTOMER_ID,
        startedAt: new Date('2026-04-24T00:00:00Z'),
      }),
    },
    invitation: {
      create: vi.fn().mockResolvedValue({
        id: '88888888-8888-4888-8888-888888888888',
        targetEmail: 'mario.rossi@example.com',
        expiresAt: new Date('2026-05-24T00:00:00Z'),
      }),
    },
    accessLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      // generate_garage_code() returns a single-column row.
      const sql = strings.join('');
      if (sql.includes('generate_garage_code')) return [{ code: 'GO-234-ABCD' }];
      return [];
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
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
        'custom:location_id': LOCATION_ID,
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
  await app.register(vehicleRoutes);
  return app;
}

describe('GET /v1/vehicles/search — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('rejects requests with none of vin/plate/garage_code', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
      status: 400,
    });
  });

  it('rejects requests with more than one of vin/plate/garage_code', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?vin=ZFA16900000512345&plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a vin that is not 17 chars', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?vin=TOOSHORT',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/vehicles/search?plate=AB123CD' });
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
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/vehicles/:id — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('rejects non-UUID ids as 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/not-a-uuid',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/vehicles/search — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  function seedVehicleRow() {
    return {
      id: VEHICLE_ID,
      garageCode: 'GO-482-KXRT',
      vin: 'ZFA16900000512345',
      plate: 'AB123CD',
      plateCountry: 'IT',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      vehicleType: 'car' as const,
      fuelType: 'petrol' as const,
      status: 'certified' as const,
      ownerships: [
        {
          id: 'o1',
          customerId: CUSTOMER_ID,
          startedAt: new Date('2026-01-01T00:00:00Z'),
          customer: {
            id: CUSTOMER_ID,
            firstName: 'Mario',
            lastName: 'Rossi',
            email: 'mario@example.com',
            phone: '+39 333 1234567',
            isBusiness: false,
            businessName: null,
            vatNumber: null,
          },
        },
      ],
    };
  }

  it('returns { data: [], meta: { has_more: false } } when no vehicle matches', async () => {
    prisma.vehicle.findMany.mockResolvedValue([]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('queries vehicle.findMany with plate filter and limit+1', async () => {
    prisma.vehicle.findMany.mockResolvedValue([seedVehicleRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD&limit=10',
      headers: { authorization: 'Bearer x' },
    });
    const arg = prisma.vehicle.findMany.mock.calls[0]?.[0] as {
      where: { plate: string };
      take: number;
      orderBy: unknown;
    };
    expect(arg.where).toMatchObject({ plate: 'AB123CD' });
    expect(arg.take).toBe(11);
  });

  it('masks PII for customers without a relation to the current tenant', async () => {
    prisma.vehicle.findMany.mockResolvedValue([seedVehicleRow()]);
    prisma.customerTenantRelation.findMany.mockResolvedValue([]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      data: Array<{ currentOwnership: { customer: Record<string, unknown> } }>;
    };
    expect(body.data[0]!.currentOwnership.customer).toEqual({
      id: CUSTOMER_ID,
      redacted: true,
      displayName: 'Proprietario non in anagrafica',
    });
  });

  it('returns full PII when the tenant has a relation', async () => {
    prisma.vehicle.findMany.mockResolvedValue([seedVehicleRow()]);
    prisma.customerTenantRelation.findMany.mockResolvedValue([{ customerId: CUSTOMER_ID }]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      data: Array<{ currentOwnership: { customer: Record<string, unknown> } }>;
    };
    expect(body.data[0]!.currentOwnership.customer).toMatchObject({
      id: CUSTOMER_ID,
      firstName: 'Mario',
      email: 'mario@example.com',
      redacted: false,
    });
  });

  it('sets meta.has_more=true and strips the extra row when findMany returns limit+1', async () => {
    const row = seedVehicleRow();
    prisma.vehicle.findMany.mockResolvedValue([
      row,
      { ...row, id: 'v2', vin: 'ZFA16900000000000' },
    ]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD&limit=1',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      data: unknown[];
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body.data).toHaveLength(1);
    expect(body.meta.has_more).toBe(true);
    expect(typeof body.meta.cursor).toBe('string');
  });

  it('writes one access_log entry per matched vehicle with action=search_match', async () => {
    prisma.vehicle.findMany.mockResolvedValue([seedVehicleRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    expect(prisma.accessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          action: 'search_match',
          tenantId: TENANT_ID,
          userId: USER_ID,
        }),
      }),
    );
  });
});

describe('GET /v1/vehicles/:id — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  const vehicleRow = () => ({
    id: VEHICLE_ID,
    garageCode: 'GO-482-KXRT',
    vin: 'ZFA16900000512345',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    version: '1.2 Lounge',
    year: 2021,
    registrationDate: new Date('2021-03-15'),
    vehicleType: 'car' as const,
    fuelType: 'petrol' as const,
    engineDisplacement: 1242,
    powerKw: 51,
    color: 'Bianco Gelato',
    status: 'certified' as const,
    certifiedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ownerships: [
      {
        id: 'o1',
        customerId: CUSTOMER_ID,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        customer: {
          id: CUSTOMER_ID,
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@example.com',
          phone: '+39 333 1234567',
          isBusiness: false,
          businessName: null,
          vatNumber: null,
        },
      },
    ],
  });

  it('returns vehicle + currentOwnership with full PII when related', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(vehicleRow());
    prisma.customerTenantRelation.findMany.mockResolvedValue([{ customerId: CUSTOMER_ID }]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; make: string };
      currentOwnership: { customer: { redacted: boolean; firstName?: string } };
    };
    expect(body.vehicle.id).toBe(VEHICLE_ID);
    expect(body.vehicle.make).toBe('Fiat');
    expect(body.currentOwnership.customer.redacted).toBe(false);
    expect(body.currentOwnership.customer.firstName).toBe('Mario');
  });

  it('redacts customer PII when the tenant has no relation', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(vehicleRow());
    prisma.customerTenantRelation.findMany.mockResolvedValue([]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      currentOwnership: { customer: Record<string, unknown> };
    };
    expect(body.currentOwnership.customer).toEqual({
      id: CUSTOMER_ID,
      redacted: true,
      displayName: 'Proprietario non in anagrafica',
    });
  });

  it('returns 404 when Prisma throws P2025', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.vehicle.findUniqueOrThrow.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('writes exactly one access_log entry with action=view', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(vehicleRow());
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(prisma.accessLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.accessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'view' }) }),
    );
  });

  it('does not include createdByTenantId, pendingMetadata, or internal timestamps', async () => {
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue(vehicleRow());
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as { vehicle: Record<string, unknown> };
    expect(body.vehicle).not.toHaveProperty('createdByTenantId');
    expect(body.vehicle).not.toHaveProperty('pendingMetadata');
    expect(body.vehicle).not.toHaveProperty('updatedAt');
    expect(body.vehicle).not.toHaveProperty('archivedAt');
  });
});

describe('POST /v1/vehicles — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  const validBody = {
    vehicle: {
      // ISO 3779-valid VIN (from the checksum test file).
      vin: '1M8GDM9AXKP042788',
      plate: 'AB123CD',
      plateCountry: 'IT',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      vehicleType: 'car',
      fuelType: 'petrol',
      odometerKm: 45000,
    },
    customer: {
      mode: 'create_new',
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'mario.rossi@example.com',
    },
    locationId: LOCATION_ID,
  };

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a clienti-pool token', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a body missing the vehicle key', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: { customer: validBody.customer, locationId: LOCATION_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
      status: 400,
    });
  });

  it('rejects a VIN that is not 17 characters', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: {
        ...validBody,
        vehicle: { ...validBody.vehicle, vin: 'TOOSHORT' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a VIN that fails ISO 3779 checksum unless forceNonstandardVin=true', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: {
        ...validBody,
        // Same VIN with a single character flipped so the check digit fails.
        vehicle: { ...validBody.vehicle, vin: '1M8GDM9A1KP042788' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'vehicle.creation.invalid_vin_checksum',
    });
  });

  it('accepts a non-standard VIN when forceNonstandardVin=true', async () => {
    // Still hits the stub (501) or subsequent DB code, but must not
    // short-circuit at the checksum layer. Unit test pins: status != 400.
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: {
        ...validBody,
        vehicle: { ...validBody.vehicle, vin: '1M8GDM9A1KP042788' },
        forceNonstandardVin: true,
      },
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('rejects create_new customer with is_business but no businessName', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: {
        ...validBody,
        customer: {
          mode: 'create_new',
          firstName: 'Azienda',
          lastName: 'S.r.l.',
          email: 'info@azienda.it',
          isBusiness: true,
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing locationId', async () => {
    app = await buildApp();
    const { locationId: _drop, ...rest } = validBody;
    void _drop;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 vehicle.creation.location_not_in_tenant when location belongs to another tenant', async () => {
    const prisma = buildFakePrisma();
    prisma.location.findUnique = vi
      .fn()
      .mockResolvedValue({ id: LOCATION_ID, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'vehicle.creation.location_not_in_tenant',
    });
  });

  it('returns 409 vehicle.creation.duplicate_vin when a vehicle with that VIN already exists', async () => {
    const prisma = buildFakePrisma();
    prisma.vehicle.findFirst = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.vin === validBody.vehicle.vin) return Promise.resolve({ id: VEHICLE_ID });
        return Promise.resolve(null);
      });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'vehicle.creation.duplicate_vin' });
  });

  it('returns 409 vehicle.creation.duplicate_plate_warning when the plate exists on another VIN and force=false', async () => {
    const prisma = buildFakePrisma();
    prisma.vehicle.findFirst = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.vin) return Promise.resolve(null);
        // plate + plateCountry match with a different VIN.
        return Promise.resolve({ id: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz' });
      });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'vehicle.creation.duplicate_plate_warning' });
  });

  it('ignores the duplicate-plate warning when force=true', async () => {
    const prisma = buildFakePrisma();
    prisma.vehicle.findFirst = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.vin) return Promise.resolve(null);
        return Promise.resolve({ id: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz' });
      });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, force: true },
    });
    // Hits the still-501 stub — the test pins that we did NOT 409 on the warning.
    expect(res.statusCode).not.toBe(409);
  });
});

// Exposed for Task 8 data-path tests to reuse the same fixtures.
export {
  buildApp,
  buildFakePrisma,
  TENANT_ID,
  COGNITO_SUB,
  USER_ID,
  VEHICLE_ID,
  CUSTOMER_ID,
  LOCATION_ID,
};
export type { FakePrisma, AppDeps };

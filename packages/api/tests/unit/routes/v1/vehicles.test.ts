import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleUpdateRoutes from '../../../../src/routes/v1/vehicles-update.js';
import vehicleRoutes from '../../../../src/routes/v1/vehicles.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const LOCATION_ID = '66666666-6666-4666-8666-666666666666';

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
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
    upsert: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: { create: ReturnType<typeof vi.fn> };
  invitation: { create: ReturnType<typeof vi.fn> };
  accessLog: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  // Tagged-template variants (garage-code.ts uses these after Task 3 fix).
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, locationId: LOCATION_ID }),
      // F-OFF-004 follow-ups Item 1: tenant-context reactive status lookup.
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    location: {
      findUnique: vi.fn().mockResolvedValue({ id: LOCATION_ID, tenantId: TENANT_ID }),
    },
    vehicle: {
      findMany: vi.fn().mockResolvedValue([]),
      // Default: a fully-shaped certified row, so POST data-path tests that
      // do not explicitly mock the post-certify fetch still get a usable
      // value back (the vehicle.id is what downstream calls — ownership,
      // invitation, access-log — depend on).
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: VEHICLE_ID,
        garageCode: 'GO-234-ABCD',
        vin: '1M8GDM9AXKP042788',
        plate: 'AB123CD',
        plateCountry: 'IT',
        make: 'Fiat',
        model: 'Panda',
        version: null,
        year: 2021,
        registrationDate: null,
        vehicleType: 'car' as const,
        fuelType: 'petrol' as const,
        engineDisplacement: null,
        powerKw: null,
        color: null,
        status: 'certified' as const,
        certifiedAt: new Date('2026-04-24T12:00:00Z'),
        certifiedByTenantId: TENANT_ID,
        createdAt: new Date('2026-04-24T12:00:00Z'),
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
    },
    customer: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      // Default returns the full ResolvedCustomer shape so the data-path
      // (invitation gate on cognitoSub, response shape on email/names)
      // works without each test having to re-mock customer.create.
      create: vi
        .fn()
        .mockImplementation(
          async ({ data }: { data: { email: string; firstName: string; lastName: string } }) => ({
            id: CUSTOMER_ID,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            cognitoSub: null,
            appInstalled: false,
            phone: null,
            status: 'active' as const,
          }),
        ),
    },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({ id: 'rel-id' }),
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
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
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
  await app.register(vehicleUpdateRoutes);
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

  it('accepts customer as the sole selector', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?customer=55555555-5555-4555-8555-555555555555',
      headers: { authorization: 'Bearer x' },
    });
    // 200 = handler proceeded past schema validation. The fake Prisma
    // returns [] by default, so this asserts the schema accepted the input.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('rejects customer combined with another selector', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?customer=55555555-5555-4555-8555-555555555555&plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
      status: 400,
    });
  });

  it('rejects a malformed customer UUID', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?customer=not-a-uuid',
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

  it('writes one access_log entry per matched vehicle with action=search_match (bulk path)', async () => {
    prisma.vehicle.findMany.mockResolvedValue([seedVehicleRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/vehicles/search?plate=AB123CD',
      headers: { authorization: 'Bearer x' },
    });
    // Search endpoint uses recordVehiclesBatch: 1 dedup findMany + 1 bulk
    // createMany. The createMany payload is an array of row objects.
    expect(prisma.accessLog.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            vehicleId: VEHICLE_ID,
            action: 'search_match',
            tenantId: TENANT_ID,
            userId: USER_ID,
          }),
        ]),
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

describe('POST /v1/vehicles — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  const validBody = {
    vehicle: {
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
      mode: 'existing',
      customerId: CUSTOMER_ID,
    },
    locationId: LOCATION_ID,
  };

  it('returns 404 when the existing customerId is not found (P2025)', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.customer.findUniqueOrThrow = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(404);
  });

  it('reuses an existing customer without inserting a new one', async () => {
    prisma.customer.findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: CUSTOMER_ID,
      email: 'existing@example.com',
      firstName: 'Luca',
      lastName: 'Bianchi',
      cognitoSub: null,
      appInstalled: false,
      phone: null,
      status: 'active',
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customer.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.customer.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER_ID },
        select: expect.objectContaining({
          id: true,
          email: true,
          phone: true, // confirms the projection from Fix #1
          status: true,
        }),
      }),
    );
    // At this checkpoint the data-path is still partially stubbed, so we
    // only assert on behaviour introduced by this task.
    void res;
  });

  it('creates a new customer when create_new is passed and email is unseen', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'new@example.com',
        isBusiness: false,
      },
      locationId: LOCATION_ID,
    };
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({
      id: CUSTOMER_ID,
      email: 'new@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      cognitoSub: null,
      appInstalled: false,
      phone: null,
      status: 'active',
    });
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'new@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          isBusiness: false,
        }),
      }),
    );
  });

  it('recovers from a P2002 race by re-fetching the customer (no error to client)', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'race@example.com',
      },
      locationId: LOCATION_ID,
    };
    const { Prisma } = await import('@garageos/database');
    // findUnique -> null (initial dedupe check), then create -> P2002,
    // then findUniqueOrThrow -> the row that won the race.
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.customer.findUniqueOrThrow.mockResolvedValue({
      id: CUSTOMER_ID,
      email: 'race@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      cognitoSub: null,
      appInstalled: false,
      phone: null,
      status: 'active',
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    // Reaches the 501 stub on the post-customer-resolve path — the test
    // pins that we did NOT propagate the P2002 as a 500.
    expect(res.statusCode).not.toBe(500);
    expect(prisma.customer.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'race@example.com' },
      }),
    );
  });

  it('reuses an existing customer by email instead of creating a duplicate', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'already@example.com',
      },
      locationId: LOCATION_ID,
    };
    prisma.customer.findUnique.mockResolvedValue({
      id: CUSTOMER_ID,
      email: 'already@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      cognitoSub: null,
      appInstalled: false,
      phone: null,
      status: 'active',
    });
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('inserts the vehicle with createdByTenantId and pending status', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'happy@example.com',
      },
      locationId: LOCATION_ID,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vin: bodyNew.vehicle.vin,
          plate: bodyNew.vehicle.plate,
          status: 'pending',
          createdByTenantId: TENANT_ID,
        }),
      }),
    );
  });

  it('certifies the vehicle by calling generate_garage_code + UPDATE in one transaction', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'cert@example.com',
      },
      locationId: LOCATION_ID,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    // $queryRaw is called via a tagged template — its first arg is a TemplateStringsArray.
    const queryCalls = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    const sawGenerate = queryCalls.some((args: unknown[]) => {
      const strings = args[0] as TemplateStringsArray | undefined;
      return strings ? strings.join('').includes('generate_garage_code') : false;
    });
    expect(sawGenerate).toBe(true);
    // $executeRaw call should reference the certified status update.
    const execCalls = (prisma.$executeRaw as ReturnType<typeof vi.fn>).mock.calls;
    const sawCertify = execCalls.some((args: unknown[]) => {
      const strings = args[0] as TemplateStringsArray | undefined;
      return strings ? strings.join('').includes("status = 'certified'") : false;
    });
    expect(sawCertify).toBe(true);
  });

  it('creates the ownership and customer_tenant_relation', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'own@example.com',
      },
      locationId: LOCATION_ID,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.vehicleOwnership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
        }),
      }),
    );
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_customerId: { tenantId: TENANT_ID, customerId: CUSTOMER_ID } },
        create: expect.objectContaining({
          tenantId: TENANT_ID,
          customerId: CUSTOMER_ID,
        }),
      }),
    );
  });

  it('uses upsert with update:{} so existing relations are no-ops', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'skip-relation@example.com',
      },
      locationId: LOCATION_ID,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
      }),
    );
    // create is NEVER called directly — upsert handles both branches.
    expect(prisma.customerTenantRelation.create).not.toHaveBeenCalled();
  });

  it('creates an invitation when send_invitation_email=true and the customer has no cognitoSub', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'invite@example.com',
      },
      locationId: LOCATION_ID,
      sendInvitationEmail: true,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.invitation.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT create an invitation when send_invitation_email=false', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'noinvite@example.com',
      },
      locationId: LOCATION_ID,
      sendInvitationEmail: false,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });

  it('writes an access_logs row with action=create (BR-154)', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'audit@example.com',
      },
      locationId: LOCATION_ID,
    };
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(prisma.accessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          tenantId: TENANT_ID,
          userId: USER_ID,
          action: 'create',
        }),
      }),
    );
  });

  it('returns 201 with vehicle + customer + ownership + invitation', async () => {
    const bodyNew = {
      vehicle: validBody.vehicle,
      customer: {
        mode: 'create_new',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'response@example.com',
      },
      locationId: LOCATION_ID,
    };
    prisma.vehicle.findUniqueOrThrow.mockResolvedValue({
      id: VEHICLE_ID,
      garageCode: 'GO-234-ABCD',
      vin: bodyNew.vehicle.vin,
      plate: bodyNew.vehicle.plate,
      plateCountry: bodyNew.vehicle.plateCountry,
      make: bodyNew.vehicle.make,
      model: bodyNew.vehicle.model,
      version: null,
      year: bodyNew.vehicle.year,
      registrationDate: null,
      vehicleType: 'car' as const,
      fuelType: 'petrol' as const,
      engineDisplacement: null,
      powerKw: null,
      color: null,
      status: 'certified' as const,
      certifiedAt: new Date('2026-04-24T12:00:00Z'),
      certifiedByTenantId: TENANT_ID,
      createdAt: new Date('2026-04-24T12:00:00Z'),
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: 'Bearer x' },
      payload: bodyNew,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      vehicle: { id: string; garageCode: string; status: string };
      customer: { id: string; email: string; phone: string | null; status: string };
      ownership: { id: string; vehicleId: string; customerId: string };
      invitation: { id: string; targetEmail: string } | null;
    };
    expect(body.vehicle.id).toBe(VEHICLE_ID);
    expect(body.vehicle.garageCode).toBe('GO-234-ABCD');
    expect(body.vehicle.status).toBe('certified');
    expect(body.customer.email).toBe('response@example.com');
    expect(body.customer.phone).toBeNull(); // Fix #2: phone is part of the response
    expect(body.customer.status).toBe('active'); // Fix #1: status from DB, not hardcoded
    expect(body.ownership.vehicleId).toBe(VEHICLE_ID);
    expect(body).not.toHaveProperty('tag_download_url');
  });
});

describe('PATCH /v1/vehicles/:id — body validation', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  const URL = `/v1/vehicles/${VEHICLE_ID}`;

  it('returns 400 when body is empty', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL,
      headers: { authorization: 'Bearer x' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body has unknown field (strict)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL,
      headers: { authorization: 'Bearer x' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when vin length is wrong', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL,
      headers: { authorization: 'Bearer x' },
      payload: { vin: 'TOO_SHORT' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when year is out of range (BR-007)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL,
      headers: { authorization: 'Bearer x' },
      payload: { year: 1800 },
    });
    expect(res.statusCode).toBe(400);
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

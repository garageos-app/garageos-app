import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleCertifyRoutes from '../../../../src/routes/v1/vehicles-certify.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const LOCATION_ID = '66666666-6666-4666-8666-666666666666';
const OWNERSHIP_ID = '77777777-7777-4777-8777-777777777777';

// ISO 3779 checksum-valid VINs (validateVinIso3779). The pending fixture
// VIN has check digit X; the all-ones VIN is the canonical valid example.
const PENDING_VIN = '1M8GDM9AXKP042788';
const VALID_OTHER_VIN = '11111111111111111';
// Same shape as PENDING_VIN but broken check digit.
const INVALID_CHECKSUM_VIN = '1M8GDM9AXKP042789';

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending' as const,
    vin: PENDING_VIN,
    plate: 'AB123CD',
    plateCountry: 'IT',
    ...overrides,
  };
}

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  vehicle: {
    findFirst: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: { findMany: ReturnType<typeof vi.fn> };
  accessLog: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

interface FakeOptions {
  // Row returned for the by-id vehicle lookup (null → 404 path).
  byId?: Record<string, unknown> | null;
  // Row returned for the duplicate-VIN lookup (non-null → 409).
  byVin?: Record<string, unknown> | null;
  // Row returned for the duplicate-plate lookup (non-null → 409 warning).
  byPlate?: Record<string, unknown> | null;
}

function buildFakePrisma(opts: FakeOptions = {}): FakePrisma {
  const byId = opts.byId === undefined ? pendingRow() : opts.byId;
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, locationId: LOCATION_ID }),
      // tenant-context reactive status lookup (F-OFF-004 follow-ups Item 1).
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    vehicle: {
      // Discriminate the three findFirst call sites by their where shape
      // (by-id guard / duplicate VIN / duplicate plate) so each test can
      // steer one path without breaking the others.
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.vin) return opts.byVin ?? null;
        if (where.plate) return opts.byPlate ?? null;
        if (where.id) return byId;
        return null;
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: VEHICLE_ID,
        garageCode: 'GO-234-ABCD',
        vin: PENDING_VIN,
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
        certifiedAt: new Date('2026-06-11T12:00:00Z'),
        createdAt: new Date('2026-06-10T12:00:00Z'),
        ownerships: [
          {
            id: OWNERSHIP_ID,
            customerId: CUSTOMER_ID,
            startedAt: new Date('2026-06-10T12:00:00Z'),
            customer: {
              id: CUSTOMER_ID,
              firstName: 'Mario',
              lastName: 'Rossi',
              email: 'mario@test.local',
              phone: null,
              isBusiness: false,
              businessName: null,
              vatNumber: null,
            },
          },
        ],
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    customerTenantRelation: { findMany: vi.fn().mockResolvedValue([]) },
    accessLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('generate_garage_code')) return [{ code: 'GO-234-ABCD' }];
      return [];
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
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
  await app.register(vehicleCertifyRoutes);
  return app;
}

function certify(app: FastifyInstance, body: unknown, id: string = VEHICLE_ID) {
  return app.inject({
    method: 'POST',
    url: `/v1/vehicles/${id}/certify`,
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/vehicles/:id/certify', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('certifies a pending vehicle without corrections (BR-004 happy path)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.vehicle.garageCode).toBe('GO-234-ABCD');
    expect(json.vehicle.status).toBe('certified');
    // No corrections → no CAS updateMany; the helper UPDATE is the only write.
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // BR-151: owner not in tenant CTR → masked PII.
    expect(json.currentOwnership.customer.redacted).toBe(true);
    expect(json.currentOwnership.customer.email).toBeUndefined();
  });

  it('records an access log row with action update', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(200);
    expect(prisma.accessLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.accessLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).toMatchObject({
      vehicleId: VEHICLE_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      action: 'update',
    });
  });

  it('applies corrections through the pending-status CAS before certifying', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { year: 2020, registrationDate: '2020-05-01', version: '1.2 Easy' },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.vehicle.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: VEHICLE_ID, status: 'pending' });
    expect(arg.data['year']).toBe(2020);
    expect(arg.data['version']).toBe('1.2 Easy');
    expect(arg.data['registrationDate']).toBeInstanceOf(Date);
  });

  it('returns 422 libretto_required when librettoVisioned is false', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.libretto_required');
    // Guard fires before any DB access.
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('returns 422 libretto_required when librettoVisioned is absent', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.libretto_required');
  });

  it('returns 404 vehicle.not_found for an unknown id', async () => {
    const prisma = buildFakePrisma({ byId: null });
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');
  });

  it('returns 422 not_pending for a certified vehicle', async () => {
    const prisma = buildFakePrisma({ byId: pendingRow({ status: 'certified' }) });
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.not_pending');
  });

  it('returns 422 not_pending for an archived vehicle', async () => {
    const prisma = buildFakePrisma({ byId: pendingRow({ status: 'archived' }) });
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.not_pending');
  });

  it('rejects a corrected VIN failing the ISO 3779 checksum (BR-001)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { vin: INVALID_CHECKSUM_VIN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('vehicle.creation.invalid_vin_checksum');
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('accepts a non-standard VIN with forceNonstandardVin (BR-001 exception)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { vin: INVALID_CHECKSUM_VIN },
      forceNonstandardVin: true,
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 409 duplicate_vin when the corrected VIN belongs to another vehicle', async () => {
    const prisma = buildFakePrisma({ byVin: { id: 'other' } });
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { vin: VALID_OTHER_VIN },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.creation.duplicate_vin');
  });

  it('skips the duplicate-VIN check when the corrected VIN equals the current one', async () => {
    const prisma = buildFakePrisma({ byVin: { id: 'self' } });
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { vin: PENDING_VIN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 409 duplicate_plate_warning on plate collision, overridable with force', async () => {
    const prisma = buildFakePrisma({ byPlate: { id: 'other' } });
    app = await buildApp(prisma);
    const collision = await certify(app, {
      librettoVisioned: true,
      corrections: { plate: 'XY987ZW' },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().code).toBe('vehicle.creation.duplicate_plate_warning');

    const forced = await certify(app, {
      librettoVisioned: true,
      corrections: { plate: 'XY987ZW' },
      force: true,
    });
    expect(forced.statusCode).toBe(200);
  });

  it('maps a lost corrections CAS (0 rows) to 422 not_pending', async () => {
    const prisma = buildFakePrisma();
    // First by-id read says pending, but the CAS finds 0 rows: a
    // concurrent certify won between read and write.
    prisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { year: 2020 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.not_pending');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('maps VehicleNotCertifiableError from the certify helper to 422 not_pending', async () => {
    const prisma = buildFakePrisma();
    // Helper UPDATE ... WHERE garage_code IS NULL affects 0 rows: the
    // no-corrections double-certify race (this is the CAS).
    prisma.$executeRaw.mockResolvedValue(0);
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.certification.not_pending');
  });

  it('rejects unknown keys in corrections (no status/garageCode injection)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      corrections: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown top-level keys (no certifiedByTenantId injection)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, {
      librettoVisioned: true,
      certifiedByTenantId: TENANT_ID,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed vehicle id with 400', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await certify(app, { librettoVisioned: true }, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
  });
});

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleTagRoutes from '../../../../src/routes/v1/vehicles-tag.js';

// Mock renderTagPdf at module level so no real PDF rendering happens in the
// unit suite — see feedback_aws_sdk_presigner_credentials_chain (same idea,
// keep the unit test hermetic and fast).
// Error classes are passed through from the real module so that the route
// handler can import + use them normally even under the mock.
vi.mock('../../../../src/lib/vehicle-tag-renderer.js', async () => {
  const real = await vi.importActual<typeof import('../../../../src/lib/vehicle-tag-renderer.js')>(
    '../../../../src/lib/vehicle-tag-renderer.js',
  );
  return { ...real, renderTagPdf: vi.fn() };
});

// Import after vi.mock so the mocked version is used.
import { renderTagPdf } from '../../../../src/lib/vehicle-tag-renderer.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '44444444-4444-4444-8444-444444444444';
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';
const GARAGE_CODE = 'GA0001';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake-tag');

beforeAll(() => {
  // Ensure AWS SDK doesn't attempt credential chain resolution —
  // feedback_aws_sdk_presigner_credentials_chain.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
});

interface FakePrisma {
  user: {
    findFirstOrThrow: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  vehicle: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  vehicleTagPrint: {
    create: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(
  vehicleRow: {
    id: string;
    garageCode: string | null;
    status: string;
  } | null = { id: VEHICLE_ID, garageCode: GARAGE_CODE, status: 'certified' },
): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({
        id: USER_ID,
        role: 'mechanic',
      }),
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(vehicleRow),
    },
    vehicleTagPrint: {
      create: vi.fn().mockResolvedValue({ id: 'audit-row-id' }),
    },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
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

  const withContext = vi.fn(async (_ctx, fn: (tx: unknown) => unknown) => fn(prisma));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(vehicleTagRoutes);
  await app.ready();
  return app;
}

describe('GET /v1/vehicles/:id/tag (unit)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
  });

  it('200 — streams application/pdf and records a first-print audit row', async () => {
    const prisma = buildFakePrisma();
    vi.mocked(renderTagPdf).mockResolvedValue(FAKE_PDF);

    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/tag`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Audit row created with correct fields
    expect(prisma.vehicleTagPrint.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'first' }) }),
    );
    const createCall = prisma.vehicleTagPrint.create.mock.calls[0]![0] as {
      data: {
        vehicleId: string;
        tenantId: string;
        printedByUserId: string;
        kind: string;
      };
    };
    expect(createCall.data.vehicleId).toBe(VEHICLE_ID);
    expect(createCall.data.tenantId).toBe(TENANT_ID);
    expect(createCall.data.printedByUserId).toBe(USER_ID);
  });

  it('404 — vehicle.not_found when findFirst returns null', async () => {
    const prisma = buildFakePrisma(null);
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/tag`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('vehicle.not_found');
    expect(renderTagPdf).not.toHaveBeenCalled();
    expect(prisma.vehicleTagPrint.create).not.toHaveBeenCalled();
  });

  it('409 — vehicle.archived when status=archived: renderer not called, audit not inserted', async () => {
    const prisma = buildFakePrisma({ id: VEHICLE_ID, garageCode: GARAGE_CODE, status: 'archived' });
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/tag`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('vehicle.archived');
    expect(renderTagPdf).not.toHaveBeenCalled();
    expect(prisma.vehicleTagPrint.create).not.toHaveBeenCalled();
  });

  it('409 — vehicle.not_certified when status=pending', async () => {
    const prisma = buildFakePrisma({ id: VEHICLE_ID, garageCode: GARAGE_CODE, status: 'pending' });
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/tag`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('vehicle.not_certified');
    expect(renderTagPdf).not.toHaveBeenCalled();
    expect(prisma.vehicleTagPrint.create).not.toHaveBeenCalled();
  });

  it('502 — vehicle_tag.render_failed when renderer throws; no audit row created', async () => {
    const prisma = buildFakePrisma();
    vi.mocked(renderTagPdf).mockRejectedValue(new Error('render boom'));
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/tag`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('vehicle_tag.render_failed');
    expect(prisma.vehicleTagPrint.create).not.toHaveBeenCalled();
  });

  it('400 — VALIDATION_ERROR when :id is not a valid UUID v4', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/not-a-uuid/tag',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(400);
  });
});

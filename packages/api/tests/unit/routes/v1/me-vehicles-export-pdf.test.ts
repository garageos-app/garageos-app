// packages/api/tests/unit/routes/v1/me-vehicles-export-pdf.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meVehicleExportPdfRoutes from '../../../../src/routes/v1/me-vehicles-export-pdf.js';

vi.mock('../../../../src/lib/vehicle-history-pdf-s3.js', async () => {
  const real = await vi.importActual<
    typeof import('../../../../src/lib/vehicle-history-pdf-s3.js')
  >('../../../../src/lib/vehicle-history-pdf-s3.js');
  return { ...real, generateVehicleHistoryPdfPresignedUrl: vi.fn() };
});

import { generateVehicleHistoryPdfPresignedUrl } from '../../../../src/lib/vehicle-history-pdf-s3.js';

const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '88888888-8888-4888-8888-888888888888';
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';

const MOCK_EXPIRES_AT = new Date('2026-06-09T19:00:00.000Z');
const MOCK_URL = `https://s3.example.com/vehicle-history-pdfs/${VEHICLE_ID}.pdf?X-Amz=abc`;

function vehicleRow() {
  return {
    id: VEHICLE_ID,
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    version: null,
    garageCode: 'GO-973-JJHM',
    vin: 'ZFA31200000123456',
    year: 2019,
    fuelType: 'Diesel',
  };
}

function interventionRow(overrides: Record<string, unknown> = {}) {
  return {
    interventionDate: new Date('2026-05-23T00:00:00.000Z'),
    odometerKm: 60000,
    title: 'Tagliando',
    description: 'desc',
    partsReplaced: [],
    interventionType: { nameIt: 'Tagliando' },
    tenant: { businessName: 'Officina X' },
    location: { city: 'Roma' },
    ...overrides,
  };
}

interface FakePrisma {
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  intervention: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(opts: {
  ownership?: { vehicle: ReturnType<typeof vehicleRow> } | null;
  interventions?: ReturnType<typeof interventionRow>[];
}): FakePrisma {
  const ownership = opts.ownership === undefined ? { vehicle: vehicleRow() } : opts.ownership;
  return {
    vehicleOwnership: { findFirst: vi.fn().mockResolvedValue(ownership) },
    intervention: {
      findMany: vi.fn().mockResolvedValue(opts.interventions ?? [interventionRow()]),
    },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
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
  await app.register(meVehicleExportPdfRoutes);
  await app.ready();
  return app;
}

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.S3_ATTACHMENTS_BUCKET ??= 'garageos-test-attachments';
});

describe('GET /v1/me/vehicles/:id/export.pdf (unit)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
  });

  it('200 — returns pdf_download_url; passes assembled data with shop-only status filter', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(generateVehicleHistoryPdfPresignedUrl).mockResolvedValue({
      url: MOCK_URL,
      expiresAt: MOCK_EXPIRES_AT,
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pdf_download_url: string; expires_at: string }>();
    expect(body.pdf_download_url).toContain(`vehicle-history-pdfs/${VEHICLE_ID}.pdf`);
    expect(body.expires_at).toBe(MOCK_EXPIRES_AT.toISOString());

    // Status filter is active+disputed (shop-only, no cancelled).
    const whereArg = prisma.intervention.findMany.mock.calls[0]![0].where;
    expect(whereArg.status).toEqual({ in: ['active', 'disputed'] });
    expect(whereArg.vehicleId).toBe(VEHICLE_ID);

    const callArg = vi.mocked(generateVehicleHistoryPdfPresignedUrl).mock.calls[0]![0];
    expect(callArg.vehicleId).toBe(VEHICLE_ID);
    expect(callArg.data.interventions[0]!.interventionDate).toBe('2026-05-23');
    expect(callArg.data.interventions[0]!.tenantName).toBe('Officina X');
    expect(callArg.data.interventions[0]!.locationCity).toBe('Roma');
  });

  it('404 — me.vehicle.not_found when ownership is null; S3 not called', async () => {
    const prisma = buildFakePrisma({ ownership: null });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('me.vehicle.not_found');
    expect(generateVehicleHistoryPdfPresignedUrl).not.toHaveBeenCalled();
    expect(prisma.intervention.findMany).not.toHaveBeenCalled();
  });

  it('200 — empty history still generates a PDF (empty interventions array forwarded)', async () => {
    const prisma = buildFakePrisma({ interventions: [] });
    vi.mocked(generateVehicleHistoryPdfPresignedUrl).mockResolvedValue({
      url: MOCK_URL,
      expiresAt: MOCK_EXPIRES_AT,
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const callArg = vi.mocked(generateVehicleHistoryPdfPresignedUrl).mock.calls[0]![0];
    expect(callArg.data.interventions).toEqual([]);
  });

  it('400 — invalid UUID', async () => {
    const prisma = buildFakePrisma({});
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles/not-a-uuid/export.pdf',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

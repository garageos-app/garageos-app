// packages/api/tests/unit/routes/v1/vehicles-export-pdf.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import vehicleExportPdfRoutes from '../../../../src/routes/v1/vehicles-export-pdf.js';

// Mock the pure renderer so no pdf-lib work happens.
vi.mock('../../../../src/lib/vehicle-history-pdf-renderer.js', async () => {
  const real = await vi.importActual<
    typeof import('../../../../src/lib/vehicle-history-pdf-renderer.js')
  >('../../../../src/lib/vehicle-history-pdf-renderer.js');
  return { ...real, renderVehicleHistoryPdf: vi.fn() };
});

import { renderVehicleHistoryPdf } from '../../../../src/lib/vehicle-history-pdf-renderer.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake-history');

function vehicleRow() {
  return {
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
    description: 'desc',
    partsReplaced: [],
    checklistSelections: [
      {
        checklistItemId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
        labelSnapshot: 'Cambio olio',
        sortOrderSnapshot: 0,
      },
    ],
    interventionType: { nameIt: 'Tagliando' },
    tenant: { businessName: 'Officina X' },
    tenantId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

interface FakePrisma {
  // tenantContext middleware calls prisma.user.findFirst to confirm the user is active.
  user: { findFirst: ReturnType<typeof vi.fn> };
  vehicle: { findUnique: ReturnType<typeof vi.fn> };
  intervention: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(opts: {
  vehicle?: ReturnType<typeof vehicleRow> | null;
  interventions?: ReturnType<typeof interventionRow>[];
}): FakePrisma {
  const vehicle = opts.vehicle === undefined ? vehicleRow() : opts.vehicle;
  return {
    user: { findFirst: vi.fn().mockResolvedValue({ id: COGNITO_SUB }) },
    vehicle: { findUnique: vi.fn().mockResolvedValue(vehicle) },
    intervention: {
      findMany: vi.fn().mockResolvedValue(opts.interventions ?? [interventionRow()]),
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
  await app.register(vehicleExportPdfRoutes);
  await app.ready();
  return app;
}

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
});

describe('GET /v1/vehicles/:id/export.pdf (unit)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
  });

  it('200 — streams application/pdf; defaults scope=all (no tenant filter) + grouped mode', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`storico-${VEHICLE_ID}.pdf`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const whereArg = prisma.intervention.findMany.mock.calls[0]![0].where;
    expect(whereArg.vehicleId).toBe(VEHICLE_ID);
    expect(whereArg.status).toEqual({ in: ['active', 'disputed'] });
    expect(whereArg).not.toHaveProperty('tenantId'); // scope=all default

    const dataArg = vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0];
    expect(dataArg.mode).toBe('grouped'); // show_names default true
    expect(dataArg.interventions[0]!.tenantName).toBe('Officina X');
    expect(dataArg.interventions[0]!.tenantId).toBeDefined();
  });

  it('scope=own — restricts the query to the caller tenant (isolation)', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf?scope=own`,
      headers: { authorization: 'Bearer test' },
    });
    const whereArg = prisma.intervention.findMany.mock.calls[0]![0].where;
    expect(whereArg.tenantId).toBe(TENANT_ID);
  });

  it('show_names=false — maps to anonymous mode', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf?show_names=false`,
      headers: { authorization: 'Bearer test' },
    });
    const dataArg = vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0];
    expect(dataArg.mode).toBe('anonymous');
  });

  it('404 — vehicle.not_found when the vehicle is absent; renderer + findMany not called', async () => {
    const prisma = buildFakePrisma({ vehicle: null });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('vehicle.not_found');
    expect(renderVehicleHistoryPdf).not.toHaveBeenCalled();
    expect(prisma.intervention.findMany).not.toHaveBeenCalled();
  });

  it('200 — empty history still generates a PDF (empty interventions array forwarded)', async () => {
    const prisma = buildFakePrisma({ interventions: [] });
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0].interventions).toEqual([]);
  });

  it('502 — vehicle_history_pdf.render_failed when the renderer throws', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockRejectedValue(new Error('boom'));
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${VEHICLE_ID}/export.pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ code: string }>().code).toBe('vehicle_history_pdf.render_failed');
  });

  it('400 — invalid UUID', async () => {
    const prisma = buildFakePrisma({});
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/not-a-uuid/export.pdf',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

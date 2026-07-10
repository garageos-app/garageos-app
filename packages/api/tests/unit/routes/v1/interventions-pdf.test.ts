// packages/api/tests/unit/routes/v1/interventions-pdf.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionPdfRoutes from '../../../../src/routes/v1/interventions-pdf.js';

// Mock the shared history renderer so no pdf-lib work happens. The single
// intervention PDF renders via the SAME renderer as the bulk vehicle-history
// export (decided 2026-07-10) — scoped to one intervention.
vi.mock('../../../../src/lib/vehicle-history-pdf-renderer.js', async () => {
  const real = await vi.importActual<
    typeof import('../../../../src/lib/vehicle-history-pdf-renderer.js')
  >('../../../../src/lib/vehicle-history-pdf-renderer.js');
  return { ...real, renderVehicleHistoryPdf: vi.fn() };
});

import { renderVehicleHistoryPdf } from '../../../../src/lib/vehicle-history-pdf-renderer.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const INTERVENTION_ID = '99999999-9999-4999-8999-999999999999';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake-intervention');

function interventionRow(overrides: Record<string, unknown> = {}) {
  return {
    interventionDate: new Date('2026-05-23T00:00:00.000Z'),
    odometerKm: 60000,
    description: 'desc',
    partsReplaced: [],
    tenantId: TENANT_ID,
    checklistSelections: [
      {
        checklistItemId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
        labelSnapshot: 'Cambio olio',
        sortOrderSnapshot: 0,
      },
    ],
    interventionType: { nameIt: 'Tagliando' },
    tenant: { businessName: 'Officina X' },
    vehicle: {
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      version: null,
      garageCode: 'GA0001',
      vin: 'ZFA00000000000001',
      year: 2020,
      fuelType: 'benzina',
    },
    ...overrides,
  };
}

interface FakePrisma {
  // tenantContext middleware calls request.server.prisma.user.findFirst to
  // verify the user is active — must be present in the fake even though the
  // route itself never queries users directly.
  user: { findFirst: ReturnType<typeof vi.fn> };
  intervention: { findFirst: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(opts: {
  intervention?: ReturnType<typeof interventionRow> | null;
}): FakePrisma {
  const intervention = opts.intervention === undefined ? interventionRow() : opts.intervention;
  return {
    user: { findFirst: vi.fn().mockResolvedValue({ id: COGNITO_SUB }) },
    intervention: { findFirst: vi.fn().mockResolvedValue(intervention) },
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
  await app.register(interventionPdfRoutes);
  await app.ready();
  return app;
}

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
});

describe('GET /v1/interventions/:id/pdf (unit)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
  });

  it('200 — streams application/pdf; grouped mode + single intervention by default', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);

    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`intervento-${INTERVENTION_ID}.pdf`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Own-only scoping frontier: findFirst is keyed on { id, tenantId }.
    const where = prisma.intervention.findFirst.mock.calls[0]![0].where;
    expect(where).toEqual({ id: INTERVENTION_ID, tenantId: TENANT_ID });

    const dataArg = vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0];
    expect(dataArg.mode).toBe('grouped'); // show_names default true
    expect(dataArg.interventions).toHaveLength(1);
    const it0 = dataArg.interventions[0]!;
    expect(it0.tenantName).toBe('Officina X');
    expect(it0.tenantId).toBe(TENANT_ID);
    expect(it0.interventionDate).toBe('2026-05-23');
    expect(it0.typeName).toBe('Tagliando');
    expect(it0.checklistItems).toEqual(['Cambio olio']);
    expect(dataArg.vehicle.vin).toBe('ZFA00000000000001');
    // No PII / operator on the customer-deliverable document.
    expect(dataArg).not.toHaveProperty('customerName');
  });

  it('show_names=false — anonymous mode (no officina label)', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf?show_names=false`,
      headers: { authorization: 'Bearer test' },
    });
    const dataArg = vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0];
    expect(dataArg.mode).toBe('anonymous');
  });

  it('404 — intervention.not_found when findFirst returns null; renderer not called', async () => {
    const prisma = buildFakePrisma({ intervention: null });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('intervention.not_found');
    expect(renderVehicleHistoryPdf).not.toHaveBeenCalled();
  });

  it('502 — intervention_pdf.render_failed when renderer throws', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderVehicleHistoryPdf).mockRejectedValue(new Error('render boom'));
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ code: string }>().code).toBe('intervention_pdf.render_failed');
  });

  it('400 — invalid UUID', async () => {
    const prisma = buildFakePrisma({});
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/not-a-uuid/pdf',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

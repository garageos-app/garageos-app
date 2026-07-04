// packages/api/tests/unit/routes/v1/interventions-pdf.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionPdfRoutes from '../../../../src/routes/v1/interventions-pdf.js';

// Mock the pure renderer so no pdf-lib work and no logo lookup happen.
vi.mock('../../../../src/lib/intervention-pdf-renderer.js', async () => {
  const real = await vi.importActual<
    typeof import('../../../../src/lib/intervention-pdf-renderer.js')
  >('../../../../src/lib/intervention-pdf-renderer.js');
  return { ...real, renderInterventionPdf: vi.fn() };
});

import { renderInterventionPdf } from '../../../../src/lib/intervention-pdf-renderer.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';
const INTERVENTION_ID = '99999999-9999-4999-8999-999999999999';
const CUSTOMER_ID = '88888888-8888-4888-8888-888888888888';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake-intervention');

function interventionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTERVENTION_ID,
    status: 'active',
    interventionDate: new Date('2026-05-23T00:00:00.000Z'),
    odometerKm: 60000,
    description: 'desc',
    partsReplaced: [],
    checklistSelections: [
      {
        checklistItemId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
        labelSnapshot: 'Cambio olio',
        sortOrderSnapshot: 0,
      },
    ],
    cancelledReason: null,
    interventionType: { nameIt: 'Tagliando' },
    tenant: {
      businessName: 'Officina X',
      addressLine: 'Via 1',
      city: 'Roma',
      vatNumber: '0000',
      phone: null,
    },
    vehicle: {
      id: VEHICLE_ID,
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      garageCode: 'GA0001',
    },
    user: { firstName: 'Giuseppe', lastName: 'Rossi' },
    ...overrides,
  };
}

const customerRow: {
  id: string;
  firstName: string;
  lastName: string;
  isBusiness: boolean;
  businessName: string | null;
} = {
  id: CUSTOMER_ID,
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
};

interface FakePrisma {
  // tenantContext middleware calls request.server.prisma.user.findFirst to
  // verify the user is active — must be present in the fake even though the
  // route itself never queries users directly.
  user: { findFirst: ReturnType<typeof vi.fn> };
  intervention: { findFirst: ReturnType<typeof vi.fn> };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  customerTenantRelation: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(opts: {
  intervention?: ReturnType<typeof interventionRow> | null;
  owner?: { customer: typeof customerRow } | null;
  relationVisible?: boolean;
}): FakePrisma {
  const intervention = opts.intervention === undefined ? interventionRow() : opts.intervention;
  const owner = opts.owner === undefined ? { customer: customerRow } : opts.owner;
  const relationVisible = opts.relationVisible ?? true;
  return {
    // tenantContext middleware calls prisma.user.findFirst (select id) to
    // confirm the user is active; any truthy row satisfies its null-check.
    user: { findFirst: vi.fn().mockResolvedValue({ id: COGNITO_SUB }) },
    intervention: { findFirst: vi.fn().mockResolvedValue(intervention) },
    vehicleOwnership: { findFirst: vi.fn().mockResolvedValue(owner) },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue(relationVisible ? [{ customerId: CUSTOMER_ID }] : []),
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

  it('200 — streams application/pdf; passes masked customer name to renderer', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);

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

    const dataArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(dataArg.customerName).toBe('Mario Rossi');
    expect(dataArg.operatorName).toBe('Giuseppe Rossi');
    expect(dataArg.interventionDate).toBe('2026-05-23');
    expect(dataArg.checklistItems).toEqual(['Cambio olio']);
    expect(dataArg).not.toHaveProperty('title');
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
    expect(renderInterventionPdf).not.toHaveBeenCalled();
  });

  it('BR-151 — customerName is placeholder when relation not visible', async () => {
    const prisma = buildFakePrisma({ relationVisible: false });
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    const callArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(callArg.customerName).toBe('Proprietario non in anagrafica');
  });

  it('owner null — customerName null, still 200', async () => {
    const prisma = buildFakePrisma({ owner: null });
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const callArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(callArg.customerName).toBeNull();
  });

  it('BR-213 — operatorName fallback "Operatore" when user is null', async () => {
    const prisma = buildFakePrisma({ intervention: interventionRow({ user: null }) });
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    const callArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(callArg.operatorName).toBe('Operatore');
  });

  it('isBusiness — uses businessName for the customer name', async () => {
    const bizCustomer = {
      customer: { ...customerRow, isBusiness: true, businessName: 'Trasporti SRL' },
    };
    const prisma = buildFakePrisma({ owner: bizCustomer });
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    const callArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(callArg.customerName).toBe('Trasporti SRL');
  });

  it('isBusiness true but businessName null — falls back to first+last name', async () => {
    const bizNoName = {
      customer: { ...customerRow, isBusiness: true, businessName: null },
    };
    const prisma = buildFakePrisma({ owner: bizNoName });
    vi.mocked(renderInterventionPdf).mockResolvedValue(FAKE_PDF);
    app = await buildApp(prisma);
    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/pdf`,
      headers: { authorization: 'Bearer test' },
    });
    const callArg = vi.mocked(renderInterventionPdf).mock.calls[0]![0];
    expect(callArg.customerName).toBe('Mario Rossi');
  });

  it('502 — intervention_pdf.render_failed when renderer throws', async () => {
    const prisma = buildFakePrisma({});
    vi.mocked(renderInterventionPdf).mockRejectedValue(new Error('render boom'));
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

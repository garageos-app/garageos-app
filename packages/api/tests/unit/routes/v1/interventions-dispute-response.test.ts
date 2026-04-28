import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionDisputeResponseRoutes from '../../../../src/routes/v1/interventions-dispute-response.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const INTERVENTION_ID = '55555555-5555-4555-8555-555555555555';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const DISPUTE_ID = '77777777-7777-4777-8777-777777777777';
const CUSTOMER_ID = '88888888-8888-4888-8888-888888888888';

const VALID_RESPONSE =
  "L'intervento è stato eseguito come da preventivo firmato il 2026-04-20; in allegato il foglio di lavoro.";

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  intervention: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  interventionDispute: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  accessLog: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildUserRow(role: 'super_admin' | 'mechanic' = 'super_admin') {
  return { id: USER_ID, role, locationId: LOCATION_ID };
}

function buildInterventionRow(
  overrides: Partial<{ status: 'active' | 'disputed' | 'cancelled' }> = {},
) {
  return {
    tenantId: TENANT_ID,
    status: 'disputed' as 'active' | 'disputed' | 'cancelled',
    vehicleId: VEHICLE_ID,
    ...overrides,
  };
}

function buildOpenDispute(id = DISPUTE_ID) {
  return {
    id,
    interventionId: INTERVENTION_ID,
    customerId: CUSTOMER_ID,
    reasonCategory: 'not_performed' as const,
    customerDescription: 'Non ho mai portato il veicolo',
    tenantResponse: null,
    tenantResponseAt: null,
    tenantResponseUserId: null,
    status: 'open' as const,
    resolvedAt: null,
    createdAt: new Date('2026-04-22T09:00:00.000Z'),
  };
}

function buildRespondedDispute(id = DISPUTE_ID) {
  return {
    ...buildOpenDispute(id),
    tenantResponse: VALID_RESPONSE,
    tenantResponseAt: new Date('2026-04-28T10:00:00.000Z'),
    tenantResponseUserId: USER_ID,
    status: 'responded' as const,
  };
}

interface FakePrismaOverrides {
  userRole?: 'super_admin' | 'mechanic';
  interventionStatus?: 'active' | 'disputed' | 'cancelled';
  // Disputes returned by findMany (omitted disputeId path)
  openTargets?: Array<{ id: string }>;
  // Single dispute returned by findUnique (explicit disputeId path)
  singleTarget?: ReturnType<typeof buildOpenDispute> | null;
  // Final responded rows returned by findMany after the updateMany
  respondedRows?: Array<ReturnType<typeof buildRespondedDispute>>;
  // Remaining 'open' count post-update
  remainingOpen?: number;
}

function buildFakePrisma(o: FakePrismaOverrides = {}): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue(buildUserRow(o.userRole ?? 'super_admin')),
    },
    intervention: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue(buildInterventionRow({ status: o.interventionStatus ?? 'disputed' })),
      update: vi.fn().mockResolvedValue({ id: INTERVENTION_ID, status: 'active' }),
    },
    interventionDispute: {
      findUnique: vi.fn().mockResolvedValue(o.singleTarget ?? null),
      findMany: vi
        .fn()
        // First call: findMany targets (omitted disputeId path).
        // Second call: findMany respondedRows.
        .mockResolvedValueOnce(o.openTargets ?? [{ id: DISPUTE_ID }])
        .mockResolvedValueOnce(o.respondedRows ?? [buildRespondedDispute()]),
      updateMany: vi.fn().mockResolvedValue({ count: o.openTargets?.length ?? 1 }),
      count: vi.fn().mockResolvedValue(o.remainingOpen ?? 0),
    },
    accessLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    },
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
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'super_admin',
        'custom:location_id': LOCATION_ID,
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
  await app.register(interventionDisputeResponseRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/interventions/:id/dispute-response (unit)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('200 happy path single dispute → flips to responded + intervention_status active', async () => {
    const prisma = buildFakePrisma({ interventionStatus: 'disputed', remainingOpen: 0 });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{ id: string; status: string; tenantResponse: string }>;
      interventionStatus: string;
    };
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]!.id).toBe(DISPUTE_ID);
    expect(body.disputes[0]!.status).toBe('responded');
    expect(body.disputes[0]!.tenantResponse).toBe(VALID_RESPONSE);
    expect(body.interventionStatus).toBe('active');

    expect(prisma.interventionDispute.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [DISPUTE_ID] } },
      data: expect.objectContaining({
        status: 'responded',
        tenantResponse: VALID_RESPONSE,
        tenantResponseUserId: USER_ID,
      }),
    });
    expect(prisma.intervention.update).toHaveBeenCalledWith({
      where: { id: INTERVENTION_ID },
      data: { status: 'active' },
    });
    expect(prisma.accessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        vehicleId: VEHICLE_ID,
        userId: USER_ID,
        action: 'respond',
      }),
    });

    // Defense: assert the fanout branch was taken (omitted disputeId).
    // If a future refactor accidentally routes through findUnique
    // instead, this would fail loudly rather than silently changing
    // semantics. Tests in Task 7 explicitly exercise the disputeId
    // branch — this assertion keeps them mutually exclusive.
    expect(prisma.interventionDispute.findUnique).not.toHaveBeenCalled();
  });
});

export { buildApp, buildFakePrisma, buildOpenDispute, buildRespondedDispute };
export {
  TENANT_ID,
  LOCATION_ID,
  USER_ID,
  VEHICLE_ID,
  INTERVENTION_ID,
  COGNITO_SUB,
  DISPUTE_ID,
  CUSTOMER_ID,
  VALID_RESPONSE,
};

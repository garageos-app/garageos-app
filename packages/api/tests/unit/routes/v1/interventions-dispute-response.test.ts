import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionDisputeResponseRoutes from '../../../../src/routes/v1/interventions-dispute-response.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const INTERVENTION_ID = '55555555-5555-4555-8555-555555555555';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const DISPUTE_ID = '77777777-7777-4777-8777-777777777777';
const CUSTOMER_ID = '88888888-8888-4888-8888-888888888888';

const VALID_RESPONSE =
  "L'intervento è stato eseguito come da preventivo firmato il 2026-04-20; in allegato il foglio di lavoro.";

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
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
  return { id: USER_ID, role };
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
      // F-OFF-004 follow-ups Item 1: tenant-context reactive status lookup.
      findFirst: vi.fn().mockResolvedValue({ id: USER_ID }),
    },
    intervention: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue(buildInterventionRow({ status: o.interventionStatus ?? 'disputed' })),
      update: vi.fn().mockResolvedValue({ id: INTERVENTION_ID, status: 'active' }),
    },
    interventionDispute: (() => {
      const respondedRows = o.respondedRows ?? [buildRespondedDispute()];
      // If `singleTarget` is provided, the route uses findUnique for
      // resolution and findMany only fires once (the post-update
      // re-fetch). Otherwise findMany fires twice: targets discovery,
      // then re-fetch.
      const findManyMock = vi.fn();
      if (o.singleTarget !== undefined) {
        findManyMock.mockResolvedValueOnce(respondedRows);
      } else {
        findManyMock
          .mockResolvedValueOnce(o.openTargets ?? [{ id: DISPUTE_ID }])
          .mockResolvedValueOnce(respondedRows);
      }
      return {
        findUnique: vi.fn().mockResolvedValue(o.singleTarget ?? null),
        findMany: findManyMock,
        updateMany: vi.fn().mockResolvedValue({ count: o.openTargets?.length ?? 1 }),
        count: vi.fn().mockResolvedValue(o.remainingOpen ?? 0),
      };
    })(),
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

  it('200 multi-dispute fanout: 2 open disputes → both responded, status active', async () => {
    const D1 = '01010101-0101-4101-8101-010101010101';
    const D2 = '02020202-0202-4202-8202-020202020202';
    const responded = [
      { ...buildRespondedDispute(D1), customerId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a' },
      { ...buildRespondedDispute(D2), customerId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' },
    ];
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      openTargets: [{ id: D1 }, { id: D2 }],
      respondedRows: responded,
      remainingOpen: 0,
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{ id: string }>;
      interventionStatus: string;
    };
    expect(body.disputes.map((d) => d.id).sort()).toEqual([D1, D2].sort());
    expect(body.interventionStatus).toBe('active');
    expect(prisma.interventionDispute.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [D1, D2] } },
      data: expect.objectContaining({ status: 'responded' }),
    });
  });

  it('200 with another open dispute remaining → intervention_status stays disputed', async () => {
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      openTargets: [{ id: DISPUTE_ID }],
      respondedRows: [buildRespondedDispute()],
      remainingOpen: 1,
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionStatus: string };
    expect(body.interventionStatus).toBe('disputed');
    expect(prisma.intervention.update).not.toHaveBeenCalled();
  });

  it('200 only `responded` siblings remain (not counted as open) → status flips to active', async () => {
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      openTargets: [{ id: DISPUTE_ID }],
      respondedRows: [buildRespondedDispute()],
      remainingOpen: 0, // siblings sono `responded`, non `open`
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionStatus: string };
    expect(body.interventionStatus).toBe('active');
    expect(prisma.intervention.update).toHaveBeenCalledOnce();
  });

  it('200 intervention.status was already `active` → no flip update needed', async () => {
    // Edge case: customer aprì dispute ma intervention.status non era stato
    // flippato (data integrity drift). La response non deve fare l'UPDATE
    // perché lo status è già nel target value.
    const prisma = buildFakePrisma({
      interventionStatus: 'active',
      openTargets: [{ id: DISPUTE_ID }],
      respondedRows: [buildRespondedDispute()],
      remainingOpen: 0,
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionStatus: string };
    expect(body.interventionStatus).toBe('active');
    expect(prisma.intervention.update).not.toHaveBeenCalled();
  });

  it('200 with explicit disputeId → only that one updated, others not in updateMany', async () => {
    const target = buildOpenDispute(DISPUTE_ID);
    const responded = buildRespondedDispute(DISPUTE_ID);
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      singleTarget: target,
      respondedRows: [responded],
      remainingOpen: 0,
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: DISPUTE_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.interventionDispute.findUnique).toHaveBeenCalledWith({
      where: { id: DISPUTE_ID },
      select: { id: true, interventionId: true, status: true },
    });
    expect(prisma.interventionDispute.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.interventionDispute.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [DISPUTE_ID] } },
      data: expect.objectContaining({ status: 'responded' }),
    });
    const body = res.json() as {
      disputes: Array<{ id: string; status: string; tenantResponse: string }>;
      interventionStatus: string;
    };
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]!.id).toBe(DISPUTE_ID);
    expect(body.disputes[0]!.status).toBe('responded');
    expect(body.disputes[0]!.tenantResponse).toBe(VALID_RESPONSE);
    expect(body.interventionStatus).toBe('active');
  });

  it('404 disputeId points to a dispute on another intervention', async () => {
    const wrongIntervention = '99999999-9999-4999-8999-999999999999';
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      singleTarget: { ...buildOpenDispute(), interventionId: wrongIntervention },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: DISPUTE_ID },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('409 disputeId points to a dispute already responded', async () => {
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      singleTarget: { ...buildOpenDispute(), status: 'responded' as never },
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: DISPUTE_ID },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');
  });

  it('404 disputeId points to a nonexistent dispute (findUnique returns null)', async () => {
    // singleTarget omitted → findUnique returns null → !target branch
    // of the compound guard (`!target || target.interventionId !== id`).
    // This is the second sub-condition of the same 404, distinct from
    // cross-intervention which exercises the right side.
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: DISPUTE_ID },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('400 missing tenant_response → Zod validation.error', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 tenant_response < 20 chars → description_too_short (handler-side)', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: 'a'.repeat(19) },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.description_too_short');
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('400 tenant_response > 2000 → Zod validation.error', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: 'a'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 extra body field → strict() rejection', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, foo: 'bar' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 mechanic role is allowed (allow-list)', async () => {
    const prisma = buildFakePrisma({ userRole: 'mechanic' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(200);
  });

  it('403 unknown role (forced via mock) → permission_denied', async () => {
    // Synthetic: simulate a future enum value not in the allow-list.
    const prisma = buildFakePrisma();
    prisma.user.findFirstOrThrow = vi.fn().mockResolvedValue({
      id: USER_ID,
      role: 'read_only', // hypothetical future role
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.permission_denied');
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('404 cross-tenant intervention → P2025 → 404 (RLS-as-404)', async () => {
    const { Prisma } = await import('@garageos/database');
    const prisma = buildFakePrisma();
    prisma.intervention.findUniqueOrThrow = vi.fn().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('401 missing Authorization header', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(401);
  });

  it('409 omitted disputeId with zero open targets → no_active_dispute', async () => {
    const prisma = buildFakePrisma({
      interventionStatus: 'active',
      openTargets: [], // findMany returns empty array
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('409 disputeId points to a dispute resolved_by_cancellation', async () => {
    // Distinct from the `responded` 409: the !== 'open' guard covers
    // every non-open status. Pinning this branch prevents a future
    // refactor from special-casing terminal states.
    const prisma = buildFakePrisma({
      interventionStatus: 'disputed',
      singleTarget: { ...buildOpenDispute(), status: 'resolved_by_cancellation' as never },
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: DISPUTE_ID },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });

  it('404 user.findFirstOrThrow throws P2025 → defense-in-depth post-#27', async () => {
    // Cross-tenant JWT sub: the JWT verifier accepts the token (its
    // claims look fine), but {cognitoSub, tenantId} returns no row in
    // users → P2025 → global handler → 404. Pin this so the post-#27
    // tightening does not accidentally degrade.
    const { Prisma } = await import('@garageos/database');
    const prisma = buildFakePrisma();
    prisma.user.findFirstOrThrow = vi.fn().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute-response`,
      headers: { authorization: 'Bearer test' },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.interventionDispute.updateMany).not.toHaveBeenCalled();
  });
});

export { buildApp, buildFakePrisma, buildOpenDispute, buildRespondedDispute };
export {
  TENANT_ID,
  USER_ID,
  VEHICLE_ID,
  INTERVENTION_ID,
  COGNITO_SUB,
  DISPUTE_ID,
  CUSTOMER_ID,
  VALID_RESPONSE,
};

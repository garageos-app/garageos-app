import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionCancelRoutes from '../../../../src/routes/v1/interventions-cancel.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const INTERVENTION_ID = '55555555-5555-4555-8555-555555555555';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const DISPUTE_ID = '77777777-7777-4777-8777-777777777777';

const VALID_REASON =
  'Annullamento per errore di trascrizione VIN — la riga è stata reinserita correttamente in seguito.';

interface FakePrisma {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  intervention: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  interventionDispute: {
    updateMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  accessLog: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  // BR-066 H1 dispatch: cancel handler calls resolveCurrentOwner →
  // tx.vehicleOwnership.findFirst on every cancel. Default null
  // mimics "no active owner" so dispatch is skipped and existing
  // unit tests don't need to mock SES or tenant lookups.
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
}

function buildUserRow(role: 'super_admin' | 'mechanic' = 'super_admin'): {
  id: string;
  role: 'super_admin' | 'mechanic';
  locationId: string;
} {
  return { id: USER_ID, role, locationId: LOCATION_ID };
}

function buildExistingRow(
  overrides: Partial<{ status: 'active' | 'disputed' | 'cancelled' }> = {},
): { tenantId: string; status: 'active' | 'disputed' | 'cancelled'; vehicleId: string } {
  return {
    tenantId: TENANT_ID,
    status: 'active' as 'active' | 'disputed' | 'cancelled',
    vehicleId: VEHICLE_ID,
    ...overrides,
  };
}

function buildReloadedRow(): Record<string, unknown> {
  return {
    id: INTERVENTION_ID,
    tenantId: TENANT_ID,
    locationId: LOCATION_ID,
    userId: USER_ID,
    vehicleId: VEHICLE_ID,
    interventionTypeId: '88888888-8888-4888-8888-888888888888',
    interventionDate: new Date('2026-04-25'),
    odometerKm: 50000,
    title: null,
    description: 'Test',
    partsReplaced: [],
    internalNotes: null,
    status: 'cancelled',
    cancelledReason: VALID_REASON,
    cancelledByUserId: USER_ID,
    cancelledAt: new Date('2026-04-27T12:00:00.000Z'),
    kmAnomaly: false,
    firstSeenByCustomerAt: null,
    wikiLockedAt: null,
    createdAt: new Date('2026-04-25'),
    updatedAt: new Date('2026-04-27T12:00:00.000Z'),
    interventionType: {
      id: '88888888-8888-4888-8888-888888888888',
      code: 'TAGLIANDO',
      nameIt: 'Tagliando',
    },
  };
}

function buildFakePrisma(
  overrides: Partial<{
    userRole: 'super_admin' | 'mechanic';
    existingStatus: 'active' | 'disputed' | 'cancelled';
    flippedDisputes: Array<{ id: string; status: string; resolvedAt: Date }>;
  }> = {},
): FakePrisma {
  return {
    user: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue(buildUserRow(overrides.userRole ?? 'super_admin')),
    },
    intervention: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValueOnce(buildExistingRow({ status: overrides.existingStatus ?? 'active' }))
        .mockResolvedValueOnce(buildReloadedRow()),
      update: vi.fn().mockResolvedValue({ id: INTERVENTION_ID, status: 'cancelled' }),
    },
    interventionDispute: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.flippedDisputes?.length ?? 0 }),
      findMany: vi.fn().mockResolvedValue(overrides.flippedDisputes ?? []),
    },
    accessLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue(null),
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
  await app.register(interventionCancelRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/interventions/:id/cancel (unit)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('200 happy path active: returns intervention + empty resolvedDisputes', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { status: string };
      resolvedDisputes: unknown[];
    };
    expect(body.intervention.status).toBe('cancelled');
    expect(body.resolvedDisputes).toEqual([]);
    expect(prisma.intervention.update).toHaveBeenCalledWith({
      where: { id: INTERVENTION_ID },
      data: expect.objectContaining({
        status: 'cancelled',
        cancelledReason: VALID_REASON,
        cancelledByUserId: USER_ID,
      }),
    });
    expect(prisma.interventionDispute.updateMany).toHaveBeenCalledOnce();
  });

  it('200 disputed → flips disputes via updateMany; response carries resolvedDisputes', async () => {
    const flipped = [
      { id: DISPUTE_ID, status: 'resolved_by_cancellation', resolvedAt: new Date() },
    ];
    const prisma = buildFakePrisma({
      existingStatus: 'disputed',
      flippedDisputes: flipped,
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolvedDisputes: Array<{ id: string }>;
    };
    expect(body.resolvedDisputes).toHaveLength(1);
    expect(body.resolvedDisputes[0]!.id).toBe(DISPUTE_ID);
    expect(prisma.interventionDispute.updateMany).toHaveBeenCalledWith({
      where: {
        interventionId: INTERVENTION_ID,
        status: { in: ['open', 'responded'] },
      },
      data: expect.objectContaining({
        status: 'resolved_by_cancellation',
      }),
    });
  });

  it('403 mechanic role is rejected with permission_denied', async () => {
    const prisma = buildFakePrisma({ userRole: 'mechanic' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.permission_denied');
    expect(prisma.intervention.update).not.toHaveBeenCalled();
  });

  it('400 reason 19 chars is rejected with reason_too_short', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: 'a'.repeat(19) },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.reason_too_short');
    expect(prisma.intervention.update).not.toHaveBeenCalled();
  });

  it('400 missing reason → Zod validation.error', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 extra field is rejected by .strict()', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON, foo: 'bar' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409 already_cancelled when existing.status is cancelled', async () => {
    const prisma = buildFakePrisma({ existingStatus: 'cancelled' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.cancellation.already_cancelled');
    expect(prisma.intervention.update).not.toHaveBeenCalled();
  });

  it('404 P2025 from existing lookup', async () => {
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
      url: `/v1/interventions/${INTERVENTION_ID}/cancel`,
      headers: { authorization: 'Bearer test' },
      payload: { reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(404);
  });
});

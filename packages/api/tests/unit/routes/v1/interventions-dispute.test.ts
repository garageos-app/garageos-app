import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionDisputeRoutes from '../../../../src/routes/v1/interventions-dispute.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const INTERVENTION_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';
const OWNERSHIP_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_ID = '66666666-6666-4666-8666-666666666666';
const DISPUTE_ID = '77777777-7777-4777-8777-777777777777';

interface FakePrisma {
  intervention: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  interventionDispute: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildInterventionRow(
  overrides: Partial<{ status: 'active' | 'disputed' | 'cancelled'; vehicleId: string }> = {},
) {
  return {
    id: INTERVENTION_ID,
    vehicleId: VEHICLE_ID,
    status: 'active' as 'active' | 'disputed' | 'cancelled',
    ...overrides,
  };
}

function buildDisputeRow(
  overrides: Partial<{ status: 'open' | 'responded' | 'resolved_by_cancellation' }> = {},
) {
  return {
    id: DISPUTE_ID,
    interventionId: INTERVENTION_ID,
    customerId: CUSTOMER_ID,
    reasonCategory: 'not_performed' as const,
    customerDescription: 'a'.repeat(40),
    status: 'open' as 'open' | 'responded' | 'resolved_by_cancellation',
    createdAt: new Date('2026-04-26T10:00:00.000Z'),
    ...overrides,
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    intervention: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(buildInterventionRow()),
      update: vi.fn().mockResolvedValue({ id: INTERVENTION_ID, status: 'disputed' }),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue({ id: OWNERSHIP_ID }),
    },
    interventionDispute: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(buildDisputeRow()),
    },
    ...overrides,
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
      pool: 'clienti',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:customer_id': CUSTOMER_ID,
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
  await app.register(interventionDisputeRoutes);
  return app;
}

const validBody = {
  reasonCategory: 'not_performed',
  description:
    'Ho portato il veicolo per il cambio olio ma non ho mai richiesto la sostituzione del filtro aria.',
};

describe('POST /v1/interventions/:id/dispute — auth & validation', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for an officine-pool token', async () => {
    const officineVerifier: JwtVerifier = {
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
    app = await buildApp({ verifier: officineVerifier });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a non-UUID :id with 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/interventions/not-a-uuid/dispute',
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a description shorter than 20 chars (BR-124)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, description: 'troppo breve' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
    });
  });

  it('rejects a description longer than 2000 chars (BR-124)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, description: 'a'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown reason_category (BR-123)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, reasonCategory: 'overcharge' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body missing reason_category', async () => {
    app = await buildApp();
    const { reasonCategory: _drop, ...rest } = validBody;
    void _drop;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/interventions/:id/dispute — preconditions', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 422 attachments_not_supported when attachmentIds is non-empty', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, attachmentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'intervention.dispute.attachments_not_supported',
    });
    expect(prisma.intervention.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('accepts an explicitly empty attachmentIds array', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: { ...validBody, attachmentIds: [] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 404 when the intervention does not exist (Prisma P2025)', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.intervention.findUniqueOrThrow.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 intervention_cancelled for a cancelled intervention (BR-130)', async () => {
    prisma.intervention.findUniqueOrThrow.mockResolvedValue(
      buildInterventionRow({ status: 'cancelled' }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'intervention.dispute.intervention_cancelled',
    });
    expect(prisma.interventionDispute.create).not.toHaveBeenCalled();
  });

  it('returns 403 not_owner when the customer has no active ownership (BR-120)', async () => {
    prisma.vehicleOwnership.findFirst.mockResolvedValue(null);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'intervention.dispute.not_owner',
    });
    expect(prisma.interventionDispute.create).not.toHaveBeenCalled();
  });

  it('returns 409 already_exists when an open dispute exists (BR-122)', async () => {
    prisma.interventionDispute.findFirst.mockResolvedValue(buildDisputeRow({ status: 'open' }));
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'intervention.dispute.already_exists',
    });
    expect(prisma.interventionDispute.create).not.toHaveBeenCalled();
  });

  it('returns 409 already_exists when a responded dispute exists (BR-122)', async () => {
    prisma.interventionDispute.findFirst.mockResolvedValue(
      buildDisputeRow({ status: 'responded' }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
  });

  it('passes the BR-122 active-status filter to interventionDispute.findFirst', async () => {
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(prisma.interventionDispute.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          interventionId: INTERVENTION_ID,
          customerId: CUSTOMER_ID,
          status: { in: ['open', 'responded'] },
        }),
      }),
    );
  });
});

describe('POST /v1/interventions/:id/dispute — happy path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('creates the dispute, flips intervention.status, and returns 201 with the new state', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      dispute: { id: string; interventionId: string; status: string };
      interventionStatus: string;
    };
    expect(body.dispute.id).toBe(DISPUTE_ID);
    expect(body.dispute.interventionId).toBe(INTERVENTION_ID);
    expect(body.dispute.status).toBe('open');
    expect(body.interventionStatus).toBe('disputed');

    expect(prisma.interventionDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          interventionId: INTERVENTION_ID,
          customerId: CUSTOMER_ID,
          reasonCategory: 'not_performed',
          customerDescription: validBody.description,
        }),
      }),
    );
    expect(prisma.intervention.update).toHaveBeenCalledWith({
      where: { id: INTERVENTION_ID },
      data: { status: 'disputed' },
    });
  });

  it('skips the intervention.status UPDATE when already disputed (idempotent BR-127)', async () => {
    prisma.intervention.findUniqueOrThrow.mockResolvedValue(
      buildInterventionRow({ status: 'disputed' }),
    );
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.interventionDispute.create).toHaveBeenCalledTimes(1);
    expect(prisma.intervention.update).not.toHaveBeenCalled();
    expect((res.json() as { interventionStatus: string }).interventionStatus).toBe('disputed');
  });

  it('runs the transaction with role:admin (RLS escape hatch)', async () => {
    const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
    app = await buildApp({ prisma, withContext });
    await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'admin' }),
      expect.any(Function),
    );
  });

  it('proceeds when a previously closed dispute exists for the same customer (BR-122 not blocking)', async () => {
    // findFirst is filtered by status IN (open, responded); a closed
    // dispute (resolved_by_cancellation, escalated, closed_by_admin)
    // does not match, so findFirst returns null → the route inserts.
    prisma.interventionDispute.findFirst.mockResolvedValue(null);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${INTERVENTION_ID}/dispute`,
      headers: { authorization: 'Bearer x' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
  });
});

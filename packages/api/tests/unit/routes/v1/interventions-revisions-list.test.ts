import { Buffer } from 'node:buffer';

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeCompoundCursor, encodeCompoundCursor } from '../../../../src/lib/cursor.js';
import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import interventionRevisionsListRoutes, {
  filterRevisionsForCustomer,
  revisionsListQuerySchema,
} from '../../../../src/routes/v1/interventions-revisions-list.js';

describe('revisionsListQuerySchema', () => {
  it('applies default limit=20 when omitted', () => {
    const parsed = revisionsListQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces limit string to int', () => {
    const parsed = revisionsListQuerySchema.parse({ limit: '15' });
    expect(parsed.limit).toBe(15);
  });

  it('rejects limit=0', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above max=50', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('rejects negative limit', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: -1 })).toThrow();
  });

  it('accepts valid cursor string', () => {
    const parsed = revisionsListQuerySchema.parse({ cursor: 'eyJyYSI6IngifQ' });
    expect(parsed.cursor).toBe('eyJyYSI6IngifQ');
  });
});

describe('encodeCompoundCursor / decodeCompoundCursor (ra field)', () => {
  it('roundtrips a valid cursor', () => {
    const ra = '2026-04-27T10:15:00.000Z';
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const decoded = decodeCompoundCursor('ra', encodeCompoundCursor('ra', ra, id));
    expect(decoded).toEqual({ ra, id });
  });

  it('decodes invalid base64 → undefined', () => {
    expect(decodeCompoundCursor('ra', '!!!!')).toBeUndefined();
  });

  it('decodes JSON missing ra → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(decodeCompoundCursor('ra', bogus)).toBeUndefined();
  });

  it('decodes JSON missing id → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ ra: '2026-04-27T10:00:00Z' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCompoundCursor('ra', bogus)).toBeUndefined();
  });

  it('decodes undefined input → undefined', () => {
    expect(decodeCompoundCursor('ra', undefined)).toBeUndefined();
  });
});

describe('filterRevisionsForCustomer', () => {
  function makeRow(changes: unknown) {
    return {
      id: 'row-1',
      revisedAt: new Date('2026-04-27T10:00:00Z'),
      reason: 'r',
      changes,
    };
  }

  it('strips internalNotes but preserves other fields', () => {
    const row = makeRow({
      title: { from: 'A', to: 'B' },
      internalNotes: { from: 'X', to: 'Y' },
    });
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(1);
    expect(out[0]!.changes).toEqual({ title: { from: 'A', to: 'B' } });
  });

  it('drops a row whose only change was internalNotes', () => {
    const row = makeRow({ internalNotes: { from: 'X', to: 'Y' } });
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with non-object changes (defensive)', () => {
    const row = makeRow('not-an-object');
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with null changes', () => {
    const row = makeRow(null);
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with array changes (defensive)', () => {
    const row = makeRow([{ title: 'x' }]);
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('preserves order of input rows', () => {
    const a = { ...makeRow({ title: { from: 'A1', to: 'A2' } }), id: 'a' };
    const b = { ...makeRow({ description: { from: 'B1', to: 'B2' } }), id: 'b' };
    const c = { ...makeRow({ title: { from: 'C1', to: 'C2' } }), id: 'c' };
    const out = filterRevisionsForCustomer([a, b, c]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips multiple internalNotes-only rows in a sequence', () => {
    const a = { ...makeRow({ internalNotes: { from: 'X', to: 'Y' } }), id: 'a' };
    const b = { ...makeRow({ title: { from: 'B1', to: 'B2' } }), id: 'b' };
    const c = { ...makeRow({ internalNotes: { from: 'P', to: 'Q' } }), id: 'c' };
    const out = filterRevisionsForCustomer([a, b, c]);
    expect(out.map((r) => r.id)).toEqual(['b']);
  });
});

// --- Route-level tests (dual-pool: officine own-only, clienti unchanged) ---

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const COGNITO_SUB = '33333333-3333-4333-8333-333333333333';
const INTERVENTION_ID = '44444444-4444-4444-8444-444444444444';
const VEHICLE_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';

// A revision touching a public field — visible everywhere.
const REVISION_ROW_PUBLIC = {
  id: 'rev-public',
  revisedAt: new Date('2026-04-26T12:00:00Z'),
  reason: 'public change',
  changes: { title: { from: 'A', to: 'B' } },
  user: { id: USER_ID, firstName: 'Mario', lastName: 'Rossi' },
  intervention: { tenant: { businessName: 'Officina Rossi' } },
};
// A revision touching ONLY the reserved internalNotes field — the
// customer/redacted view drops this row entirely (BR-065); the owning
// officina still sees it (full trail).
const REVISION_ROW_INTERNAL_ONLY = {
  id: 'rev-internal',
  revisedAt: new Date('2026-04-26T11:00:00Z'),
  reason: 'internal only',
  changes: { internalNotes: { from: 'x', to: 'y' } },
  user: { id: USER_ID, firstName: 'Mario', lastName: 'Rossi' },
  intervention: { tenant: { businessName: 'Officina Rossi' } },
};

interface FakePrisma {
  intervention: {
    findFirst: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  interventionRevision: { findMany: ReturnType<typeof vi.fn> };
  // tenantContext (officina preHandler) does its own reactive lookup on
  // request.server.prisma (not the withContext-scoped tx) — see
  // src/middleware/tenant-context.ts. Required for any officina-pool
  // request to reach the handler at all.
  user: { findFirst: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    intervention: {
      findFirst: vi.fn().mockResolvedValue({ id: INTERVENTION_ID }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: INTERVENTION_ID, vehicleId: VEHICLE_ID }),
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ownership-id' }),
    },
    interventionRevision: {
      findMany: vi.fn().mockResolvedValue([REVISION_ROW_PUBLIC, REVISION_ROW_INTERNAL_ONLY]),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'user-uuid' }),
    },
    ...overrides,
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
  withContext?: ReturnType<typeof vi.fn>;
}

function officineVerifierFor(tenantId: string): JwtVerifier {
  return {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': tenantId,
        'custom:role': 'mechanic',
      },
    }),
  };
}

const clientiVerifier: JwtVerifier = {
  verify: async (): Promise<VerifyResult> => ({
    pool: 'clienti',
    payload: {
      sub: COGNITO_SUB,
      token_use: 'id',
      'custom:customer_id': CUSTOMER_ID,
    },
  }),
};

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const withContext = deps.withContext ?? vi.fn(async (_ctx, fn) => fn(prisma));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', deps.verifier ?? officineVerifierFor(TENANT_ID));
  await app.register(interventionRevisionsListRoutes);
  return app;
}

interface RevisionResponseItem {
  id: string;
  revised_at: string;
  reason: string | null;
  changes: Record<string, unknown>;
  user?: { id: string; first_name: string; last_name: string };
  tenant?: { business_name: string };
}

describe('GET /v1/interventions/:id/revisions (officine pool — own-only)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 intervention.not_found for a foreign-tenant intervention', async () => {
    // Dynamic: simulate app-layer scoping — only a lookup carrying the
    // OWNING tenant's id resolves a row; any other tenantId (including
    // the caller's own, foreign, tenantId) resolves to null.
    const findFirst = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === INTERVENTION_ID && where.tenantId === TENANT_ID
          ? { id: INTERVENTION_ID }
          : null,
      );
    const prisma = buildFakePrisma({
      intervention: { findFirst, findUniqueOrThrow: vi.fn() },
    });
    app = await buildApp({ verifier: officineVerifierFor(FOREIGN_TENANT_ID), prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'intervention.not_found' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTERVENTION_ID, tenantId: FOREIGN_TENANT_ID },
      }),
    );
  });

  it('returns 404 intervention.not_found for a non-existent intervention id', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildFakePrisma({
      intervention: { findFirst, findUniqueOrThrow: vi.fn() },
    });
    app = await buildApp({ verifier: officineVerifierFor(TENANT_ID), prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'intervention.not_found' });
  });

  it('returns the full, unredacted audit trail (with user identity) for the owning tenant', async () => {
    const findFirst = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === INTERVENTION_ID && where.tenantId === TENANT_ID
          ? { id: INTERVENTION_ID }
          : null,
      );
    const prisma = buildFakePrisma({
      intervention: { findFirst, findUniqueOrThrow: vi.fn() },
    });
    app = await buildApp({ verifier: officineVerifierFor(TENANT_ID), prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: RevisionResponseItem[] };
    // Both rows present — including the internalNotes-only one — because
    // the owning officina is NOT run through filterRevisionsForCustomer.
    expect(body.data).toHaveLength(2);
    expect(body.data.every((d) => d.user !== undefined)).toBe(true);
    expect(body.data.every((d) => d.tenant === undefined)).toBe(true);

    const internalOnly = body.data.find((d) => d.id === 'rev-internal');
    expect(internalOnly).toBeDefined();
    expect('internalNotes' in internalOnly!.changes).toBe(true);
    expect(internalOnly!.user).toEqual({
      id: USER_ID,
      first_name: 'Mario',
      last_name: 'Rossi',
    });
  });

  it('does not call intervention.findUniqueOrThrow on the officina branch', async () => {
    const findUniqueOrThrow = vi.fn();
    const prisma = buildFakePrisma({
      intervention: {
        findFirst: vi.fn().mockResolvedValue({ id: INTERVENTION_ID }),
        findUniqueOrThrow,
      },
    });
    app = await buildApp({ verifier: officineVerifierFor(TENANT_ID), prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('does not call vehicleOwnership.findFirst on the officina branch', async () => {
    const ownershipFindFirst = vi.fn();
    const prisma = buildFakePrisma({
      vehicleOwnership: { findFirst: ownershipFindFirst },
    });
    app = await buildApp({ verifier: officineVerifierFor(TENANT_ID), prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(ownershipFindFirst).not.toHaveBeenCalled();
  });
});

describe('GET /v1/interventions/:id/revisions (clienti pool — unchanged)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('uses findUniqueOrThrow({id}) — not the officina-only tenant-scoped findFirst', async () => {
    const findFirst = vi.fn();
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ id: INTERVENTION_ID, vehicleId: VEHICLE_ID });
    const prisma = buildFakePrisma({ intervention: { findFirst, findUniqueOrThrow } });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: INTERVENTION_ID },
      select: { id: true, vehicleId: true },
    });
  });

  it('returns 404 when the intervention does not exist (P2025 from findUniqueOrThrow)', async () => {
    const { Prisma } = await import('@garageos/database');
    const notFound = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const prisma = buildFakePrisma({
      intervention: {
        findFirst: vi.fn(),
        findUniqueOrThrow: vi.fn().mockRejectedValue(notFound),
      },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 intervention.revisions.not_owner when the customer has no active ownership', async () => {
    // Dynamic: ownership lookup is scoped to THIS caller's customerId;
    // simulate no active row for it (any other customerId would match).
    const ownershipFindFirst = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { customerId: string } }) =>
        where.customerId === CUSTOMER_ID ? null : { id: 'someone-elses-ownership' },
      );
    const prisma = buildFakePrisma({
      vehicleOwnership: { findFirst: ownershipFindFirst },
    });
    app = await buildApp({ verifier: clientiVerifier, prisma });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'intervention.revisions.not_owner' });
    expect(ownershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
          endedAt: null,
        }),
      }),
    );
  });

  it('strips internalNotes, drops internalNotes-only rows, and uses the tenant shape (no user)', async () => {
    app = await buildApp({ verifier: clientiVerifier });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${INTERVENTION_ID}/revisions`,
      headers: { authorization: 'Bearer valid.jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: RevisionResponseItem[] };
    // The internalNotes-only row is dropped entirely (BR-065); only the
    // public-field row survives.
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe('rev-public');
    expect('internalNotes' in body.data[0]!.changes).toBe(false);
    expect(body.data[0]!.tenant).toEqual({ business_name: 'Officina Rossi' });
    expect(body.data[0]!.user).toBeUndefined();
  });
});

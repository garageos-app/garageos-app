// Unit tests for POST /v1/admin/tenants — Slice 1 platform-admin create-tenant endpoint.
//
// Pattern: FakePrisma + module-level vi.mock for cognito / ses-client / secure-tokens,
// modeled on packages/api/tests/unit/routes/v1/customers-create.test.ts.
//
// The platform-admins JWT verifier mock returns pool:'platform-admins' so
// requirePlatformAdminsPool passes. Officine/clienti verifiers trigger 403.
// withContext is mocked as (_ctx, fn) => fn(prisma) — one call per request.

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import { adminTenantsCreateRoutes } from '../../../../src/routes/v1/admin-tenants-create.js';

// ---- Module mocks (hoisted by vitest transform) ----

vi.mock('../../../../src/lib/cognito.js', () => {
  class CognitoUnavailableError extends Error {
    override name = 'CognitoUnavailableError';
    constructor(message: string) {
      super(message);
    }
  }
  return {
    getOfficineUserByEmail: vi.fn().mockResolvedValue({ exists: false }),
    CognitoUnavailableError,
  };
});

vi.mock('../../../../src/lib/ses-client.js', () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/lib/secure-tokens.js', () => ({
  generateInvitationToken: vi.fn().mockReturnValue({
    plaintext: 'test-token-abc123',
    hash: 'test-hash-abc123',
  }),
}));

import { getOfficineUserByEmail, CognitoUnavailableError } from '../../../../src/lib/cognito.js';
import { sendInvitationEmail } from '../../../../src/lib/ses-client.js';
import { generateInvitationToken } from '../../../../src/lib/secure-tokens.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const ADMIN_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const INVITATION_ID = '33333333-3333-4333-8333-333333333333';

// ─── FakePrisma ───────────────────────────────────────────────────────────────
interface FakePrisma {
  tenant: { create: ReturnType<typeof vi.fn> };
  location: { create: ReturnType<typeof vi.fn> };
  invitation: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    tenant: {
      create: vi.fn().mockResolvedValue({
        id: TENANT_ID,
        businessName: 'Test Officina SRL',
        vatNumber: '12345678901',
        status: 'pending',
      }),
    },
    location: {
      create: vi.fn().mockResolvedValue({ id: LOCATION_ID }),
    },
    invitation: {
      // Default: no pending cross-tenant invitation — happy path proceeds.
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: INVITATION_ID,
        expiresAt: new Date('2026-07-05T00:00:00.000Z'),
      }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-log-1' }),
    },
    ...overrides,
  };
}

// ─── JWT verifiers ────────────────────────────────────────────────────────────
const platformAdminVerifier: JwtVerifier = {
  verify: async (): Promise<VerifyResult> => ({
    pool: 'platform-admins',
    payload: {
      sub: ADMIN_SUB,
      token_use: 'id',
      given_name: 'Admin',
      family_name: 'GarageOS',
      email: 'admin@garageos.it',
    },
  }),
};

const officineVerifier: JwtVerifier = {
  verify: async (): Promise<VerifyResult> => ({
    pool: 'officine',
    payload: {
      sub: ADMIN_SUB,
      token_use: 'id',
      'custom:tenant_id': TENANT_ID,
      'custom:role': 'super_admin',
    },
  }),
};

const clientiVerifier: JwtVerifier = {
  verify: async (): Promise<VerifyResult> => ({
    pool: 'clienti',
    payload: { sub: ADMIN_SUB, token_use: 'id' },
  }),
};

// ─── App factory ──────────────────────────────────────────────────────────────
interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const fakeWithContext = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma),
  );
  const verifier = deps.verifier ?? platformAdminVerifier;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(adminTenantsCreateRoutes);
  return app;
}

// ─── Request helpers ──────────────────────────────────────────────────────────
const VALID_BODY = {
  businessName: 'Test Officina SRL',
  vatNumber: '12345678901',
  email: 'officina@test.it',
  ownerFirstName: 'Mario',
  ownerLastName: 'Rossi',
  ownerEmail: 'mario@test.it',
};

function post(app: FastifyInstance, body: unknown, authed = true) {
  return app.inject({
    method: 'POST',
    url: '/v1/admin/tenants',
    headers: {
      ...(authed ? { authorization: 'Bearer x' } : {}),
      'content-type': 'application/json',
    },
    payload: body as object,
  });
}

// ─── describe 1: auth & Zod validation ───────────────────────────────────────
describe('POST /v1/admin/tenants — auth & Zod validation', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  // Case 1
  it('returns 401 without Authorization header', async () => {
    app = await buildApp();
    const res = await post(app, VALID_BODY, false);
    expect(res.statusCode).toBe(401);
  });

  // Case 2
  it('returns 403 for officine pool token', async () => {
    app = await buildApp({ verifier: officineVerifier });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(403);
  });

  // Case 3
  it('returns 403 for clienti pool token', async () => {
    app = await buildApp({ verifier: clientiVerifier });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(403);
  });

  // Case 4
  it('returns 400 when businessName is missing (Zod)', async () => {
    app = await buildApp();
    const bodyMissingName = {
      vatNumber: VALID_BODY.vatNumber,
      email: VALID_BODY.email,
      ownerFirstName: VALID_BODY.ownerFirstName,
      ownerLastName: VALID_BODY.ownerLastName,
      ownerEmail: VALID_BODY.ownerEmail,
    };
    const res = await post(app, bodyMissingName);
    expect(res.statusCode).toBe(400);
  });
});

// ─── describe 2: business logic ───────────────────────────────────────────────
describe('POST /v1/admin/tenants — business logic', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;

  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
    // Reset module-level mock state after vi.clearAllMocks would clear it.
    // Restore safe defaults so each test starts clean.
    vi.mocked(getOfficineUserByEmail).mockResolvedValue({ exists: false });
    vi.mocked(sendInvitationEmail).mockResolvedValue(undefined);
    vi.mocked(generateInvitationToken).mockReturnValue({
      plaintext: 'test-token-abc123',
      hash: 'test-hash-abc123',
    });
  });
  afterEach(async () => {
    await app?.close();
  });

  // Case 5
  it('returns 400 tenant.vat_number_invalid for non-11-digit VAT; tenant.create NOT called', async () => {
    app = await buildApp({ prisma });
    const res = await post(app, { ...VALID_BODY, vatNumber: '123456' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('tenant.vat_number_invalid');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  // Case 6
  it('returns 201 on happy path with all DB inserts and email called correctly', async () => {
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(201);

    // tenant.create called once
    expect(prisma.tenant.create).toHaveBeenCalledTimes(1);

    // sede-unica: no location.create — tenant has no separate Location row
    expect(prisma.location.create).not.toHaveBeenCalled();

    // invitation.create called with role:'super_admin' and invitationType:'internal_user'
    expect(prisma.invitation.create).toHaveBeenCalledTimes(1);
    const invArg = prisma.invitation.create.mock.calls[0]![0] as {
      data: { role: string; invitationType: string };
    };
    expect(invArg.data.role).toBe('super_admin');
    expect(invArg.data.invitationType).toBe('internal_user');

    // auditLog.create called with action:'tenant_created' and actorType:'system'
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; actorType: string };
    };
    expect(auditArg.data.action).toBe('tenant_created');
    expect(auditArg.data.actorType).toBe('system');

    // sendInvitationEmail called with magicLinkUrl ending /invitations/<token> and role:'super_admin'
    expect(sendInvitationEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendInvitationEmail).mock.calls[0]![0];
    expect(emailArg.magicLinkUrl).toContain('/invitations/test-token-abc123');
    expect(emailArg.role).toBe('super_admin');

    // Response has invitation.emailSent:true and no token field
    const body = res.json() as {
      invitation: { emailSent: boolean };
      token?: unknown;
    };
    expect(body.invitation.emailSent).toBe(true);
    expect(body.token).toBeUndefined();
  });

  // Case 7
  it('returns 409 user.invitation.email_in_other_tenant when owner email exists in Cognito; tenant.create NOT called', async () => {
    vi.mocked(getOfficineUserByEmail).mockResolvedValue({
      exists: true,
      sub: 'some-sub',
      attributes: {},
    });
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('user.invitation.email_in_other_tenant');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  // Case 8
  it('returns 502 auth.cognito_unavailable when Cognito throws CognitoUnavailableError', async () => {
    vi.mocked(getOfficineUserByEmail).mockRejectedValueOnce(
      new CognitoUnavailableError('Cognito SDK error'),
    );
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('auth.cognito_unavailable');
  });

  // Case 9
  it('returns 409 tenant.vat_number_duplicate when tenant.create throws P2002', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.tenant.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('tenant.vat_number_duplicate');
  });

  // Case 10
  it('returns 201 with emailSent:false when sendInvitationEmail throws; tenant still persisted', async () => {
    vi.mocked(sendInvitationEmail).mockRejectedValueOnce(new Error('SES timeout'));
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { invitation: { emailSent: boolean } };
    expect(body.invitation.emailSent).toBe(false);
    expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
  });

  // Case 11 — F1: cross-tenant pending-invitation collision
  it('returns 409 user.invitation.email_in_other_tenant when a pending internal_user invite exists in another tenant; tenant.create NOT called', async () => {
    // DB pre-check finds a non-null pending invite → 409 before the creation tx.
    prisma.invitation.findFirst.mockResolvedValueOnce({ id: 'existing-pending-invite-id' });
    app = await buildApp({ prisma });
    const res = await post(app, VALID_BODY);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('user.invitation.email_in_other_tenant');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  // Case 12 — F3: whitespace-only string must be rejected by server Zod validation
  it('returns 400 when businessName is whitespace-only (trim then min(1)); tenant.create NOT called', async () => {
    app = await buildApp({ prisma });
    const res = await post(app, { ...VALID_BODY, businessName: '   ' });
    expect(res.statusCode).toBe(400);
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });
});

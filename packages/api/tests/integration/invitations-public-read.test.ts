// Integration tests for GET /v1/invitations/:token — F-OFF-004 public read.
// Public (no auth) endpoint; token is the credential.
//
// Helper pattern mirrors users-invitations-list-revoke.test.ts (T7):
//   buildTestServer / createTenantWithLocation / pgAdmin / resetDb.
// No JWT token needed: route has no preHandler chain.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { hashToken } from '../../src/lib/secure-tokens.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Helper: insert an invitation row directly via pgAdmin (bypasses RLS).
// Mirrors the createInvitation helper in users-invitations-list-revoke.test.ts.
async function createInvitation(params: {
  tenantId: string;
  targetEmail: string;
  invitationType?: 'internal_user' | 'customer_app';
  firstName?: string;
  lastName?: string;
  role?: 'super_admin' | 'mechanic';
  token?: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}): Promise<{ invitationId: string; token: string }> {
  const {
    tenantId,
    targetEmail,
    invitationType = 'internal_user',
    firstName = 'Test',
    lastName = 'User',
    role = 'mechanic',
    token = `tok-${crypto.randomUUID()}`,
    expiresAt = new Date(Date.now() + 7 * 86400000),
    acceptedAt = null,
  } = params;
  const tokenHash = hashToken(token);
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, first_name, last_name,
        role, token_hash, expires_at, accepted_at, created_at)
     VALUES (gen_random_uuid(), $1, $2::"InvitationType", $3, $4, $5,
        $6::"UserRole", $7, $8, $9, NOW())
     RETURNING id`,
    [
      tenantId,
      invitationType,
      targetEmail,
      firstName,
      lastName,
      role,
      tokenHash,
      expiresAt,
      acceptedAt,
    ],
  );
  return { invitationId: rows[0]!.id, token };
}

// Helper: insert a customer_app invitation (no role column — null allowed).
async function createCustomerAppInvitation(params: {
  tenantId: string;
  targetEmail: string;
  token?: string;
  expiresAt?: Date;
}): Promise<{ invitationId: string; token: string }> {
  const {
    tenantId,
    targetEmail,
    token = `tok-${crypto.randomUUID()}`,
    expiresAt = new Date(Date.now() + 7 * 86400000),
  } = params;
  const tokenHash = hashToken(token);
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email,
        token_hash, expires_at, created_at)
     VALUES (gen_random_uuid(), $1, 'customer_app'::"InvitationType", $2,
        $3, $4, NOW())
     RETURNING id`,
    [tenantId, targetEmail, tokenHash, expiresAt],
  );
  return { invitationId: rows[0]!.id, token };
}

describe('GET /v1/invitations/:token', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('returns public view for valid pending invitation', async () => {
    const suffix = `pub-read-ok-${crypto.randomUUID().slice(0, 8)}`;
    const { tenantId } = await createTenantWithLocation(suffix);

    // Fetch the known fixture values seeded by createTenantWithLocation.
    const { rows: tRows } = await pgAdmin.query<{ business_name: string }>(
      `SELECT business_name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const expectedTenantName = tRows[0]!.business_name;

    const { token } = await createInvitation({
      tenantId,
      targetEmail: 'mario@x.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'mechanic',
      token: `public-token-${suffix}`,
    });

    const res = await app.inject({ method: 'GET', url: `/v1/invitations/${token}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      invitation: {
        targetEmail: string;
        firstName: string;
        lastName: string;
        role: string;
        tenantName: string;
        expiresAt: string;
      };
    };

    expect(body.invitation.targetEmail).toBe('mario@x.com');
    expect(body.invitation.firstName).toBe('Mario');
    expect(body.invitation.lastName).toBe('Rossi');
    expect(body.invitation.role).toBe('mechanic');
    // tenantName is sourced from tenant.businessName (see adaptation note).
    expect(body.invitation.tenantName).toBe(expectedTenantName);
    // sede-unica: locationName removed from invitation public read response.
    expect(body.invitation.expiresAt).toBeDefined();

    // Response must NOT expose internal fields (anti-enum).
    expect(body.invitation).not.toHaveProperty('id');
    expect(body.invitation).not.toHaveProperty('token');
    expect(body.invitation).not.toHaveProperty('locationId');
    expect(body.invitation).not.toHaveProperty('acceptedAt');
    expect(body.invitation).not.toHaveProperty('createdAt');
  });

  it('returns 404 + code user.invitation.not_found for unknown token (anti-enum)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/invitations/unknown-xyz' });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user.invitation.not_found');
  });

  it('returns 404 for already-consumed invitation (anti-enum)', async () => {
    const { tenantId } = await createTenantWithLocation(
      `pub-read-consumed-${crypto.randomUUID().slice(0, 8)}`,
    );
    const { token } = await createInvitation({
      tenantId,
      targetEmail: 'consumed@x.com',
      acceptedAt: new Date(),
    });

    const res = await app.inject({ method: 'GET', url: `/v1/invitations/${token}` });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for expired invitation (anti-enum)', async () => {
    const { tenantId } = await createTenantWithLocation(
      `pub-read-expired-${crypto.randomUUID().slice(0, 8)}`,
    );
    const { token } = await createInvitation({
      tenantId,
      targetEmail: 'expired@x.com',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({ method: 'GET', url: `/v1/invitations/${token}` });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for customer_app invitation type (this route is internal_user only)', async () => {
    const { tenantId } = await createTenantWithLocation(
      `pub-read-custapp-${crypto.randomUUID().slice(0, 8)}`,
    );
    const { token } = await createCustomerAppInvitation({
      tenantId,
      targetEmail: 'cust@x.com',
    });

    const res = await app.inject({ method: 'GET', url: `/v1/invitations/${token}` });

    expect(res.statusCode).toBe(404);
  });
});

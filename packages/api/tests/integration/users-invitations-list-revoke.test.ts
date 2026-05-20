// Integration tests for GET + DELETE /v1/users/invitations — F-OFF-004.
// List pending invitations and revoke (tombstone) them.
//
// Helper pattern mirrors users-invitations-create.test.ts (T6):
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / pgAdmin / resetDb.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { hashToken } from '../../src/lib/secure-tokens.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Helper: insert an invitation row directly via pgAdmin (bypasses RLS).
async function createInvitation(params: {
  tenantId: string;
  targetEmail: string;
  firstName?: string;
  lastName?: string;
  role?: 'super_admin' | 'mechanic';
  locationId?: string | null;
  token?: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}): Promise<{ invitationId: string }> {
  const {
    tenantId,
    targetEmail,
    firstName = 'Test',
    lastName = 'User',
    role = 'mechanic',
    locationId = null,
    token = `tok-${crypto.randomUUID()}`,
    expiresAt = new Date(Date.now() + 7 * 86400000),
    acceptedAt = null,
  } = params;
  const tokenHash = hashToken(token);
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, first_name, last_name,
        role, location_id, token_hash, expires_at, accepted_at, created_at)
     VALUES (gen_random_uuid(), $1, 'internal_user'::"InvitationType", $2, $3, $4,
        $5::"UserRole", $6, $7, $8, $9, NOW())
     RETURNING id`,
    [
      tenantId,
      targetEmail,
      firstName,
      lastName,
      role,
      locationId,
      tokenHash,
      expiresAt,
      acceptedAt,
    ],
  );
  return { invitationId: rows[0]!.id };
}

describe('GET + DELETE /v1/users/invitations', () => {
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

  it('GET returns only pending (non-accepted, non-expired) invitations of tenant', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('inv-list-ok');
    const adminSub = `sa-list-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-list@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    // Pending — should appear.
    await createInvitation({ tenantId, targetEmail: 'a@x.com', locationId });
    // Already accepted (tombstone) — must be excluded.
    await createInvitation({
      tenantId,
      targetEmail: 'b@x.com',
      locationId,
      acceptedAt: new Date(),
    });
    // Expired — must be excluded.
    await createInvitation({
      tenantId,
      targetEmail: 'c@x.com',
      locationId,
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { invitations: Array<{ targetEmail: string }> };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.targetEmail).toBe('a@x.com');
  });

  it('DELETE marks invitation as accepted (tombstone) + audits with user_invitation_revoked', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('inv-revoke-ok');
    const adminSub = `sa-revoke-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-revoke@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const { invitationId } = await createInvitation({
      tenantId,
      targetEmail: 'm@x.com',
      locationId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/invitations/${invitationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);

    // Tombstone: acceptedAt must be set.
    const { rows: invRows } = await pgAdmin.query<{ accepted_at: Date | null }>(
      `SELECT accepted_at FROM invitations WHERE id = $1`,
      [invitationId],
    );
    expect(invRows[0]!.accepted_at).not.toBeNull();

    // Audit log must exist with action = 'user_invitation_revoked'.
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT action, entity_type, entity_id
         FROM audit_logs
        WHERE entity_type = 'invitation' AND entity_id = $1
        LIMIT 1`,
      [invitationId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('user_invitation_revoked');
  });

  it('DELETE returns 404 for non-existent invitation', async () => {
    const { tenantId } = await createTenantWithLocation('inv-404');
    const adminSub = `sa-404-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-404@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    // crypto.randomUUID() produces a valid UUID V4 — avoids Zod validation
    // rejecting the UUID before the DB lookup (see feedback_zod_v4_uuid_strict_version).
    const nonExistentId = crypto.randomUUID();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/invitations/${nonExistentId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE returns 404 for cross-tenant invitation (tenant isolation)', async () => {
    const { tenantId: t1Id, locationId: t1LocId } = await createTenantWithLocation('inv-cross-t1');
    const { tenantId: t2Id } = await createTenantWithLocation('inv-cross-t2');

    const sa2Sub = `sa-cross2-${crypto.randomUUID()}`;
    await createUser({
      tenantId: t2Id,
      cognitoSub: sa2Sub,
      email: 'sa-cross2@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: sa2Sub,
      tenantId: t2Id,
      role: 'super_admin',
    });

    // Invitation belongs to tenant 1.
    const { invitationId } = await createInvitation({
      tenantId: t1Id,
      targetEmail: 'cross@x.com',
      locationId: t1LocId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/invitations/${invitationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Must be 404 — not 403 — to avoid leaking that the invitation exists.
    expect(res.statusCode).toBe(404);
  });

  it('DELETE returns 410 with code user.invitation.already_accepted for already-tombstoned invitation', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('inv-410');
    const adminSub = `sa-410-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-410@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    // Seed already-accepted invitation (tombstoned via acceptedAt).
    const { invitationId } = await createInvitation({
      tenantId,
      targetEmail: 'acc@x.com',
      locationId,
      acceptedAt: new Date(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/invitations/${invitationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(410);
    expect((res.json() as { code: string }).code).toBe('user.invitation.already_accepted');
  });
});

// Integration tests for POST /v1/users/invitations — F-OFF-004.
// Uses aws-sdk-client-mock to intercept SES calls without hitting AWS.
// Actual helpers mirror users-list.test.ts (T5 pattern):
//   buildTestServer / createTenantWithLocation / createUser / signTestToken / resetDb.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { _resetSesClientForTests } from '../../src/lib/ses-client.js';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

const sesMock = mockClient(SESv2Client);

describe('POST /v1/users/invitations', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // Reset the ses-client singleton so aws-sdk-client-mock hooks the fresh
    // SESv2Client instance created on next call (same pattern as other SES tests).
    _resetSesClientForTests();
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
  });

  it('creates an invitation + sends SES email (happy path)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('inv-create-ok');
    const adminSub = `sa-inv-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin@inv.test',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'mario@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        role: 'mechanic',
        locationId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { invitation: Record<string, unknown> };
    expect(body.invitation.targetEmail).toBe('mario@example.com');
    expect(body.invitation.role).toBe('mechanic');
    expect(body.invitation.locationId).toBe(locationId);
    expect(body.invitation.expiresAt).toBeDefined();
    // Plaintext token must never be exposed in the response (security invariant).
    expect(body.invitation).not.toHaveProperty('token');

    // SES send was called exactly once.
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);

    // Audit log row must be created with actor traced to the inviting user.
    const invitationId = body.invitation.id as string;
    const { rows: auditRows } = await pgAdmin.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_id: string | null;
    }>(
      `SELECT action, entity_type, entity_id, actor_id
         FROM audit_logs
        WHERE entity_type = 'invitation' AND entity_id = $1
        LIMIT 1`,
      [invitationId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('user_invitation_created');
    // actorId must be populated — the handler looks up the Super Admin's DB UUID.
    expect(auditRows[0]!.actor_id).not.toBeNull();
  });

  it('rejects mechanic role without locationId (BR-204)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-br204');
    const adminSub = `sa-br204-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-br204@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
        locationId: null,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('user.location_required_for_mechanic');
  });

  it('rejects email collision with an existing active user (409)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-collision');
    const adminSub = `sa-col-${crypto.randomUUID()}`;
    const existingSub = `ex-col-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-col@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId,
      cognitoSub: existingSub,
      email: 'existing@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'existing@test.it',
        firstName: 'X',
        lastName: 'Y',
        role: 'super_admin',
        locationId: null,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('user.invitation.email_already_active');
  });

  it('rejects duplicate pending invitation — partial unique index (BR-206)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('inv-dup');
    const adminSub = `sa-dup-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-dup@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });
    const payload = {
      email: 'mario@dup.test',
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'mechanic' as const,
      locationId,
    };

    // First invite — should succeed.
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res1.statusCode).toBe(201);

    // Duplicate — same email + same tenant + still pending = P2002 on partial unique index.
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('user.invitation.duplicate_pending');
  });

  it('returns 201 even when SES send fails (best-effort)', async () => {
    // Override mock: SES throws on send.
    sesMock.on(SendEmailCommand).rejects(new Error('SES sandbox'));

    const { tenantId, locationId } = await createTenantWithLocation('inv-ses-fail');
    const adminSub = `sa-sesfail-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa-sesfail@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'nomail@sesfail.test',
        firstName: 'No',
        lastName: 'Mail',
        role: 'mechanic',
        locationId,
      },
    });

    // Best-effort: 201 even if SES failed.
    expect(res.statusCode).toBe(201);
    // DB row must still exist — verified directly in the DB, not just via
    // the response body (mirrors the feedback_integration_test_mirror_frontend_wire
    // pattern: test what's actually persisted, not what the handler echoes back).
    const body = res.json() as { invitation: { id: string } };
    expect(body.invitation.id).toBeDefined();
    const { rows: invRows } = await pgAdmin.query<{ id: string; target_email: string }>(
      `SELECT id, target_email FROM invitations WHERE target_email = $1 LIMIT 1`,
      ['nomail@sesfail.test'],
    );
    expect(invRows).toHaveLength(1);
    expect(invRows[0]!.id).toBe(body.invitation.id);
  });

  it('blocks mechanic role with 403 (requireSuperAdmin)', async () => {
    const { tenantId } = await createTenantWithLocation('inv-403');
    const mechSub = `mech-403-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: mechSub,
      email: 'mech-403@test.it',
      role: 'mechanic',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'mechanic',
        locationId: null,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });
});

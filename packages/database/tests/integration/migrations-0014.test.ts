import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// Migration 20260519000000 — partial unique index uq_invitations_pending_internal.
// BR-206: at most one pending internal_user invitation per (tenant_id, target_email).
// Customer-app invitations are intentionally not constrained (BR-205 resend semantics).

describe('Migration 0014 — invitations partial unique index', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function createTenant(): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [
        `Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        String(Math.floor(Math.random() * 1e11)).padStart(11, '0'),
        `tenant-${Math.random().toString(36).slice(2, 8)}@test.local`,
      ],
    );
    return rows[0]!.id;
  }

  async function createInvitation(opts: {
    tenantId: string;
    invitationType: 'internal_user' | 'customer_app';
    targetEmail: string;
    token: string;
    acceptedAt?: Date | null;
  }): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, token, expires_at, accepted_at,
          created_at)
       VALUES
         (gen_random_uuid(), $1, $2::"InvitationType", $3, $4,
          NOW() + INTERVAL '7 days', $5, NOW())
       RETURNING id`,
      [opts.tenantId, opts.invitationType, opts.targetEmail, opts.token, opts.acceptedAt ?? null],
    );
    return rows[0]!.id;
  }

  it('rejects a second pending internal_user invitation for the same (tenant, email)', async () => {
    const tenantId = await createTenant();
    const inv1 = await createInvitation({
      tenantId,
      invitationType: 'internal_user',
      targetEmail: 'mario@example.com',
      token: 'token-A',
    });

    await expect(
      createInvitation({
        tenantId,
        invitationType: 'internal_user',
        targetEmail: 'mario@example.com',
        token: 'token-B',
      }),
    ).rejects.toThrow(/uq_invitations_pending_internal|unique constraint/i);

    expect(inv1).toBeDefined();
  });

  it('allows a new pending after the first is consumed (acceptedAt set)', async () => {
    const tenantId = await createTenant();
    await createInvitation({
      tenantId,
      invitationType: 'internal_user',
      targetEmail: 'lucia@example.com',
      token: 'tok-1',
      acceptedAt: new Date(),
    });

    const inv2Id = await createInvitation({
      tenantId,
      invitationType: 'internal_user',
      targetEmail: 'lucia@example.com',
      token: 'tok-2',
    });

    expect(inv2Id).toBeDefined();
  });

  it('does NOT constrain customer_app invitation type', async () => {
    const tenantId = await createTenant();
    await createInvitation({
      tenantId,
      invitationType: 'customer_app',
      targetEmail: 'cliente@example.com',
      token: 'cust-1',
    });

    const inv2Id = await createInvitation({
      tenantId,
      invitationType: 'customer_app',
      targetEmail: 'cliente@example.com',
      token: 'cust-2',
    });

    expect(inv2Id).toBeDefined();
  });
});

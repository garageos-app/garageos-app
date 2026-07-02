// Integration tests for GET /v1/admin/tenants/:id/metrics — Slice 4 per-tenant.
//
// Tier-1:
//   1. Pool isolation — officine 403, clienti 403, no-auth 401.
//   2. 404 (anti-enum) — unknown UUID and invalid-format id both → tenant.not_found.
//   3. Scoping + correctness — tenant A's metrics exclude tenant B's rows and
//      exclude soft-deleted entities (cancelled interventions, deleted users,
//      deleted customer relations, completed/cancelled deadlines, accepted/
//      expired/customer_app invitations). lastAt reflects newest non-cancelled.
//   4. lastAt null when the tenant has no interventions.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import type { TenantMetrics } from '../../src/lib/dtos/tenant-metrics.js';

import { buildTestServer } from './fixtures.js';
import {
  resetDb,
  createTenant,
  createUser,
  createCustomer,
  createVehicle,
  createCustomerTenantRelation,
  createIntervention,
  ensureSystemInterventionType,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Seed a deadline directly (no helper exists). due_date satisfies the
// chk_deadline_has_criterion CHECK. status defaults to 'open' unless overridden.
async function seedDeadline(params: {
  tenantId: string;
  vehicleId: string;
  interventionTypeId: string;
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
}): Promise<void> {
  const { tenantId, vehicleId, interventionTypeId, status = 'open' } = params;
  await pgAdmin.query(
    `INSERT INTO deadlines
       (id, tenant_id, vehicle_id, intervention_type_id, due_date, status,
        is_recurring, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, (NOW() + INTERVAL '30 days')::date,
        $4::"DeadlineStatus", false, NOW(), NOW())`,
    [tenantId, vehicleId, interventionTypeId, status],
  );
}

// Seed an invitation directly. token_hash is a unique 64-hex placeholder.
async function seedInvitation(params: {
  tenantId: string;
  type?: 'internal_user' | 'customer_app';
  acceptedAt?: string | null; // SQL expr or null
  expiresAt?: string; // SQL expr
  tokenHashSuffix: string; // 2 hex chars, unique per row
}): Promise<void> {
  const {
    tenantId,
    type = 'internal_user',
    acceptedAt = null,
    expiresAt = "NOW() + INTERVAL '7 days'",
    tokenHashSuffix,
  } = params;
  const acceptedAtSql = acceptedAt !== null ? acceptedAt : 'NULL';
  const hash = tokenHashSuffix.padEnd(64, 'a');
  await pgAdmin.query(
    `INSERT INTO invitations
       (id, tenant_id, invitation_type, target_email, role, token_hash,
        expires_at, accepted_at, created_at)
     VALUES (gen_random_uuid(), $1, $2::"InvitationType", $3, 'mechanic'::"UserRole",
        $4, ${expiresAt}, ${acceptedAtSql}, NOW())`,
    [tenantId, type, `inv-${tokenHashSuffix}@test.it`, hash],
  );
}

describe('GET /v1/admin/tenants/:id/metrics — isolation & 404 (integration)', () => {
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

  it('returns 401 with no Authorization header', async () => {
    const { tenantId } = await createTenant('tm-401');
    const res = await app.inject({ method: 'GET', url: `/v1/admin/tenants/${tenantId}/metrics` });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 for an officine token', async () => {
    const { tenantId } = await createTenant('tm-off');
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantId}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 for a clienti token', async () => {
    const { tenantId } = await createTenant('tm-cli');
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantId}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 tenant.not_found for an unknown UUID', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/00000000-0000-0000-0000-000000000000/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/tenant.not_found',
      status: 404,
    });
  });

  it('returns 404 tenant.not_found for an invalid-format id (anti-enum)', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/not-a-uuid/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/tenant.not_found',
      status: 404,
    });
  });
});

describe('GET /v1/admin/tenants/:id/metrics — scoping & correctness (integration)', () => {
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

  it('counts only tenant A rows, excludes soft-deleted, and reports lastAt', async () => {
    const itype = await ensureSystemInterventionType('MECCANICO');
    const { tenantId: tenantA } = await createTenant('tm-A');
    const { tenantId: tenantB } = await createTenant('tm-B');

    // ── Users: A has 2 active + 1 soft-deleted; B has 1 (must not leak). ──
    const { userId: userA } = await createUser({
      tenantId: tenantA,
      cognitoSub: 'tm-a-1',
      role: 'super_admin',
    });
    await createUser({ tenantId: tenantA, cognitoSub: 'tm-a-2', role: 'mechanic' });
    const { userId: delUserA } = await createUser({
      tenantId: tenantA,
      cognitoSub: 'tm-a-del',
      role: 'mechanic',
    });
    await pgAdmin.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [delUserA]);
    await createUser({ tenantId: tenantB, cognitoSub: 'tm-b-1', role: 'super_admin' });

    // ── Vehicles: A created 2 (own); B created 1 certified by A → counts for A. ──
    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tenantA });
    await createVehicle({ createdByTenantId: tenantA });
    await createVehicle({ createdByTenantId: tenantB, certifiedByTenantId: tenantA });
    // A vehicle wholly owned by B (must not count for A).
    const { vehicleId: vB1 } = await createVehicle({ createdByTenantId: tenantB });

    // ── Customers: A has 2 relations (1 deleted → excluded); B has 1. ──
    const { customerId: cA1 } = await createCustomer({ email: 'tm-a1@test.it' });
    const { customerId: cA2 } = await createCustomer({ email: 'tm-a2@test.it' });
    const { customerId: cB1 } = await createCustomer({ email: 'tm-b1@test.it' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: cA1 });
    await createCustomerTenantRelation({
      tenantId: tenantA,
      customerId: cA2,
      customerDeleted: true,
    });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId: cB1 });

    // ── Interventions on A: 2 active recent + 1 cancelled + 1 backdated >30d. ──
    const today = new Date().toISOString().slice(0, 10);
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 1000,
    });
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 1100,
    });
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 1200,
      status: 'cancelled',
    });
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 900,
      createdAt: fortyDaysAgo,
    });
    // An intervention on B (must not count for A).
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: 'tm-b-int',
      role: 'super_admin',
    });
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId: vB1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 50,
    });

    // ── Deadlines on A: 1 open + 1 overdue (counted) + 1 completed + 1 cancelled. ──
    await seedDeadline({
      tenantId: tenantA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      status: 'open',
    });
    await seedDeadline({
      tenantId: tenantA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      status: 'overdue',
    });
    await seedDeadline({
      tenantId: tenantA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      status: 'completed',
    });
    await seedDeadline({
      tenantId: tenantA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      status: 'cancelled',
    });
    // Deadline on B (must not count for A).
    await seedDeadline({
      tenantId: tenantB,
      vehicleId: vB1,
      interventionTypeId: itype.id,
      status: 'open',
    });

    // ── Invitations on A: 1 pending internal_user (counted); 1 accepted; ──
    // ── 1 expired; 1 pending customer_app (excluded by type). B: 1 pending. ──
    await seedInvitation({ tenantId: tenantA, tokenHashSuffix: 'a1' });
    await seedInvitation({
      tenantId: tenantA,
      acceptedAt: "NOW() - INTERVAL '1 day'",
      tokenHashSuffix: 'a2',
    });
    await seedInvitation({
      tenantId: tenantA,
      expiresAt: "NOW() - INTERVAL '1 day'",
      tokenHashSuffix: 'a3',
    });
    await seedInvitation({ tenantId: tenantA, type: 'customer_app', tokenHashSuffix: 'a4' });
    await seedInvitation({ tenantId: tenantB, tokenHashSuffix: 'b1' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantA}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TenantMetrics;

    expect(body.interventions.total).toBe(3); // 2 recent + 1 backdated; cancelled excluded
    expect(body.interventions.last30d).toBe(2); // backdated (>30d) and cancelled excluded
    expect(body.interventions.lastAt).not.toBeNull();
    expect(body.usersTotal).toBe(2); // deleted user excluded; B's user not counted
    expect(body.vehiclesTotal).toBe(3); // 2 own + 1 certified-by-A; B's own not counted
    expect(body.customersTotal).toBe(1); // deleted relation excluded; B's not counted
    expect(body.openDeadlines).toBe(2); // open + overdue; completed/cancelled excluded
    expect(body.pendingInvitations).toBe(1); // accepted/expired/customer_app excluded
  });

  it('returns lastAt null and zeroed counts for a tenant with no activity', async () => {
    const { tenantId } = await createTenant('tm-empty');
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantId}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TenantMetrics;
    expect(body.interventions).toEqual({ total: 0, last30d: 0, lastAt: null });
    expect(body.usersTotal).toBe(0);
    expect(body.vehiclesTotal).toBe(0);
    expect(body.customersTotal).toBe(0);
    expect(body.openDeadlines).toBe(0);
    expect(body.pendingInvitations).toBe(0);
  });
});

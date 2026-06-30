# Platform-admin Slice 4 — PR-B: Per-tenant Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-tenant metrics block to the admin console `TenantDetail` page, backed by a new `GET /v1/admin/tenants/:id/metrics` endpoint.

**Architecture:** One read-only API endpoint computes per-tenant counts on-demand under `withContext({ role: 'admin' })` (RLS admin branch — zero migration), scoped to `:id` with the same anti-enum 404 pattern as `admin-tenant-detail.ts`. `TenantDetail` gains a lazy react-query + a "Metriche" card of stat cards (reusing PR-A's `StatCard`). No chart (platform-only, per the spec). No new error codes / BR / migration.

**Tech Stack:** Fastify + Prisma (pg adapter) API; React + Vite + TanStack Query + Tailwind + shadcn/ui admin-web. Vitest + Testcontainers integration (CI-only).

**Spec:** `docs/superpowers/specs/2026-06-30-platform-admin-slice4-metrics-design.md`
**Branch:** `feat/admin-slice4-metrics-per-tenant` (already created off `main` `f7bc72d`).

## Global Constraints

- **No migration, no new RLS policy, no new error code** — reuse `UNAUTHORIZED` / `FORBIDDEN` / `tenant.not_found`. **No new BR.**
- **No new dependency.** (PR-A already added `recharts`; PR-B reuses `StatCard` and adds nothing.)
- **Metric definition = "non eliminati"** (consistent with PR-A, shipped): users via `deletedAt: null`; interventions via `status <> 'cancelled'`; customers via `customerTenantRelation.customerDeleted = false`; vehicles via `createdByTenantId OR certifiedByTenantId`.
- **User-facing strings in Italian**, inline.
- **TypeScript strict; no `any` without a justifying comment.**
- **Conventional Commits**, scope `api` or `admin-web`; summary ≤72 chars, lowercase, imperative.
- **Local gate = `pnpm -r typecheck`.** Integration tests are CI-only (Docker) — do NOT run locally on Windows. admin-web unit tests are fast and may be run locally.
- **PR size target <500 / hard <1500 LOC.**

## Pre-flight findings (already verified)

- Per-tenant endpoint pattern: `admin-tenant-detail.ts` — `ParamsSchema = z.object({ id: z.string().uuid() })`; invalid UUID → `tenant.not_found` 404 (anti-enum); `withContext({ role: 'admin' })`; existence check `tx.tenant.findFirst({ where: { id, deletedAt: null }, select: { id: true } })` → null → `tenant.not_found` 404.
- Enums/fields: `DeadlineStatus` = open/completed/overdue/cancelled (open deadlines = `open` + `overdue`); `InvitationType` = customer_app / internal_user; `Deadline` has `tenantId`, `status`, `dueDate`; vehicles have no `tenantId` (use `createdByTenantId`/`certifiedByTenantId`); `CustomerTenantRelation` has `tenantId` + `customerDeleted`.
- Register admin routes in `packages/api/src/server.ts` (admin block ~line 178+, after `adminTenantDetailRoutes`).
- Integration helpers (`packages/api/tests/integration/helpers.ts`): `createTenant(suffix)`, `createUser({tenantId,cognitoSub,role?,...})`, `createCustomer({...})`, `createVehicle({createdByTenantId,certifiedByTenantId?,...})`, `createCustomerTenantRelation({tenantId,customerId,customerDeleted?})`, `createIntervention({tenantId,userId,vehicleId,interventionTypeId,interventionDate,odometerKm,status?,createdAt?})`, `ensureSystemInterventionType('TAGLIANDO')` (UPPERCASE — only key in SYSTEM_TYPE_FALLBACKS). No `createDeadline` helper → seed deadlines via raw `pgAdmin.query` (must include a criterion: `due_date`, per CHECK `chk_deadline_has_criterion`).
- `signTestToken({ pool })` from `../helpers/jwt.js`; `buildTestServer` from `./fixtures.js`; `resetDb`/`pgAdmin` from `./helpers.js`/`./setup.js`; `PROBLEM_JSON_CONTENT_TYPE` from `../../src/config/constants.js`.
- admin-web: `StatCard` exists at `packages/admin-web/src/components/StatCard.tsx` (`{ label, value, hint? }`); frontend metrics types live in `packages/admin-web/src/lib/metrics-types.ts`; `TenantDetail` at `packages/admin-web/src/pages/TenantDetail.tsx` (profile query + users query, each its own card with isLoading/error). Tests `packages/admin-web/tests/tenant-detail.test.tsx` route `apiFetch` by path via `mockApiFetch.mockImplementation((path) => …)` (default tenant id `tenant-001`).

## File Structure

- Create `packages/api/src/lib/dtos/tenant-metrics.ts` — `TenantMetrics` DTO type.
- Create `packages/api/src/routes/v1/admin-tenant-metrics.ts` — the endpoint.
- Modify `packages/api/src/server.ts` — register the route.
- Create `packages/api/tests/integration/admin-tenant-metrics.test.ts` — Tier-1 tests.
- Modify `packages/admin-web/src/lib/metrics-types.ts` — add `TenantMetrics` mirror.
- Modify `packages/admin-web/src/pages/TenantDetail.tsx` — metrics query + "Metriche" card.
- Modify `packages/admin-web/tests/tenant-detail.test.tsx` — route `/metrics` + new test.
- Modify `docs/APPENDICE_A_API.md` — document the endpoint (§3.12.12).

---

### Task 1: `GET /v1/admin/tenants/:id/metrics` endpoint + DTO + integration tests

**Files:**
- Create: `packages/api/src/lib/dtos/tenant-metrics.ts`
- Create: `packages/api/src/routes/v1/admin-tenant-metrics.ts`
- Modify: `packages/api/src/server.ts` (admin block, after `adminTenantDetailRoutes`)
- Test: `packages/api/tests/integration/admin-tenant-metrics.test.ts`

**Interfaces:**
- Produces: `TenantMetrics` (from `lib/dtos/tenant-metrics.js`); route plugin `adminTenantMetricsRoutes`.
- Consumes: `app.withContext`, `requireAuth`, `requirePlatformAdminsPool`, `businessError`.

- [ ] **Step 1: Write the DTO type**

Create `packages/api/src/lib/dtos/tenant-metrics.ts`:

```ts
// DTO for GET /v1/admin/tenants/:id/metrics — Slice 4 per-tenant metrics.

export interface TenantMetrics {
  interventions: { total: number; last30d: number; lastAt: string | null };
  /** Officine staff users of this tenant, non eliminati (deletedAt null). */
  usersTotal: number;
  /** Vehicles created or certified by this tenant. */
  vehiclesTotal: number;
  /** Customers linked to this tenant (non-deleted relations). */
  customersTotal: number;
  /** Deadlines still open or overdue. */
  openDeadlines: number;
  /** Internal-user invitations not yet accepted and not expired. */
  pendingInvitations: number;
}
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/api/tests/integration/admin-tenant-metrics.test.ts`:

```ts
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
    const itype = await ensureSystemInterventionType('TAGLIANDO');
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
    await seedDeadline({ tenantId: tenantA, vehicleId: vA1, interventionTypeId: itype.id, status: 'open' });
    await seedDeadline({ tenantId: tenantA, vehicleId: vA1, interventionTypeId: itype.id, status: 'overdue' });
    await seedDeadline({ tenantId: tenantA, vehicleId: vA1, interventionTypeId: itype.id, status: 'completed' });
    await seedDeadline({ tenantId: tenantA, vehicleId: vA1, interventionTypeId: itype.id, status: 'cancelled' });
    // Deadline on B (must not count for A).
    await seedDeadline({ tenantId: tenantB, vehicleId: vB1, interventionTypeId: itype.id, status: 'open' });

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
```

- [ ] **Step 3: Confirm the test compiles (route absent → behavioral fail on CI)**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (test imports only existing helpers + the new DTO type). Behavioral pass/fail runs on CI; do NOT run the integration suite locally.

- [ ] **Step 4: Implement the route**

Create `packages/api/src/routes/v1/admin-tenant-metrics.ts`:

```ts
// GET /v1/admin/tenants/:id/metrics — Slice 4 per-tenant metrics for the admin
// console TenantDetail page. On-demand counts under admin RLS context (no
// migration). Separate from admin-tenant-detail so the page loads it lazily and
// the detail payload stays stable.
//
// Anti-enum: invalid UUID and unknown UUID both → tenant.not_found 404.
// "non eliminati" everywhere: users deletedAt null, interventions status<>cancelled,
// customers via non-deleted relation. Auth: requireAuth → requirePlatformAdminsPool.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import type { TenantMetrics } from '../../lib/dtos/tenant-metrics.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const adminTenantMetricsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/tenants/:id/metrics',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const metrics = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Existence check (anti-enum 404) before computing anything.
        const existing = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) throw businessError('tenant.not_found', 404, 'Officina non trovata.');

        const [
          interventionsTotal,
          interventionsLast30d,
          lastIntervention,
          usersTotal,
          vehiclesTotal,
          customersTotal,
          openDeadlines,
          pendingInvitations,
        ] = await Promise.all([
          tx.intervention.count({ where: { tenantId: id, status: { not: 'cancelled' } } }),
          tx.intervention.count({
            where: { tenantId: id, status: { not: 'cancelled' }, createdAt: { gte: since30d } },
          }),
          tx.intervention.findFirst({
            where: { tenantId: id, status: { not: 'cancelled' } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          tx.user.count({ where: { tenantId: id, deletedAt: null } }),
          tx.vehicle.count({
            where: { OR: [{ createdByTenantId: id }, { certifiedByTenantId: id }] },
          }),
          tx.customerTenantRelation.count({ where: { tenantId: id, customerDeleted: false } }),
          tx.deadline.count({ where: { tenantId: id, status: { in: ['open', 'overdue'] } } }),
          tx.invitation.count({
            where: {
              tenantId: id,
              invitationType: 'internal_user',
              acceptedAt: null,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);

        return {
          interventions: {
            total: interventionsTotal,
            last30d: interventionsLast30d,
            lastAt: lastIntervention ? lastIntervention.createdAt.toISOString() : null,
          },
          usersTotal,
          vehiclesTotal,
          customersTotal,
          openDeadlines,
          pendingInvitations,
        } satisfies TenantMetrics;
      });

      return reply.code(200).send(metrics);
    },
  );
};
```

- [ ] **Step 5: Register the route**

In `packages/api/src/server.ts`, add the import alongside the other admin-route imports and register it after `adminTenantDetailRoutes`:

```ts
import { adminTenantMetricsRoutes } from './routes/v1/admin-tenant-metrics.js';
```

```ts
  await app.register(adminTenantDetailRoutes);
  await app.register(adminTenantMetricsRoutes);
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/dtos/tenant-metrics.ts \
        packages/api/src/routes/v1/admin-tenant-metrics.ts \
        packages/api/src/server.ts \
        packages/api/tests/integration/admin-tenant-metrics.test.ts
git commit -m "feat(api): add GET /v1/admin/tenants/:id/metrics endpoint"
```

(CI runs the integration suite — must be green before merge.)

---

### Task 2: TenantDetail metrics section + tests

**Files:**
- Modify: `packages/admin-web/src/lib/metrics-types.ts` (append `TenantMetrics`)
- Modify: `packages/admin-web/src/pages/TenantDetail.tsx`
- Modify: `packages/admin-web/tests/tenant-detail.test.tsx`

**Interfaces:**
- Consumes: `StatCard` (`packages/admin-web/src/components/StatCard.tsx`), `TenantMetrics`, `useApiFetch`.

- [ ] **Step 1: Add the frontend `TenantMetrics` mirror**

Append to `packages/admin-web/src/lib/metrics-types.ts`:

```ts
// Mirror of GET /v1/admin/tenants/:id/metrics DTO
// (packages/api/src/lib/dtos/tenant-metrics.ts). Keep in sync.
export interface TenantMetrics {
  interventions: { total: number; last30d: number; lastAt: string | null };
  usersTotal: number;
  vehiclesTotal: number;
  customersTotal: number;
  openDeadlines: number;
  pendingInvitations: number;
}
```

- [ ] **Step 2: Update the failing tests (route /metrics + new assertion)**

In `packages/admin-web/tests/tenant-detail.test.tsx`:

(a) Add a metrics fixture near the existing `TENANT_PROFILE` / users fixtures:

```ts
import type { TenantMetrics } from '@/lib/metrics-types';

const TENANT_METRICS: TenantMetrics = {
  interventions: { total: 42, last30d: 7, lastAt: '2026-06-27T09:14:00.000Z' },
  usersTotal: 3,
  vehiclesTotal: 18,
  customersTotal: 12,
  openDeadlines: 5,
  pendingInvitations: 1,
};
```

(b) In EVERY existing `mockApiFetch.mockImplementation((path) => …)` block, add a metrics branch so the new query resolves (place it before the users branch or anywhere in the chain):

```ts
if (path.endsWith('/metrics')) return Promise.resolve(TENANT_METRICS);
```

(c) Add a new test in the main describe block:

```ts
it('renders the per-tenant metrics section', async () => {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.endsWith('/metrics')) return Promise.resolve(TENANT_METRICS);
    if (path.endsWith('/users')) return Promise.resolve({ users: [] as AdminUser[] });
    return Promise.resolve({ tenant: TENANT_PROFILE });
  });

  render(<TenantDetail />, { wrapper: makeWrapper() });

  // Metrics card heading + a couple of values.
  expect(await screen.findByText('Metriche')).toBeInTheDocument();
  expect(await screen.findByText('42')).toBeInTheDocument(); // interventi total
  expect(screen.getByText('5')).toBeInTheDocument(); // scadenze aperte
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/admin-web test`
Expected: the new "renders the per-tenant metrics section" test FAILS (no Metriche card yet). Existing tests still pass (metrics branch returns a value; unused if not asserted).

- [ ] **Step 4: Implement the metrics section**

In `packages/admin-web/src/pages/TenantDetail.tsx`:

(a) Add imports near the other component imports:

```tsx
import { StatCard } from '@/components/StatCard';
import type { TenantMetrics } from '@/lib/metrics-types';
```

(b) Add a metrics query alongside the users query (after the users `useQuery` block, ~line 122):

```tsx
  // ── Metrics query ────────────────────────────────────────────────────────────
  // Independent of profile/users — its own loading/error state so a metrics
  // failure does not block the rest of the page.
  const {
    data: metricsData,
    isLoading: metricsLoading,
    error: metricsError,
  } = useQuery<TenantMetrics>({
    queryKey: ['admin-tenant-metrics', id],
    queryFn: () => apiFetch(`/v1/admin/tenants/${id!}/metrics`),
    enabled: !!id,
  });
```

(c) Add a "Metriche" card immediately after the Users `</Card>` (before the closing `</div>` of `max-w-2xl`, ~line 488). Note: widen the page container from `max-w-2xl` to `max-w-3xl` so the stat-card grid has room:

Change the two container lines (the error/loading guards AND the main render) from `max-w-2xl` to `max-w-3xl` — there are 3 occurrences of `className="max-w-2xl mx-auto"`; update all 3 for consistency.

Insert the card:

```tsx
        {/* ── Metrics section ───────────────────────────────────────────────── */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Metriche</CardTitle>
          </CardHeader>
          <CardContent>
            {metricsError ? (
              <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
                Errore nel caricamento delle metriche.
              </div>
            ) : metricsLoading || !metricsData ? (
              <p className="text-muted-foreground">Caricamento metriche…</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <StatCard
                  label="Interventi"
                  value={metricsData.interventions.total}
                  hint={`${metricsData.interventions.last30d} ultimi 30 giorni`}
                />
                <StatCard
                  label="Ultimo intervento"
                  value={
                    metricsData.interventions.lastAt
                      ? new Date(metricsData.interventions.lastAt).toLocaleDateString('it-IT')
                      : '—'
                  }
                />
                <StatCard label="Utenti" value={metricsData.usersTotal} />
                <StatCard label="Veicoli" value={metricsData.vehiclesTotal} />
                <StatCard label="Clienti" value={metricsData.customersTotal} />
                <StatCard label="Scadenze aperte" value={metricsData.openDeadlines} />
                <StatCard label="Inviti pendenti" value={metricsData.pendingInvitations} />
              </div>
            )}
          </CardContent>
        </Card>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/admin-web test`
Expected: all pass, including the new metrics-section test.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-web/src/lib/metrics-types.ts \
        packages/admin-web/src/pages/TenantDetail.tsx \
        packages/admin-web/tests/tenant-detail.test.tsx
git commit -m "feat(admin-web): per-tenant metrics section on tenant detail"
```

---

### Task 3: API docs

**Files:**
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Document the endpoint**

Mirror the existing admin endpoint format (a summary-table row + a detailed `§3.12.x` section — read `§3.12.11` for `GET /v1/admin/metrics` as the template). Add:

(a) A table row in the admin endpoints table (after the existing `GET /v1/admin/metrics` row), referencing the next detail section:

```markdown
| GET | `/v1/admin/tenants/:id/metrics` | Slice 4 | Platform Admin | **[DETTAGLIATO §3.12.12]** Metriche per-officina (conteggi + attività + scadenze + inviti) |
```

(b) A detailed `§3.12.12` section mirroring §3.12.11's format (Italian prose, auth, errors, 200 example):

```markdown
### GET /v1/admin/tenants/:id/metrics

Metriche operative della singola officina, per il blocco "Metriche" di TenantDetail.

- **Auth:** solo pool platform-admins (`requireAuth` + `requirePlatformAdminsPool`). Nessun tenant context.
- **Errori:** `401 UNAUTHORIZED` (token assente/non valido), `403 FORBIDDEN` (pool errato), `404 tenant.not_found` (UUID sconosciuto o formato non valido — anti-enumeration).

**Risposta 200:**

```json
{
  "interventions": { "total": 84, "last30d": 12, "lastAt": "2026-06-27T09:14:00.000Z" },
  "usersTotal": 3,
  "vehiclesTotal": 61,
  "customersTotal": 52,
  "openDeadlines": 7,
  "pendingInvitations": 1
}
```

Conteggi "non eliminati", calcolati cross-tenant sotto il contesto RLS admin: `interventions` esclude gli interventi `cancelled` (`lastAt` = data dell'ultimo intervento non annullato, `null` se nessuno); `usersTotal` = utenti staff con `deletedAt` nullo; `vehiclesTotal` = veicoli creati o certificati dall'officina; `customersTotal` = relazioni cliente non eliminate; `openDeadlines` = scadenze `open` o `overdue`; `pendingInvitations` = inviti `internal_user` non accettati e non scaduti.
```

- [ ] **Step 2: Commit**

```bash
git add docs/APPENDICE_A_API.md
git commit -m "docs: document GET /v1/admin/tenants/:id/metrics endpoint"
```

---

## Final steps (after all tasks)

- [ ] **Whole-branch review:** `/code-review high` (load-bearing final gate). Apply Critical/Important; list Minor in the PR description.
- [ ] **Push & CI:** `git push -u origin feat/admin-slice4-metrics-per-tenant`; watch with explicit `gh pr checks <n>` (not only `--watch` — it can exit 0 with integration still red).
- [ ] **Smoke (BLOCKER — admin-web UI-facing):** after merge + deploy, on `https://admin.garageos.aifollyadvisor.com` open a tenant (`/officine/:id`) → the "Metriche" card shows real numbers; browser console clean.
- [ ] **Self-merge** only after CI green + final review + smoke pass + zero open questions: `gh pr merge <n> --squash --delete-branch`, then sync `main`.
- [ ] **PR description:** note this completes Slice 4 (PR-A platform dashboard + PR-B per-tenant); the audit viewer remains deferred. Carry the same Minor tech-debt note as PR-A (the `metrics-types.ts` mirror; no `@garageos/shared` package yet).

## Self-Review (plan vs spec)

- **Spec coverage (per-tenant block):** endpoint `GET /v1/admin/tenants/:id/metrics` (Task 1) ✓; conteggi base — interventi/utenti/veicoli/clienti (Task 1 + cards Task 2) ✓; attività recente — last30d + lastAt (Task 1 + card Task 2) ✓; scadenze aperte (Task 1 + card) ✓; inviti pendenti (Task 1 + card) ✓; stat cards, no chart (Task 2) ✓; 404 anti-enum (Task 1 + test) ✓; Tier-1 isolation + scoping + soft-delete exclusion + lastAt null (Task 1 test) ✓; Tier-2 UI test (Task 2) ✓; docs (Task 3) ✓. Platform dashboard was PR-A (shipped) — out of this plan.
- **Placeholder scan:** none — every step carries concrete code/commands.
- **Type consistency:** `TenantMetrics` identical across API DTO (Task 1) and frontend mirror (Task 2); `StatCard` props (`label`/`value`/`hint`) match call sites; the `/metrics` query key `['admin-tenant-metrics', id]` distinct from profile/users keys; test fixture `TENANT_METRICS` matches the `TenantMetrics` shape.

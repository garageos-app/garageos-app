# Platform-admin Slice 4 — PR-A: Platform Metrics Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-level metrics endpoint and dashboard to the admin console — aggregate counts across all tenants plus an 8-week interventions trend chart.

**Architecture:** One read-only API endpoint `GET /v1/admin/metrics` computes counts on-demand under `withContext({ role: 'admin' })` (RLS admin branch — zero migration). The `PlatformConsole` page renders stat cards (shadcn `card`) + a bar chart (`recharts`). No new error codes, no new BRs, no migration.

**Tech Stack:** Fastify + Prisma (pg driver adapter) on the API; React + Vite + TanStack Query + Tailwind + shadcn/ui + **recharts** (new dep) on admin-web. Integration tests via Vitest + Testcontainers (CI-only).

**Spec:** `docs/superpowers/specs/2026-06-30-platform-admin-slice4-metrics-design.md`
**Branch:** `feat/admin-slice4-metrics-platform` (already created; spec already committed here).

## Global Constraints

- **No migration, no new RLS policy.** Every read uses an existing admin SELECT branch.
- **No new error codes / no `APPENDICE_G` change.** Reuse `UNAUTHORIZED` / `FORBIDDEN` only.
- **No new BR.** Internal tooling; no business rule governs it.
- **New dependency `recharts`** in `packages/admin-web` only — must be justified in the PR description (ecosystem-standard charting, basis of shadcn `chart`). No other new deps.
- **User-facing strings in Italian**, inline (admin-web has no i18n system; mirror existing pages).
- **TypeScript strict; no `any` without a justifying comment.**
- **Conventional Commits**, scope `api` or `admin-web`; summary ≤72 chars, lowercase, imperative.
- **Local gate = `pnpm -r typecheck` only.** Integration tests are CI-only (Docker); do NOT run them locally on Windows. admin-web unit tests (`pnpm --filter @garageos/admin-web test`) are fast and may be run locally.
- **PR size target <500 / hard <1500 LOC.**

## Pre-flight findings (already verified)

- RLS: `tenants`, `users`, `interventions` SELECT = `is_admin_role() OR tenant_id=…`; `customers`, `vehicles` SELECT = `USING(true)`. Admin context reads all. → no migration.
- `app.withContext({ role: 'admin' }, async (tx) => …)` is the established cross-tenant read pattern (`admin-tenants-list.ts`). `tx` exposes all Prisma models + `tx.$queryRaw`.
- Admin routes register in `packages/api/src/server.ts` (block around line 178). Auth chain `[requireAuth, requirePlatformAdminsPool]`.
- Integration tests: `packages/api/tests/integration/`; helpers `createTenant`, `createUser`, `createCustomer`, `createVehicle`, `createCustomerTenantRelation`, `createIntervention`, `ensureSystemInterventionType` from `./helpers.js`; `signTestToken({ pool })` from `../helpers/jwt.js`; `buildTestServer` from `./fixtures.js`; `resetDb` from `./helpers.js`; `PROBLEM_JSON_CONTENT_TYPE` from `../../src/config/constants.js`.
- admin-web tests live in `packages/admin-web/tests/`; pages in `packages/admin-web/src/pages/`; ui in `packages/admin-web/src/components/ui/`. No `recharts` / `chart.tsx` present yet.

## File Structure

- Create `packages/api/src/lib/dtos/platform-metrics.ts` — DTO types shared by route + tests.
- Create `packages/api/src/routes/v1/admin-metrics.ts` — the endpoint.
- Modify `packages/api/src/server.ts` — register the route.
- Create `packages/api/tests/integration/admin-metrics.test.ts` — Tier-1 tests.
- Modify `packages/admin-web/package.json` — add `recharts`.
- Create `packages/admin-web/src/lib/metrics-types.ts` — frontend DTO mirror.
- Create `packages/admin-web/src/components/StatCard.tsx` — presentational stat card.
- Create `packages/admin-web/src/components/InterventionsTrendChart.tsx` — bar chart.
- Modify `packages/admin-web/src/pages/PlatformConsole.tsx` — render dashboard.
- Modify `packages/admin-web/tests/platform-console.test.tsx` — path-based mock + new tests.
- Modify `docs/APPENDICE_A_API.md` — document the endpoint.

---

### Task 1: `GET /v1/admin/metrics` endpoint + DTO + integration tests

**Files:**
- Create: `packages/api/src/lib/dtos/platform-metrics.ts`
- Create: `packages/api/src/routes/v1/admin-metrics.ts`
- Modify: `packages/api/src/server.ts` (admin-route registration block, ~line 178)
- Test: `packages/api/tests/integration/admin-metrics.test.ts`

**Interfaces:**
- Produces: `PlatformMetrics`, `WeeklyTrendPoint` (from `lib/dtos/platform-metrics.js`); route plugin `adminMetricsRoutes`.
- Consumes: `app.withContext`, `requireAuth`, `requirePlatformAdminsPool`.

- [ ] **Step 1: Write the DTO types**

Create `packages/api/src/lib/dtos/platform-metrics.ts`:

```ts
// DTO for GET /v1/admin/metrics — Slice 4 platform-admin aggregate metrics.

export interface WeeklyTrendPoint {
  /** Monday of the ISO week, formatted YYYY-MM-DD. */
  week: string;
  count: number;
}

export interface PlatformMetrics {
  tenants: { total: number; active: number; suspended: number };
  /** Officine staff users with status = active (platform-wide). */
  usersTotal: number;
  interventions: { total: number; last30d: number };
  vehiclesTotal: number;
  customersTotal: number;
  /** Interventions per ISO week, exactly 8 entries, ascending, zero-filled. */
  trend: WeeklyTrendPoint[];
}
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/api/tests/integration/admin-metrics.test.ts`:

```ts
// Integration tests for GET /v1/admin/metrics — Slice 4 platform metrics.
//
// Tier-1:
//   1. Pool isolation — officine 403, clienti 403, no-auth 401.
//   2. Cross-tenant aggregate counts over a 2-tenant seed.
//   3. Trend: exactly 8 ascending weekly points, zero-filled, with a
//      backdated intervention landing in an earlier bucket.
//   4. Empty platform → all zeros, trend still 8 points all count 0.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import type { PlatformMetrics } from '../../src/lib/dtos/platform-metrics.js';

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

describe('GET /v1/admin/metrics — pool isolation (integration)', () => {
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

  it('returns 401 when no Authorization header is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 FORBIDDEN for an officine token', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 FORBIDDEN for a clienti token', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });
});

describe('GET /v1/admin/metrics — aggregate counts (integration)', () => {
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

  it('returns 200 with all-zero metrics and an 8-point zero trend on an empty platform', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as PlatformMetrics;
    expect(body.tenants).toEqual({ total: 0, active: 0, suspended: 0 });
    expect(body.usersTotal).toBe(0);
    expect(body.interventions).toEqual({ total: 0, last30d: 0 });
    expect(body.vehiclesTotal).toBe(0);
    expect(body.customersTotal).toBe(0);
    expect(body.trend).toHaveLength(8);
    expect(body.trend.every((p) => p.count === 0)).toBe(true);
    // Ascending by week (YYYY-MM-DD string sort == chronological).
    const weeks = body.trend.map((p) => p.week);
    expect([...weeks].sort()).toEqual(weeks);
  });

  it('aggregates counts across multiple tenants and buckets the trend', async () => {
    // Tenant A: active, 1 user, 2 vehicles, 2 customers, 3 interventions
    //   (2 recent + 1 backdated 3 weeks ago).
    // Tenant B: suspended, 1 user, 1 vehicle, 1 customer, 1 recent intervention.
    const itype = await ensureSystemInterventionType('tagliando');

    const { tenantId: tenantA } = await createTenant('metrics-A');
    const { tenantId: tenantB } = await createTenant('metrics-B');
    // Make B suspended.
    await pgAdmin.query(
      `UPDATE tenants SET status = 'suspended'::"TenantStatus" WHERE id = $1`,
      [tenantB],
    );

    const { userId: userA } = await createUser({
      tenantId: tenantA,
      cognitoSub: 'sub-metrics-a',
      role: 'super_admin',
    });
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: 'sub-metrics-b',
      role: 'super_admin',
    });

    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tenantA });
    await createVehicle({ createdByTenantId: tenantA });
    const { vehicleId: vB1 } = await createVehicle({ createdByTenantId: tenantB });

    const { customerId: cA1 } = await createCustomer({ email: 'a1@test.it' });
    const { customerId: cA2 } = await createCustomer({ email: 'a2@test.it' });
    const { customerId: cB1 } = await createCustomer({ email: 'b1@test.it' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: cA1 });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: cA2 });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId: cB1 });

    const today = new Date().toISOString().slice(0, 10);
    // 2 recent interventions on tenant A.
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 10100,
    });
    // 1 backdated intervention (3 weeks ago) on tenant A → earlier trend bucket,
    // and OUTSIDE the last-30d window? No — 3 weeks < 30 days, so still last30d.
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 9000,
      createdAt: threeWeeksAgo,
    });
    // 1 recent intervention on tenant B.
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId: vB1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 5000,
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as PlatformMetrics;

    expect(body.tenants).toEqual({ total: 2, active: 1, suspended: 1 });
    expect(body.usersTotal).toBe(2);
    expect(body.interventions.total).toBe(4);
    expect(body.interventions.last30d).toBe(4); // all 4 within 30 days
    expect(body.vehiclesTotal).toBe(3);
    expect(body.customersTotal).toBe(3);

    // Trend: 8 buckets, sum of counts == 4, current week has the 3 recent ones,
    // the bucket 3 weeks back has the 1 backdated one.
    expect(body.trend).toHaveLength(8);
    const total = body.trend.reduce((acc, p) => acc + p.count, 0);
    expect(total).toBe(4);
    expect(body.trend[body.trend.length - 1]!.count).toBe(3); // current week
    // Exactly one earlier bucket carries the backdated intervention.
    const earlierWithOne = body.trend
      .slice(0, body.trend.length - 1)
      .filter((p) => p.count === 1);
    expect(earlierWithOne).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Confirm the test cannot pass yet (route absent)**

Run locally: `pnpm --filter @garageos/api typecheck`
Expected: PASS (the test imports only existing helpers + the new DTO type). The
behavioral failure surfaces on CI (route returns 404 until implemented). Do NOT
run the integration suite locally (Docker).

- [ ] **Step 4: Implement the route**

Create `packages/api/src/routes/v1/admin-metrics.ts`:

```ts
// GET /v1/admin/metrics — Slice 4 platform-admin aggregate metrics.
//
// On-demand counts across all tenants under admin RLS context (no migration:
// every table read already grants `is_admin_role()` SELECT). The interventions
// trend is a single generate_series LEFT JOIN so empty weeks are zero-filled in
// SQL (8 buckets: current ISO week + 7 prior), avoiding JS/timezone date math.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No tenant context.

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import type {
  PlatformMetrics,
  WeeklyTrendPoint,
} from '../../lib/dtos/platform-metrics.js';

export const adminMetricsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/metrics',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (_request, reply) => {
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const metrics = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const [
          tenantsTotal,
          tenantsActive,
          tenantsSuspended,
          usersTotal,
          interventionsTotal,
          interventionsLast30d,
          vehiclesTotal,
          customersTotal,
          trendRows,
        ] = await Promise.all([
          tx.tenant.count({ where: { deletedAt: null } }),
          tx.tenant.count({ where: { deletedAt: null, status: 'active' } }),
          tx.tenant.count({ where: { deletedAt: null, status: 'suspended' } }),
          tx.user.count({ where: { status: 'active' } }),
          tx.intervention.count(),
          tx.intervention.count({ where: { createdAt: { gte: since30d } } }),
          tx.vehicle.count(),
          tx.customer.count(),
          tx.$queryRaw<Array<{ week: string; count: number }>>`
            SELECT to_char(wk, 'YYYY-MM-DD') AS week,
                   COALESCE(c.count, 0)::int AS count
            FROM generate_series(
              date_trunc('week', now()) - interval '7 weeks',
              date_trunc('week', now()),
              interval '1 week'
            ) AS wk
            LEFT JOIN (
              SELECT date_trunc('week', created_at) AS wk, count(*) AS count
              FROM interventions
              WHERE created_at >= date_trunc('week', now()) - interval '7 weeks'
              GROUP BY 1
            ) c ON c.wk = wk
            ORDER BY wk
          `,
        ]);

        const trend: WeeklyTrendPoint[] = trendRows.map((r) => ({
          week: r.week,
          count: Number(r.count),
        }));

        return {
          tenants: {
            total: tenantsTotal,
            active: tenantsActive,
            suspended: tenantsSuspended,
          },
          usersTotal,
          interventions: { total: interventionsTotal, last30d: interventionsLast30d },
          vehiclesTotal,
          customersTotal,
          trend,
        } satisfies PlatformMetrics;
      });

      return reply.code(200).send(metrics);
    },
  );
};
```

- [ ] **Step 5: Register the route**

In `packages/api/src/server.ts`, add the import near the other admin-route
imports and register it next to `adminMeRoutes`:

```ts
import { adminMetricsRoutes } from './routes/v1/admin-metrics.js';
```

```ts
  await app.register(adminMeRoutes);
  await app.register(adminMetricsRoutes);
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/dtos/platform-metrics.ts \
        packages/api/src/routes/v1/admin-metrics.ts \
        packages/api/src/server.ts \
        packages/api/tests/integration/admin-metrics.test.ts
git commit -m "feat(api): add GET /v1/admin/metrics platform metrics endpoint"
```

(CI runs the integration suite and must be green before merge.)

---

### Task 2: admin-web charting deps + presentational components

**Files:**
- Modify: `packages/admin-web/package.json` (add `recharts`)
- Create: `packages/admin-web/src/lib/metrics-types.ts`
- Create: `packages/admin-web/src/components/StatCard.tsx`
- Create: `packages/admin-web/src/components/InterventionsTrendChart.tsx`

**Interfaces:**
- Produces: `PlatformMetrics`, `WeeklyTrendPoint` (frontend mirror); `StatCard({ label, value, hint? })`; `InterventionsTrendChart({ data })`.

- [ ] **Step 1: Add the `recharts` dependency**

Edit `packages/admin-web/package.json` — add to `dependencies` (keep alphabetical):

```json
    "recharts": "^2.15.0",
```

Then install with the pinned Node (fnm Node 22; the repo rejects Node 23):

Run: `pnpm install`
Expected: lockfile updated, `recharts` resolved. If EPERM on Windows, ensure no
Vite/Metro dev server is holding `node_modules` (memory `metro-locks-node-modules`).

- [ ] **Step 2: Write the frontend DTO mirror**

Create `packages/admin-web/src/lib/metrics-types.ts`:

```ts
// Mirror of the backend GET /v1/admin/metrics DTO
// (packages/api/src/lib/dtos/platform-metrics.ts). Keep in sync.

export interface WeeklyTrendPoint {
  week: string; // YYYY-MM-DD (Monday of the ISO week)
  count: number;
}

export interface PlatformMetrics {
  tenants: { total: number; active: number; suspended: number };
  usersTotal: number;
  interventions: { total: number; last30d: number };
  vehiclesTotal: number;
  customersTotal: number;
  trend: WeeklyTrendPoint[];
}
```

- [ ] **Step 3: Write the `StatCard` component**

Create `packages/admin-web/src/components/StatCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Write the `InterventionsTrendChart` component**

Create `packages/admin-web/src/components/InterventionsTrendChart.tsx`:

```tsx
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { WeeklyTrendPoint } from '@/lib/metrics-types';

// YYYY-MM-DD → DD/MM for compact x-axis labels.
function formatWeek(week: string): string {
  const parts = week.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : week;
}

interface InterventionsTrendChartProps {
  data: WeeklyTrendPoint[];
}

export function InterventionsTrendChart({ data }: InterventionsTrendChartProps) {
  const chartData = data.map((p) => ({ week: formatWeek(p.week), count: p.count }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Interventi per settimana (ultime 8)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64" data-testid="trend-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="week" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} fontSize={12} tickLine={false} axisLine={false} width={32} />
              <Tooltip />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-web/package.json pnpm-lock.yaml \
        packages/admin-web/src/lib/metrics-types.ts \
        packages/admin-web/src/components/StatCard.tsx \
        packages/admin-web/src/components/InterventionsTrendChart.tsx
git commit -m "feat(admin-web): add recharts + stat card and trend chart components"
```

---

### Task 3: PlatformConsole dashboard + tests

**Files:**
- Modify: `packages/admin-web/src/pages/PlatformConsole.tsx`
- Modify: `packages/admin-web/tests/platform-console.test.tsx`

**Interfaces:**
- Consumes: `StatCard`, `InterventionsTrendChart`, `PlatformMetrics`, `useApiFetch`.

- [ ] **Step 1: Update the failing tests (path-based mock + dashboard assertions)**

Replace `packages/admin-web/tests/platform-console.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformConsole } from '@/pages/PlatformConsole';
import type { PlatformMetrics } from '@/lib/metrics-types';

const { mockApiFetch, mockSignOut } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
}));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    state: { status: 'authenticated', user: { email: 'admin@garageos.it' } },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

const ME = {
  sub: 'sub-abc123',
  email: 'admin@garageos.it',
  firstName: 'Mario',
  lastName: 'Rossi',
};

const METRICS: PlatformMetrics = {
  tenants: { total: 7, active: 5, suspended: 2 },
  usersTotal: 19,
  interventions: { total: 420, last30d: 33 },
  vehiclesTotal: 88,
  customersTotal: 64,
  trend: Array.from({ length: 8 }, (_, i) => ({
    week: `2026-05-${String(5 + i).padStart(2, '0')}`,
    count: i,
  })),
};

// Route the mock by path so both queries (me + metrics) resolve.
function routeApiFetch(overrides?: { me?: unknown; metrics?: unknown }) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/v1/admin/me') return Promise.resolve(overrides?.me ?? ME);
    if (path === '/v1/admin/metrics') return Promise.resolve(overrides?.metrics ?? METRICS);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockSignOut.mockReset();
});

describe('PlatformConsole page', () => {
  it('renders admin identity and aggregate metric values', async () => {
    routeApiFetch();
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByText('Mario Rossi')).toBeInTheDocument();
    // Tenants total + interventions total surface as stat-card values.
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(await screen.findByText('420')).toBeInTheDocument();
    // Trend chart container is rendered.
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
  });

  it('shows an error alert when GET /v1/admin/metrics fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/admin/me') return Promise.resolve(ME);
      return Promise.reject(new Error('Network error'));
    });
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('calls signOut when the Esci button is clicked', async () => {
    routeApiFetch();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    await screen.findByText('Mario Rossi');
    await user.click(screen.getByRole('button', { name: /esci/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/admin-web test`
Expected: FAIL — the new metric assertions (`7`, `420`, `trend-chart`) fail
because `PlatformConsole` does not yet fetch or render metrics.

- [ ] **Step 3: Implement the dashboard in PlatformConsole**

Replace `packages/admin-web/src/pages/PlatformConsole.tsx` with:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApiFetch } from '@/lib/api-client';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/StatCard';
import { InterventionsTrendChart } from '@/components/InterventionsTrendChart';
import type { PlatformMetrics } from '@/lib/metrics-types';

// Shape returned by GET /v1/admin/me — all fields always present (default '').
interface AdminMe {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
}

export function PlatformConsole() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const apiFetch = useApiFetch();

  const meQuery = useQuery<AdminMe>({
    queryKey: ['admin-me'],
    queryFn: () => apiFetch<AdminMe>('/v1/admin/me'),
  });

  const metricsQuery = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => apiFetch<PlatformMetrics>('/v1/admin/metrics'),
  });

  const displayName = meQuery.data
    ? [meQuery.data.firstName, meQuery.data.lastName].filter(Boolean).join(' ') ||
      meQuery.data.email
    : undefined;

  const metrics = metricsQuery.data;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">Console piattaforma</h1>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => navigate('/officine')}>
              Officine
            </Button>
            <Button onClick={() => navigate('/officine/nuova')}>Crea officina</Button>
            <Button variant="outline" onClick={signOut}>
              Esci
            </Button>
          </div>
        </div>

        {meQuery.data && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>{displayName}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{meQuery.data.email}</p>
            </CardContent>
          </Card>
        )}

        {metricsQuery.isLoading && (
          <p className="text-muted-foreground">Caricamento metriche...</p>
        )}

        {metricsQuery.error && (
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
            Errore nel caricamento delle metriche. Riprova.
          </div>
        )}

        {!metricsQuery.isLoading && !metricsQuery.error && metrics && (
          <div className="space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <StatCard
                label="Officine"
                value={metrics.tenants.total}
                hint={`${metrics.tenants.active} attive · ${metrics.tenants.suspended} sospese`}
              />
              <StatCard label="Utenti officine" value={metrics.usersTotal} />
              <StatCard
                label="Interventi"
                value={metrics.interventions.total}
                hint={`${metrics.interventions.last30d} ultimi 30 giorni`}
              />
              <StatCard label="Veicoli" value={metrics.vehiclesTotal} />
              <StatCard label="Clienti" value={metrics.customersTotal} />
            </div>

            <InterventionsTrendChart data={metrics.trend} />
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: the error `role="alert"` now reports the metrics failure, satisfying the
error-state test. The identity card renders independently of the metrics query.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/admin-web test`
Expected: PASS (all PlatformConsole tests). recharts may log a width/height
warning under jsdom — harmless; the `trend-chart` container always renders.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-web/src/pages/PlatformConsole.tsx \
        packages/admin-web/tests/platform-console.test.tsx
git commit -m "feat(admin-web): platform metrics dashboard on console landing"
```

---

### Task 4: API docs

**Files:**
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Document the endpoint**

Find the platform-admin section of `docs/APPENDICE_A_API.md` (search for
`GET /v1/admin/me` or `/v1/admin/tenants`). Add an entry immediately after the
`GET /v1/admin/me` documentation, mirroring its format:

```markdown
### GET /v1/admin/metrics

Platform-level aggregate metrics for the admin console dashboard.

- **Auth:** platform-admins pool only (`requireAuth` + `requirePlatformAdminsPool`). No tenant context.
- **Errors:** `401 UNAUTHORIZED` (no/invalid token), `403 FORBIDDEN` (wrong pool).

**200 response:**

```json
{
  "tenants": { "total": 7, "active": 5, "suspended": 2 },
  "usersTotal": 19,
  "interventions": { "total": 420, "last30d": 33 },
  "vehiclesTotal": 88,
  "customersTotal": 64,
  "trend": [
    { "week": "2026-05-12", "count": 38 },
    { "week": "2026-05-19", "count": 41 }
  ]
}
```

`trend` is interventions per ISO week — exactly 8 ascending entries (current week
+ 7 prior), empty weeks zero-filled. `week` is the Monday of the ISO week
(YYYY-MM-DD). All counts are computed cross-tenant under the admin RLS context.
```

- [ ] **Step 2: Commit**

```bash
git add docs/APPENDICE_A_API.md
git commit -m "docs: document GET /v1/admin/metrics endpoint"
```

---

## Final steps (after all tasks)

- [ ] **Whole-branch review:** run `/code-review high` on the branch (load-bearing final gate — cross-references schema, APPENDICE_A/G, cross-task consistency). Apply Critical/Important findings; list Minor in the PR description.
- [ ] **Push & CI:** `git push -u origin feat/admin-slice4-metrics-platform`; watch with `gh pr checks <n>` (explicit, not only `--watch` — memory `gh pr checks --watch can exit 0 with integration still red`).
- [ ] **Smoke (BLOCKER — admin-web is UI-facing):** on `https://admin.garageos.aifollyadvisor.com`, log in → console shows the stat cards with real numbers + the trend chart renders; browser console clean (Vite `global` shim). Per the right-sizing rules and prior slices, smoke before merge.
- [ ] **Self-merge** only after CI green + final review + smoke pass + zero open questions: `gh pr merge <n> --squash --delete-branch`, then sync `main`.
- [ ] **PR description:** justify the `recharts` dependency; note that PR-B (per-tenant metrics) follows.

## Self-Review (plan vs spec)

- **Spec coverage:** platform endpoint (Task 1) ✓; all four platform metric groups — officine by status, users, interventions+30d, vehicles+customers (Task 1 DTO + Task 3 cards) ✓; trend 8-week zero-filled (Task 1 SQL + test) ✓; dashboard UI with cards + chart (Tasks 2-3) ✓; recharts decision (Task 2) ✓; Tier-1 API tests incl. isolation + cross-tenant correctness + zero-fill (Task 1) ✓; Tier-2 UI tests happy/error + chart-receives-series (Task 3) ✓; docs (Task 4) ✓; smoke BLOCKER (final) ✓. Per-tenant metrics are intentionally **PR-B**, out of this plan.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `PlatformMetrics`/`WeeklyTrendPoint` identical across API DTO (Task 1) and frontend mirror (Task 2); `StatCard`/`InterventionsTrendChart` props match their call sites in Task 3; `trend-chart` test-id defined in Task 2 and asserted in Task 3.

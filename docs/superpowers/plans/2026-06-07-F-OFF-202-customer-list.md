# F-OFF-202 Elenco clienti — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tenant-scoped, paginated, name-searchable customer list — `GET /v1/customers` (API) and a `/customers` page (web) — each row showing name, phone, vehicle count, and last intervention date, clickable through to the existing customer detail page.

**Architecture:** API mirrors the existing `customers.ts` search handler (auth → officina-pool → tenantContext → withContext), adds a thin pure serializer in `lib/customer-list-shared.ts`, and reuses the id-only cursor helpers. `vehicleCount` comes from a Prisma filtered `_count` on active ownerships; `lastInterventionAt` from the denormalized `CustomerTenantRelation` column. Web mirrors `DeadlineDashboard` (`useInfiniteQuery` + "Carica altre"), reuses `useDebouncedValue` for the name filter, and flips the already-present-but-disabled "Clienti" sidebar item to a real link.

**Tech Stack:** Fastify + Zod + Prisma (API), Vitest (unit + integration), React + react-router + @tanstack/react-query + Tailwind/shadcn (web).

**Spec:** `docs/superpowers/specs/2026-06-07-F-OFF-202-customer-list-design.md`

**Pre-flight notes (project conventions):**
- `/customers` DTO is **camelCase** (like all `/v1/customers*` routes).
- Integration tests use a free source IP in the `10.20.4x` range; reuse the existing `helpers.ts` fixtures (`createCustomer`, `createCustomerTenantRelation`, `createVehicle`, `createOwnership`).
- Commit messages: header ≤72 chars, body lines ≤100, scope in enum (`api`/`web`/`docs`). Use `git commit -F <file>` if a multi-line body is needed (here-strings break in the Bash tool).
- Do not pre-stage symbols before they are used (eslint pre-commit `no-unused-vars`).
- After each API task run `pnpm -r typecheck`; for route-handler tasks also run the api unit suite (typecheck does not catch broken FakePrisma mocks).
- No migration in this slice.

---

## File structure

**API**
- Create `packages/api/src/lib/customer-list-shared.ts` — select shape, row + DTO types, `projectCustomerListRow`.
- Create `packages/api/src/routes/v1/customers-list.ts` — `GET /v1/customers` handler.
- Modify `packages/api/src/server.ts` — register the new route.
- Create `packages/api/tests/unit/lib/customer-list-shared.test.ts`.
- Create `packages/api/tests/unit/routes/v1/customers-list.test.ts`.
- Create `packages/api/tests/integration/customers-list.test.ts`.

**Web**
- Modify `packages/web/src/queries/types.ts` — add `CustomerListItem` + `CustomerListResponse`.
- Create `packages/web/src/queries/customersList.ts` — `useCustomersList` infinite query.
- Create `packages/web/src/queries/customersList.test.tsx`.
- Create `packages/web/src/lib/customer-display.ts` — `customerDisplayName`.
- Create `packages/web/src/lib/customer-display.test.ts`.
- Create `packages/web/src/pages/CustomerList.tsx`.
- Create `packages/web/src/pages/CustomerList.test.tsx`.
- Modify `packages/web/src/App.tsx` — add `/customers` route.
- Modify `packages/web/src/components/layout/Sidebar.tsx` — enable "Clienti".
- Modify `packages/web/src/components/layout/Sidebar.test.tsx` — update expectations.

**Docs**
- Modify `docs/APPENDICE_A_API.md` — detailed `GET /v1/customers` section.

---

## Task 1: API shared serializer (`lib/customer-list-shared.ts`)

**Files:**
- Create: `packages/api/src/lib/customer-list-shared.ts`
- Test: `packages/api/tests/unit/lib/customer-list-shared.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/lib/customer-list-shared.test.ts
import { describe, expect, it } from 'vitest';

import {
  projectCustomerListRow,
  type CustomerListRow,
} from '../../../../src/lib/customer-list-shared.js';

function row(overrides: Partial<CustomerListRow> = {}): CustomerListRow {
  return {
    id: 'cust-1',
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: '+39 333 1234567',
    isBusiness: false,
    businessName: null,
    _count: { ownerships: 2 },
    tenantRelations: [{ lastInterventionAt: new Date('2026-05-01T10:00:00.000Z') }],
    ...overrides,
  };
}

describe('projectCustomerListRow', () => {
  it('maps fields and serializes lastInterventionAt to ISO', () => {
    expect(projectCustomerListRow(row())).toEqual({
      id: 'cust-1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    });
  });

  it('returns lastInterventionAt null when the CTR has none', () => {
    const dto = projectCustomerListRow(row({ tenantRelations: [{ lastInterventionAt: null }] }));
    expect(dto.lastInterventionAt).toBeNull();
  });

  it('passes phone null through and reads vehicleCount from _count', () => {
    const dto = projectCustomerListRow(row({ phone: null, _count: { ownerships: 0 } }));
    expect(dto.phone).toBeNull();
    expect(dto.vehicleCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- customer-list-shared`
Expected: FAIL — cannot find module `customer-list-shared.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/lib/customer-list-shared.ts
import type { Prisma } from '@garageos/database';

// Select shape for GET /v1/customers (list). vehicleCount uses a Prisma
// filtered relation count on active ownerships (endedAt null) — matching
// the detail endpoint, whose `vehicles` array is the customer's active
// ownerships regardless of tenant. lastInterventionAt is the denormalized
// per-tenant CTR column; the route handler injects the tenant `where` on
// tenantRelations (mirrors customers-detail.ts).
export const customerListSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  isBusiness: true,
  businessName: true,
  _count: { select: { ownerships: { where: { endedAt: null } } } },
  tenantRelations: {
    select: { lastInterventionAt: true },
  },
} as const satisfies Prisma.CustomerSelect;

// Concrete row shape Prisma returns for customerListSelect with the
// tenant-filtered tenantRelations. The CTR array is never empty when the
// outer find succeeds (the where filters tenantRelations.some).
export interface CustomerListRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  _count: { ownerships: number };
  tenantRelations: Array<{ lastInterventionAt: Date | null }>;
}

export interface CustomerListItemDto {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vehicleCount: number;
  lastInterventionAt: string | null;
}

export function projectCustomerListRow(row: CustomerListRow): CustomerListItemDto {
  // tenantRelations[0] guaranteed present: the outer find filters by
  // tenantRelations.some({ tenantId }). Defensive optional chaining keeps
  // tsc strict-happy without runtime cost.
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    isBusiness: row.isBusiness,
    businessName: row.businessName,
    vehicleCount: row._count.ownerships,
    lastInterventionAt: row.tenantRelations[0]?.lastInterventionAt?.toISOString() ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- customer-list-shared`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/api/src/lib/customer-list-shared.ts packages/api/tests/unit/lib/customer-list-shared.test.ts
git commit -m "feat(api): add customer-list serializer for F-OFF-202"
```

---

## Task 2: API endpoint `GET /v1/customers`

**Files:**
- Create: `packages/api/src/routes/v1/customers-list.ts`
- Modify: `packages/api/src/server.ts` (imports ~line 54-56; registration ~line 166-168)
- Test: `packages/api/tests/unit/routes/v1/customers-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/routes/v1/customers-list.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import customerListRoutes from '../../../../src/routes/v1/customers-list.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

interface FakePrisma {
  customer: { findMany: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    customer: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-uuid' }) },
    ...overrides,
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = deps.verifier ?? {
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
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(customerListRoutes);
  return app;
}

function seedRow(id = CUSTOMER_ID) {
  return {
    id,
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: '+39 333 1234567',
    isBusiness: false,
    businessName: null,
    _count: { ownerships: 2 },
    tenantRelations: [{ lastInterventionAt: new Date('2026-05-01T10:00:00.000Z') }],
  };
}

describe('GET /v1/customers — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/customers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for clienti-pool tokens', async () => {
    const clientiVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'clienti',
        payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
      }),
    };
    app = await buildApp({ verifier: clientiVerifier });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a request with no q (lists all)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('rejects q shorter than 2 chars when present', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=a',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit > 50', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=51',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/customers — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('projects the list DTO and omits PII (no email/taxCode/vatNumber)', async () => {
    prisma.customer.findMany.mockResolvedValueOnce([seedRow()]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>>; meta: unknown };
    expect(body.data[0]).toEqual({
      id: CUSTOMER_ID,
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    });
    expect(body.data[0]).not.toHaveProperty('email');
    expect(body.data[0]).not.toHaveProperty('taxCode');
    expect(body.data[0]).not.toHaveProperty('vatNumber');
  });

  it('scopes by tenant and orders by lastName, firstName, id (no q)', async () => {
    prisma.customer.findMany.mockResolvedValueOnce([seedRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: 'Bearer x' },
    });
    const call = prisma.customer.findMany.mock.calls[0]![0] as {
      where: {
        status: string;
        tenantRelations: { some: { tenantId: string; customerDeleted: boolean } };
        AND?: unknown;
      };
      orderBy: unknown;
      take: number;
    };
    expect(call.where.status).toBe('active');
    expect(call.where.tenantRelations).toEqual({
      some: { tenantId: TENANT_ID, customerDeleted: false },
    });
    expect(call.where.AND).toBeUndefined();
    expect(call.orderBy).toEqual([{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }]);
    expect(call.take).toBe(21);
  });

  it('builds the q token AND/OR clause when q is present', async () => {
    prisma.customer.findMany.mockResolvedValueOnce([seedRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/customers?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    const call = prisma.customer.findMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    expect(call.where.AND).toEqual([
      {
        OR: [
          { firstName: { contains: 'mar', mode: 'insensitive' } },
          { lastName: { contains: 'mar', mode: 'insensitive' } },
          { businessName: { contains: 'mar', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('returns has_more=true and a cursor when rows exceed limit', async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      seedRow(`${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`),
    );
    prisma.customer.findMany.mockResolvedValueOnce(rows);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as { data: unknown[]; meta: { has_more: boolean; cursor?: string } };
    expect(body.data).toHaveLength(20);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- customers-list`
Expected: FAIL — cannot find module `customers-list.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/routes/v1/customers-list.ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import {
  customerListSelect,
  projectCustomerListRow,
  type CustomerListRow,
} from '../../lib/customer-list-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// F-OFF-202 customer list. Tenant-scoped via the customer_tenant_relations
// JOIN (BR-151). Distinct from /v1/customers/search (autocomplete, q
// required, id-ordered): the list has optional q and alphabetical order.
// Least-PII DTO: only the fields shown in the list (no email/taxCode/
// vatNumber) — the detail endpoint already exposes those to the same
// related tenant.
const listQuerySchema = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const customerListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { q, limit, cursor } = listQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      // Same token split as /customers/search: AND across whitespace
      // tokens, OR across the 3 searchable columns. q is .trim()'d by the
      // schema, so tokens is never empty when q is present.
      const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

      return app.withContext({ tenantId }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const rows = (await tx.customer.findMany({
          where: {
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
            ...(tokens.length
              ? {
                  AND: tokens.map((token) => ({
                    OR: [
                      { firstName: { contains: token, mode: 'insensitive' as const } },
                      { lastName: { contains: token, mode: 'insensitive' as const } },
                      { businessName: { contains: token, mode: 'insensitive' as const } },
                    ],
                  })),
                }
              : {}),
          },
          select: {
            ...customerListSelect,
            tenantRelations: {
              ...customerListSelect.tenantRelations,
              where: { tenantId, customerDeleted: false },
            },
          },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        })) as CustomerListRow[];

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page.at(-1);

        return {
          data: page.map(projectCustomerListRow),
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );
};

export default customerListRoutes;
```

- [ ] **Step 4: Register the route in `server.ts`**

Add the import alongside the other customer imports (after line 56 `import customerRoutes from './routes/v1/customers.js';`):

```ts
import customerListRoutes from './routes/v1/customers-list.js';
```

Add the registration alongside the other customer registrations (after line 166 `await app.register(customerRoutes);`):

```ts
  await app.register(customerListRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @garageos/api test:unit -- customers-list`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/api/src/routes/v1/customers-list.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/customers-list.test.ts
git commit -m "feat(api): GET /v1/customers tenant customer list (F-OFF-202)"
```

---

## Task 3: API integration test

**Files:**
- Test: `packages/api/tests/integration/customers-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/integration/customers-list.test.ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-202 customer list end-to-end. Verifies tenant-scoping (BR-151),
// alphabetical ordering, the active-ownership vehicleCount, the
// denormalized lastInterventionAt, name search, and cursor pagination.

describe('GET /v1/customers (integration)', () => {
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

  async function tokenFor(tenantId: string, cognitoSub: string): Promise<string> {
    await createUser({ tenantId, cognitoSub });
    return signTestToken({ pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic' });
  }

  it('returns only customers related to the calling tenant, ordered by name', async () => {
    const { tenantId } = await createTenantWithLocation('cl-scope');
    const { tenantId: otherTenant } = await createTenantWithLocation('cl-scope-other');
    const token = await tokenFor(tenantId, '11111111-1111-4111-8111-111111111111');

    const { customerId: rossi } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: bianchi } = await createCustomer({ firstName: 'Anna', lastName: 'Bianchi' });
    const { customerId: hidden } = await createCustomer({ firstName: 'Zed', lastName: 'Hidden' });
    await createCustomerTenantRelation({ tenantId, customerId: rossi });
    await createCustomerTenantRelation({ tenantId, customerId: bianchi });
    await createCustomerTenantRelation({ tenantId: otherTenant, customerId: hidden });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string; lastName: string }> };
    // Alphabetical by lastName: Bianchi before Rossi; Hidden excluded.
    expect(body.data.map((c) => c.id)).toEqual([bianchi, rossi]);
  });

  it('counts only active ownerships in vehicleCount', async () => {
    const { tenantId } = await createTenantWithLocation('cl-count');
    const token = await tokenFor(tenantId, '22222222-2222-4222-8222-222222222222');

    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Conti' });
    await createCustomerTenantRelation({ tenantId, customerId });

    const { vehicleId: v1 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v2 } = await createVehicle({ createdByTenantId: tenantId });
    const { vehicleId: v3 } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId: v1, customerId });
    await createOwnership({ vehicleId: v2, customerId });
    // Terminated ownership must NOT be counted.
    await createOwnership({ vehicleId: v3, customerId, endedAt: new Date('2025-01-01') });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ id: string; vehicleCount: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.vehicleCount).toBe(2);
  });

  it('surfaces the denormalized lastInterventionAt from the CTR', async () => {
    const { tenantId } = await createTenantWithLocation('cl-last');
    const token = await tokenFor(tenantId, '33333333-3333-4333-8333-333333333333');

    const last = new Date('2026-05-01T10:00:00.000Z');
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Dati' });
    await createCustomerTenantRelation({ tenantId, customerId, lastInterventionAt: last });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ lastInterventionAt: string | null }> };
    expect(body.data[0]!.lastInterventionAt).toBe(last.toISOString());
  });

  it('filters by name via q', async () => {
    const { tenantId } = await createTenantWithLocation('cl-q');
    const token = await tokenFor(tenantId, '44444444-4444-4444-8444-444444444444');

    const { customerId: keep } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: drop } = await createCustomer({ firstName: 'Anna', lastName: 'Verdi' });
    await createCustomerTenantRelation({ tenantId, customerId: keep });
    await createCustomerTenantRelation({ tenantId, customerId: drop });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=ross',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([keep]);
  });

  it('paginates with cursor without gaps or duplicates', async () => {
    const { tenantId } = await createTenantWithLocation('cl-page');
    const token = await tokenFor(tenantId, '55555555-5555-4555-8555-555555555555');

    // Distinct last names so alphabetical order is deterministic.
    const names = ['Aldi', 'Bruno', 'Carli'];
    const ids: string[] = [];
    for (const lastName of names) {
      const { customerId } = await createCustomer({ firstName: 'Mario', lastName });
      await createCustomerTenantRelation({ tenantId, customerId });
      ids.push(customerId);
    }

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    const body1 = res1.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data.map((c) => c.id)).toEqual([ids[0], ids[1]]);
    expect(body1.meta.has_more).toBe(true);

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/customers?limit=2&cursor=${encodeURIComponent(body1.meta.cursor!)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as { data: Array<{ id: string }>; meta: { has_more: boolean } };
    expect(body2.data.map((c) => c.id)).toEqual([ids[2]]);
    expect(body2.meta.has_more).toBe(false);
  });
});
```

- [ ] **Step 2: Note on running**

Per project policy, **do not run integration tests locally** (Docker/Testcontainers freezes Windows). Push and let CI run them: `gh pr checks --watch`. If you must reproduce a CI failure: `pnpm --filter @garageos/api test:integration -- customers-list`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/customers-list.test.ts
git commit -m "test(api): integration coverage for GET /v1/customers"
```

---

## Task 4: Web query hook + types

**Files:**
- Modify: `packages/web/src/queries/types.ts`
- Create: `packages/web/src/queries/customersList.ts`
- Test: `packages/web/src/queries/customersList.test.tsx`

- [ ] **Step 1: Add types to `types.ts`**

Append near the other customer types (after `CustomerSearchResponse`, ~line 189):

```ts
export interface CustomerListItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vehicleCount: number;
  lastInterventionAt: string | null;
}

export interface CustomerListResponse {
  data: CustomerListItem[];
  meta: { has_more: boolean; cursor?: string };
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// packages/web/src/queries/customersList.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCustomersList } from './customersList';
import type { CustomerListResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

const page1: CustomerListResponse = {
  data: [
    {
      id: 'c1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    },
  ],
  meta: { has_more: true, cursor: 'CUR1' },
};

describe('useCustomersList', () => {
  it('fetches /v1/customers with limit and no q by default', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList(''), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?limit=20');
    expect(result.current.data?.pages[0]?.data[0]?.id).toBe('c1');
  });

  it('includes q when provided (trimmed)', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList('  ross '), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?q=ross&limit=20');
  });

  it('passes meta.cursor as the next page param', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    apiFetchMock.mockResolvedValueOnce({ data: [], meta: { has_more: false } });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList(''), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith('/v1/customers?limit=20&cursor=CUR1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- customersList`
Expected: FAIL — cannot find module `./customersList`.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/web/src/queries/customersList.ts
import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { CustomerListResponse } from './types';

// F-OFF-202 customer list. Tenant-scoped GET /v1/customers; optional name
// search via q (the caller passes an already-debounced value). Cursor
// pagination via meta.cursor (id-only opaque cursor).
export function useCustomersList(q: string) {
  const apiFetch = useApiFetch();
  const trimmed = q.trim();
  return useInfiniteQuery({
    queryKey: ['customers', 'list', trimmed] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (trimmed) search.set('q', trimmed);
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<CustomerListResponse>(`/v1/customers?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => (last.meta.has_more ? last.meta.cursor : undefined),
    staleTime: 60_000,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- customersList`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/queries/types.ts packages/web/src/queries/customersList.ts packages/web/src/queries/customersList.test.tsx
git commit -m "feat(web): useCustomersList infinite query (F-OFF-202)"
```

---

## Task 5: Web display helper

**Files:**
- Create: `packages/web/src/lib/customer-display.ts`
- Test: `packages/web/src/lib/customer-display.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/customer-display.test.ts
import { describe, expect, it } from 'vitest';

import { customerDisplayName } from './customer-display';

describe('customerDisplayName', () => {
  it('returns "Cognome Nome" for a private customer', () => {
    expect(
      customerDisplayName({ isBusiness: false, businessName: null, firstName: 'Mario', lastName: 'Rossi' }),
    ).toBe('Rossi Mario');
  });

  it('returns the business name for a business customer', () => {
    expect(
      customerDisplayName({
        isBusiness: true,
        businessName: 'Trattoria Da Luigi S.r.l.',
        firstName: 'Luigi',
        lastName: 'Verdi',
      }),
    ).toBe('Trattoria Da Luigi S.r.l.');
  });

  it('falls back to person name when business has no businessName', () => {
    expect(
      customerDisplayName({ isBusiness: true, businessName: null, firstName: 'Luigi', lastName: 'Verdi' }),
    ).toBe('Verdi Luigi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- customer-display`
Expected: FAIL — cannot find module `./customer-display`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/lib/customer-display.ts

// Display label for a customer row. Business customers show their
// businessName; otherwise (and as a fallback when a business row has no
// businessName) show "Cognome Nome" — the order officina staff scan by.
export function customerDisplayName(c: {
  isBusiness: boolean;
  businessName: string | null;
  firstName: string;
  lastName: string;
}): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return `${c.lastName} ${c.firstName}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- customer-display`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/customer-display.ts packages/web/src/lib/customer-display.test.ts
git commit -m "feat(web): customerDisplayName helper for customer list"
```

---

## Task 6: Web `CustomerList` page

**Files:**
- Create: `packages/web/src/pages/CustomerList.tsx`
- Test: `packages/web/src/pages/CustomerList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/pages/CustomerList.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CustomerList } from './CustomerList';
import type { CustomerListResponse } from '@/queries/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<CustomerList />, { wrapper: Wrapper });
}

const onePage: CustomerListResponse = {
  data: [
    {
      id: 'c1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    },
    {
      id: 'c2',
      firstName: 'Anna',
      lastName: 'Bianchi',
      phone: null,
      isBusiness: false,
      businessName: null,
      vehicleCount: 0,
      lastInterventionAt: null,
    },
  ],
  meta: { has_more: false },
};

describe('CustomerList', () => {
  beforeEach(() => apiFetchMock.mockReset());
  afterEach(() => vi.clearAllTimers());

  it('renders customer rows with name, phone, vehicle count, last intervention', async () => {
    apiFetchMock.mockResolvedValueOnce(onePage);
    renderPage();

    expect(await screen.findByText('Rossi Mario')).toBeInTheDocument();
    expect(screen.getByText('Bianchi Anna')).toBeInTheDocument();
    // Private customer with no phone shows the em-dash fallback.
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument();
    // Last intervention null shows "Nessuno".
    expect(screen.getByText('Nessuno')).toBeInTheDocument();
  });

  it('shows the empty state when no customers match', async () => {
    apiFetchMock.mockResolvedValueOnce({ data: [], meta: { has_more: false } });
    renderPage();
    expect(await screen.findByText(/nessun cliente/i)).toBeInTheDocument();
  });

  it('shows an error alert with retry on failure', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument();
  });

  it('passes the typed query to the API (debounced)', async () => {
    apiFetchMock.mockResolvedValue(onePage);
    renderPage();
    await screen.findByText('Rossi Mario');

    const input = screen.getByPlaceholderText(/cerca per nome/i);
    await userEvent.type(input, 'ross');

    await waitFor(
      () => expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?q=ross&limit=20'),
      { timeout: 2000 },
    );
  });

  it('shows "Carica altre" when there is a next page', async () => {
    apiFetchMock.mockResolvedValueOnce({ ...onePage, meta: { has_more: true, cursor: 'CUR1' } });
    renderPage();
    expect(await screen.findByRole('button', { name: /carica altre/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- CustomerList`
Expected: FAIL — cannot find module `./CustomerList`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/web/src/pages/CustomerList.tsx
// IT-strings — hardcoded, no i18n in demo-2
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, SearchX } from 'lucide-react';

import { useCustomersList } from '@/queries/customersList';
import { customerDisplayName } from '@/lib/customer-display';
import { formatDate } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { CustomerListItem } from '@/queries/types';

export function CustomerList() {
  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q, 300);
  const query = useCustomersList(debouncedQ);
  const navigate = useNavigate();

  const items: CustomerListItem[] = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Users size={24} className="text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Clienti</h1>
      </div>

      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cerca per nome o ragione sociale"
        className="w-72"
      />

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{query.error instanceof Error ? query.error.message : 'Errore sconosciuto'}</span>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.isSuccess && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX size={48} className="mb-3" />
          <div className="font-medium text-foreground">Nessun cliente trovato.</div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-3 font-semibold">Nome</th>
                <th className="px-4 py-3 font-semibold">Telefono</th>
                <th className="px-4 py-3 font-semibold text-right">Veicoli</th>
                <th className="px-4 py-3 font-semibold">Ultimo intervento</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/customers/${c.id}`)}
                  className="cursor-pointer hover:bg-muted/50 transition"
                >
                  <td className="px-4 py-3 font-medium text-foreground">{customerDisplayName(c)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.phone ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.vehicleCount}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.lastInterventionAt ? formatDate(c.lastInterventionAt) : 'Nessuno'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <div className="pt-2">
          <Button
            variant="outline"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- CustomerList`
Expected: PASS (5 tests). If the debounce test flakes, confirm `useDebouncedValue` uses real timers and the `waitFor` timeout (2000ms) exceeds the 300ms debounce.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/pages/CustomerList.tsx packages/web/src/pages/CustomerList.test.tsx
git commit -m "feat(web): customer list page (F-OFF-202)"
```

---

## Task 7: Web routing + sidebar

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.test.tsx`

- [ ] **Step 1: Update the Sidebar test (failing first)**

Replace the disabled-"Clienti" expectation. Add this test inside the existing `describe('Sidebar', …)` block:

```tsx
  it('"Clienti" links to /customers and is active on that path', () => {
    const { unmount } = renderAt('/customers');
    const link = screen.getByRole('link', { name: /clienti/i });
    expect(link).toHaveAttribute('href', '/customers');
    expect(link).toHaveAttribute('aria-current', 'page');
    unmount();
  });
```

If an existing test asserts that "Clienti" is disabled / shows "soon", update or remove it so it no longer expects a disabled item. Search the file for `clienti`/`soon` and adjust.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- Sidebar`
Expected: FAIL — "Clienti" is currently a non-link disabled `div`, so `getByRole('link', { name: /clienti/i })` throws.

- [ ] **Step 3: Enable the nav item in `Sidebar.tsx`**

Change the `customers` entry (line 11) from:

```ts
  { id: 'customers', label: 'Clienti', icon: Users, enabled: false },
```

to:

```ts
  { id: 'customers', label: 'Clienti', icon: Users, to: '/customers', enabled: true },
```

Add a `customers` branch to `isActiveFor` (after the `settings` branch):

```ts
  if (itemId === 'customers') {
    return pathname.startsWith('/customers');
  }
```

- [ ] **Step 4: Add the route in `App.tsx`**

Add the import alongside the other page imports (after the `CustomerDetail` import, line 11):

```ts
import { CustomerList } from '@/pages/CustomerList';
```

Add the route inside `<AppLayout>` (before `/customers/:id`, line 49) so the static path is registered alongside it:

```tsx
                  <Route path="/customers" element={<CustomerList />} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @garageos/web test -- Sidebar`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/App.tsx packages/web/src/components/layout/Sidebar.tsx packages/web/src/components/layout/Sidebar.test.tsx
git commit -m "feat(web): route + sidebar entry for customer list (F-OFF-202)"
```

---

## Task 8: Docs — APPENDICE_A detailed section

**Files:**
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Add a detailed `GET /v1/customers` section**

Insert a new subsection after §2.8 (`GET /v1/customers/search`) and before §2.9 (`GET /v1/customers/:id`). Renumber the existing detail section if the doc numbers sequentially, or add as §2.8b if renumbering is disruptive — follow the file's existing convention. Content:

````markdown
### 2.8b `GET /v1/customers` — Elenco clienti officina (F-OFF-202)

Lista paginata dei clienti del tenant, ordinata alfabeticamente per
cognome/nome. Ricerca opzionale per nome (`q`). Tenant-scoped via
`customer_tenant_relations` (BR-151).

**Auth:** Tenant User (pool officine). 401 senza token, 403 con token pool
clienti.

**Query string:**

| Param | Tipo | Default | Note |
|---|---|---|---|
| `q` | string | — | opzionale; se presente `2..60` char. Match case-insensitive su `firstName`/`lastName`/`businessName` (AND tra token whitespace, OR tra colonne). `email`/`taxCode`/`vatNumber` NON matchabili. |
| `limit` | int | 20 | `1..50` |
| `cursor` | string | — | cursore opaco id-only (dalla `meta.cursor` della pagina precedente) |

**Ordinamento:** `lastName ASC, firstName ASC, id ASC`.

**Response 200** (camelCase):

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Mario",
      "lastName": "Rossi",
      "phone": "+39 333 1234567",
      "isBusiness": false,
      "businessName": null,
      "vehicleCount": 2,
      "lastInterventionAt": "2026-05-01T10:00:00.000Z"
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaco>" }
}
```

- `vehicleCount`: numero di ownership **attive** del cliente (`ended_at IS NULL`),
  non tenant-scoped — coerente con l'array `vehicles` del dettaglio.
- `lastInterventionAt`: colonna denormalizzata per-tenant
  `customer_tenant_relations.last_intervention_at` (null se nessun intervento).
- DTO **least-PII**: niente `email`/`taxCode`/`vatNumber` (esposti solo dal
  dettaglio `GET /v1/customers/:id`).
- `meta.cursor` presente solo quando `has_more` è `true`.

Distinto da `GET /v1/customers/search` (autocomplete: `q` obbligatorio,
ordinamento per `id`, DTO con email).
````

- [ ] **Step 2: Commit**

```bash
git add docs/APPENDICE_A_API.md
git commit -m "docs: detail GET /v1/customers in APPENDICE_A (F-OFF-202)"
```

---

## Final verification

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm --filter @garageos/api test:unit` green (new shared + route unit suites).
- [ ] `pnpm --filter @garageos/web test` green (query + helper + page + sidebar).
- [ ] Push branch `feat/customers-list`, open PR, watch CI: `gh pr checks --watch` (integration + lint + cdk-synth run on CI).
- [ ] Single final Opus review of the whole diff before merge.

## PR description checklist (per CLAUDE.md)

- **What:** read-only customer list — `GET /v1/customers` + `/customers` page.
- **Why:** F-OFF-202 (MUST) gap from audit `2026-05-31`; BR-151 PII scoping.
- **Implementation notes:** `vehicleCount` via filtered `_count`; `lastInterventionAt` from denormalized CTR; least-PII DTO; sidebar item enabled.
- **Tests:** unit (serializer, route, query hook, display helper, page, sidebar) + integration (scoping, count, last-intervention, search, pagination).
- **Docs:** APPENDICE_A §2.8b added.
- No migration. No new dependency.

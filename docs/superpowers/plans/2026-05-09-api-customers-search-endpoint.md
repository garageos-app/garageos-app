# Customers Search Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /v1/customers/search` — tenant-scoped autocomplete search of customers by `firstName`/`lastName`/`businessName` for the officina UI.

**Architecture:** Fastify route plugin mounted under `/v1`, auth via `requireAuth + requireOfficinaPool + tenantContext`. Tenant scoping via Prisma `customerTenantRelation.some` JOIN (RLS-permissive `customers_read USING (true)` is supplemented at the application layer). Cursor pagination identical to PR #76 vehicles search, with helpers extracted to `lib/cursor.ts` for the second consumer.

**Tech Stack:** Fastify, Zod, Prisma 7, Vitest (unit), Testcontainers Postgres (integration), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-09-api-customers-search-endpoint-design.md`

---

## File structure

| File | State | Purpose | Est LOC |
|---|---|---|---|
| `packages/api/src/lib/cursor.ts` | NEW | `encodeCursor`/`decodeCursor` extracted from `vehicles.ts` | ~20 |
| `packages/api/src/lib/cursor.test.ts` | NEW | Unit tests for cursor helpers | ~25 |
| `packages/api/src/routes/v1/customers.ts` | NEW | Route plugin with `GET /v1/customers/search` handler | ~85 |
| `packages/api/src/routes/v1/vehicles.ts:207-221` | MODIFY | Replace inline cursor helpers with import from `lib/cursor.ts` | −15 |
| `packages/api/src/server.ts` | MODIFY | Import + register `customerRoutes` | +2 |
| `packages/api/tests/integration/helpers.ts` | MODIFY | Extend `createCustomer` + `createCustomerTenantRelation` with new optional params | ~+15 |
| `packages/api/tests/unit/routes/v1/customers.test.ts` | NEW | Schema validation + auth + Prisma stub data path | ~110 |
| `packages/api/tests/integration/customers-search.test.ts` | NEW | Real-DB scenarios | ~180 |
| `docs/APPENDICE_A_API.md` | MODIFY | Document the endpoint | +30 |

**Net total:** ~450 LOC (entro budget — lo spec stimava 290 ma sotto-stimato unit e helpers).

---

## Task 1: Extract cursor helpers to `lib/cursor.ts`

**Why first:** PR #76 `vehicles.ts` already has these helpers inline. Extracting them now (a) gives Task 4 a clean import, (b) avoids duplicating ~10 LOC, (c) is the smallest reversible step.

**Files:**
- Create: `packages/api/src/lib/cursor.ts`
- Create: `packages/api/src/lib/cursor.test.ts`
- Modify: `packages/api/src/routes/v1/vehicles.ts:207-221` (remove inline definitions, add import)

- [ ] **Step 1.1: Write the unit tests for cursor helpers**

Create `packages/api/src/lib/cursor.test.ts` with this content:

```ts
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor helpers', () => {
  it('round-trips a uuid through encode/decode', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cursor = encodeCursor(id);
    expect(decodeCursor(cursor)).toBe(id);
  });

  it('returns undefined when the cursor is undefined', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('returns undefined when the cursor is not valid base64url JSON', () => {
    expect(decodeCursor('not-a-cursor')).toBeUndefined();
  });

  it('returns undefined when the decoded payload has no id field', () => {
    const cursor = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(decodeCursor(cursor)).toBeUndefined();
  });

  it('returns undefined when the decoded payload id is not a string', () => {
    const cursor = Buffer.from(JSON.stringify({ id: 42 }), 'utf8').toString('base64url');
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
pnpm --filter @garageos/api exec vitest run src/lib/cursor.test.ts
```

Expected: FAIL with "Cannot find module './cursor.js'" (file does not exist yet).

- [ ] **Step 1.3: Create `lib/cursor.ts`**

Create `packages/api/src/lib/cursor.ts`:

```ts
// Cursor helpers for id-based pagination. Shared by /v1/vehicles/search
// (PR #76) and /v1/customers/search. Base64url-encoded JSON `{ id }` is
// opaque enough to discourage clients from constructing cursors by hand
// while remaining easy to debug in logs.

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
pnpm --filter @garageos/api exec vitest run src/lib/cursor.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 1.5: Refactor `vehicles.ts` to import from `lib/cursor.ts`**

Open `packages/api/src/routes/v1/vehicles.ts`. At the top, add the import (alphabetical order with the other `lib/` imports):

```ts
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
```

Then delete the inline definitions at lines 207-221:

```ts
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 1.6: Run all api unit tests to ensure no regression**

```bash
pnpm --filter @garageos/api exec vitest run --dir tests/unit --dir src/lib
```

Expected: all existing api unit tests still pass + 5 new cursor tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add packages/api/src/lib/cursor.ts packages/api/src/lib/cursor.test.ts packages/api/src/routes/v1/vehicles.ts
git commit -m "refactor(api): extract cursor helpers to lib/cursor.ts

Lifted encodeCursor/decodeCursor out of vehicles.ts so the upcoming
/v1/customers/search handler can reuse them without duplication.
Behavior unchanged; existing vehicles tests cover both consumers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extend integration test helpers

**Why:** the integration suite needs to seed customers with `isBusiness`/`businessName`/`vatNumber`/`status` and CTRs with `customerDeleted=true` to exercise filtering. Current helpers don't expose those fields.

**Files:**
- Modify: `packages/api/tests/integration/helpers.ts` (`createCustomer`, `createCustomerTenantRelation`)

- [ ] **Step 2.1: Extend `createCustomer` with optional B2B + status params**

Open `packages/api/tests/integration/helpers.ts`. Replace the `createCustomer` function (lines ~100-132) with:

```ts
export async function createCustomer(params: {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  // Set when the test needs a customer that authenticates via the
  // clienti pool. Mirrors the cognito_sub linkage flow at signup
  // (BR-130 — customer Cognito → Customer row mapping).
  cognitoSub?: string | null;
  // BR-226 channel × event toggles. Defaults to `{}` so the
  // application-side fallback (DEFAULT_NOTIFICATION_PREFERENCES) kicks
  // in — matches signup behavior.
  notificationPreferences?: object;
  // B2B optional fields exposed so the customers/search suite can
  // exercise businessName matching. Default false/null preserves the
  // existing B2C-shaped fixture.
  isBusiness?: boolean;
  businessName?: string | null;
  vatNumber?: string | null;
  // Allow seeding pending_verification / deleted rows to verify the
  // status='active' filter. Default 'active' preserves the previous
  // behavior of every existing call site.
  status?: 'active' | 'pending_verification' | 'deleted';
}): Promise<{ customerId: string; email: string }> {
  const {
    email = `cust-${Math.random().toString(36).slice(2, 10)}@test.it`,
    firstName = 'Mario',
    lastName = 'Rossi',
    phone = '+39 333 1234567',
    cognitoSub = null,
    notificationPreferences = {},
    isBusiness = false,
    businessName = null,
    vatNumber = null,
    status = 'active',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customers
       (id, cognito_sub, email, first_name, last_name, phone,
        is_business, business_name, vat_number, status,
        notification_preferences, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9::"CustomerStatus",
        $10::jsonb, NOW(), NOW())
     RETURNING id`,
    [
      cognitoSub,
      email,
      firstName,
      lastName,
      phone,
      isBusiness,
      businessName,
      vatNumber,
      status,
      JSON.stringify(notificationPreferences),
    ],
  );
  return { customerId: rows[0]!.id, email };
}
```

- [ ] **Step 2.2: Extend `createCustomerTenantRelation` with `customerDeleted`**

Replace `createCustomerTenantRelation` (lines ~210-225):

```ts
export async function createCustomerTenantRelation(params: {
  tenantId: string;
  customerId: string;
  customerDeleted?: boolean;
}): Promise<{ relationId: string }> {
  const { tenantId, customerId, customerDeleted = false } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO customer_tenant_relations
       (id, tenant_id, customer_id, intervention_count, customer_deleted, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 0, $3, NOW(), NOW())
     RETURNING id`,
    [tenantId, customerId, customerDeleted],
  );
  return { relationId: rows[0]!.id };
}
```

- [ ] **Step 2.3: Verify nothing else breaks**

The existing call sites pass no `isBusiness`/`businessName`/`vatNumber`/`status`/`customerDeleted` params, so the defaults preserve current behavior. Run a typecheck on the api package to confirm:

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

- [ ] **Step 2.4: Commit**

```bash
git add packages/api/tests/integration/helpers.ts
git commit -m "test(api): extend integration helpers with B2B + status fields

Surfaces isBusiness/businessName/vatNumber/status on createCustomer
and customerDeleted on createCustomerTenantRelation so the upcoming
customers/search suite can exercise filtering. Defaults preserve
all existing call sites.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Write unit tests for the customer search route (red phase)

**TDD red phase**: write the unit tests first; they will fail because the route file does not exist yet.

**Files:**
- Create: `packages/api/tests/unit/routes/v1/customers.test.ts`

- [ ] **Step 3.1: Create the unit test file**

Create `packages/api/tests/unit/routes/v1/customers.test.ts`:

```ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import customerRoutes from '../../../../src/routes/v1/customers.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

interface FakePrisma {
  customer: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    customer: {
      findMany: vi.fn().mockResolvedValue([]),
    },
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
  await app.register(customerRoutes);
  return app;
}

describe('GET /v1/customers/search — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('rejects requests without q', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects q shorter than 2 chars', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=a',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects q longer than 60 chars', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=${'x'.repeat(61)}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit < 1', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar&limit=0',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit > 50', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar&limit=51',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/customers/search?q=mar' });
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
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/customers/search — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  function seedRow() {
    return {
      id: CUSTOMER_ID,
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'mario@example.it',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vatNumber: null,
      status: 'active' as const,
    };
  }

  it('returns the DTO shape on a valid query (empty page)', async () => {
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('passes q + tenantId to the Prisma where clause', async () => {
    prisma.customer.findMany.mockResolvedValueOnce([seedRow()]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    const call = prisma.customer.findMany.mock.calls[0]![0] as {
      where: {
        status: string;
        tenantRelations: { some: { tenantId: string; customerDeleted: boolean } };
        OR: Array<Record<string, unknown>>;
      };
    };
    expect(call.where.status).toBe('active');
    expect(call.where.tenantRelations).toEqual({
      some: { tenantId: TENANT_ID, customerDeleted: false },
    });
    expect(call.where.OR).toEqual([
      { firstName: { contains: 'mar', mode: 'insensitive' } },
      { lastName: { contains: 'mar', mode: 'insensitive' } },
      { businessName: { contains: 'mar', mode: 'insensitive' } },
    ]);
  });

  it('returns has_more=true and a cursor when rows exceed limit', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...seedRow(),
      id: `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    prisma.customer.findMany.mockResolvedValueOnce(rows);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as {
      data: unknown[];
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body.data).toHaveLength(20);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeTruthy();
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail (red)**

```bash
pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/customers.test.ts
```

Expected: FAIL with "Cannot find module '../../../../src/routes/v1/customers.js'".

---

## Task 4: Implement the customer search route (green phase)

**Files:**
- Create: `packages/api/src/routes/v1/customers.ts`
- Modify: `packages/api/src/server.ts` (register the plugin)

- [ ] **Step 4.1: Create the route file**

Create `packages/api/src/routes/v1/customers.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// E2 customer autocomplete (Persona Giuseppe demo). Tenant-scoped via
// the customer_tenant_relations JOIN — see
// docs/superpowers/specs/2026-05-09-api-customers-search-endpoint-design.md
// §2.3 for the BR-151 rationale (customers_read RLS is permissive,
// PII gating happens in WHERE here).
//
// q matches firstName / lastName / businessName only. email / taxCode /
// vatNumber are intentionally NOT searchable to keep PII surface low.

const searchQuerySchema = z.object({
  q: z.string().min(2).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const customerSearchSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  isBusiness: true,
  businessName: true,
  vatNumber: true,
  status: true,
} as const;

const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers/search',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { q, limit, cursor } = searchQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const rows = await tx.customer.findMany({
          where: {
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { businessName: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: customerSearchSelect,
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page.at(-1);

        return {
          data: page,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );
};

export default customerRoutes;
```

- [ ] **Step 4.2: Register the route in `server.ts`**

Open `packages/api/src/server.ts`. Find the import block (around line 36-37 where `vehicleRoutes` is imported) and add the customer import in alphabetical order:

```ts
import customerRoutes from './routes/v1/customers.js';
```

Then find the `await app.register(vehicleRoutes);` call (around line 123) and add immediately before it:

```ts
  await app.register(customerRoutes);
```

The result should look like:

```ts
  await app.register(tenantRoutes);
  await app.register(customerRoutes);
  await app.register(vehicleRoutes);
  await app.register(vehicleUpdateRoutes);
```

- [ ] **Step 4.3: Run unit tests to verify they pass (green)**

```bash
pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/customers.test.ts
```

Expected: PASS — 10 tests (7 validation/auth + 3 data-path).

- [ ] **Step 4.4: Run typecheck**

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

- [ ] **Step 4.5: Commit**

```bash
git add packages/api/src/routes/v1/customers.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/customers.test.ts
git commit -m "feat(api): GET /v1/customers/search endpoint

Tenant-scoped autocomplete by firstName/lastName/businessName for the
officina UI (Persona Giuseppe demo). Mirrors the cursor pagination of
PR #76 vehicles search; PII visibility is satisfied by construction
because the customer_tenant_relations JOIN excludes non-related rows
(BR-151).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Integration tests against real Postgres + RLS

**Files:**
- Create: `packages/api/tests/integration/customers-search.test.ts`

- [ ] **Step 5.1: Create the integration test file**

Create `packages/api/tests/integration/customers-search.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createTenantWithLocation,
  createUser,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// E2 customer search end-to-end. Verifies the tenant-scoping JOIN
// (BR-151), the ILIKE substring case-insensitive match across the
// three searchable fields, the customer_deleted + status filters, and
// cursor pagination. Cross-tenant non-leakage gets its own scenario
// because that is the load-bearing privacy guarantee.

describe('GET /v1/customers/search (integration)', () => {
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

  it('returns only customers related to the calling tenant', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cs-scope-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cs-scope-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tenantA, cognitoSub });

    const { customerId: aliceId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { customerId: bobId } = await createCustomer({ firstName: 'Mario', lastName: 'Bianchi' });
    const { customerId: carolId } = await createCustomer({ firstName: 'Mario', lastName: 'Verdi' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: aliceId });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: bobId });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId: carolId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantA,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id).sort();
    expect(ids).toEqual([aliceId, bobId].sort());
    expect(ids).not.toContain(carolId);
  });

  it('does not leak customers from other tenants (BR-151 cross-tenant)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cs-leak-A');
    const { tenantId: tenantB } = await createTenantWithLocation('cs-leak-B');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId: tenantB, cognitoSub });

    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Hidden' });
    // Only tenantA is related; tenantB is NOT.
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId: tenantB,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });

  it('matches case-insensitively on firstName, lastName, businessName', async () => {
    const { tenantId } = await createTenantWithLocation('cs-ilike');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });

    const { customerId: c1 } = await createCustomer({ firstName: 'Marina', lastName: 'Esposito' });
    const { customerId: c2 } = await createCustomer({ firstName: 'Luca', lastName: 'Marini' });
    const { customerId: c3 } = await createCustomer({
      firstName: 'B2B',
      lastName: 'Owner',
      isBusiness: true,
      businessName: 'MARTINI Auto Service',
    });
    const { customerId: c4 } = await createCustomer({ firstName: 'Anna', lastName: 'Bianchi' });
    await createCustomerTenantRelation({ tenantId, customerId: c1 });
    await createCustomerTenantRelation({ tenantId, customerId: c2 });
    await createCustomerTenantRelation({ tenantId, customerId: c3 });
    await createCustomerTenantRelation({ tenantId, customerId: c4 });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=mar',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id).sort();
    expect(ids).toEqual([c1, c2, c3].sort());
    expect(ids).not.toContain(c4);
  });

  it('returns full DTO shape including B2B fields', async () => {
    const { tenantId } = await createTenantWithLocation('cs-shape');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });

    const { customerId } = await createCustomer({
      firstName: 'Trattoria',
      lastName: 'DaLuigi',
      isBusiness: true,
      businessName: 'Trattoria Da Luigi S.r.l.',
      vatNumber: 'IT01234567890',
      phone: '+39 02 1234567',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=trattoria',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        phone: string | null;
        isBusiness: boolean;
        businessName: string | null;
        vatNumber: string | null;
        status: string;
      }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: customerId,
      firstName: 'Trattoria',
      lastName: 'DaLuigi',
      isBusiness: true,
      businessName: 'Trattoria Da Luigi S.r.l.',
      vatNumber: 'IT01234567890',
      phone: '+39 02 1234567',
      status: 'active',
    });
  });

  it('excludes customers with customer_deleted=true on the relation', async () => {
    const { tenantId } = await createTenantWithLocation('cs-deleted-rel');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });

    const { customerId: kept } = await createCustomer({ firstName: 'Mario', lastName: 'Kept' });
    const { customerId: dropped } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Dropped',
    });
    await createCustomerTenantRelation({ tenantId, customerId: kept });
    await createCustomerTenantRelation({ tenantId, customerId: dropped, customerDeleted: true });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([kept]);
    expect(body.data.map((c) => c.id)).not.toContain(dropped);
  });

  it('excludes customers with status != active', async () => {
    const { tenantId } = await createTenantWithLocation('cs-status');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId, cognitoSub });

    const { customerId: active } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Active',
      status: 'active',
    });
    const { customerId: pending } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Pending',
      status: 'pending_verification',
    });
    const { customerId: deleted } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Deleted',
      status: 'deleted',
    });
    await createCustomerTenantRelation({ tenantId, customerId: active });
    await createCustomerTenantRelation({ tenantId, customerId: pending });
    await createCustomerTenantRelation({ tenantId, customerId: deleted });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual([active]);
  });

  it('paginates with cursor and returns has_more=true when results exceed limit', async () => {
    const { tenantId } = await createTenantWithLocation('cs-pagination');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { customerId } = await createCustomer({
        firstName: 'Mario',
        lastName: `Pag${i}`,
        email: `pag-${i}-${Math.random().toString(36).slice(2, 8)}@test.it`,
      });
      await createCustomerTenantRelation({ tenantId, customerId });
      ids.push(customerId);
    }
    const expectedSorted = [...ids].sort();

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=Mario&limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean; cursor?: string };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.has_more).toBe(true);
    expect(body1.meta.cursor).toBeTruthy();
    expect(body1.data.map((c) => c.id)).toEqual(expectedSorted.slice(0, 2));

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/customers/search?q=Mario&limit=2&cursor=${encodeURIComponent(body1.meta.cursor!)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as {
      data: Array<{ id: string }>;
      meta: { has_more: boolean };
    };
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0]!.id).toBe(expectedSorted[2]);
    expect(body2.meta.has_more).toBe(false);
  });

  it('returns empty data array when no row matches', async () => {
    const { tenantId } = await createTenantWithLocation('cs-empty');
    const cognitoSub = '88888888-8888-4888-8888-888888888888';
    await createUser({ tenantId, cognitoSub });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers/search?q=zzzzz',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], meta: { has_more: false } });
  });
});
```

- [ ] **Step 5.2: (Local debug only) Optionally smoke-run the new integration test**

Per CLAUDE.md, integration tests are CI-gated, not a local pre-PR gate. **Skip running them locally**: pushing the branch will trigger CI which is the authoritative check.

If you want to debug a specific failure later, the narrow command is:

```bash
pnpm --filter @garageos/api test:integration -- customers-search.test.ts
```

(Run only when reproducing a CI failure — see CLAUDE.md "Testing" section.)

- [ ] **Step 5.3: Commit**

```bash
git add packages/api/tests/integration/customers-search.test.ts
git commit -m "test(api): integration suite for /v1/customers/search

Eight scenarios against real Postgres + RLS: tenant scoping, BR-151
cross-tenant non-leakage, ILIKE case-insensitive matching across the
three searchable fields, full DTO shape including B2B, customer_deleted
exclusion, status filter, cursor pagination, empty result.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Document the endpoint in `APPENDICE_A_API.md`

**Files:**
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 6.1: Locate the customer endpoints section (or create one)**

Open `docs/APPENDICE_A_API.md`. Find a sensible insertion point — either an existing customer-related section, or right after the vehicles search section. Use Grep to confirm:

```bash
# (run via the assistant's Grep tool, not Bash)
# pattern: "vehicles/search"
# path: docs/APPENDICE_A_API.md
```

If a `## Customers` heading does not yet exist, add it before the upcoming endpoint section.

- [ ] **Step 6.2: Add the endpoint documentation**

Insert this section (adjust the heading level to match the surrounding doc):

```markdown
### GET /v1/customers/search

Tenant-scoped autocomplete search of customers by name. Returns only customers
in `customer_tenant_relations` for the calling tenant. Designed for the
officina UI: operator types 2+ characters, list of matches lets them pick
a customer to register an intervention against.

**Auth:** officina pool (Cognito group `officina`). Customer pool returns 403.

**Query parameters:**

| Name   | Type    | Required | Default | Notes |
|--------|---------|----------|---------|-------|
| `q`    | string  | yes      | —       | Min 2, max 60 chars. Case-insensitive substring match against `firstName`, `lastName`, `businessName`. |
| `limit`| integer | no       | 20      | 1–50. |
| `cursor`| string | no       | —       | Opaque base64url cursor returned by a previous response's `meta.cursor`. |

**Response 200:**

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Mario",
      "lastName": "Rossi",
      "email": "mario.rossi@example.it",
      "phone": "+39 333 1234567",
      "isBusiness": false,
      "businessName": null,
      "vatNumber": null,
      "status": "active"
    }
  ],
  "meta": { "has_more": false }
}
```

When `has_more` is `true`, `meta.cursor` is present; pass it as the `cursor`
query param to fetch the next page.

**Error codes:**

- `400` — Zod validation (q too short/long, limit out of range, missing q).
- `401` — missing/invalid JWT.
- `403` — caller is not in the officina pool.

**BR coverage:** BR-151 (PII gating via the `customer_tenant_relations` JOIN).

**Non-features (intentional):**

- Email, tax code, VAT number are not searchable via `q`.
- No cross-tenant search — pick `customer.mode='create_new'` on
  `POST /v1/vehicles` to onboard a new customer.
- No fuzzy / typo tolerance.
```

- [ ] **Step 6.3: Commit**

```bash
git add docs/APPENDICE_A_API.md
git commit -m "docs(api): document GET /v1/customers/search endpoint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final validation and PR

**Files:** none (verification + git operations)

- [ ] **Step 7.1: Run typecheck across the workspace**

```bash
pnpm -r typecheck
```

Expected: 0 errors in every package. The pre-push hook re-runs this, so any failure here will block the push.

- [ ] **Step 7.2: Verify the LOC budget**

```bash
git diff main --stat
```

Expected: total changed lines ~450, all within `packages/api`, `docs/APPENDICE_A_API.md`, and the spec file. No drift into other packages.

- [ ] **Step 7.3: Push the branch**

```bash
git push -u origin feat/api-customers-search-endpoint
```

Expected: pre-push hook runs `pnpm -r typecheck` and passes. Push succeeds.

- [ ] **Step 7.4: Open the PR with full description**

```bash
gh pr create --title "feat(api): customers search endpoint (autocomplete officina)" --body "$(cat <<'EOF'
## What

`GET /v1/customers/search` — tenant-scoped autocomplete search of customers by `firstName` / `lastName` / `businessName`. Complements PR #76 (vehicles search by customer): #76 is "list this customer's vehicles", this PR is "find this customer by name". Together they unblock the officina demo `intervention create` autocomplete (Persona Giuseppe / F-WEB-DEMO3).

## Why

- Spec: `docs/superpowers/specs/2026-05-09-api-customers-search-endpoint-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-api-customers-search-endpoint.md`
- Follows up on PR #76 — that spec explicitly carved out the customer-side search as a separate feature.

## Implementation notes

- Tenant scoping via Prisma `tenantRelations.some` JOIN. The RLS policy `customers_read` is `USING (true)` (permissive cross-tenant reads), so privacy is enforced at the application layer in the WHERE clause. BR-151 is satisfied by construction: every returned row is by definition tenant-related, so no PII redaction shape is needed.
- ILIKE substring case-insensitive (Prisma `contains` + `mode: 'insensitive'`) on three fields. Email / taxCode / VAT are NOT searchable — privacy-by-default.
- Cursor pagination identical to PR #76. Helpers extracted to `lib/cursor.ts` for the second consumer.
- Filters: `status='active'` (excludes `pending_verification`/`deleted`) + `customer_deleted=false` on the relation.
- No audit log — endpoint is intra-tenant by construction; no BR-154 trigger.

## Tests

- [x] Unit (10): schema validation (q missing/short/long, limit range), auth (401, 403), data path (DTO shape, where clause, pagination)
- [x] Integration (8): tenant scoping, BR-151 cross-tenant non-leakage, ILIKE on 3 fields, B2B DTO shape, customer_deleted exclusion, status filter, cursor pagination, empty result
- [x] BR-151 verified explicitly via the cross-tenant non-leakage scenario
- [ ] Manual smoke (post-deploy, optional): see spec §8

## Checklist

- [x] Conventional Commits title
- [x] Types compile (`pnpm -r typecheck`)
- [x] Linter clean (CI)
- [x] No `console.log`, no commented-out code
- [x] No secrets committed
- [x] APPENDICE_A_API.md updated
- [x] BR-151 cited in code (route header comment)
EOF
)"
```

- [ ] **Step 7.5: Watch CI**

```bash
gh pr checks --watch
```

Expected: all 9 checks green. If anything fails, fix and push a follow-up commit.

---

## Self-review summary

After writing this plan I cross-checked it against the spec:

| Spec section | Covered by |
|---|---|
| §2.1 Path & auth | Task 4.1 (route + preHandlers), Task 3 (401/403 unit tests) |
| §2.2 Query schema | Task 4.1 (Zod), Task 3 (q-length and limit-range unit tests) |
| §2.3 Tenant scoping | Task 4.1 (where clause), Task 5.1 scenarios 1+2 |
| §2.4 Match strategy | Task 4.1 (OR clause), Task 5.1 scenario 3 |
| §2.5 Pagination | Task 1 (cursor extraction), Task 4.1 (orderBy/take/skip), Task 5.1 scenario 7 |
| §2.6 Response DTO | Task 4.1 (select), Task 5.1 scenario 4 (B2B shape) |
| §2.7 Error responses | Task 3 (400/401/403 unit tests), Task 5.1 scenario 8 (200 empty) |
| §3 Files & components | All tasks |
| §4 Test plan (6 unit + 8 integration) | Task 3 (extended to 10 unit for completeness) + Task 5 |
| §5 BR coverage | Task 5.1 scenario 2 (BR-151 explicit) |
| §6 Non-goals | Not in scope (no work needed) |
| §7 Performance | Implicit via Prisma `select` + `tenantRelations.some` (idx-backed) |
| §8 Operational | Task 7 (CI gates), spec §8 manual smoke |
| §9 PR description | Task 7.4 |

No placeholders, no "similar to Task N" shortcuts. Every code block is the exact content the engineer needs.

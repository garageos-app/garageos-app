# F-OFF-201 Creazione cliente standalone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship standalone customer creation — `POST /v1/customers` (dedupe-by-email + ensure tenant relation, returns the full detail DTO plus a `created` flag) and a "Nuovo cliente" dialog launched from the customer list page (#163) that navigates to the new customer's detail on success.

**Architecture:** The API handler mirrors `resolveCustomer` (create_new branch) from `vehicles.ts` — dedupe by the globally-unique email, reuse + ensure CTR (BR-041/BR-152) or create + CTR, P2002 race-safe — but `vehicles.ts` is left untouched. It reuses `customerDetailSelect`/`projectCustomerDetail` for the response. The web dialog mirrors `InviteUserDialog` (shadcn Dialog + react-hook-form + zodResolver + sonner toast).

**Tech Stack:** Fastify + Zod + Prisma (API), Vitest (unit + integration), React + react-router + react-hook-form + zod + @tanstack/react-query + shadcn (web).

**Spec:** `docs/superpowers/specs/2026-06-08-F-OFF-201-customer-create-design.md`

**Pre-flight notes (project conventions):**
- `/customers` DTO is **camelCase**.
- Integration tests use a free source IP in the `10.20.4x` range; reuse `helpers.ts` fixtures (`createCustomer`, `createCustomerTenantRelation`, `createTenantWithLocation`, `createUser`).
- Commit messages: header ≤72, body lines ≤100, scope in enum (`api`/`web`/`docs`).
- Do not pre-stage symbols before use (eslint pre-commit `no-unused-vars`).
- After each API task run `pnpm -r typecheck`; for route-handler tasks also run the api unit suite.
- Web tests in `packages/web/src/**` run with `pnpm --filter @garageos/web test -- <pattern>`.
- API unit test for a `tests/unit/routes/v1/*` file imports source as `../../../../src/...` (4 levels); a `tests/unit/lib/*` file uses `../../../src/...` (3 levels).
- No migration. No new dependency. `vehicles.ts` must not be modified.

---

## File structure

**API**
- Create `packages/api/src/routes/v1/customers-create.ts` — `POST /v1/customers` handler.
- Modify `packages/api/src/server.ts` — register the route.
- Create `packages/api/tests/unit/routes/v1/customers-create.test.ts`.
- Create `packages/api/tests/integration/customers-create.test.ts`.

**Web**
- Modify `packages/web/src/queries/types.ts` — add `CustomerCreateBody` + `CustomerCreateResponse`.
- Create `packages/web/src/queries/customersCreate.ts` — `useCreateCustomer` mutation.
- Create `packages/web/src/queries/customersCreate.test.tsx`.
- Create `packages/web/src/components/customers/CreateCustomerDialog.tsx`.
- Create `packages/web/src/components/customers/CreateCustomerDialog.test.tsx`.
- Modify `packages/web/src/pages/CustomerList.tsx` — "Nuovo cliente" button + dialog state.
- Modify `packages/web/src/pages/CustomerList.test.tsx` — button opens dialog.

**Docs**
- Modify `docs/APPENDICE_A_API.md` — detailed `POST /v1/customers` section.

---

## Task 1: API endpoint `POST /v1/customers`

**Files:**
- Create: `packages/api/src/routes/v1/customers-create.ts`
- Modify: `packages/api/src/server.ts`
- Test: `packages/api/tests/unit/routes/v1/customers-create.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/routes/v1/customers-create.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import customerCreateRoutes from '../../../../src/routes/v1/customers-create.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

interface FakePrisma {
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: { upsert: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
}

// Detail row shape projectCustomerDetail expects (CTR filtered to tenant).
function detailRow(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    email: 'mario@example.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: null,
    taxCode: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    addressLine: null,
    city: null,
    province: null,
    postalCode: null,
    cognitoSub: null,
    status: 'active',
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    tenantRelations: [
      { tenantNotes: null, interventionCount: 0, firstInterventionAt: null, lastInterventionAt: null },
    ],
    ownerships: [],
    ...over,
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    customer: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      create: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      findFirst: vi.fn().mockResolvedValue(detailRow()),
    },
    customerTenantRelation: { upsert: vi.fn().mockResolvedValue({ id: 'ctr-1' }) },
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
  await app.register(customerCreateRoutes);
  return app;
}

const VALID = { firstName: 'Mario', lastName: 'Rossi', email: 'mario@example.it' };

function post(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    payload: body as object,
  });
}

describe('POST /v1/customers — validation & auth', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/customers', payload: VALID });
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
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when a required field is missing', async () => {
    app = await buildApp();
    const res = await post(app, { firstName: 'Mario', lastName: 'Rossi' }); // no email
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a malformed email', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 unknown_field for unknown keys', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, status: 'deleted' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.create.unknown_field');
  });

  it('returns 422 when isBusiness is true without businessName', async () => {
    app = await buildApp();
    const res = await post(app, { ...VALID, isBusiness: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('customer.create.business_name_required');
  });
});

describe('POST /v1/customers — data path', () => {
  let app: FastifyInstance | undefined;
  let prisma: FakePrisma;
  beforeEach(() => {
    app = undefined;
    prisma = buildFakePrisma();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('creates a new customer + CTR and returns 201 created:true', async () => {
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.id).toBe(CUSTOMER_ID);
    expect(body.email).toBe('mario@example.it');
    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.customerTenantRelation.upsert.mock.calls[0]![0] as {
      where: { tenantId_customerId: { tenantId: string; customerId: string } };
    };
    expect(upsertArg.where.tenantId_customerId).toEqual({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
    });
  });

  it('dedupes by email: existing customer is linked, created:false, no create', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce({ id: CUSTOMER_ID });
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(false);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
  });

  it('handles a P2002 race: refetch by email, link, created:false', async () => {
    const { Prisma } = await import('@garageos/database');
    prisma.customer.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    app = await buildApp({ prisma });
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(false);
    expect(prisma.customer.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.customerTenantRelation.upsert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- customers-create`
Expected: FAIL — cannot find module `customers-create.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/routes/v1/customers-create.ts
import { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  customerDetailSelect,
  projectCustomerDetail,
  type CustomerDetailRow,
} from '../../lib/customer-detail-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// F-OFF-201 standalone customer creation. Email is globally unique, so a
// person is a single Customer row shared across tenants via CTR. Creating a
// customer whose email already exists reuses the row and ensures a CTR
// (BR-041/BR-152) — mirrors resolveCustomer (create_new) in vehicles.ts,
// which is intentionally left untouched.
const bodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    addressLine: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(2).optional(),
    postalCode: z.string().max(10).optional(),
    isBusiness: z.boolean().default(false),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
  })
  .strict();

const customerCreateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/customers',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      // safeParse to discriminate unknown keys (422 domain code) from
      // generic validation errors (400 VALIDATION_ERROR via global handler).
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('customer.create.unknown_field', 422, 'Campo non riconosciuto.');
        }
        throw parsed.error;
      }
      const body = parsed.data;
      if (body.isBusiness && !body.businessName?.trim()) {
        throw businessError(
          'customer.create.business_name_required',
          422,
          'La ragione sociale è obbligatoria per un cliente aziendale.',
        );
      }

      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        // Dedupe by the globally-unique email (BR-041).
        const existing = await tx.customer.findUnique({
          where: { email: body.email },
          select: { id: true },
        });

        let customerId: string;
        let created: boolean;
        if (existing) {
          customerId = existing.id;
          created = false;
        } else {
          try {
            const row = await tx.customer.create({
              data: {
                firstName: body.firstName,
                lastName: body.lastName,
                email: body.email,
                isBusiness: body.isBusiness,
                ...(body.phone ? { phone: body.phone } : {}),
                ...(body.taxCode ? { taxCode: body.taxCode } : {}),
                ...(body.addressLine ? { addressLine: body.addressLine } : {}),
                ...(body.city ? { city: body.city } : {}),
                ...(body.province ? { province: body.province } : {}),
                ...(body.postalCode ? { postalCode: body.postalCode } : {}),
                ...(body.businessName ? { businessName: body.businessName } : {}),
                ...(body.vatNumber ? { vatNumber: body.vatNumber } : {}),
              },
              select: { id: true },
            });
            customerId = row.id;
            created = true;
          } catch (err) {
            // P2002 race: a concurrent insert won between findUnique and
            // create. Re-fetch and treat as a reuse (BR-041 dedupe-hit).
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              const raced = await tx.customer.findUniqueOrThrow({
                where: { email: body.email },
                select: { id: true },
              });
              customerId = raced.id;
              created = false;
            } else {
              throw err;
            }
          }
        }

        // BR-152: ensure the calling tenant is related to the customer.
        // Atomic upsert avoids the find-then-create race.
        await tx.customerTenantRelation.upsert({
          where: { tenantId_customerId: { tenantId, customerId } },
          update: {},
          create: { tenantId, customerId, interventionCount: 0 },
          select: { id: true },
        });

        const row = (await tx.customer.findFirst({
          where: {
            id: customerId,
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
          },
          select: {
            ...customerDetailSelect,
            tenantRelations: {
              ...customerDetailSelect.tenantRelations,
              where: { tenantId, customerDeleted: false },
            },
          },
        })) as CustomerDetailRow | null;

        if (!row) {
          // Unreachable: we just ensured the customer + CTR exist.
          throw businessError(
            'customer.not_found',
            404,
            'Cliente non trovato dopo la creazione.',
          );
        }

        reply.code(201);
        return { ...projectCustomerDetail(row), created };
      });
    },
  );
};

export default customerCreateRoutes;
```

- [ ] **Step 4: Register the route in `server.ts`**

Add the import alongside the other customer imports (after `import customerListRoutes from './routes/v1/customers-list.js';`):

```ts
import customerCreateRoutes from './routes/v1/customers-create.js';
```

Add the registration after `await app.register(customerListRoutes);`:

```ts
  await app.register(customerCreateRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @garageos/api test:unit -- customers-create`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/api/src/routes/v1/customers-create.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/customers-create.test.ts
git commit -m "feat(api): POST /v1/customers standalone create (F-OFF-201)"
```

---

## Task 2: API integration test

**Files:**
- Test: `packages/api/tests/integration/customers-create.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/integration/customers-create.test.ts
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

// F-OFF-201 standalone create end-to-end. Verifies row + CTR persistence,
// email dedupe (reuse + link, created:false), cross-tenant link, and the
// returned DTO shape.

describe('POST /v1/customers (integration)', () => {
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

  function post(token: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: body as object,
    });
  }

  it('creates a customer and a CTR, returns 201 created:true', async () => {
    const { tenantId } = await createTenantWithLocation('cc-new');
    const token = await tokenFor(tenantId, '11111111-1111-4111-8111-111111111111');

    const res = await post(token, {
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'cc-new-mario@test.it',
      phone: '+39 333 1234567',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean; phone: string | null };
    expect(body.created).toBe(true);
    expect(body.phone).toBe('+39 333 1234567');

    // The new customer is visible via the tenant-scoped list (CTR exists).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=Rossi',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list.json() as { data: Array<{ id: string }> }).data.map((c) => c.id)).toContain(
      body.id,
    );
  });

  it('dedupes by email: a second create links the existing row, created:false', async () => {
    const { tenantId } = await createTenantWithLocation('cc-dupe');
    const token = await tokenFor(tenantId, '22222222-2222-4222-8222-222222222222');
    const { customerId, email } = await createCustomer({
      firstName: 'Anna',
      lastName: 'Verdi',
    });
    await createCustomerTenantRelation({ tenantId, customerId });

    const res = await post(token, { firstName: 'Anna', lastName: 'Verdi', email });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.id).toBe(customerId);
  });

  it('links an email belonging to another tenant customer (cross-tenant reuse)', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('cc-x-a');
    const { tenantId: tenantB } = await createTenantWithLocation('cc-x-b');
    const tokenB = await tokenFor(tenantB, '33333333-3333-4333-8333-333333333333');
    const { customerId, email } = await createCustomer({ firstName: 'Luca', lastName: 'Neri' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    const res = await post(tokenB, { firstName: 'Luca', lastName: 'Neri', email });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.id).toBe(customerId);

    // tenantB now sees the customer in its list (CTR was created).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=Neri',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect((list.json() as { data: Array<{ id: string }> }).data.map((c) => c.id)).toContain(
      customerId,
    );
  });

  it('returns 422 for a business customer without businessName', async () => {
    const { tenantId } = await createTenantWithLocation('cc-biz');
    const token = await tokenFor(tenantId, '44444444-4444-4444-8444-444444444444');
    const res = await post(token, {
      firstName: 'Ditta',
      lastName: 'Owner',
      email: 'cc-biz@test.it',
      isBusiness: true,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('customer.create.business_name_required');
  });
});
```

- [ ] **Step 2: Note on running**

Per project policy, do not run integration tests locally (Docker/Testcontainers). Push and let CI run them: `gh pr checks --watch`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/customers-create.test.ts
git commit -m "test(api): integration coverage for POST /v1/customers"
```

---

## Task 3: Web mutation hook + types

**Files:**
- Modify: `packages/web/src/queries/types.ts`
- Create: `packages/web/src/queries/customersCreate.ts`
- Test: `packages/web/src/queries/customersCreate.test.tsx`

- [ ] **Step 1: Add types to `types.ts`**

Append after the `CustomerDetail` interface (and its `CustomerDetailUpdate`):

```ts
export interface CustomerCreateBody {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  taxCode?: string;
  addressLine?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  isBusiness: boolean;
  businessName?: string;
  vatNumber?: string;
}

export type CustomerCreateResponse = CustomerDetail & { created: boolean };
```

- [ ] **Step 2: Write the failing test**

```tsx
// packages/web/src/queries/customersCreate.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCreateCustomer } from './customersCreate';
import type { CustomerCreateResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const created: CustomerCreateResponse = {
  id: 'c1',
  email: 'mario@example.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: null,
  taxCode: null,
  isBusiness: false,
  businessName: null,
  vatNumber: null,
  addressLine: null,
  city: null,
  province: null,
  postalCode: null,
  cognitoSub: null,
  status: 'active',
  createdAt: '2026-06-08T00:00:00.000Z',
  tenantRelation: {
    tenantNotes: null,
    interventionCount: 0,
    firstInterventionAt: null,
    lastInterventionAt: null,
  },
  vehicles: [],
  created: true,
};

describe('useCreateCustomer', () => {
  it('POSTs the body and returns the created customer', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(created);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: Wrapper });

    let res: CustomerCreateResponse | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      });
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers', {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      }),
    });
    expect(res?.id).toBe('c1');
    expect(res?.created).toBe(true);
  });

  it('invalidates the customers list on success', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(created);
    const { Wrapper, qc } = makeWrapper();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['customers', 'list'] });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- customersCreate`
Expected: FAIL — cannot find module `./customersCreate`.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/web/src/queries/customersCreate.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';

import type { CustomerCreateBody, CustomerCreateResponse } from './types';

// F-OFF-201 standalone create. Invalidates the customer list so the new
// (or newly-linked) customer appears. Navigation + toast live in the dialog,
// which needs the returned `created` flag and id.
export function useCreateCustomer() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<CustomerCreateResponse, ApiError, CustomerCreateBody>({
    mutationFn: (body) =>
      apiFetch<CustomerCreateResponse>('/v1/customers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers', 'list'] });
    },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- customersCreate`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/queries/types.ts packages/web/src/queries/customersCreate.ts packages/web/src/queries/customersCreate.test.tsx
git commit -m "feat(web): useCreateCustomer mutation (F-OFF-201)"
```

---

## Task 4: Web `CreateCustomerDialog`

**Files:**
- Create: `packages/web/src/components/customers/CreateCustomerDialog.tsx`
- Test: `packages/web/src/components/customers/CreateCustomerDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/customers/CreateCustomerDialog.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CreateCustomerDialog } from './CreateCustomerDialog';

const { mockMutateAsync, mockToastSuccess, mockNavigate } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/queries/customersCreate', () => ({
  useCreateCustomer: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderOpen() {
  return render(<CreateCustomerDialog open onOpenChange={vi.fn()} />, { wrapper: wrap });
}

describe('CreateCustomerDialog', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockNavigate.mockReset();
  });

  it('shows required-field errors and does not submit an empty form', async () => {
    renderOpen();
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    expect(await screen.findByText('Nome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Cognome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Email obbligatoria')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid form, navigates to the detail and toasts on created', async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: 'c1', created: true });
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Mario');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Rossi');
    await userEvent.type(screen.getByLabelText('Email'), 'mario@example.it');
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/customers/c1'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Cliente creato');
  });

  it('toasts the linked message when the customer already existed', async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: 'c2', created: false });
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Anna');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Verdi');
    await userEvent.type(screen.getByLabelText('Email'), 'anna@example.it');
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/customers/c2'));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Cliente già esistente, collegato alla tua officina',
    );
  });

  it('requires a business name when "Cliente aziendale" is on', async () => {
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Ditta');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Owner');
    await userEvent.type(screen.getByLabelText('Email'), 'ditta@example.it');
    await userEvent.click(screen.getByRole('switch', { name: /cliente aziendale/i }));
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    expect(await screen.findByText('Ragione sociale obbligatoria')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- CreateCustomerDialog`
Expected: FAIL — cannot find module `./CreateCustomerDialog`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/web/src/components/customers/CreateCustomerDialog.tsx
// F-OFF-201 standalone customer creation. Mirrors InviteUserDialog
// (shadcn Dialog + react-hook-form + zodResolver + sonner toast).
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import { useCreateCustomer } from '@/queries/customersCreate';
import type { CustomerCreateBody } from '@/queries/types';

const FormSchema = z
  .object({
    firstName: z.string().min(1, 'Nome obbligatorio').max(100, 'Nome troppo lungo'),
    lastName: z.string().min(1, 'Cognome obbligatorio').max(100, 'Cognome troppo lungo'),
    email: z.string().min(1, 'Email obbligatoria').email('Email non valida').max(255),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    addressLine: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(2).optional(),
    postalCode: z.string().max(10).optional(),
    isBusiness: z.boolean(),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
  })
  .refine((d) => !(d.isBusiness && !d.businessName?.trim()), {
    message: 'Ragione sociale obbligatoria',
    path: ['businessName'],
  });

type FormValues = z.infer<typeof FormSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Drop empty-string optionals so the API stores null, not "".
function toBody(v: FormValues): CustomerCreateBody {
  const opt = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  return {
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    email: v.email.trim(),
    isBusiness: v.isBusiness,
    ...(opt(v.phone) ? { phone: opt(v.phone) } : {}),
    ...(opt(v.taxCode) ? { taxCode: opt(v.taxCode) } : {}),
    ...(opt(v.addressLine) ? { addressLine: opt(v.addressLine) } : {}),
    ...(opt(v.city) ? { city: opt(v.city) } : {}),
    ...(opt(v.province) ? { province: opt(v.province) } : {}),
    ...(opt(v.postalCode) ? { postalCode: opt(v.postalCode) } : {}),
    ...(v.isBusiness && opt(v.businessName) ? { businessName: opt(v.businessName) } : {}),
    ...(opt(v.vatNumber) ? { vatNumber: opt(v.vatNumber) } : {}),
  };
}

export function CreateCustomerDialog({ open, onOpenChange }: Props) {
  const mutation = useCreateCustomer();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { firstName: '', lastName: '', email: '', isBusiness: false },
  });

  const isBusiness = watch('isBusiness');

  function handleClose(next: boolean) {
    if (!next) {
      reset();
      setFormError(null);
    }
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    setFormError(null);
    try {
      const result = await mutation.mutateAsync(toBody(values));
      toast.success(
        result.created ? 'Cliente creato' : 'Cliente già esistente, collegato alla tua officina',
      );
      handleClose(false);
      navigate(`/customers/${result.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(translateError(err.code, err.message));
      } else {
        setFormError('Errore imprevisto, riprova.');
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo cliente</DialogTitle>
          <DialogDescription>Aggiungi un cliente alla tua anagrafica.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          {formError && (
            <div
              className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
              role="alert"
            >
              {formError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-firstName">Nome</Label>
              <Input id="cc-firstName" {...register('firstName')} />
              {errors.firstName && (
                <p className="text-sm text-red-600 mt-1">{errors.firstName.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="cc-lastName">Cognome</Label>
              <Input id="cc-lastName" {...register('lastName')} />
              {errors.lastName && (
                <p className="text-sm text-red-600 mt-1">{errors.lastName.message}</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="cc-email">Email</Label>
            <Input id="cc-email" type="email" autoComplete="off" {...register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-phone">Telefono (opzionale)</Label>
              <Input id="cc-phone" {...register('phone')} />
            </div>
            <div>
              <Label htmlFor="cc-taxCode">Codice fiscale (opzionale)</Label>
              <Input id="cc-taxCode" {...register('taxCode')} />
            </div>
          </div>

          <div>
            <Label htmlFor="cc-addressLine">Indirizzo (opzionale)</Label>
            <Input id="cc-addressLine" {...register('addressLine')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="cc-city">Città</Label>
              <Input id="cc-city" {...register('city')} />
            </div>
            <div>
              <Label htmlFor="cc-province">Prov.</Label>
              <Input id="cc-province" maxLength={2} {...register('province')} />
            </div>
            <div>
              <Label htmlFor="cc-postalCode">CAP</Label>
              <Input id="cc-postalCode" {...register('postalCode')} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="cc-isBusiness"
              checked={isBusiness}
              onCheckedChange={(v) => setValue('isBusiness', v, { shouldValidate: true })}
              aria-label="Cliente aziendale"
            />
            <Label htmlFor="cc-isBusiness">Cliente aziendale</Label>
          </div>

          {isBusiness && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cc-businessName">Ragione sociale</Label>
                <Input id="cc-businessName" {...register('businessName')} />
                {errors.businessName && (
                  <p className="text-sm text-red-600 mt-1">{errors.businessName.message}</p>
                )}
              </div>
              <div>
                <Label htmlFor="cc-vatNumber">P.IVA (opzionale)</Label>
                <Input id="cc-vatNumber" {...register('vatNumber')} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={isSubmitting}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creazione…' : 'Crea cliente'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- CreateCustomerDialog`
Expected: PASS (4 tests). If the Switch role query flakes, confirm shadcn `Switch` renders `role="switch"` (Radix does) and that `aria-label="Cliente aziendale"` is set.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/components/customers/CreateCustomerDialog.tsx packages/web/src/components/customers/CreateCustomerDialog.test.tsx
git commit -m "feat(web): create customer dialog (F-OFF-201)"
```

---

## Task 5: Wire "Nuovo cliente" into the customer list

**Files:**
- Modify: `packages/web/src/pages/CustomerList.tsx`
- Modify: `packages/web/src/pages/CustomerList.test.tsx`

- [ ] **Step 1: Add the failing test**

Add `within` to the `@testing-library/react` import at the top of `CustomerList.test.tsx` (it currently imports `render, screen, waitFor`). Then add this test inside the `describe('CustomerList', …)` block:

```tsx
  it('opens the create-customer dialog from the "Nuovo cliente" button', async () => {
    apiFetchMock.mockResolvedValue(onePage);
    renderPage();
    await screen.findByText('Rossi Mario');
    await userEvent.click(screen.getByRole('button', { name: /nuovo cliente/i }));
    const dialog = await screen.findByRole('dialog');
    // The form is present inside the dialog (email field is unique to it).
    expect(within(dialog).getByLabelText('Email')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- CustomerList`
Expected: FAIL — no "Nuovo cliente" button.

- [ ] **Step 3: Wire the button + dialog into `CustomerList.tsx`**

Add imports near the top:

```tsx
import { CreateCustomerDialog } from '@/components/customers/CreateCustomerDialog';
```

Add `useState` for the dialog (the file already imports `useState`):

```tsx
  const [createOpen, setCreateOpen] = useState(false);
```

Replace the header block:

```tsx
      <div className="flex items-center gap-3">
        <Users size={24} className="text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Clienti</h1>
      </div>
```

with a header that includes the action button + the dialog:

```tsx
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users size={24} className="text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Clienti</h1>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Nuovo cliente</Button>
      </div>

      <CreateCustomerDialog open={createOpen} onOpenChange={setCreateOpen} />
```

`Button` is already imported in `CustomerList.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- CustomerList`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/web/src/pages/CustomerList.tsx packages/web/src/pages/CustomerList.test.tsx
git commit -m "feat(web): Nuovo cliente button on customer list (F-OFF-201)"
```

---

## Task 6: Docs — APPENDICE_A detailed section

**Files:**
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Add a detailed `POST /v1/customers` section**

Insert after the `GET /v1/customers/:id` detail section (§2.9) — or wherever the customer routes are detailed; follow the file's numbering convention (e.g. §2.9b). Content:

````markdown
### 2.9b `POST /v1/customers` — Creazione cliente standalone (F-OFF-201)

Crea un cliente per il tenant, indipendentemente dalla creazione veicolo.
`email` è **unique globale**: se esiste già, la riga viene riusata e si
garantisce la relazione `customer_tenant_relations` (BR-041/BR-152).

**Auth:** Tenant User (pool officine). `401` senza token, `403` con token
pool clienti.

**Body** (camelCase, `.strict()`):

| Campo | Regola |
|---|---|
| `firstName` | string 1..100, obbligatorio |
| `lastName` | string 1..100, obbligatorio |
| `email` | email valida, max 255, obbligatorio |
| `phone` | string max 30, opzionale |
| `taxCode` | string max 20, opzionale |
| `addressLine` | string max 255, opzionale |
| `city` | string max 100, opzionale |
| `province` | string max 2, opzionale |
| `postalCode` | string max 10, opzionale |
| `isBusiness` | boolean (default false) |
| `businessName` | string max 200, opzionale (obbligatorio se `isBusiness`) |
| `vatNumber` | string max 20, opzionale |

**Errori:**
- `400 VALIDATION_ERROR` — campo obbligatorio mancante o email malformata.
- `422 customer.create.unknown_field` — chiave non riconosciuta nel body.
- `422 customer.create.business_name_required` — `isBusiness` true senza `businessName`.

**Response `201`:** il DTO completo come `GET /v1/customers/:id` + campo
top-level `created: boolean` (true = nuova riga creata; false = cliente
preesistente collegato a questa officina). `201` in entrambi i casi: `created`
porta la distinzione (divergenza pragmatica dal REST stretto, scelta per dare
al client un solo path).

Comportamento: dedupe per `email` → se esiste, upsert CTR e ritorna
l'esistente (`created:false`, l'anagrafica digitata è ignorata); altrimenti
crea cliente + CTR (`created:true`). Race P2002 → refetch + link.
`tenantNotes` non è impostabile in creazione (usa `PATCH /v1/customers/:id`).
````

- [ ] **Step 2: Update the index row** (if it isn't already marked detailed)

Find the index row `| POST | \`/customers\` | F-OFF-201 | …` and prefix the description with `**[DETTAGLIATO §2.9b]**`.

- [ ] **Step 3: Format + commit**

```bash
pnpm exec prettier --write docs/APPENDICE_A_API.md
git add docs/APPENDICE_A_API.md
git commit -m "docs: detail POST /v1/customers in APPENDICE_A (F-OFF-201)"
```

---

## Final verification

- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm --filter @garageos/api test:unit` green (new route unit suite).
- [ ] `pnpm --filter @garageos/web test` green (mutation + dialog + list).
- [ ] Push branch `feat/customers-create`, open PR, watch CI: `gh pr checks --watch` (integration + lint + cdk-synth on CI).
- [ ] Single final Opus review of the whole diff before merge.

## PR description checklist (per CLAUDE.md)

- **What:** standalone customer creation — `POST /v1/customers` + "Nuovo cliente" dialog.
- **Why:** F-OFF-201 (MUST) gap from audit `2026-05-31`; BR-041/BR-152/BR-151.
- **Implementation notes:** dedupe-by-email + ensure CTR (mirrors `resolveCustomer`, `vehicles.ts` untouched); `created` flag; 201 in both cases; least-PII not applicable (full detail DTO returned to the now-related tenant).
- **Tests:** unit (route validation + create/dedupe/race) + integration (persist, dedupe-link, cross-tenant link, business 422) + web (mutation, dialog, list button).
- **Docs:** APPENDICE_A §2.9b added.
- No migration. No new dependency. `vehicles.ts` unchanged.

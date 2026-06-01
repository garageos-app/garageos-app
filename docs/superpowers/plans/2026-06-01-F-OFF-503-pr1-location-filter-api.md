# F-OFF-503 PR1 — Location filter API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `location_id` filter to the three tenant-scoped list endpoints (`interventions/recent`, `deadlines`, `disputes/open`) and enforce BR-205 server-side so a mechanic only ever sees their own location.

**Architecture:** A single pure helper `resolveLocationFilter(role, userLocationId, queryLocationId)` encodes the BR-205 rule (mechanic → own location, param ignored; super_admin → optional param). Each endpoint parses an optional `location_id` query param, computes the effective location via the helper using `request.userRole` / `request.locationId` (already populated by `tenantContext` from JWT claims — no extra DB lookup), and conditionally adds `locationId` to its Prisma `where`. No DB migration (`intervention.location_id` and `deadline.location_id` already exist, NOT NULL).

**Tech Stack:** Fastify, TypeScript, Zod, Prisma, Vitest (unit + Testcontainers integration).

**Spec:** `docs/superpowers/specs/2026-06-01-F-OFF-503-location-filter-design.md`

---

## File Structure

**Source (modify):**
- `packages/api/src/lib/location-filter.ts` — **new** pure helper `resolveLocationFilter`.
- `packages/api/src/routes/v1/interventions-recent.ts` — add `location_id` to query schema; apply filter.
- `packages/api/src/routes/v1/deadlines-list-tenant.ts` — add `location_id` to query schema; apply filter.
- `packages/api/src/routes/v1/disputes-open.ts` — add a query schema (none today); apply filter to both dispute groups.

**Tests:**
- `packages/api/tests/unit/lib/location-filter.test.ts` — **new** pure unit tests for the helper.
- `packages/api/tests/integration/helpers.ts` — add `createLocation` fixture helper (2nd location in an existing tenant).
- `packages/api/tests/unit/routes/v1/interventions-recent.test.ts` — add where-clause assertions for mechanic vs super_admin.
- `packages/api/tests/integration/interventions-recent.test.ts` — add location-filter describe block.
- `packages/api/tests/integration/deadlines-list-tenant.test.ts` — add location-filter describe block.
- `packages/api/tests/integration/disputes-open.test.ts` — add location-filter describe block.

**No new error codes, no migration, no infra.**

---

## Pre-flight (already verified during planning)

- `request.userRole` (`'super_admin' | 'mechanic'`) and `request.locationId` (`string | undefined`) are populated by `tenant-context.ts` from `custom:role` / `custom:location_id`. Confirmed at `packages/api/src/middleware/tenant-context.ts:64-70`.
- `signTestToken` accepts `locationId` (`tests/helpers/jwt.ts:137,167-169`).
- `createUser` accepts `locationId` (`tests/integration/helpers.ts:75,84`).
- `createTenantWithLocation` returns `{ tenantId, locationId }` (the primary location).
- BR-205 / BR-204 wording: `docs/APPENDICE_F_BUSINESS_LOGIC.md:841-852`.
- Integration tests must use a free IP per describe block (`feedback_integration_test_rate_limit_isolation`). The `10.20.4x` range is free — this plan uses `10.20.41.x` / `10.20.42.x` / `10.20.43.x`.

---

## Task 1: Pure helper `resolveLocationFilter`

**Files:**
- Create: `packages/api/src/lib/location-filter.ts`
- Test: `packages/api/tests/unit/lib/location-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/location-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveLocationFilter } from '../../../src/lib/location-filter.js';

const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('resolveLocationFilter (BR-205)', () => {
  it('mechanic is forced to own location; query param is ignored', () => {
    expect(resolveLocationFilter('mechanic', LOC_A, LOC_B)).toBe(LOC_A);
  });

  it('mechanic uses own location when no query param given', () => {
    expect(resolveLocationFilter('mechanic', LOC_A, undefined)).toBe(LOC_A);
  });

  it('mechanic without a location yields no filter (defensive; BR-204 prevents this)', () => {
    expect(resolveLocationFilter('mechanic', undefined, LOC_B)).toBeUndefined();
  });

  it('super_admin applies the query param when present', () => {
    expect(resolveLocationFilter('super_admin', undefined, LOC_B)).toBe(LOC_B);
  });

  it('super_admin sees all sedi (undefined) when no query param', () => {
    expect(resolveLocationFilter('super_admin', undefined, undefined)).toBeUndefined();
  });

  it('super_admin ignores its own location attribute (sees all unless narrowed)', () => {
    expect(resolveLocationFilter('super_admin', LOC_A, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- location-filter`
Expected: FAIL — cannot resolve `../../../src/lib/location-filter.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `packages/api/src/lib/location-filter.ts`:

```ts
import type { UserRole } from '../middleware/tenant-context.js';

/**
 * Resolve the effective location filter for a tenant-scoped list endpoint.
 *
 * BR-205 — visibilità cross-location:
 *  - mechanic   → forced to their own location; the `location_id` query
 *                 param is ignored. A mechanic always has a location
 *                 (BR-204); if somehow absent, returns undefined (no
 *                 filter) rather than throwing — defensive only.
 *  - super_admin → the query param when present, otherwise undefined
 *                 (= all sedi of the tenant, the pre-F-OFF-503 behavior).
 *
 * Returns the location id to filter on, or `undefined` for "no location
 * filter". Callers spread `...(loc ? { locationId: loc } : {})` into the
 * Prisma `where`.
 */
export function resolveLocationFilter(
  role: UserRole,
  userLocationId: string | undefined,
  queryLocationId: string | undefined,
): string | undefined {
  if (role === 'mechanic') return userLocationId;
  return queryLocationId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- location-filter`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/location-filter.ts packages/api/tests/unit/lib/location-filter.test.ts
git commit -m "feat(api): add resolveLocationFilter helper (BR-205)"
```

---

## Task 2: `createLocation` integration test helper

**Files:**
- Modify: `packages/api/tests/integration/helpers.ts` (add export near `createTenantWithLocation`, ~line 63)

This fixture creates a **second** active location in an existing tenant, needed by all three integration test blocks. `pgAdmin` is already imported/used throughout `helpers.ts`.

- [ ] **Step 1: Add the helper**

Insert after `createTenantWithLocation` (after line 63) in `packages/api/tests/integration/helpers.ts`:

```ts
// Insert an additional (secondary) location into an existing tenant.
// Superuser insert (bypasses RLS) — mirrors createTenantWithLocation.
// Defaults to a non-primary active location so BR-201's partial unique
// index (one primary per tenant) is never violated.
export async function createLocation(params: {
  tenantId: string;
  name?: string;
  isPrimary?: boolean;
}): Promise<{ locationId: string }> {
  const { tenantId, name = 'Sede Secondaria', isPrimary = false } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO locations
       (id, tenant_id, name, address_line, city, province, postal_code,
        country, is_primary, status, created_at, updated_at)
     VALUES
       (gen_random_uuid(), $1, $2, 'Via Test 2', 'Roma', 'RM',
        '00100', 'IT', $3, 'active'::"LocationStatus", NOW(), NOW())
     RETURNING id`,
    [tenantId, name, isPrimary],
  );
  return { locationId: rows[0]!.id };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (no callers yet; this only adds an export).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/helpers.ts
git commit -m "test(api): add createLocation integration fixture helper"
```

---

## Task 3: Wire `interventions/recent`

**Files:**
- Modify: `packages/api/src/routes/v1/interventions-recent.ts`
- Test: `packages/api/tests/unit/routes/v1/interventions-recent.test.ts`
- Test: `packages/api/tests/integration/interventions-recent.test.ts`

- [ ] **Step 1: Write the failing unit tests**

In `packages/api/tests/unit/routes/v1/interventions-recent.test.ts`, the existing `buildApp` hard-codes a mechanic token with `custom:location_id`. Add a parameter so we can also build a super_admin app. Replace the `buildApp` signature and the verifier block:

Find (around line 72-84):

```ts
async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
        'custom:location_id': '44444444-4444-4444-8444-444444444444',
      },
    }),
  };
```

Replace with:

```ts
const MECHANIC_LOCATION_ID = '44444444-4444-4444-8444-444444444444';

async function buildApp(
  prisma: FakePrisma,
  claims: { role: 'super_admin' | 'mechanic'; locationId?: string } = {
    role: 'mechanic',
    locationId: MECHANIC_LOCATION_ID,
  },
): Promise<FastifyInstance> {
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': claims.role,
        ...(claims.locationId ? { 'custom:location_id': claims.locationId } : {}),
      },
    }),
  };
```

> Note: existing `buildApp(prisma)` calls keep working (default = mechanic with location). The existing assertion `where: expect.objectContaining({ tenantId, status })` stays green because `objectContaining` ignores the new `locationId` key.

Now add these tests inside `describe('GET /v1/interventions/recent (unit)')` (after the existing `it(...)` at line ~157):

```ts
  it('mechanic: where includes own locationId (BR-205, query param ignored)', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma); // default mechanic @ MECHANIC_LOCATION_ID
    await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?location_id=99999999-9999-4999-8999-999999999999',
      headers: { authorization: 'Bearer test' },
    });
    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ locationId: MECHANIC_LOCATION_ID }),
      }),
    );
  });

  it('super_admin: no location_id param → where has no locationId (all sedi)', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma, { role: 'super_admin' });
    await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: 'Bearer test' },
    });
    const where = prisma.intervention.findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty('locationId');
  });

  it('super_admin: location_id param narrows the where', async () => {
    const prisma = buildFakePrisma([]);
    app = await buildApp(prisma, { role: 'super_admin' });
    await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?location_id=55555555-5555-4555-8555-555555555555',
      headers: { authorization: 'Bearer test' },
    });
    expect(prisma.intervention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          locationId: '55555555-5555-4555-8555-555555555555',
        }),
      }),
    );
  });

  it('400 on malformed location_id (not a uuid)', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent?location_id=not-a-uuid',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(400);
  });
```

> The `.mock.calls[0]![0].where` access needs `findMany` to be typed loosely; the existing `findManySelect` helper already casts via `unknown`, so add a local cast inline as shown (`as Record<string, unknown>`) — no new type import needed.

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `pnpm --filter @garageos/api test:unit -- interventions-recent`
Expected: FAIL — `location_id` not parsed, no `locationId` in where; malformed-uuid case currently returns 200.

- [ ] **Step 3: Implement the route change**

In `packages/api/src/routes/v1/interventions-recent.ts`:

Add the import after the existing imports (after line 6):

```ts
import { resolveLocationFilter } from '../../lib/location-filter.js';
```

Extend the query schema (replace lines 24-26):

```ts
export const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  location_id: z.uuid().optional(),
});
```

In the handler, replace the parse + where (lines 50-58 region):

```ts
      const { limit, location_id } = recentQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;
      const effectiveLocationId = resolveLocationFilter(
        request.userRole!,
        request.locationId,
        location_id,
      );

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const rows = await tx.intervention.findMany({
          where: {
            tenantId,
            status: { in: ['active', 'disputed'] },
            ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
          },
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm --filter @garageos/api test:unit -- interventions-recent`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Write the integration tests**

Append a new describe block at the end of `packages/api/tests/integration/interventions-recent.test.ts` (import `createLocation` in the existing import list from `./helpers.js`):

```ts
describe('GET /v1/interventions/recent — location filter (F-OFF-503)', () => {
  const LOC_IP = '10.20.41.2';
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

  async function seed() {
    const { tenantId, locationId: locPrimary } = await createTenantWithLocation('rec-loc');
    const { locationId: locSecondary } = await createLocation({ tenantId });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const mkInt = async (locationId: string, userId: string, title: string) =>
      createIntervention({
        tenantId,
        locationId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-20',
        odometerKm: 50000,
        title,
      });
    return { tenantId, locPrimary, locSecondary, mkInt };
  }

  it('mechanic sees only own-location interventions (BR-205)', async () => {
    const { tenantId, locPrimary, locSecondary, mkInt } = await seed();
    const cognitoSub = '10000000-0000-4000-8000-000000000001';
    const { userId } = await createUser({ tenantId, cognitoSub, locationId: locPrimary });
    await mkInt(locPrimary, userId, 'In primary');
    await mkInt(locSecondary, userId, 'In secondary');

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId: locPrimary,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items.map((i) => i.summary)).toEqual(['In primary']);
  });

  it('mechanic location_id param is ignored (forced to own location)', async () => {
    const { tenantId, locPrimary, locSecondary, mkInt } = await seed();
    const cognitoSub = '10000000-0000-4000-8000-000000000002';
    const { userId } = await createUser({ tenantId, cognitoSub, locationId: locPrimary });
    await mkInt(locPrimary, userId, 'In primary');
    await mkInt(locSecondary, userId, 'In secondary');

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId: locPrimary,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/recent?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ summary: string }> };
    expect(body.items.map((i) => i.summary)).toEqual(['In primary']);
  });

  it('super_admin without param sees all locations; with param narrows', async () => {
    const { tenantId, locPrimary, locSecondary, mkInt } = await seed();
    const cognitoSub = '10000000-0000-4000-8000-000000000003';
    // super_admin user row has no location (BR-204); mechanic user owns the interventions.
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const { userId: mech } = await createUser({
      tenantId,
      cognitoSub: '10000000-0000-4000-8000-00000000000a',
      locationId: locPrimary,
    });
    await mkInt(locPrimary, mech, 'In primary');
    await mkInt(locSecondary, mech, 'In secondary');

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const resAll = await app.inject({
      method: 'GET',
      url: '/v1/interventions/recent',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    const all = (resAll.json() as { items: Array<{ summary: string }> }).items
      .map((i) => i.summary)
      .sort();
    expect(all).toEqual(['In primary', 'In secondary']);

    const resNarrow = await app.inject({
      method: 'GET',
      url: `/v1/interventions/recent?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    const narrow = (resNarrow.json() as { items: Array<{ summary: string }> }).items.map(
      (i) => i.summary,
    );
    expect(narrow).toEqual(['In secondary']);
  });
});
```

- [ ] **Step 6: (Optional local) run integration test**

Integration tests run on CI (Docker). Only run locally to debug a CI failure:
`pnpm --filter @garageos/api test:integration -- interventions-recent`

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/v1/interventions-recent.ts packages/api/tests/unit/routes/v1/interventions-recent.test.ts packages/api/tests/integration/interventions-recent.test.ts
git commit -m "feat(api): location_id filter on interventions/recent (BR-205)"
```

---

## Task 4: Wire `deadlines`

**Files:**
- Modify: `packages/api/src/routes/v1/deadlines-list-tenant.ts`
- Test: `packages/api/tests/integration/deadlines-list-tenant.test.ts`

(No unit test file exists for this route; coverage is integration. The shared helper is already unit-tested in Task 1.)

- [ ] **Step 1: Write the failing integration tests**

In `packages/api/tests/integration/deadlines-list-tenant.test.ts`, add `createLocation` to the import list from `./helpers.js`. The file already defines a local `seedDeadline` helper (top of file) — reuse it. Append a new describe block at the end of the file:

```ts
describe('GET /v1/deadlines — location filter (F-OFF-503)', () => {
  const LOC_IP = '10.20.42.2';
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

  async function seed() {
    const { tenantId, locationId: locPrimary } = await createTenantWithLocation('dl-loc');
    const { locationId: locSecondary } = await createLocation({ tenantId });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await seedDeadline({
      tenantId,
      locationId: locPrimary,
      vehicleId,
      interventionTypeId: typeId,
      dueDate: new Date('2026-08-01'),
      description: 'primary-dl',
    });
    await seedDeadline({
      tenantId,
      locationId: locSecondary,
      vehicleId,
      interventionTypeId: typeId,
      dueDate: new Date('2026-08-02'),
      description: 'secondary-dl',
    });
    return { tenantId, locPrimary, locSecondary };
  }

  it('mechanic sees only own-location deadlines (BR-205); param ignored', async () => {
    const { tenantId, locPrimary, locSecondary } = await seed();
    const cognitoSub = '20000000-0000-4000-8000-000000000001';
    await createUser({ tenantId, cognitoSub, locationId: locPrimary });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId: locPrimary,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: Array<{ description: string | null }> };
    expect(body.deadlines.map((d) => d.description)).toEqual(['primary-dl']);
  });

  it('super_admin: all sedi without param, narrows with param', async () => {
    const { tenantId, locSecondary } = await seed();
    const cognitoSub = '20000000-0000-4000-8000-000000000002';
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });

    const resAll = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    const all = (resAll.json() as { deadlines: Array<{ description: string | null }> }).deadlines
      .map((d) => d.description)
      .sort();
    expect(all).toEqual(['primary-dl', 'secondary-dl']);

    const resNarrow = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    const narrow = (
      resNarrow.json() as { deadlines: Array<{ description: string | null }> }
    ).deadlines.map((d) => d.description);
    expect(narrow).toEqual(['secondary-dl']);
  });
});
```

- [ ] **Step 2: Verify failure rationale**

The route does not yet parse `location_id`; the mechanic test would return both deadlines (FAIL). Integration suite runs on CI — no local run required (the logic is also covered by Task 1's unit tests + the unit assertions in Task 3).

- [ ] **Step 3: Implement the route change**

In `packages/api/src/routes/v1/deadlines-list-tenant.ts`:

Add the import after line 7:

```ts
import { resolveLocationFilter } from '../../lib/location-filter.js';
```

Extend the query schema (replace lines 20-25):

```ts
const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).default('open'),
  intervention_type_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
  location_id: z.uuid().optional(),
});
```

Replace the parse + where head (lines 32-40 region):

```ts
      const { status, intervention_type_id, limit, cursor, location_id } = querySchema.parse(
        request.query,
      );
      const tenantId = request.tenantId!;
      const effectiveLocationId = resolveLocationFilter(
        request.userRole!,
        request.locationId,
        location_id,
      );

      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.deadline.findMany({
          where: {
            status,
            ...(intervention_type_id ? { interventionTypeId: intervention_type_id } : {}),
            ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
          },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/deadlines-list-tenant.ts packages/api/tests/integration/deadlines-list-tenant.test.ts
git commit -m "feat(api): location_id filter on deadlines list (BR-205)"
```

---

## Task 5: Wire `disputes/open`

**Files:**
- Modify: `packages/api/src/routes/v1/disputes-open.ts`
- Test: `packages/api/tests/integration/disputes-open.test.ts`

This endpoint currently parses no query params and imports no `zod`. The dispute's location lives on its `intervention` relation, so the filter goes into the `intervention` nested where on **all four** queries (2 `findMany` + 2 `count`).

- [ ] **Step 1: Write the failing integration tests**

In `packages/api/tests/integration/disputes-open.test.ts`, add `createLocation` to the import list from `./helpers.js`. Append a new describe block at the end:

```ts
describe('GET /v1/disputes/open — location filter (F-OFF-503)', () => {
  const LOC_IP = '10.20.43.2';
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

  async function seed() {
    const { tenantId, locationId: locPrimary } = await createTenantWithLocation('do-loc');
    const { locationId: locSecondary } = await createLocation({ tenantId });
    const { id: typeId } = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({ email: 'do-loc@test.it' });
    await createCustomerTenantRelation({ tenantId, customerId });
    const mkDispute = async (locationId: string, userId: string, km: number) => {
      const { interventionId } = await createIntervention({
        tenantId,
        locationId,
        userId,
        vehicleId,
        interventionTypeId: typeId,
        interventionDate: '2026-05-20',
        odometerKm: km,
        title: `int-${km}`,
      });
      await createDispute({ interventionId, customerId, status: 'open' });
      return interventionId;
    };
    return { tenantId, locPrimary, locSecondary, mkDispute, customerId };
  }

  it('mechanic sees only own-location disputes (BR-205); param ignored', async () => {
    const { tenantId, locPrimary, locSecondary, mkDispute } = await seed();
    const cognitoSub = '30000000-0000-4000-8000-000000000001';
    const { userId } = await createUser({ tenantId, cognitoSub, locationId: locPrimary });
    const iPrimary = await mkDispute(locPrimary, userId, 10000);
    await mkDispute(locSecondary, userId, 10001);

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId: locPrimary,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/open?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingResponse: { count: number; items: Array<{ interventionId: string }> };
    };
    expect(body.pendingResponse.count).toBe(1);
    expect(body.pendingResponse.items.map((i) => i.interventionId)).toEqual([iPrimary]);
  });

  it('super_admin: all sedi without param, narrows with param', async () => {
    const { tenantId, locPrimary, locSecondary, mkDispute } = await seed();
    const adminSub = '30000000-0000-4000-8000-000000000002';
    await createUser({ tenantId, cognitoSub: adminSub, role: 'super_admin' });
    const { userId: mech } = await createUser({
      tenantId,
      cognitoSub: '30000000-0000-4000-8000-00000000000a',
      locationId: locPrimary,
    });
    await mkDispute(locPrimary, mech, 10000);
    const iSecondary = await mkDispute(locSecondary, mech, 10001);

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const resAll = await app.inject({
      method: 'GET',
      url: '/v1/disputes/open',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    expect((resAll.json() as { pendingResponse: { count: number } }).pendingResponse.count).toBe(2);

    const resNarrow = await app.inject({
      method: 'GET',
      url: `/v1/disputes/open?location_id=${locSecondary}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': LOC_IP },
    });
    const narrow = resNarrow.json() as {
      pendingResponse: { count: number; items: Array<{ interventionId: string }> };
    };
    expect(narrow.pendingResponse.count).toBe(1);
    expect(narrow.pendingResponse.items.map((i) => i.interventionId)).toEqual([iSecondary]);
  });
});
```

- [ ] **Step 2: Implement the route change**

In `packages/api/src/routes/v1/disputes-open.ts`:

Add imports at the top (after line 1):

```ts
import { z } from 'zod';

import { resolveLocationFilter } from '../../lib/location-filter.js';
```

Add the query schema near the other module constants (after line 31, the `CUSTOMER_FALLBACK` const):

```ts
const querySchema = z.object({ location_id: z.uuid().optional() });
```

In the handler, replace the head (lines 53-56 region) where `tenantId` is read:

```ts
      const { location_id } = querySchema.parse(request.query);
      const tenantId = request.tenantId!;
      const effectiveLocationId = resolveLocationFilter(
        request.userRole!,
        request.locationId,
        location_id,
      );
      const interventionWhere = {
        tenantId,
        ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
      };

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
```

Then replace each of the **four** `intervention: { tenantId }` occurrences in the `Promise.all` block (the two `findMany` `where` and the two `count` `where`) with `intervention: interventionWhere`:

```ts
        const [pendingItems, pendingCount, inProgressItems, inProgressCount] = await Promise.all([
          tx.interventionDispute.findMany({
            where: { intervention: interventionWhere, status: 'open' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: LIMIT_PER_GROUP,
            select: selectShape,
          }),
          tx.interventionDispute.count({
            where: { intervention: interventionWhere, status: 'open' },
          }),
          tx.interventionDispute.findMany({
            where: {
              intervention: interventionWhere,
              status: { in: ['responded', 'escalated'] },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: LIMIT_PER_GROUP,
            select: selectShape,
          }),
          tx.interventionDispute.count({
            where: {
              intervention: interventionWhere,
              status: { in: ['responded', 'escalated'] },
            },
          }),
        ]);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 4: Run the existing disputes-open unit test (mock-shape regression guard)**

The unit test `tests/unit/routes/v1/disputes-open.test.ts` asserts on `findMany`/`count` call shapes. The where now nests `intervention: { tenantId }` (unchanged when no location), so `expect.objectContaining`-style assertions stay green. Verify:

Run: `pnpm --filter @garageos/api test:unit -- disputes-open`
Expected: PASS. If an assertion used a strict `toEqual` on the where and now fails because of an unrelated shape, update it to reflect `intervention: { tenantId }` (no `locationId` key when none selected).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/disputes-open.ts packages/api/tests/integration/disputes-open.test.ts
git commit -m "feat(api): location_id filter on disputes/open (BR-205)"
```

---

## Task 6: Full typecheck, push, PR, watch CI

- [ ] **Step 1: Repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/location-filter-api
```

(The husky pre-push hook runs `pnpm -r typecheck` — must be green.)

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(api): per-location filter on tenant list endpoints (F-OFF-503 PR1)" --body "<fill from CLAUDE.md template>"
```

PR body must cover:
- **What:** optional `location_id` filter on `interventions/recent`, `deadlines`, `disputes/open`; BR-205 mechanic enforcement (mechanic forced to own location server-side, param ignored).
- **Why:** F-OFF-503 (spec link) + closes the BR-205 mechanic-visibility gap. Unblocks PR2 (web selector).
- **Implementation notes:** shared `resolveLocationFilter` helper; role/location read from JWT claims via `tenantContext` (no extra DB lookup); foreign `location_id` returns empty (no ownership-422, no new error code); no migration.
- **Behavior change callout:** mechanics now see only their own location's interventions/deadlines/disputes (previously all sedi). Covered by integration tests.
- **Tests:** unit (helper + recent where-shape) + integration (3 endpoints × mechanic-isolation/param-ignored/super_admin-narrow). BR-205 verified.

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on red.

---

## Self-Review (completed by plan author)

**Spec coverage (design §API):**
- Optional `location_id` on the 3 endpoints → Tasks 3, 4, 5. ✓
- Role-keyed resolution (mechanic forced / super_admin optional) → Task 1 helper + wired in 3, 4, 5. ✓
- Role/location from `request.userRole`/`request.locationId`, no DB lookup → Tasks 3-5 (verified `tenant-context.ts:64-70`). ✓
- Foreign `location_id` → empty, no 422, no new error code → no ownership lookup added anywhere; uuid-format validation only (`z.uuid().optional()`). ✓
- Disputes filter via `intervention` relation on both groups + counts → Task 5 (all 4 queries). ✓
- Integration test matrix (mechanic own-only, mechanic param-ignored, super_admin all, super_admin narrow, invalid-format 400) → Tasks 3-5 (400-format case in Task 3 unit). ✓

**Placeholder scan:** PR body is the only `<fill>` (deliberate, per CLAUDE.md template). No TODO/TBD in code or tests. ✓

**Type/name consistency:** `resolveLocationFilter(role, userLocationId, queryLocationId)` signature identical across Task 1 definition and Tasks 3-5 call sites. `UserRole` imported from `middleware/tenant-context.js` (the file that exports it). `effectiveLocationId` variable name consistent. `createLocation({ tenantId, name?, isPrimary? })` defined Task 2, used Tasks 3-5. `location_id` (snake_case wire param) vs `locationId` (Prisma field) used consistently. ✓

**Risks addressed:**
- Existing unit assertions use `expect.objectContaining` → new `locationId` key is non-breaking (noted Task 3 Step 1).
- Rate-limit isolation → distinct IPs `10.20.41/42/43.2` per new describe block (`feedback_integration_test_rate_limit_isolation`). ✓
- Mock-shape regression on disputes-open unit → explicit verify step (Task 5 Step 4), per `feedback_handler_change_breaks_unit_mock`. ✓

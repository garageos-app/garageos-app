# Deadline Dashboard Officina Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /v1/deadlines` officina-side aggregate endpoint + web Dashboard scadenze con groupings (Scadute / Settimana / Mese / 3 mesi) + filtro tipo, per chiudere F-OFF-402.

**Architecture:** Vertical slice web + small backend. New tenant-aggregate endpoint con BR-151 PII filter (mirror vehicles/search pattern). Web page consume via TanStack Query infinite, frontend bucket-izza per dueDate ranges (no backend grouping). Sidebar nav abilitata.

**Tech Stack:** Fastify + Prisma + Zod (backend), React 19 + Vite + TanStack Query 5 + shadcn UI + Tailwind (web), Vitest 4 + Testcontainers Postgres (backend integration), Vitest 4 + jsdom (web tests).

**Spec:** `docs/superpowers/specs/2026-05-09-deadline-dashboard-officina-design.md`

---

## File structure

| File | Stato | Resp. | LOC |
|---|---|---|---|
| `packages/api/src/routes/v1/deadlines-list-tenant.ts` | NEW | Route handler | ~110 |
| `packages/api/tests/integration/deadlines-list-tenant.test.ts` | NEW | 8 real-DB scenari | ~250 |
| `packages/api/src/server.ts` | MOD | Register plugin | +2 |
| `docs/APPENDICE_A_API.md` | MOD | Doc endpoint | +30 |
| `packages/web/src/queries/types.ts` | MOD | TenantDeadline + DeadlinesListResponse | +30 |
| `packages/web/src/queries/deadlinesList.ts` | NEW | `useDeadlinesList(filters)` | ~30 |
| `packages/web/src/queries/deadlinesList.test.tsx` | NEW | Hook unit test | ~50 |
| `packages/web/src/lib/deadline-grouping.ts` | NEW | `groupByDueBucket` + `isOverdue` | ~60 |
| `packages/web/src/lib/deadline-grouping.test.tsx` | NEW | Helper unit tests | ~110 |
| `packages/web/src/components/DeadlineRow.tsx` | NEW | Row presentational | ~70 |
| `packages/web/src/components/DeadlineRow.test.tsx` | NEW | Component tests | ~110 |
| `packages/web/src/pages/DeadlineDashboard.tsx` | NEW | Page | ~190 |
| `packages/web/src/pages/DeadlineDashboard.test.tsx` | NEW | Page integration | ~150 |
| `packages/web/src/components/layout/Sidebar.tsx` | MOD | Enable Scadenze nav | ~5 |
| `packages/web/src/App.tsx` | MOD | Add route `/deadlines` | +2 |

**Net LOC stimato:** ~1199 (300 backend + 30 doc + 800 web). Sopra spec estimate ~970 perché test del web sono spesso più LOC del primo cut. Ancora entro hard limit 1500.

---

## Pre-req: working directory & branch

Branch: `feat/deadline-dashboard-officina` (already created). HEAD: `d4b6de2` (spec doc commit). Working directory: `C:\Users\Michele\source\repos\garageos`.

Pre-commit hook: prettier + eslint --fix + secretlint. Pre-push hook: `pnpm -r typecheck`.

DO NOT run `pnpm test:integration` LOCALLY (Docker freeze risk per CLAUDE.md). Backend integration tests are CI-gated. Only typecheck + targeted unit tests during development.

---

## Task 1: Backend route + integration tests + doc

**Files:**
- Create: `packages/api/src/routes/v1/deadlines-list-tenant.ts`
- Create: `packages/api/tests/integration/deadlines-list-tenant.test.ts`
- Modify: `packages/api/src/server.ts`
- Modify: `docs/APPENDICE_A_API.md`

### Step 1.1: Implement the route

Create `packages/api/src/routes/v1/deadlines-list-tenant.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/deadlines — F-OFF-402.
//
// Officina-side aggregate read of all deadlines for the calling
// tenant. RLS deadlines_tenant_isolation guarantees tenant scoping.
// Customer PII gated by BR-151 via resolvePiiVisibility +
// maskCustomer (mirror vehicles/search PR #76 pattern).
//
// Note: 'overdue' status is in the enum but no cron updates it today.
// The filter accepts it for forward-compat; frontend derives
// effectiveStatus from (dueDate < today && status === 'open').

const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).default('open'),
  intervention_type_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const deadlinesListTenantRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/deadlines',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { status, intervention_type_id, limit, cursor } = querySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.deadline.findMany({
          where: {
            status,
            ...(intervention_type_id ? { interventionTypeId: intervention_type_id } : {}),
          },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            vehicleId: true,
            interventionTypeId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            isRecurring: true,
            status: true,
            interventionType: { select: { id: true, code: true, nameIt: true } },
            vehicle: {
              select: {
                id: true,
                plate: true,
                make: true,
                model: true,
                ownerships: {
                  where: { endedAt: null },
                  take: 1,
                  select: {
                    customer: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        phone: true,
                        isBusiness: true,
                        businessName: true,
                        vatNumber: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;

        // BR-151 PII visibility per row's customer (if any active ownership).
        const customerIds = items
          .flatMap((d) => d.vehicle.ownerships.map((o) => o.customer?.id))
          .filter((id): id is string => Boolean(id));
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const data = items.map((d) => {
          const ownership = d.vehicle.ownerships[0] ?? null;
          const cust = ownership?.customer ?? null;
          return {
            id: d.id,
            vehicleId: d.vehicleId,
            interventionTypeId: d.interventionTypeId,
            dueDate: d.dueDate,
            dueOdometerKm: d.dueOdometerKm,
            description: d.description,
            isRecurring: d.isRecurring,
            status: d.status,
            interventionType: d.interventionType,
            vehicle: {
              id: d.vehicle.id,
              plate: d.vehicle.plate,
              make: d.vehicle.make,
              model: d.vehicle.model,
              currentOwnership: cust
                ? { customer: maskCustomer(cust, visibleSet.has(cust.id)) }
                : null,
            },
          };
        });

        const nextCursor = hasMore ? items[items.length - 1]!.id : null;
        return reply.send({ deadlines: data, nextCursor });
      });
    },
  );
};

export default deadlinesListTenantRoutes;
```

### Step 1.2: Register the plugin in server.ts

Open `packages/api/src/server.ts`. Find the imports block (around lines 14-38) and add `deadlines-list-tenant` import in alphabetical order with the other deadlines route imports:

```ts
import deadlinesListTenantRoutes from './routes/v1/deadlines-list-tenant.js';
```

Find the `await app.register(...)` block and add the new registration alongside the other deadlines routes (the order doesn't matter for routes with non-overlapping paths). Example:

```ts
  await app.register(deadlinesCompleteRoutes);
  await app.register(deadlinesCreateRoutes);
  await app.register(deadlinesDeleteRoutes);
  await app.register(deadlinesListCustomerRoutes);
  await app.register(deadlinesListTenantRoutes);
  await app.register(deadlinesListVehicleRoutes);
  await app.register(deadlinesUpdateRoutes);
```

(If the existing block has a different ordering, follow that pattern; the key is to add the new register call in a sensible place.)

### Step 1.3: Write the integration tests

Create `packages/api/tests/integration/deadlines-list-tenant.test.ts`:

```ts
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
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// F-OFF-402 + BR-151 end-to-end: deadlines tenant-isolated by RLS,
// customer PII gated by customer_tenant_relations existence.

interface SeedDeadlineParams {
  tenantId: string;
  locationId: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate?: Date | null;
  dueOdometerKm?: number | null;
  description?: string | null;
  status?: 'open' | 'completed' | 'overdue' | 'cancelled';
}

async function seedDeadline(params: SeedDeadlineParams): Promise<{ deadlineId: string }> {
  const {
    tenantId,
    locationId,
    vehicleId,
    interventionTypeId,
    dueDate = null,
    dueOdometerKm = null,
    description = null,
    status = 'open',
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO deadlines (id, tenant_id, location_id, vehicle_id, intervention_type_id,
        due_date, due_odometer_km, description, status, is_recurring, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::"DeadlineStatus", false, NOW(), NOW())
     RETURNING id`,
    [tenantId, locationId, vehicleId, interventionTypeId, dueDate, dueOdometerKm, description, status],
  );
  return { deadlineId: rows[0]!.id };
}

async function seedInterventionType(params: {
  code: string;
  nameIt: string;
  category?: 'maintenance' | 'tires' | 'repair' | 'inspection' | 'body' | 'other';
}): Promise<{ id: string }> {
  const { code, nameIt, category = 'maintenance' } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_types (id, code, name_it, description, icon, category,
        suggests_deadline, custom, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '', 'wrench', $3::"InterventionTypeCategory",
        true, false, NOW(), NOW())
     RETURNING id`,
    [code, nameIt, category],
  );
  return { id: rows[0]!.id };
}

describe('GET /v1/deadlines (integration)', () => {
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

  it('returns only deadlines for the calling tenant (RLS isolation)', async () => {
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('dl-iso-A');
    const { tenantId: tB, locationId: lB } = await createTenantWithLocation('dl-iso-B');
    const cognitoSub = '11111111-1111-4111-8111-111111111111';
    await createUser({ tenantId: tA, cognitoSub });

    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });

    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vA2 } = await createVehicle({ createdByTenantId: tA });
    const { vehicleId: vB } = await createVehicle({ createdByTenantId: tB });

    await seedDeadline({
      tenantId: tA, locationId: lA, vehicleId: vA1, interventionTypeId: typeId,
      dueDate: new Date('2025-08-01'),
    });
    await seedDeadline({
      tenantId: tA, locationId: lA, vehicleId: vA2, interventionTypeId: typeId,
      dueDate: new Date('2025-09-01'),
    });
    await seedDeadline({
      tenantId: tB, locationId: lB, vehicleId: vB, interventionTypeId: typeId,
      dueDate: new Date('2025-08-01'),
    });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId: tA, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deadlines: Array<{ vehicleId: string }>; nextCursor: string | null };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.map((d) => d.vehicleId).sort()).toEqual([vA1, vA2].sort());
  });

  it('default status filter excludes completed and cancelled', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('dl-status-default');
    const cognitoSub = '22222222-2222-4222-8222-222222222222';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'GOMME', nameIt: 'Gomme' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId, status: 'open' });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId, status: 'completed' });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId, status: 'cancelled' });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ status: string }> };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.status).toBe('open');
  });

  it('?status=cancelled override returns cancelled rows', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('dl-status-override');
    const cognitoSub = '33333333-3333-4333-8333-333333333333';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'REVISIONE', nameIt: 'Revisione' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId, status: 'open' });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId, status: 'cancelled' });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines?status=cancelled',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ status: string }> };
    expect(body.deadlines).toHaveLength(1);
    expect(body.deadlines[0]!.status).toBe('cancelled');
  });

  it('filters by intervention_type_id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('dl-type-filter');
    const cognitoSub = '44444444-4444-4444-8444-444444444444';
    await createUser({ tenantId, cognitoSub });
    const { id: typeA } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { id: typeB } = await seedInterventionType({ code: 'GOMME', nameIt: 'Gomme' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeA });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeB });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?intervention_type_id=${typeA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { deadlines: Array<{ interventionTypeId: string }> };
    expect(body.deadlines).toHaveLength(2);
    expect(body.deadlines.every((d) => d.interventionTypeId === typeA)).toBe(true);
  });

  it('returns customer PII when tenant is related to the customer', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('dl-pii-related');
    const cognitoSub = '55555555-5555-4555-8555-555555555555';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { customerId } = await createCustomer({ firstName: 'Mario', lastName: 'Rossi' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await createCustomerTenantRelation({ tenantId, customerId });
    await seedDeadline({ tenantId, locationId, vehicleId, interventionTypeId: typeId });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as {
      deadlines: Array<{
        vehicle: {
          currentOwnership: {
            customer: { redacted: boolean; firstName?: string; lastName?: string };
          } | null;
        };
      }>;
    };
    expect(body.deadlines).toHaveLength(1);
    const cust = body.deadlines[0]!.vehicle.currentOwnership!.customer;
    expect(cust.redacted).toBe(false);
    expect(cust.firstName).toBe('Mario');
    expect(cust.lastName).toBe('Rossi');
  });

  it('redacts customer PII when tenant is NOT related (BR-151)', async () => {
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('dl-pii-A');
    const { tenantId: tB } = await createTenantWithLocation('dl-pii-B');
    const cognitoSub = '66666666-6666-4666-8666-666666666666';
    await createUser({ tenantId: tA, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });

    // Customer + vehicle + ownership exist but tenant A has NO CTR with the customer.
    const { customerId } = await createCustomer({ firstName: 'Hidden', lastName: 'Customer' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tA });
    await createOwnership({ vehicleId, customerId });
    // Only tenant B is related (decoy — proves nontrivial CTR query):
    await createCustomerTenantRelation({ tenantId: tB, customerId });

    await seedDeadline({ tenantId: tA, locationId: lA, vehicleId, interventionTypeId: typeId });

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId: tA, role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as {
      deadlines: Array<{
        vehicle: {
          currentOwnership: {
            customer: { redacted: boolean; displayName?: string };
          } | null;
        };
      }>;
    };
    expect(body.deadlines).toHaveLength(1);
    const cust = body.deadlines[0]!.vehicle.currentOwnership!.customer;
    expect(cust.redacted).toBe(true);
    expect(cust.displayName).toBe('Proprietario non in anagrafica');
  });

  it('paginates with cursor', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('dl-pagination');
    const cognitoSub = '77777777-7777-4777-8777-777777777777';
    await createUser({ tenantId, cognitoSub });
    const { id: typeId } = await seedInterventionType({ code: 'TAGLIANDO', nameIt: 'Tagliando' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

    const seededIds: string[] = [];
    for (const day of [1, 2, 3]) {
      const { deadlineId } = await seedDeadline({
        tenantId, locationId, vehicleId, interventionTypeId: typeId,
        dueDate: new Date(`2025-08-0${day}`),
      });
      seededIds.push(deadlineId);
    }

    const token = await signTestToken({
      pool: 'officine', sub: cognitoSub, tenantId, role: 'mechanic',
    });
    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/deadlines?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });
    const body1 = res1.json() as { deadlines: Array<{ id: string }>; nextCursor: string | null };
    expect(body1.deadlines).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/deadlines?limit=2&cursor=${body1.nextCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = res2.json() as { deadlines: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.deadlines).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();

    const allIds = [...body1.deadlines.map((d) => d.id), ...body2.deadlines.map((d) => d.id)].sort();
    expect(allIds).toEqual([...seededIds].sort());
  });

  it('returns 401 without auth and 403 for clienti pool tokens', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v1/deadlines' });
    expect(noAuth.statusCode).toBe(401);

    const customerCognitoSub = '88888888-8888-4888-8888-888888888888';
    const customerToken = await signTestToken({
      pool: 'clienti', sub: customerCognitoSub, customerId: customerCognitoSub,
    });
    const wrongPool = await app.inject({
      method: 'GET',
      url: '/v1/deadlines',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(wrongPool.statusCode).toBe(403);
  });
});
```

### Step 1.4: Add documentation to APPENDICE_A_API.md

Open `docs/APPENDICE_A_API.md`. Find the §3.8 Deadlines section (search for `### 3.8 Deadlines`). Add a new row at the top of the section's table for the tenant-aggregate endpoint:

```markdown
| GET | `/deadlines` | F-OFF-402 | Tenant User | Lista aggregata scadenze del tenant (officina). Filtri status (default open) + intervention_type_id + cursor pagination. BR-151 PII customer filtrata. |
```

(If §3.8 has a slightly different format, follow the existing column order.)

### Step 1.5: Typecheck

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

### Step 1.6: (Skip local integration run)

Per CLAUDE.md, integration tests are CI-gated. **Do NOT run** `pnpm test:integration` locally — Docker freeze risk. The push will trigger CI which validates.

### Step 1.7: Commit

```bash
git add packages/api/src/routes/v1/deadlines-list-tenant.ts packages/api/tests/integration/deadlines-list-tenant.test.ts packages/api/src/server.ts docs/APPENDICE_A_API.md
git commit -m "$(cat <<'EOF'
feat(api): GET /v1/deadlines officina-side aggregate endpoint

Implements F-OFF-402 read surface — tenant-aggregate deadline list
ordered by dueDate ASC NULLS LAST + id ASC, cursor pagination, BR-151
PII filter via resolvePiiVisibility + maskCustomer (mirror
vehicles/search PR #76 pattern). 'overdue' status accepted in filter
for forward-compat but no cron updates it today; frontend derives
effectiveStatus from (dueDate < today && status === 'open').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Web types + query hook + grouping helper (TDD)

**Files:**
- Modify: `packages/web/src/queries/types.ts`
- Create: `packages/web/src/queries/deadlinesList.ts`
- Create: `packages/web/src/queries/deadlinesList.test.tsx`
- Create: `packages/web/src/lib/deadline-grouping.ts`
- Create: `packages/web/src/lib/deadline-grouping.test.tsx`

### Step 2.1: Add types to `queries/types.ts`

Open `packages/web/src/queries/types.ts`. Append at the end of the file (after the last export):

```ts
// /v1/deadlines (officina-side aggregate, F-OFF-402).
//
// `customer` follows the same MaskedCustomer shape used by
// vehicles/search: when BR-151 redacts PII, the JSON has no
// firstName/lastName fields (the type allows nullable for runtime
// truthy-check ergonomics). Mirror VehicleResultCard's pattern:
// `customer && customer.firstName && customer.lastName ? ... : '—'`.
export type DeadlineStatus = 'open' | 'completed' | 'overdue' | 'cancelled';

export interface TenantDeadlineCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  isBusiness: boolean | null;
  businessName: string | null;
  vatNumber: string | null;
}

export interface TenantDeadlineVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  currentOwnership: { customer: TenantDeadlineCustomer | null } | null;
}

export interface TenantDeadline {
  id: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string | null;
  dueOdometerKm: number | null;
  description: string | null;
  isRecurring: boolean;
  status: DeadlineStatus;
  vehicle: TenantDeadlineVehicle;
  interventionType: { id: string; code: string; nameIt: string };
}

export interface DeadlinesListResponse {
  deadlines: TenantDeadline[];
  nextCursor: string | null;
}
```

### Step 2.2: Write `useDeadlinesList` test (RED)

Create `packages/web/src/queries/deadlinesList.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useDeadlinesList } from './deadlinesList';
import type { DeadlinesListResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: DeadlinesListResponse = { deadlines: [], nextCursor: null };

describe('useDeadlinesList', () => {
  it('fires the query and includes status=open by default', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDeadlinesList({}), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/deadlines?status=open&limit=50');
  });

  it('passes intervention_type_id when provided', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const typeId = '11111111-1111-4111-8111-111111111111';
    const { result } = renderHook(() => useDeadlinesList({ interventionTypeId: typeId }), {
      wrapper: wrap,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/v1/deadlines?status=open&intervention_type_id=${typeId}&limit=50`,
    );
  });
});
```

### Step 2.3: Run failing test (RED)

```bash
pnpm --filter @garageos/web exec vitest run src/queries/deadlinesList.test.tsx
```

Expected: FAIL with "Cannot find module './deadlinesList'".

### Step 2.4: Implement `useDeadlinesList`

Create `packages/web/src/queries/deadlinesList.ts`:

```ts
import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { DeadlinesListResponse } from './types';

interface DeadlinesFilters {
  interventionTypeId?: string;
}

export function useDeadlinesList(filters: DeadlinesFilters) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['deadlines-list-tenant', filters] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('status', 'open');
      if (filters.interventionTypeId) {
        search.set('intervention_type_id', filters.interventionTypeId);
      }
      search.set('limit', '50');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<DeadlinesListResponse>(`/v1/deadlines?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}
```

### Step 2.5: Run test (GREEN)

```bash
pnpm --filter @garageos/web exec vitest run src/queries/deadlinesList.test.tsx
```

Expected: PASS — 2 tests.

### Step 2.6: Write `deadline-grouping` test (RED)

Create `packages/web/src/lib/deadline-grouping.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';

import { groupByDueBucket, isOverdue } from './deadline-grouping';
import type { TenantDeadline } from '@/queries/types';

const TODAY = new Date('2025-06-15T00:00:00Z');

function makeDeadline(overrides: Partial<TenantDeadline>): TenantDeadline {
  return {
    id: overrides.id ?? 'd1',
    vehicleId: 'v1',
    interventionTypeId: 't1',
    dueDate: overrides.dueDate ?? null,
    dueOdometerKm: overrides.dueOdometerKm ?? null,
    description: null,
    isRecurring: false,
    status: overrides.status ?? 'open',
    vehicle: {
      id: 'v1',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: null,
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

describe('isOverdue', () => {
  it('returns false for completed deadlines even if dueDate is past', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'completed' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns false for cancelled deadlines', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'cancelled' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns false for null dueDate', () => {
    const d = makeDeadline({ dueDate: null, status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns true for open + dueDate < today', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(true);
  });

  it('returns false for open + dueDate === today', () => {
    const d = makeDeadline({ dueDate: '2025-06-15T00:00:00Z', status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });
});

describe('groupByDueBucket', () => {
  it('returns all empty buckets on empty input', () => {
    const buckets = groupByDueBucket([], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('puts overdue items in the overdue bucket', () => {
    const d = makeDeadline({ id: 'd1', dueDate: '2025-06-10T00:00:00Z', status: 'open' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue.map((x) => x.id)).toEqual(['d1']);
    expect(buckets.thisWeek).toEqual([]);
  });

  it('puts items within 7 days in thisWeek', () => {
    const d = makeDeadline({ id: 'd2', dueDate: '2025-06-20T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.thisWeek.map((x) => x.id)).toEqual(['d2']);
  });

  it('puts items beyond 7 and within 30 days in thisMonth', () => {
    const d = makeDeadline({ id: 'd3', dueDate: '2025-07-10T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.thisMonth.map((x) => x.id)).toEqual(['d3']);
  });

  it('puts items beyond 30 and within 90 days in threeMonths', () => {
    const d = makeDeadline({ id: 'd4', dueDate: '2025-08-15T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.threeMonths.map((x) => x.id)).toEqual(['d4']);
  });

  it('excludes items beyond 90 days', () => {
    const d = makeDeadline({ id: 'd5', dueDate: '2026-01-01T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('excludes items with null dueDate from all buckets', () => {
    const d = makeDeadline({ id: 'd6', dueDate: null, dueOdometerKm: 30000 });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('correctly buckets a mixed dataset', () => {
    const items = [
      makeDeadline({ id: 'overdue1', dueDate: '2025-06-01T00:00:00Z', status: 'open' }),
      makeDeadline({ id: 'week1', dueDate: '2025-06-18T00:00:00Z' }),
      makeDeadline({ id: 'month1', dueDate: '2025-07-01T00:00:00Z' }),
      makeDeadline({ id: 'three1', dueDate: '2025-08-01T00:00:00Z' }),
      makeDeadline({ id: 'far', dueDate: '2026-01-01T00:00:00Z' }),
      makeDeadline({ id: 'nodate', dueDate: null }),
    ];
    const buckets = groupByDueBucket(items, TODAY);
    expect(buckets.overdue.map((x) => x.id)).toEqual(['overdue1']);
    expect(buckets.thisWeek.map((x) => x.id)).toEqual(['week1']);
    expect(buckets.thisMonth.map((x) => x.id)).toEqual(['month1']);
    expect(buckets.threeMonths.map((x) => x.id)).toEqual(['three1']);
  });
});
```

### Step 2.7: Run failing test (RED)

```bash
pnpm --filter @garageos/web exec vitest run src/lib/deadline-grouping.test.tsx
```

Expected: FAIL with "Cannot find module './deadline-grouping'".

### Step 2.8: Implement `deadline-grouping`

Create `packages/web/src/lib/deadline-grouping.ts`:

```ts
import type { TenantDeadline } from '@/queries/types';

// Bucket boundaries (relative to `today` at midnight):
//   overdue     dueDate < today          (open status only)
//   thisWeek    today ≤ dueDate ≤ +7d
//   thisMonth   +8d   ≤ dueDate ≤ +30d
//   threeMonths +31d  ≤ dueDate ≤ +90d
//   (>90d, dueDate null, completed/cancelled — all excluded)

export type DeadlineBuckets = {
  overdue: TenantDeadline[];
  thisWeek: TenantDeadline[];
  thisMonth: TenantDeadline[];
  threeMonths: TenantDeadline[];
};

export function isOverdue(d: TenantDeadline, today: Date): boolean {
  if (d.status !== 'open') return false;
  if (!d.dueDate) return false;
  return new Date(d.dueDate) < today;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function groupByDueBucket(items: TenantDeadline[], today: Date): DeadlineBuckets {
  const buckets: DeadlineBuckets = {
    overdue: [],
    thisWeek: [],
    thisMonth: [],
    threeMonths: [],
  };

  for (const item of items) {
    if (!item.dueDate) continue;
    const due = new Date(item.dueDate);

    if (isOverdue(item, today)) {
      buckets.overdue.push(item);
      continue;
    }

    const days = daysBetween(today, due);
    if (days < 0) continue; // overdue + non-open: drop
    if (days <= 7) buckets.thisWeek.push(item);
    else if (days <= 30) buckets.thisMonth.push(item);
    else if (days <= 90) buckets.threeMonths.push(item);
    // > 90 days: dropped
  }

  return buckets;
}
```

### Step 2.9: Run test (GREEN)

```bash
pnpm --filter @garageos/web exec vitest run src/lib/deadline-grouping.test.tsx
```

Expected: PASS — all grouping tests.

### Step 2.10: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

### Step 2.11: Commit

```bash
git add packages/web/src/queries/types.ts packages/web/src/queries/deadlinesList.ts packages/web/src/queries/deadlinesList.test.tsx packages/web/src/lib/deadline-grouping.ts packages/web/src/lib/deadline-grouping.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): deadline list query hook + bucket grouping helper

Adds the TenantDeadline / DeadlinesListResponse DTO types, the
useDeadlinesList infinite query hook gated on optional
interventionTypeId, and the groupByDueBucket / isOverdue helper that
splits items into overdue / thisWeek / thisMonth / threeMonths
buckets relative to the current date. Pure functions, no consumer
yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `DeadlineRow` component (TDD)

**Files:**
- Create: `packages/web/src/components/DeadlineRow.test.tsx`
- Create: `packages/web/src/components/DeadlineRow.tsx`

### Step 3.1: Write the component test (RED)

Create `packages/web/src/components/DeadlineRow.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { DeadlineRow } from './DeadlineRow';
import type { TenantDeadline, TenantDeadlineCustomer } from '@/queries/types';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';

const VISIBLE_CUSTOMER: TenantDeadlineCustomer = {
  id: 'cust-1',
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@example.it',
  phone: null,
  isBusiness: false,
  businessName: null,
  vatNumber: null,
};

const REDACTED_CUSTOMER: TenantDeadlineCustomer = {
  id: 'cust-2',
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  isBusiness: null,
  businessName: null,
  vatNumber: null,
};

function makeDeadline(overrides: Partial<TenantDeadline>): TenantDeadline {
  return {
    id: 'd1',
    vehicleId: VEHICLE_ID,
    interventionTypeId: 't1',
    dueDate: overrides.dueDate ?? '2025-08-15T00:00:00Z',
    dueOdometerKm: overrides.dueOdometerKm ?? null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: VEHICLE_ID,
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: overrides.vehicle?.currentOwnership ?? {
        customer: VISIBLE_CUSTOMER,
      },
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

function renderRow(item: TenantDeadline) {
  return render(
    <MemoryRouter>
      <DeadlineRow item={item} />
    </MemoryRouter>,
  );
}

describe('DeadlineRow', () => {
  it('renders vehicle make/model + plate + intervention type + dueDate + customer name', () => {
    renderRow(makeDeadline({}));
    expect(screen.getByText(/Fiat Panda/)).toBeInTheDocument();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('Tagliando')).toBeInTheDocument();
    expect(screen.getByText(/15\/08\/2025/)).toBeInTheDocument();
    expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument();
  });

  it('shows "—" when customer is redacted (PII)', () => {
    const d = makeDeadline({
      vehicle: {
        id: VEHICLE_ID,
        plate: 'AB123CD',
        make: 'Fiat',
        model: 'Panda',
        currentOwnership: { customer: REDACTED_CUSTOMER },
      },
    });
    renderRow(d);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/Mario Rossi/)).not.toBeInTheDocument();
  });

  it('shows "—" when there is no current ownership', () => {
    const d = makeDeadline({
      vehicle: {
        id: VEHICLE_ID,
        plate: 'AB123CD',
        make: 'Fiat',
        model: 'Panda',
        currentOwnership: null,
      },
    });
    renderRow(d);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows km target when dueDate is null and dueOdometerKm is set', () => {
    const d = makeDeadline({ dueDate: null, dueOdometerKm: 30000 });
    renderRow(d);
    expect(screen.getByText(/30\.000 km/)).toBeInTheDocument();
  });

  it('navigates to /vehicles/:id on click', async () => {
    navigateMock.mockClear();
    const user = userEvent.setup();
    renderRow(makeDeadline({}));
    await user.click(screen.getByRole('button'));
    expect(navigateMock).toHaveBeenCalledWith(`/vehicles/${VEHICLE_ID}`);
  });
});
```

### Step 3.2: Run failing test (RED)

```bash
pnpm --filter @garageos/web exec vitest run src/components/DeadlineRow.test.tsx
```

Expected: FAIL with "Cannot find module './DeadlineRow'".

### Step 3.3: Implement `DeadlineRow`

Create `packages/web/src/components/DeadlineRow.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { Calendar, Gauge, User } from 'lucide-react';

import { formatDate, formatKm } from '@/lib/format';
import type { TenantDeadline } from '@/queries/types';

// Single row for the deadline dashboard. Click anywhere on the row
// navigates to the underlying vehicle detail page so the operator
// can register a closing intervention or inspect history.
//
// Customer name follows the existing PII pattern from
// VehicleResultCard: when redacted, firstName/lastName are
// effectively undefined and the truthy-check renders "—".

interface Props {
  item: TenantDeadline;
}

export function DeadlineRow({ item }: Props) {
  const navigate = useNavigate();
  const customer = item.vehicle.currentOwnership?.customer ?? null;
  const customerName =
    customer && customer.firstName && customer.lastName
      ? `${customer.firstName} ${customer.lastName}`
      : '—';

  return (
    <button
      type="button"
      onClick={() => navigate(`/vehicles/${item.vehicleId}`)}
      className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-blue-50/30 dark:hover:bg-blue-950/30 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate">
          {item.vehicle.make} {item.vehicle.model}{' '}
          <span className="font-mono text-xs text-muted-foreground">{item.vehicle.plate}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
          <span>{item.interventionType.nameIt}</span>
          <span className="flex items-center gap-1">
            {item.dueDate ? (
              <>
                <Calendar size={12} /> {formatDate(item.dueDate)}
              </>
            ) : (
              <>
                <Gauge size={12} /> {formatKm(item.dueOdometerKm)}
              </>
            )}
          </span>
          <span className="flex items-center gap-1">
            <User size={12} /> {customerName}
          </span>
        </div>
      </div>
    </button>
  );
}
```

### Step 3.4: Run test (GREEN)

```bash
pnpm --filter @garageos/web exec vitest run src/components/DeadlineRow.test.tsx
```

Expected: PASS — 5 tests.

### Step 3.5: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

### Step 3.6: Commit

```bash
git add packages/web/src/components/DeadlineRow.tsx packages/web/src/components/DeadlineRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): DeadlineRow presentational component

Renders make/model + plate, intervention type name, due date OR km
target (mutually exclusive display), customer name with BR-151 PII
truthy-check fallback to "—". Click navigates to /vehicles/:id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `DeadlineDashboard` page + Sidebar + App.tsx route

**Files:**
- Create: `packages/web/src/pages/DeadlineDashboard.tsx`
- Create: `packages/web/src/pages/DeadlineDashboard.test.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.tsx`
- Modify: `packages/web/src/App.tsx`

### Step 4.1: Write the page test (RED)

Create `packages/web/src/pages/DeadlineDashboard.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DeadlineDashboard } from './DeadlineDashboard';
import type {
  DeadlinesListResponse,
  InterventionTypesResponse,
  TenantDeadline,
} from '@/queries/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TODAY_OFFSET_DAYS = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

function makeDeadline(id: string, dueOffsetDays: number): TenantDeadline {
  return {
    id,
    vehicleId: `veh-${id}`,
    interventionTypeId: 't1',
    dueDate: TODAY_OFFSET_DAYS(dueOffsetDays),
    dueOdometerKm: null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: `veh-${id}`,
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: {
        customer: {
          id: 'cust-1',
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@example.it',
          phone: null,
          isBusiness: false,
          businessName: null,
          vatNumber: null,
        },
      },
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

const TYPES_FIXTURE: InterventionTypesResponse = {
  data: [
    {
      id: 't1',
      code: 'TAGLIANDO',
      nameIt: 'Tagliando',
      description: '',
      icon: 'wrench',
      category: 'maintenance',
      suggestsDeadline: true,
      defaultDeadlineMonths: 12,
      defaultDeadlineKm: 15000,
      custom: false,
    },
    {
      id: 't2',
      code: 'GOMME',
      nameIt: 'Gomme',
      description: '',
      icon: 'circle',
      category: 'tires',
      suggestsDeadline: false,
      defaultDeadlineMonths: null,
      defaultDeadlineKm: null,
      custom: false,
    },
  ],
};

function setupApiFetch(deadlinesResp: DeadlinesListResponse | Error) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/v1/intervention-types') return TYPES_FIXTURE;
    if (path.startsWith('/v1/deadlines')) {
      if (deadlinesResp instanceof Error) throw deadlinesResp;
      return deadlinesResp;
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('DeadlineDashboard', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });
  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows skeletons while data is loading', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}));
    render(wrap({ children: <DeadlineDashboard /> }));
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows error alert with Riprova on failure', async () => {
    setupApiFetch(new Error('boom'));
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument(),
    );
  });

  it('renders all 4 grouping sections with counts', async () => {
    setupApiFetch({
      deadlines: [
        makeDeadline('overdue1', -10),
        makeDeadline('week1', 3),
        makeDeadline('month1', 20),
        makeDeadline('three1', 60),
      ],
      nextCursor: null,
    });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() => expect(screen.getByText(/Scadute/i)).toBeInTheDocument());
    expect(screen.getByText(/Questa settimana/i)).toBeInTheDocument();
    expect(screen.getByText(/Questo mese/i)).toBeInTheDocument();
    expect(screen.getByText(/Prossimi 3 mesi/i)).toBeInTheDocument();
  });

  it('shows empty-state when no deadlines exist', async () => {
    setupApiFetch({ deadlines: [], nextCursor: null });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByText(/nessuna scadenza configurata/i)).toBeInTheDocument(),
    );
  });

  it('refetches with intervention_type_id when the dropdown changes', async () => {
    setupApiFetch({ deadlines: [], nextCursor: null });
    const user = userEvent.setup();
    render(wrap({ children: <DeadlineDashboard /> }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const initialCalls = apiFetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('/v1/deadlines'),
    ).length;

    // Find the select trigger and open it. shadcn Select uses a button with
    // role=combobox when there's a placeholder.
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    await user.click(await screen.findByText('Tagliando'));

    await waitFor(() => {
      const filtered = apiFetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('intervention_type_id=t1'),
      );
      expect(filtered.length).toBeGreaterThan(0);
    });
    // sanity: total deadlines calls increased
    const finalCalls = apiFetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('/v1/deadlines'),
    ).length;
    expect(finalCalls).toBeGreaterThan(initialCalls);
  });

  it('shows "Carica altre" when hasNextPage', async () => {
    setupApiFetch({
      deadlines: [makeDeadline('d1', 5)],
      nextCursor: 'next-cursor-id',
    });
    render(wrap({ children: <DeadlineDashboard /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /carica altre/i })).toBeInTheDocument(),
    );
  });
});
```

### Step 4.2: Run failing test (RED)

```bash
pnpm --filter @garageos/web exec vitest run src/pages/DeadlineDashboard.test.tsx
```

Expected: FAIL with "Cannot find module './DeadlineDashboard'".

### Step 4.3: Implement `DeadlineDashboard`

Create `packages/web/src/pages/DeadlineDashboard.tsx`:

```tsx
// IT-strings — hardcoded
import { useState } from 'react';
import { Calendar, SearchX } from 'lucide-react';

import { useDeadlinesList } from '@/queries/deadlinesList';
import { useInterventionTypes } from '@/queries/interventionTypes';
import { groupByDueBucket } from '@/lib/deadline-grouping';
import { DeadlineRow } from '@/components/DeadlineRow';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TenantDeadline } from '@/queries/types';

// F-OFF-402 dashboard. Frontend bucket-izza per dueDate ranges su
// `today` corrente; "overdue" è derivato (`dueDate < today &&
// status === 'open'`) perché nessun cron aggiorna lo status enum
// `overdue` oggi.

const ALL_TYPES = '__all__';

export function DeadlineDashboard() {
  const [interventionTypeId, setInterventionTypeId] = useState<string>(ALL_TYPES);
  const types = useInterventionTypes();
  const query = useDeadlinesList({
    interventionTypeId: interventionTypeId === ALL_TYPES ? undefined : interventionTypeId,
  });

  const items: TenantDeadline[] = query.data?.pages.flatMap((p) => p.deadlines) ?? [];
  const today = startOfDayLocal(new Date());
  const buckets = groupByDueBucket(items, today);

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Calendar size={24} className="text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Scadenze in arrivo</h1>
      </div>

      <div>
        <Select value={interventionTypeId} onValueChange={setInterventionTypeId}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder="Tutti i tipi" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TYPES}>Tutti i tipi</SelectItem>
            {types.data?.data.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.nameIt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
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
          <div className="font-medium text-foreground">
            {interventionTypeId === ALL_TYPES
              ? 'Nessuna scadenza configurata.'
              : 'Nessuna scadenza per il tipo selezionato.'}
          </div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <div className="space-y-6">
          <BucketSection title="Scadute" tone="destructive" items={buckets.overdue} />
          <BucketSection title="Questa settimana" items={buckets.thisWeek} />
          <BucketSection title="Questo mese" items={buckets.thisMonth} />
          <BucketSection title="Prossimi 3 mesi" items={buckets.threeMonths} />
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

interface BucketSectionProps {
  title: string;
  items: TenantDeadline[];
  tone?: 'destructive';
}

function BucketSection({ title, items, tone }: BucketSectionProps) {
  return (
    <section>
      <div
        className={
          tone === 'destructive'
            ? 'text-xs uppercase tracking-wider font-semibold text-destructive mb-2'
            : 'text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2'
        }
      >
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-4 text-sm text-muted-foreground">
          Nessuna scadenza in questa fascia.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg divide-y divide-border">
          {items.map((d) => (
            <DeadlineRow key={d.id} item={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function startOfDayLocal(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
```

### Step 4.4: Run page test (GREEN)

```bash
pnpm --filter @garageos/web exec vitest run src/pages/DeadlineDashboard.test.tsx
```

Expected: PASS — 6 tests. If the dropdown test (#5) fails because shadcn Select renders a different role, inspect via `screen.debug()` — common alternatives are `combobox` (correct) or `button` with `aria-haspopup="listbox"`. The plan uses `combobox`.

### Step 4.5: Update Sidebar to enable "Scadenze"

Open `packages/web/src/components/layout/Sidebar.tsx`. Replace the `navItems` const with:

```tsx
import { Search, Wrench, Users, Settings, LogOut, Calendar } from 'lucide-react';
// ... rest of imports unchanged

const navItems = [
  { id: 'search', label: 'Cerca veicolo', icon: Search, to: '/', enabled: true },
  { id: 'interventions', label: 'Interventi', icon: Wrench, enabled: false },
  { id: 'deadlines', label: 'Scadenze', icon: Calendar, to: '/deadlines', enabled: true },
  { id: 'customers', label: 'Clienti', icon: Users, enabled: false },
  { id: 'settings', label: 'Impostazioni', icon: Settings, enabled: false },
] as const;
```

Then update `isSearchActive` to no longer match `/deadlines` (it currently matches `/`, `/search`, `/vehicles`). Add a separate active-check for the deadlines route. Replace the `isSearchActive` function with:

```tsx
function isActiveFor(itemId: string, pathname: string): boolean {
  if (itemId === 'search') {
    return pathname === '/' || pathname.startsWith('/search') || pathname.startsWith('/vehicles');
  }
  if (itemId === 'deadlines') {
    return pathname.startsWith('/deadlines');
  }
  return false;
}
```

In the JSX, the existing `const active = isSearchActive(pathname);` line inside the map call must change. Replace the entire `if (item.enabled && 'to' in item) { ... }` block with:

```tsx
          if (item.enabled && 'to' in item) {
            const active = isActiveFor(item.id, pathname);
            return (
              <Link
                key={item.id}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                  active ? 'bg-blue-900 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          }
```

(Just replacing the `isSearchActive(pathname)` call with `isActiveFor(item.id, pathname)`.)

### Step 4.6: Add the `/deadlines` route to App.tsx

Open `packages/web/src/App.tsx`. Add the import alongside the other page imports:

```tsx
import { DeadlineDashboard } from '@/pages/DeadlineDashboard';
```

Add the route inside the `<Route element={<AppLayout />}>` block, after `/vehicles/:id/interventions/new` and before the catch-all:

```tsx
                  <Route path="/deadlines" element={<DeadlineDashboard />} />
```

### Step 4.7: Run full web unit suite

```bash
pnpm --filter @garageos/web test:unit
```

Expected: full PASS across all test files.

### Step 4.8: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

### Step 4.9: Commit

```bash
git add packages/web/src/pages/DeadlineDashboard.tsx packages/web/src/pages/DeadlineDashboard.test.tsx packages/web/src/components/layout/Sidebar.tsx packages/web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): DeadlineDashboard page + Sidebar Scadenze nav

F-OFF-402 dashboard with 4 grouping sections (Scadute / Settimana
/ Mese / 3 mesi), intervention type filter dropdown, cursor-based
pagination via "Carica altre". Sidebar item Scadenze abilitato con
nuova route /deadlines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final validation, push, PR

**Files:** none (verification + git operations).

### Step 5.1: Workspace typecheck

```bash
pnpm -r typecheck
```

Expected: 0 errors across all 4 packages.

### Step 5.2: Web unit suite

```bash
pnpm --filter @garageos/web test:unit
```

Expected: all tests pass.

### Step 5.3: LOC budget check

```bash
git diff main..HEAD --stat
```

Expected: total ~1200 LOC (incl. spec + plan + ~970 net code). No drift outside `packages/api`, `packages/web`, `docs/superpowers/`, `docs/APPENDICE_A_API.md`.

### Step 5.4: Push the branch

```bash
git push -u origin feat/deadline-dashboard-officina
```

Expected: pre-push hook runs `pnpm -r typecheck` and passes.

### Step 5.5: Open the PR

```bash
gh pr create --title "feat(api,web): dashboard scadenze officina (F-OFF-402)" --body "$(cat <<'EOF'
## What

Ship `GET /v1/deadlines` officina-side aggregate endpoint + web Dashboard scadenze con groupings (Scadute / Settimana / Mese / 3 mesi) + filtro tipo + sidebar nav.

Secondo vertical slice post pivot agile. Web + small backend.

## Why

- Spec: `docs/superpowers/specs/2026-05-09-deadline-dashboard-officina-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-deadline-dashboard-officina.md`
- F-OFF-402 — "Vista scadenze in arrivo" (MUST priority).
- Cluster H1+H3 reminder backend + create/complete/delete erano tutti shipped, mancava solo l'aggregate read officina-side per chiudere il loop demo daily.

## Implementation notes

- Backend `GET /v1/deadlines` — officina-pool, tenant-scoped via RLS `deadlines_tenant_isolation`. Order `dueDate ASC NULLS LAST + id ASC`. Cursor pagination identica a deadlines-list-vehicle. BR-151 PII filter via `resolvePiiVisibility + maskCustomer` (mirror vehicles/search).
- Status `overdue` accettato nel filter ma nessun cron lo aggiorna oggi → frontend deriva `effectiveStatus` da `dueDate < today && status === 'open'`. Followup ticket per cron.
- Frontend bucket-izza per dueDate ranges relativi a `today` (mezzanotte locale). Bucket: overdue / 0–7d / 8–30d / 31–90d. Beyond 90d esclusi v1.
- Customer name nella row segue il pattern `MaskedCustomer | null` di `VehicleResultCard` — quando PII redacted, truthy-check `customer.firstName` falsy → "—".
- Filtro UI: dropdown `Select` shadcn alimentato da `useInterventionTypes`. Filter location escluso v1 (followup F-OFF-402 completion).
- Sidebar nav `Scadenze` abilitata (era `enabled: false` con badge "soon"). Helper `isActiveFor(itemId, pathname)` rimpiazza `isSearchActive` per gestire 2 route attive.

## Tests

- [x] Backend integration (8): tenant isolation, default status filter, status override, type filter, PII visible, PII redacted, cursor pagination, 401/403
- [x] Web hook unit (2): default URL, with intervention_type_id
- [x] Helper unit `deadline-grouping` (~10): isOverdue 5 cases + groupByDueBucket 7 cases (empty/each bucket/boundaries/mixed/null/beyond-90)
- [x] Web component `DeadlineRow` (5): full render, redacted, no ownership, km target, click navigate
- [x] Web page `DeadlineDashboard` (6): loading skeletons, error+Riprova, 4 sections happy path, empty state, filter dropdown refetch, "Carica altre" hasNextPage
- [ ] Manual smoke (post-deploy):
  1. Login web Giuseppe
  2. Click Sidebar "Scadenze"
  3. Verify dashboard renders sections (richiede dataset deadline)
  4. Filtra per tipo → query rifatta
  5. Click su una row → naviga al veicolo

## Followup tickets to file (post-merge)

1. **Cron auto-overdue**: backend job che setta `status='overdue'` quando `dueDate` passa. Oggi enum esiste ma nessuno lo aggiorna; frontend deriva.
2. **Filtro location**: F-OFF-402 lo prevede, ma multi-sede minor v1. Followup.
3. **Quick-complete modal**: F-OFF-405 closure dalla dashboard senza navigare al veicolo. Slice futuro.
4. **Recurring deadlines UI**: campo `isRecurring` nel DTO, no UI v1.
5. **Followup tickets PR #77/#78/#79** ancora aperti.

## Checklist

- [x] Conventional Commits title
- [x] Types compile (`pnpm -r typecheck` clean)
- [x] No console.log, no commented-out code
- [x] No secrets committed
- [x] Spec + plan committed
- [x] Subagent-driven 3-stage review loop + opus final reviewer
EOF
)"
```

### Step 5.6: Watch CI

```bash
gh pr checks --watch
```

Expected: 9/9 green. The new backend integration tests run on the integration-tests CI job (Testcontainers Postgres).

If anything fails, fix and push a follow-up commit.

---

## Self-review summary

Spec → plan coverage:

| Spec section | Covered by |
|---|---|
| §2.1 Backend route | Task 1 step 1.1 |
| §2.2 Web pages structure | Task 4 step 4.3 |
| §2.3 Grouping logic | Task 2 step 2.8 |
| §3.1 NEW files | Tasks 1, 2, 3, 4 |
| §3.2 MODIFIED files | Tasks 1 (server.ts, APPENDICE), 2 (types), 4 (Sidebar, App.tsx) |
| §3.3 Module shapes | Tasks 1, 2, 3, 4 (full code blocks) |
| §4 Edge cases | Task 2 grouping tests + Task 3 row tests + Task 4 page tests cover all listed cases |
| §5.1 Backend tests (8) | Task 1 step 1.3 |
| §5.2 Helper tests (5+grouping) | Task 2 step 2.6 |
| §5.3 Row tests (5) | Task 3 step 3.1 |
| §5.4 Page tests (6) | Task 4 step 4.1 |
| §6 Non-goals | Out of scope by construction |
| §7 BR coverage (BR-151) | Task 1 PII test scenarios + DeadlineRow PII test |
| §8 Operational | Task 5 (CI gates) + manual smoke optional |
| §9 PR description | Task 5.5 |

No placeholders. Every step has actual content. Type signatures cross-reference: `TenantDeadline`, `TenantDeadlineCustomer`, `TenantDeadlineVehicle`, `DeadlinesListResponse`, `DeadlineStatus`, `DeadlineBuckets` all defined in earlier tasks before consumed by later ones. The web `MaskedCustomer`-style truthy-check pattern is documented in the types file comment + reused in DeadlineRow + tested explicitly.

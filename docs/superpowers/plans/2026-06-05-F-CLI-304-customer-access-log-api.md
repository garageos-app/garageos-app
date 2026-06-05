# F-CLI-304 Customer access-log API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /v1/me/vehicles/:id/access-log` so an owning customer sees the BR-155-redacted audit trail of accesses to their vehicle, completing the last section of F-CLI-106.

**Architecture:** Customer-pool endpoint added to the existing `me-vehicles.ts`. `access_logs` only has `tenant_isolation` RLS (a customer cannot satisfy it), so reads run in `withContext({ role: 'admin' })` and a 404 ownership gate is the real security boundary. A new `vehicle_registered` `AccessLogAction` value disambiguates vehicle-registration from intervention-`create`, so the customer audit can map `create → 'new_intervention'` unambiguously. A pure serializer enforces BR-155 redaction; pagination reuses the existing compound `(createdAt, id)` cursor helper.

**Tech Stack:** Fastify + TypeScript + Prisma (Postgres), Zod, Vitest. Spec: `docs/superpowers/specs/2026-06-05-F-CLI-304-customer-access-log-api-design.md`.

---

## File Structure

- **Modify** `packages/database/prisma/schema.prisma` — add `vehicle_registered` to `enum AccessLogAction` (line ~169-177).
- **Create** `packages/database/prisma/migrations/20260605120000_access_log_vehicle_registered/migration.sql` — `ALTER TYPE ... ADD VALUE`.
- **Modify** `packages/api/src/lib/access-log.ts:10` — extend the inlined `AccessLogAction` union.
- **Modify** `packages/api/src/routes/v1/vehicles.ts:540-553` — vehicle-registration logs `vehicle_registered`.
- **Modify** `packages/api/tests/unit/routes/v1/vehicles.test.ts:1256-1284` — update the registration access-log assertion.
- **Modify** `packages/api/tests/integration/vehicles-post.test.ts:24,104-106` — update the registration access-log SQL assertion.
- **Create** `packages/api/src/lib/customer-access-log.ts` — pure BR-155 serializer.
- **Create** `packages/api/tests/unit/lib/customer-access-log.test.ts` — serializer unit tests.
- **Modify** `packages/api/src/routes/v1/me-vehicles.ts` — add the `GET /v1/me/vehicles/:id/access-log` handler + imports.
- **Modify** `packages/api/tests/unit/routes/v1/me-vehicles.test.ts` — extend `FakePrisma`, add the access-log describe block.
- **Modify** `packages/api/tests/integration/me-vehicles.test.ts` — add the access-log integration describe block.
- **Modify** `docs/APPENDICE_A_API.md`, `docs/APPENDICE_B_DATABASE.md`, `docs/APPENDICE_F_BUSINESS_LOGIC.md`.

---

## Task 1: Enum split — `vehicle_registered`

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (enum `AccessLogAction`, ~line 169)
- Create: `packages/database/prisma/migrations/20260605120000_access_log_vehicle_registered/migration.sql`
- Modify: `packages/api/src/lib/access-log.ts:10`
- Modify: `packages/api/src/routes/v1/vehicles.ts:540-553`
- Modify: `packages/api/tests/unit/routes/v1/vehicles.test.ts:1256-1284`
- Modify: `packages/api/tests/integration/vehicles-post.test.ts:24,104-106`

- [ ] **Step 1: Update the registration unit-test assertion first (red)**

In `packages/api/tests/unit/routes/v1/vehicles.test.ts`, change the test at line 1256 — rename it and flip the expected action:

```ts
  it('writes an access_logs row with action=vehicle_registered (BR-154)', async () => {
```

and in its `expect(prisma.accessLog.create).toHaveBeenCalledWith(...)` block (line ~1280) change:

```ts
          action: 'vehicle_registered',
```

(leave the surrounding `vehicleId`/`tenantId`/`userId` assertions unchanged).

- [ ] **Step 2: Run the unit test to verify it fails**

Run (PowerShell, redirect to a file + sentinel so the backgrounded run is observable):

```powershell
pnpm --filter @garageos/api test:unit -- vehicles.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t1.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t1.txt
```

Expected: FAIL — the code still logs `action: 'create'`, so the assertion mismatches.

- [ ] **Step 3: Add the enum value (schema + migration + lib union)**

In `packages/database/prisma/schema.prisma`, add to `enum AccessLogAction` (after `respond`):

```prisma
enum AccessLogAction {
  view
  create
  update
  search_match
  cancel
  respond
  ownership_transfer // BR-049
  vehicle_registered // F-CLI-304: distinguishes vehicle registration from intervention create
}
```

Create `packages/database/prisma/migrations/20260605120000_access_log_vehicle_registered/migration.sql`:

```sql
-- F-CLI-304 — vehicle registration is a distinct audit event from an
-- intervention create. The customer audit (BR-155) surfaces intervention
-- 'create' as "new intervention"; without a separate action the two are
-- indistinguishable in access_logs (no row-level discriminator).
-- ALTER TYPE ADD VALUE is not transactional in Postgres; Prisma migrate
-- applies it in a dedicated migration with no other DDL.
ALTER TYPE "AccessLogAction" ADD VALUE 'vehicle_registered';
```

In `packages/api/src/lib/access-log.ts:10`, extend the union:

```ts
export type AccessLogAction =
  | 'view'
  | 'create'
  | 'update'
  | 'search_match'
  | 'cancel'
  | 'respond'
  | 'vehicle_registered';
```

- [ ] **Step 4: Regenerate the Prisma client**

Run:

```powershell
pnpm --filter @garageos/database prisma generate
```

Expected: client regenerated, `AccessLogAction` now includes `vehicle_registered`.

- [ ] **Step 5: Switch the vehicle-registration write-site (green)**

In `packages/api/src/routes/v1/vehicles.ts`, change the registration access-log call (line ~540-553). Update the comment and the action:

```ts
        // BR-154 / F-CLI-304: a vehicle registration is logged as a
        // distinct 'vehicle_registered' action (not the overloaded
        // 'create'), so the customer audit (BR-155) can surface
        // intervention creates as "new intervention" without conflating
        // them with the one-time registration row. Reuses
        // recordVehicleAccess so the 30-min dedup stays centralized.
        await recordVehicleAccess({
          tx,
          vehicleId: vehicle.id,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'vehicle_registered',
          ipAddress: request.ip,
          log: request.log,
        });
```

- [ ] **Step 6: Update the integration assertion**

In `packages/api/tests/integration/vehicles-post.test.ts`:
- Line 24 comment: `//   - BR-154 (access_log action='vehicle_registered')`
- Lines 104-106 SQL:

```ts
      `SELECT COUNT(*)::text AS count FROM access_logs
       WHERE vehicle_id = $1 AND action = 'vehicle_registered'`,
```

- [ ] **Step 7: Run the unit test to verify it passes + typecheck**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- vehicles.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t1.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t1.txt
pnpm -r typecheck
```

Expected: vehicles unit suite PASS; typecheck clean. (Do NOT run integration locally — CI covers it.)

- [ ] **Step 8: Commit**

```powershell
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/api/src/lib/access-log.ts packages/api/src/routes/v1/vehicles.ts packages/api/tests/unit/routes/v1/vehicles.test.ts packages/api/tests/integration/vehicles-post.test.ts
git commit -m "feat(database): add vehicle_registered access-log action (F-CLI-304)"
```

---

## Task 2: BR-155 serializer (pure)

**Files:**
- Create: `packages/api/src/lib/customer-access-log.ts`
- Test: `packages/api/tests/unit/lib/customer-access-log.test.ts`

- [ ] **Step 1: Write the failing serializer test**

Create `packages/api/tests/unit/lib/customer-access-log.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { serializeCustomerAccessLog } from '../../../src/lib/customer-access-log.js';

const TENANT_REL = '55555555-5555-4555-8555-555555555555';
const TENANT_NO_REL = '66666666-6666-4666-8666-666666666666';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    action: 'view',
    createdAt: new Date('2026-06-04T10:00:00.000Z'),
    tenant: { id: TENANT_REL, businessName: 'Officina Rossi' },
    location: { city: 'Bologna' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
    ...overrides,
  };
}

describe('serializeCustomerAccessLog', () => {
  it('maps view -> view and create -> new_intervention', () => {
    const out = serializeCustomerAccessLog(
      [row({ action: 'view' }), row({ action: 'create' })],
      new Set<string>(),
    );
    expect(out[0]!.action).toBe('view');
    expect(out[1]!.action).toBe('new_intervention');
  });

  it('emits the redacted BR-155 shape and no internal fields', () => {
    const [entry] = serializeCustomerAccessLog([row()], new Set([TENANT_REL]));
    expect(entry).toEqual({
      action: 'view',
      tenantName: 'Officina Rossi',
      locationCity: 'Bologna',
      occurredAt: '2026-06-04T10:00:00.000Z',
      mechanicName: 'Mario Bianchi',
    });
    // No internal ids / ip / user agent leaked.
    expect(entry).not.toHaveProperty('id');
    expect(entry).not.toHaveProperty('tenantId');
    expect(entry).not.toHaveProperty('userId');
    expect(entry).not.toHaveProperty('locationId');
    expect(entry).not.toHaveProperty('vehicleId');
    expect(entry).not.toHaveProperty('ipAddress');
    expect(entry).not.toHaveProperty('userAgent');
  });

  it('omits mechanicName when no customer_tenant_relation exists', () => {
    const [entry] = serializeCustomerAccessLog(
      [row({ tenant: { id: TENANT_NO_REL, businessName: 'Officina Verdi' } })],
      new Set([TENANT_REL]),
    );
    expect(entry).not.toHaveProperty('mechanicName');
    expect(entry!.tenantName).toBe('Officina Verdi');
  });

  it('returns locationCity null when the row has no location', () => {
    const [entry] = serializeCustomerAccessLog([row({ location: null })], new Set([TENANT_REL]));
    expect(entry!.locationCity).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- customer-access-log.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t2.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t2.txt
```

Expected: FAIL — module `customer-access-log` does not exist.

- [ ] **Step 3: Implement the serializer**

Create `packages/api/src/lib/customer-access-log.ts`:

```ts
// BR-155 — the owning customer sees the audit trail of accesses to their
// vehicle in a strictly redacted shape: tenant name, location city,
// action type, timestamp, and (only if a customer_tenant_relation exists,
// BR-151) the mechanic's name. IP address, user agent, and all internal
// ids are never exposed.
//
// Pure function: the route resolves the relation set and passes it in, so
// this stays DB-free and unit-testable.

export type CustomerAccessAction = 'view' | 'new_intervention';

export interface CustomerAccessLogEntry {
  action: CustomerAccessAction;
  tenantName: string;
  locationCity: string | null;
  occurredAt: string;
  mechanicName?: string;
}

export interface RawCustomerAccessLogRow {
  // `action` is constrained upstream to the audit's customer-visible set
  // ('view' | 'create') by the route's where-filter.
  action: string;
  createdAt: Date;
  tenant: { id: string; businessName: string };
  location: { city: string } | null;
  user: { firstName: string; lastName: string };
}

export function serializeCustomerAccessLog(
  rows: RawCustomerAccessLogRow[],
  relationTenantIds: Set<string>,
): CustomerAccessLogEntry[] {
  return rows.map((r) => {
    const entry: CustomerAccessLogEntry = {
      action: r.action === 'view' ? 'view' : 'new_intervention',
      tenantName: r.tenant.businessName,
      locationCity: r.location?.city ?? null,
      occurredAt: r.createdAt.toISOString(),
    };
    // BR-151/BR-155: mechanic name only for tenants the customer relates to.
    if (relationTenantIds.has(r.tenant.id)) {
      entry.mechanicName = `${r.user.firstName} ${r.user.lastName}`;
    }
    return entry;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- customer-access-log.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t2.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t2.txt
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add packages/api/src/lib/customer-access-log.ts packages/api/tests/unit/lib/customer-access-log.test.ts
git commit -m "feat(api): add BR-155 customer access-log serializer (F-CLI-304)"
```

---

## Task 3: Route handler `GET /v1/me/vehicles/:id/access-log`

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

- [ ] **Step 1: Extend `FakePrisma` in the unit test**

In `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`, replace the `FakePrisma` interface (line 36-41) and `buildFakePrisma` (line 43-51):

```ts
interface FakePrisma {
  vehicleOwnership: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  accessLog: {
    findMany: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: {
    findMany: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicleOwnership: {
      findMany: vi.fn().mockResolvedValue([OWNERSHIP_ROW]),
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
    },
    accessLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}
```

(Existing tests spread-override only `vehicleOwnership`, so they keep the new defaults — no other test changes.)

- [ ] **Step 2: Write the failing access-log describe block (append to the file, before the final closing)**

Append this describe block at the end of `me-vehicles.test.ts` (after the `GET /v1/me/vehicles/:id` block, before EOF):

```ts
describe('GET /v1/me/vehicles/:id/access-log', () => {
  let app: FastifyInstance | undefined;

  const ACCESS_ROW_VIEW = {
    id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    action: 'view',
    createdAt: new Date('2026-06-04T10:00:00.000Z'),
    tenant: { id: TENANT_ID, businessName: 'Officina Rossi' },
    location: { city: 'Bologna' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
  };
  const ACCESS_ROW_CREATE = {
    id: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
    action: 'create',
    createdAt: new Date('2026-06-03T09:00:00.000Z'),
    tenant: { id: TENANT_ID, businessName: 'Officina Rossi' },
    location: { city: 'Bologna' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
  };

  function accessPrisma(rows: unknown[], relations: Array<{ tenantId: string }> = []) {
    return buildFakePrisma({
      vehicleOwnership: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW) },
      accessLog: { findMany: vi.fn().mockResolvedValue(rows) },
      customerTenantRelation: { findMany: vi.fn().mockResolvedValue(relations) },
    });
  }

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 me.vehicle.not_found when the customer does not own the vehicle', async () => {
    const prisma = buildFakePrisma({
      vehicleOwnership: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.not_found',
      status: 404,
    });
  });

  it('runs the reads in admin context', async () => {
    const withContext = vi.fn(async (_ctx, fn) => fn(accessPrisma([ACCESS_ROW_VIEW])));
    app = await buildApp({ withContext });
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
  });

  it('filters access_logs to view + create, newest first', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW]);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(prisma.accessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          action: { in: ['view', 'create'] },
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });

  it('maps actions and emits the redacted BR-155 shape with mechanicName when related', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW, ACCESS_ROW_CREATE], [{ tenantId: TENANT_ID }]);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      action: 'view',
      tenantName: 'Officina Rossi',
      locationCity: 'Bologna',
      occurredAt: '2026-06-04T10:00:00.000Z',
      mechanicName: 'Mario Bianchi',
    });
    expect(body.data[1]!.action).toBe('new_intervention');
    expect(body.data[0]).not.toHaveProperty('ipAddress');
    expect(body.data[0]).not.toHaveProperty('userId');
    expect(body.data[0]).not.toHaveProperty('tenantId');
  });

  it('omits mechanicName when the customer has no relation with the tenant', async () => {
    const prisma = accessPrisma([ACCESS_ROW_VIEW], []); // empty relation set
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('mechanicName');
  });

  it('paginates with limit + cursor and emits a cursor when has_more is true', async () => {
    const rows = [
      { ...ACCESS_ROW_VIEW, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: new Date('2026-06-04T10:00:00.000Z') },
      { ...ACCESS_ROW_VIEW, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: new Date('2026-06-03T10:00:00.000Z') },
      { ...ACCESS_ROW_VIEW, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdAt: new Date('2026-06-02T10:00:00.000Z') },
    ];
    const prisma = accessPrisma(rows);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log?limit=2`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const body = res.json() as { data: unknown[]; meta: { has_more: boolean; cursor?: string } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.cursor).toBeDefined();

    // Round-trip: the decoded cursor drives the "older than" where predicate.
    await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${VEHICLE_ID}/access-log?limit=2&cursor=${body.meta.cursor!}`,
      headers: { authorization: 'Bearer valid.jwt' },
    });
    const lastWhere = (prisma.accessLog.findMany.mock.calls.at(-1)?.[0] as { where: { OR?: unknown[] } }).where;
    expect(lastWhere.OR).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- me-vehicles.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t3.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t3.txt
```

Expected: FAIL — the `/access-log` route returns 404 (route not registered) so most new tests fail.

- [ ] **Step 4: Implement the handler**

In `packages/api/src/routes/v1/me-vehicles.ts`, update the imports at the top:

```ts
import {
  decodeCursor,
  encodeCursor,
  encodeCompoundCursor,
  decodeDateCompoundCursor,
} from '../../lib/cursor.js';
import { businessError } from '../../lib/business-error.js';
import { serializeCustomerAccessLog } from '../../lib/customer-access-log.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';
```

Add the handler inside `meVehicleRoutes`, after the `GET /v1/me/vehicles/:id` handler (before the closing `};`):

```ts
  // GET /v1/me/vehicles/:id/access-log — F-CLI-304 / BR-155.
  // The owning customer's audit trail of accesses to their vehicle.
  //
  // access_logs carries only the generic tenant_isolation RLS policy
  // (is_admin_role() OR tenant_id = current_tenant_id()), which a
  // customer (no tenant_id, not admin) cannot satisfy — so the reads run
  // in admin context and the app-layer ownership gate below is the
  // security boundary (the #154 lesson: never rely on RLS alone for a
  // customer endpoint). All reads are explicitly scoped by the
  // authenticated customerId / the gated vehicleId; no unscoped query
  // runs under the elevated role.
  //
  // Only 'view' and intervention 'create' surface; vehicle registrations
  // log the dedicated 'vehicle_registered' action and are excluded.
  // BR-155 redaction (no ip/userAgent/internal ids) is enforced by the
  // serializer. Mirrors the /me/profile precedent (admin context, scoped
  // by id) from F-CLI-004.
  app.get(
    '/v1/me/vehicles/:id/access-log',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const { limit, cursor } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      return app.withContext({ role: 'admin' }, async (tx) => {
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        const cur = decodeDateCompoundCursor('at', cursor, 'timestamp');
        const rows = await tx.accessLog.findMany({
          where: {
            vehicleId,
            action: { in: ['view', 'create'] },
            ...(cur
              ? {
                  OR: [
                    { createdAt: { lt: new Date(cur.at) } },
                    { createdAt: new Date(cur.at), id: { lt: cur.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: {
            id: true,
            action: true,
            createdAt: true,
            tenant: { select: { id: true, businessName: true } },
            location: { select: { city: true } },
            user: { select: { firstName: true, lastName: true } },
          },
        });

        const relations = await tx.customerTenantRelation.findMany({
          where: { customerId },
          select: { tenantId: true },
        });
        const relationTenantIds = new Set(relations.map((r) => r.tenantId));

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const data = serializeCustomerAccessLog(page, relationTenantIds);
        const last = page.at(-1);
        return {
          data,
          meta: {
            has_more: hasMore,
            ...(hasMore && last
              ? { cursor: encodeCompoundCursor('at', last.createdAt.toISOString(), last.id) }
              : {}),
          },
        };
      });
    },
  );
```

Note: `decodeCursor`/`encodeCursor` remain imported (used by the existing list endpoint).

- [ ] **Step 5: Run the tests to verify they pass + typecheck**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- me-vehicles.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\t3.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\t3.txt
pnpm -r typecheck
```

Expected: me-vehicles unit suite PASS; typecheck clean.

- [ ] **Step 6: Commit**

```powershell
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -m "feat(api): add GET /me/vehicles/:id/access-log (F-CLI-304)"
```

---

## Task 4: Integration test (real Postgres)

**Files:**
- Modify: `packages/api/tests/integration/me-vehicles.test.ts`

- [ ] **Step 1: Add the access-log integration describe block**

Ensure the helper imports include `createUser` and `createCustomerTenantRelation` (add to the existing `import { ... } from './helpers.js'`). Append this describe block to `packages/api/tests/integration/me-vehicles.test.ts`:

```ts
describe('GET /v1/me/vehicles/:id/access-log (integration)', () => {
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

  async function seedAccess(params: {
    vehicleId: string;
    tenantId: string;
    locationId: string;
    userId: string;
    action: string;
    createdAt: string; // ISO
  }) {
    await pgAdmin.query(
      `INSERT INTO access_logs (vehicle_id, tenant_id, location_id, user_id, action, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5::"AccessLogAction", $6::inet, $7, $8)`,
      [
        params.vehicleId,
        params.tenantId,
        params.locationId,
        params.userId,
        params.action,
        '203.0.113.7',
        'seed-agent/1.0',
        params.createdAt,
      ],
    );
  }

  it('returns only view + intervention create, redacted, newest first, with relation-gated mechanic name', async () => {
    const cognitoSub = 'me-acc-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });

    // Tenant A: customer HAS a relation -> mechanic name visible.
    const { tenantId: tenantA, locationId: locA } = await createTenantWithLocation('me-acc-a');
    const { userId: mechA } = await createUser({
      tenantId: tenantA,
      locationId: locA,
      cognitoSub: cognitoSub + '-mA',
      email: `mA-${cognitoSub}@example.com`,
      firstName: 'Anna',
      lastName: 'Verdi',
      role: 'mechanic',
    });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId });

    // Tenant B: NO relation -> mechanic name hidden.
    const { tenantId: tenantB, locationId: locB } = await createTenantWithLocation('me-acc-b');
    const { userId: mechB } = await createUser({
      tenantId: tenantB,
      locationId: locB,
      cognitoSub: cognitoSub + '-mB',
      email: `mB-${cognitoSub}@example.com`,
      firstName: 'Bruno',
      lastName: 'Neri',
      role: 'mechanic',
    });

    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantA,
      vin: 'ZFA1ACCESS0000001',
      plate: 'ME900AC',
      make: 'Fiat',
      model: 'Panda',
    });
    await createOwnership({ vehicleId, customerId });

    // T0 < T1 < T2 < T3 < T4 (oldest..newest)
    await seedAccess({ vehicleId, tenantId: tenantA, locationId: locA, userId: mechA, action: 'vehicle_registered', createdAt: '2026-06-01T08:00:00.000Z' }); // excluded
    await seedAccess({ vehicleId, tenantId: tenantA, locationId: locA, userId: mechA, action: 'view', createdAt: '2026-06-02T08:00:00.000Z' });
    await seedAccess({ vehicleId, tenantId: tenantA, locationId: locA, userId: mechA, action: 'create', createdAt: '2026-06-03T08:00:00.000Z' });
    await seedAccess({ vehicleId, tenantId: tenantB, locationId: locB, userId: mechB, action: 'search_match', createdAt: '2026-06-04T08:00:00.000Z' }); // excluded
    await seedAccess({ vehicleId, tenantId: tenantB, locationId: locB, userId: mechB, action: 'view', createdAt: '2026-06-05T08:00:00.000Z' });

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        action: string;
        tenantName: string;
        locationCity: string | null;
        occurredAt: string;
        mechanicName?: string;
      }>;
      meta: { has_more: boolean };
    };

    // 3 surfaced rows (vehicle_registered + search_match excluded), newest first.
    expect(body.data.map((e) => e.action)).toEqual(['view', 'new_intervention', 'view']);
    expect(body.data.map((e) => e.occurredAt)).toEqual([
      '2026-06-05T08:00:00.000Z',
      '2026-06-03T08:00:00.000Z',
      '2026-06-02T08:00:00.000Z',
    ]);
    // Newest is tenant B (no relation) -> mechanic name hidden.
    // createTenantWithLocation stores business_name = `Test Tenant <suffix>`
    // and a hardcoded city 'Milano'.
    expect(body.data[0]!.tenantName).toBe('Test Tenant me-acc-b');
    expect(body.data[0]).not.toHaveProperty('mechanicName');
    expect(body.data[0]!.locationCity).toBe('Milano');
    // Tenant A rows (related) -> mechanic name visible.
    expect(body.data[1]!.mechanicName).toBe('Anna Verdi');
    expect(body.data[2]!.mechanicName).toBe('Anna Verdi');
    // Redaction: no internal fields anywhere.
    for (const entry of body.data) {
      expect(entry).not.toHaveProperty('ipAddress');
      expect(entry).not.toHaveProperty('userAgent');
      expect(entry).not.toHaveProperty('userId');
      expect(entry).not.toHaveProperty('tenantId');
    }
  });

  it('paginates newest-first across a page boundary via cursor', async () => {
    const cognitoSub = 'me-acc-pg-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const { tenantId, locationId } = await createTenantWithLocation('me-acc-pg');
    const { userId } = await createUser({
      tenantId,
      locationId,
      cognitoSub: cognitoSub + '-m',
      email: `m-${cognitoSub}@example.com`,
      firstName: 'Carla',
      lastName: 'Gialli',
      role: 'mechanic',
    });
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1ACCESSPG00001',
      plate: 'ME901PG',
    });
    await createOwnership({ vehicleId, customerId });
    for (let i = 1; i <= 3; i++) {
      await seedAccess({
        vehicleId,
        tenantId,
        locationId,
        userId,
        action: 'view',
        createdAt: `2026-06-0${i}T08:00:00.000Z`,
      });
    }

    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log?limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    const b1 = page1.json() as { data: Array<{ occurredAt: string }>; meta: { has_more: boolean; cursor?: string } };
    expect(b1.data.map((e) => e.occurredAt)).toEqual(['2026-06-03T08:00:00.000Z', '2026-06-02T08:00:00.000Z']);
    expect(b1.meta.has_more).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log?limit=2&cursor=${b1.meta.cursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const b2 = page2.json() as { data: Array<{ occurredAt: string }>; meta: { has_more: boolean } };
    expect(b2.data.map((e) => e.occurredAt)).toEqual(['2026-06-01T08:00:00.000Z']);
    expect(b2.meta.has_more).toBe(false);
  });

  it('returns 404 for a vehicle the customer does not own (cross-customer)', async () => {
    const ownerSub = 'me-acc-own-' + Math.random().toString(36).slice(2, 10);
    const otherSub = 'me-acc-oth-' + Math.random().toString(36).slice(2, 10);
    const { customerId: ownerId } = await createCustomer({ cognitoSub: ownerSub });
    const { customerId: otherId } = await createCustomer({ cognitoSub: otherSub });
    const { tenantId } = await createTenantWithLocation('me-acc-x');
    const { vehicleId } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1ACCESSXC00001',
      plate: 'ME902XC',
    });
    await createOwnership({ vehicleId, customerId: ownerId });

    const otherToken = await signTestToken({ pool: 'clienti', sub: otherSub, customerId: otherId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/access-log`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

> Note: `createTenantWithLocation(suffix)` returns `{ tenantId, locationId }`, stores `business_name = "Test Tenant <suffix>"`, and a hardcoded location `city = 'Milano'` — the assertions reflect that. `createUser` returns `{ userId }`; `createCustomerTenantRelation` returns `{ relationId }`; `createCustomer` returns `{ customerId }`.

- [ ] **Step 2: Verify it compiles (typecheck only — do NOT run integration locally)**

Run:

```powershell
pnpm -r typecheck
```

Expected: clean. Integration tests run on CI (Docker/Testcontainers); per the project gate they are not run locally on Windows. CI will execute this suite.

- [ ] **Step 3: Commit**

```powershell
git add packages/api/tests/integration/me-vehicles.test.ts
git commit -m "test(api): integration coverage for /me/vehicles/:id/access-log (F-CLI-304)"
```

---

## Task 5: Documentation

**Files:**
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/APPENDICE_B_DATABASE.md`
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md`

- [ ] **Step 1: Document the endpoint in APPENDICE_A**

Add, in the `/v1/me/*` section near the other `/me/vehicles` entries, a subsection:

```markdown
### GET /v1/me/vehicles/:id/access-log

Returns the BR-155 audit trail of accesses to a vehicle the authenticated customer owns
(F-CLI-304). Clienti pool only.

Query: `limit` (1-50, default 20), `cursor` (opaque compound `(createdAt, id)` cursor).

Response `200`:

​```jsonc
{
  "data": [
    {
      "action": "view",            // "view" | "new_intervention"
      "tenantName": "Officina Rossi",
      "locationCity": "Bologna",   // string | null
      "occurredAt": "2026-06-04T14:32:10.123Z",
      "mechanicName": "Mario Bianchi"  // present only if a customer_tenant_relation exists (BR-151)
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaque>" }
}
​```

Redaction (BR-155): the response never includes IP address, user agent, or internal ids. Only
`view` and intervention `create` (surfaced as `new_intervention`) appear; vehicle registrations
(`vehicle_registered`) and other actions are excluded. `404 me.vehicle.not_found` if the customer
does not currently own the vehicle.
```

- [ ] **Step 2: Note the enum value in APPENDICE_B**

In the `access_logs` / `AccessLogAction` section, add a row/line documenting `vehicle_registered`: "vehicle registration audit event (F-CLI-304), kept distinct from intervention `create` so the customer audit (BR-155) can label intervention creates without conflating them with the one-time registration row."

- [ ] **Step 3: Annotate BR-154 / BR-155 in APPENDICE_F**

Under BR-154, note: "vehicle registration is logged as `vehicle_registered` (not `create`) since F-CLI-304." Under BR-155, note: "the customer audit endpoint (`GET /v1/me/vehicles/:id/access-log`) surfaces `view` and intervention `create` only; mechanic name appears only when a `customer_tenant_relation` exists (BR-151)."

- [ ] **Step 4: Commit**

```powershell
git add docs/APPENDICE_A_API.md docs/APPENDICE_B_DATABASE.md docs/APPENDICE_F_BUSINESS_LOGIC.md
git commit -m "docs: document /me/vehicles/:id/access-log + vehicle_registered (F-CLI-304)"
```

---

## Task 6: Final verification + push

- [ ] **Step 1: Full typecheck**

Run:

```powershell
pnpm -r typecheck
```

Expected: clean across all packages.

- [ ] **Step 2: Run the touched API unit suites once more**

Run:

```powershell
pnpm --filter @garageos/api test:unit -- customer-access-log.test.ts me-vehicles.test.ts vehicles.test.ts 2>&1 | Tee-Object -FilePath $env:TEMP\tfinal.txt; "__EXIT $LASTEXITCODE__" | Out-File -Append $env:TEMP\tfinal.txt
```

Expected: all PASS.

- [ ] **Step 3: Push and open the PR**

```powershell
git push -u origin feat/me-vehicle-access-log
```

Then open a PR titled `feat(api): customer access-log endpoint GET /me/vehicles/:id/access-log (F-CLI-304)` with the standard description (What / Why F-CLI-304 + BR-154/BR-155 / Implementation notes / Tests checklist).

- [ ] **Step 4: Watch CI**

Run:

```powershell
gh pr checks --watch
```

Expected: all green. Fix-forward on any failure (most likely the integration suite, which only runs here).

---

## Self-Review

**Spec coverage:**
- BR-155 redacted shape + mechanic-name relation gate → Task 2 (serializer) + Task 3/4 (tests).
- Admin-context + 404 ownership gate (security) → Task 3 handler + unit 404/admin tests + integration cross-customer 404.
- `vehicle_registered` enum split + write-site + regression tests → Task 1.
- view + create filter, `create → new_intervention` → Task 3 (where filter) + Task 2 (mapping) + Task 4 (excludes vehicle_registered/search_match).
- Compound cursor pagination → Task 3 unit pagination test + Task 4 integration pagination test.
- Docs A/B/F → Task 5.

**Placeholder scan:** none — every code/test step shows full content.

**Type consistency:** `serializeCustomerAccessLog(rows, Set<string>)` and `CustomerAccessLogEntry`/`RawCustomerAccessLogRow` are used identically in lib, route, and tests. The handler `select` (id, action, createdAt, tenant{id,businessName}, location{city}, user{firstName,lastName}) matches `RawCustomerAccessLogRow`. Cursor field key `'at'` is used consistently in encode/decode. Reused error code `me.vehicle.not_found` matches the sibling handler.

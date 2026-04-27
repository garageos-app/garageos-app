# PATCH /v1/vehicles/:id Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `PATCH /v1/vehicles/:id` (F-OFF-106) so a Tenant User can edit identifying + technical fields of a vehicle they created or certified, with full BR-001/002/005/007/008/151 enforcement.

**Architecture:** New thin handler in `routes/v1/vehicles-update.ts` mirroring `vehicles-timeline.ts`. Shared selects + `idParamSchema` factored to `lib/vehicle-shared.ts`. `businessError` factory factored to `lib/business-error.ts` for cross-cutting reuse. Body validated by new `UpdateVehicleSchema` (strict, all fields optional, refine non-empty) in `@garageos/database`. RLS `vehicles_update` policy already enforces tenant ownership → forbidden falls out as 404 via Prisma P2025.

**Tech Stack:** Fastify 5, TypeScript strict, Prisma 7 with `withContext` RLS, Zod 4, Vitest, Testcontainers Postgres.

**Spec:** `docs/superpowers/specs/2026-04-27-patch-vehicle-design.md`

---

## File Structure

**NEW**
- `packages/api/src/lib/business-error.ts` — utility factory for `FastifyError` with code/status/detail. Cross-cutting, replaces inline copies in `vehicles.ts` (and reusable by future endpoints).
- `packages/api/src/lib/vehicle-shared.ts` — `idParamSchema`, `vehicleDetailSelect`, `vehicleOwnershipSelect`. Single source of truth shared by `vehicles.ts`, `vehicles-timeline.ts`, `vehicles-update.ts`.
- `packages/api/src/routes/v1/vehicles-update.ts` — Fastify plugin exporting `vehicleUpdateRoutes` (PATCH `/v1/vehicles/:id`).
- `packages/api/tests/integration/vehicles-patch.test.ts` — integration suite.

**MODIFIED**
- `packages/api/src/routes/v1/vehicles.ts` — drops local `idParamSchema`, `vehicleDetailSelect`, `vehicleOwnershipSelect`, `businessError`; imports from new lib files; adds `excludeId?: string` parameter to `checkDuplicatePlateWarning`; exports `checkDuplicateVin` + `checkDuplicatePlateWarning` for reuse.
- `packages/api/src/routes/v1/vehicles-timeline.ts` — drops local `idParamSchema`, imports from `lib/vehicle-shared.js`.
- `packages/api/src/server.ts` — registers `vehicleUpdateRoutes` after `vehicleRoutes`.
- `packages/api/tests/unit/routes/v1/vehicles.test.ts` — appends `describe('PATCH /v1/vehicles/:id')` block with body-validation unit tests.
- `packages/database/src/validators/vehicle.ts` — adds `UpdateVehicleSchema` + type, exported via existing `validators/index.ts` re-export.

**No migrations. No new error codes (reuses `vehicle.creation.*` and `vehicle.modification.*` already in APPENDICE_G).**

---

## Task 1: Extract `businessError` to `lib/business-error.ts`

Pure refactor, no behavior change. Existing tests must stay green.

**Files:**
- Create: `packages/api/src/lib/business-error.ts`
- Modify: `packages/api/src/routes/v1/vehicles.ts:42-49` (remove inline factory) and all call sites in the same file (~6 calls)

- [ ] **Step 1: Create the new file**

```typescript
// packages/api/src/lib/business-error.ts
import type { FastifyError } from 'fastify';

// Problem+JSON factory with a specific machine code. Used for business-
// rule failures the shared error handler cannot infer from the exception
// shape (it maps P2025 → 404 and ZodError → 400; domain codes need an
// explicit path).
export function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}
```

- [ ] **Step 2: Remove inline factory + add import in `vehicles.ts`**

In `packages/api/src/routes/v1/vehicles.ts`, delete lines 42-49 (the inline `businessError` function and its leading comment). Add at the top of the imports section (after the existing `'../../middleware/...'` imports):

```typescript
import { businessError } from '../../lib/business-error.js';
```

All existing `businessError(...)` call sites stay unchanged — they now resolve to the imported function.

- [ ] **Step 3: Run unit + integration tests for vehicles**

```bash
pnpm --filter @garageos/api test:unit -- vehicles
pnpm --filter @garageos/api test:integration -- vehicles
```

Expected: all existing tests pass. Zero behavior change.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/lib/business-error.ts packages/api/src/routes/v1/vehicles.ts
git commit -m "refactor(api): extract businessError factory to lib"
```

---

## Task 2: Extract shared schemas + selects to `lib/vehicle-shared.ts`

DRY: `idParamSchema` is duplicated between `vehicles.ts` and `vehicles-timeline.ts`. `vehicleDetailSelect` + `vehicleOwnershipSelect` will be reused by `vehicles-update.ts`.

**Files:**
- Create: `packages/api/src/lib/vehicle-shared.ts`
- Modify: `packages/api/src/routes/v1/vehicles.ts:27-29` (drop `idParamSchema`), `:200-260` (drop `vehicleOwnershipSelect`, `vehicleDetailSelect`)
- Modify: `packages/api/src/routes/v1/vehicles-timeline.ts:16` (drop local `idParamSchema`)

- [ ] **Step 1: Create the new file**

```typescript
// packages/api/src/lib/vehicle-shared.ts
import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.uuid(),
});

// Current ownership is the single VehicleOwnership row with
// ended_at IS NULL, enforced by partial unique index
// uq_ownership_vehicle_active (BR-040 — migration
// 20260424100000:190-192). take:1 is defensive in case future rows
// leak through during a transfer window.
export const vehicleOwnershipSelect = {
  where: { endedAt: null },
  select: {
    id: true,
    customerId: true,
    startedAt: true,
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
  take: 1,
} as const;

// Detail shape: all public tech fields + certifiedAt/createdAt. Kept
// in sync by comment only with BR-153 "VISIBILE" — missing fields
// like version/color/displacement are added here explicitly.
export const vehicleDetailSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  version: true,
  year: true,
  registrationDate: true,
  vehicleType: true,
  fuelType: true,
  engineDisplacement: true,
  powerKw: true,
  color: true,
  status: true,
  certifiedAt: true,
  createdAt: true,
  ownerships: vehicleOwnershipSelect,
} as const;
```

- [ ] **Step 2: Update `vehicles.ts` — drop local definitions + import**

In `packages/api/src/routes/v1/vehicles.ts`:
1. Delete lines 27-29 (local `idParamSchema`).
2. Delete lines 200-260 (the `vehicleOwnershipSelect` + `vehicleDetailSelect` blocks; `vehicleSearchSelect` stays — it's only used here).
3. Add import after the existing lib imports:

```typescript
import {
  idParamSchema,
  vehicleDetailSelect,
  vehicleOwnershipSelect,
} from '../../lib/vehicle-shared.js';
```

4. Update `vehicleSearchSelect` to reference the imported `vehicleOwnershipSelect`:

```typescript
const vehicleSearchSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  year: true,
  vehicleType: true,
  fuelType: true,
  status: true,
  ownerships: vehicleOwnershipSelect,
} as const;
```

- [ ] **Step 3: Update `vehicles-timeline.ts` — drop local schema + import**

In `packages/api/src/routes/v1/vehicles-timeline.ts`:
1. Delete line 16 (`const idParamSchema = z.object({ id: z.uuid() });`).
2. Add to existing imports:

```typescript
import { idParamSchema } from '../../lib/vehicle-shared.js';
```

- [ ] **Step 4: Type-check + run tests**

```bash
pnpm --filter @garageos/api typecheck
pnpm --filter @garageos/api test:unit -- vehicles
pnpm --filter @garageos/api test:integration -- vehicles
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/vehicle-shared.ts packages/api/src/routes/v1/vehicles.ts packages/api/src/routes/v1/vehicles-timeline.ts
git commit -m "refactor(api): extract vehicle shared schemas + selects to lib"
```

---

## Task 3: Extend `checkDuplicatePlateWarning` with `excludeId` + export helpers

Adds optional `excludeId: string` so PATCH callers can ignore the row being modified. Backward-compatible — POST keeps calling without the parameter.

**Files:**
- Modify: `packages/api/src/routes/v1/vehicles.ts:73-91` (function signature + body) + add `export` to `checkDuplicateVin` and `checkDuplicatePlateWarning`

- [ ] **Step 1: Update `checkDuplicatePlateWarning` and add `export`**

Replace the existing function body (around lines 73-91 of `vehicles.ts`) with:

```typescript
// BR-002: plate uniqueness is per-country (an Italian "AB123CD" must
// not collide with a Spanish "AB123CD"). The check is a *warning* —
// the workshop can confirm with force=true if they know the plate has
// been transferred or the previous record is stale. excludeId skips a
// specific vehicle row (used by PATCH so the unchanged-plate case
// does not collide with itself).
export async function checkDuplicatePlateWarning(
  tx: import('@garageos/database').PrismaClient,
  plate: string,
  plateCountry: string,
  force: boolean,
  excludeId?: string,
): Promise<void> {
  if (force) return;
  const existing = await tx.vehicle.findFirst({
    where: {
      plate,
      plateCountry,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw businessError(
      'vehicle.creation.duplicate_plate_warning',
      409,
      `Esiste già un veicolo con targa ${plate}. Passa force=true per confermare.`,
    );
  }
}
```

- [ ] **Step 2: Add `export` to `checkDuplicateVin`**

In `vehicles.ts` around line 55, change `async function checkDuplicateVin` to `export async function checkDuplicateVin`. Body unchanged.

- [ ] **Step 3: Run integration tests for vehicles POST (regression check)**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-post
```

Expected: all existing POST tests pass (the new `excludeId` parameter defaults to undefined → identical behavior).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/vehicles.ts
git commit -m "refactor(api): excludeId on checkDuplicatePlateWarning + export helpers"
```

---

## Task 4: Add `UpdateVehicleSchema` in `@garageos/database`

Strict (`.strict()`) Zod object with all editable fields optional plus the override flags, plus a `.refine` rejecting empty bodies.

**Files:**
- Modify: `packages/database/src/validators/vehicle.ts` (append schema after `ClaimVehicleSchema`)
- Test: `packages/database/tests/unit/validators/vehicle-update.test.ts` (new file)

- [ ] **Step 1: Write the failing test file**

```typescript
// packages/database/tests/unit/validators/vehicle-update.test.ts
import { describe, expect, it } from 'vitest';

import { UpdateVehicleSchema } from '../../../src/validators/vehicle.js';

describe('UpdateVehicleSchema', () => {
  it('accepts a single editable field', () => {
    const result = UpdateVehicleSchema.safeParse({ color: 'red' });
    expect(result.success).toBe(true);
  });

  it('accepts multiple editable fields', () => {
    const result = UpdateVehicleSchema.safeParse({
      color: 'blue',
      powerKw: 80,
      registrationDate: '2020-01-15',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty body', () => {
    const result = UpdateVehicleSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/almeno un campo|at least one/i);
    }
  });

  it('rejects unknown fields (strict)', () => {
    const result = UpdateVehicleSchema.safeParse({ status: 'archived' });
    expect(result.success).toBe(false);
  });

  it('rejects vin with wrong length', () => {
    const result = UpdateVehicleSchema.safeParse({ vin: 'ABC' });
    expect(result.success).toBe(false);
  });

  it('rejects year out of range (BR-007)', () => {
    const tooOld = UpdateVehicleSchema.safeParse({ year: 1800 });
    expect(tooOld.success).toBe(false);
    const currentYear = new Date().getUTCFullYear();
    const tooFuture = UpdateVehicleSchema.safeParse({ year: currentYear + 5 });
    expect(tooFuture.success).toBe(false);
  });

  it('rejects plateCountry with wrong length', () => {
    const result = UpdateVehicleSchema.safeParse({ plateCountry: 'ITA' });
    expect(result.success).toBe(false);
  });

  it('accepts override flags', () => {
    const result = UpdateVehicleSchema.safeParse({
      color: 'red',
      forceNonstandardVin: true,
      force: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects body with only override flags (no editable field)', () => {
    const result = UpdateVehicleSchema.safeParse({
      forceNonstandardVin: true,
      force: true,
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm --filter @garageos/database test:unit -- vehicle-update
```

Expected: FAIL with `UpdateVehicleSchema is not exported`.

- [ ] **Step 3: Add `UpdateVehicleSchema` to the validator**

Append to `packages/database/src/validators/vehicle.ts` (after `ClaimVehicleSchema`):

```typescript
// PATCH /v1/vehicles/:id (F-OFF-106). All editable fields optional;
// override flags piggyback for VIN-checksum and duplicate-plate
// confirmation. .strict() rejects unknown keys (status, garageCode,
// certifiedAt, createdByTenantId, ...) so callers get a 400 instead
// of a silent strip. .refine ensures at least one editable field is
// present, otherwise the call is a no-op.
const EDITABLE_FIELDS = [
  'vin',
  'plate',
  'plateCountry',
  'make',
  'model',
  'version',
  'year',
  'registrationDate',
  'vehicleType',
  'fuelType',
  'engineDisplacement',
  'powerKw',
  'color',
] as const;

export const UpdateVehicleSchema = z
  .object({
    vin: VinSchema.optional(),
    plate: ItalianPlateSchema.optional(),
    plateCountry: z.string().length(2).optional(),
    make: z.string().min(1).max(50).optional(),
    model: z.string().min(1).max(100).optional(),
    version: z.string().max(150).nullable().optional(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(CURRENT_YEAR + 1)
      .optional(),
    registrationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    vehicleType: VehicleTypeEnum.optional(),
    fuelType: FuelTypeEnum.optional(),
    engineDisplacement: z.number().int().positive().nullable().optional(),
    powerKw: z.number().int().positive().nullable().optional(),
    color: z.string().max(50).nullable().optional(),
    forceNonstandardVin: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .strict()
  .refine(
    (data) => EDITABLE_FIELDS.some((k) => (data as Record<string, unknown>)[k] !== undefined),
    { message: 'Specifica almeno un campo da modificare' },
  );

export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;
```

- [ ] **Step 4: Run the test — expect pass**

```bash
pnpm --filter @garageos/database test:unit -- vehicle-update
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/validators/vehicle.ts packages/database/tests/unit/validators/vehicle-update.test.ts
git commit -m "feat(database): add UpdateVehicleSchema for PATCH /vehicles"
```

---

## Task 5: Skeleton handler — happy path (single-field PATCH)

Minimum viable handler: parse body + load vehicle + UPDATE + return refreshed row. NO BR-005/008 yet, NO PII filter yet, NO access_log yet (those are added in subsequent tasks via TDD).

**Files:**
- Create: `packages/api/src/routes/v1/vehicles-update.ts`
- Modify: `packages/api/src/server.ts` (register the new plugin)
- Test: `packages/api/tests/integration/vehicles-patch.test.ts` (new file)

- [ ] **Step 1: Write the failing integration test (happy path)**

```typescript
// packages/api/tests/integration/vehicles-patch.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signTestToken } from './auth-helpers.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { buildTestServer, closeTestServer, type TestServer } from './server-helper.js';
import { pgAdmin } from './setup.js';

describe('PATCH /v1/vehicles/:id', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  beforeEach(async () => {
    await resetDb();
  });

  describe('happy path', () => {
    it('updates a single tech field and returns the refreshed vehicle', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'blu metallizzato' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { vehicle: { color: string } };
      expect(body.vehicle.color).toBe('blu metallizzato');

      const { rows } = await pgAdmin.query<{ color: string }>(
        `SELECT color FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(rows[0]!.color).toBe('blu metallizzato');
    });
  });
});
```

> **Note:** check whether `signTestToken`, `buildTestServer`, `closeTestServer`, `TestServer` exist in the integration helpers. If the names differ (very likely — this codebase has its own conventions), open `packages/api/tests/integration/vehicles-id.test.ts` and copy the same imports + setup boilerplate exactly. Adapt this test to whatever shape that file uses.

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: FAIL — either "route not found" (404) or test setup error if helper names differ.

- [ ] **Step 3: Create the skeleton handler**

```typescript
// packages/api/src/routes/v1/vehicles-update.ts
import { UpdateVehicleSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { idParamSchema, vehicleDetailSelect } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const vehicleUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/vehicles/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = UpdateVehicleSchema.parse(request.body);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        // Build update payload: only the fields the caller sent (defined fields).
        // Override flags (`force`, `forceNonstandardVin`) are NOT persisted.
        const data: Record<string, unknown> = {};
        for (const k of [
          'vin',
          'plate',
          'plateCountry',
          'make',
          'model',
          'version',
          'year',
          'registrationDate',
          'vehicleType',
          'fuelType',
          'engineDisplacement',
          'powerKw',
          'color',
        ] as const) {
          if ((body as Record<string, unknown>)[k] !== undefined) {
            const value = (body as Record<string, unknown>)[k];
            data[k] = k === 'registrationDate' && typeof value === 'string'
              ? new Date(value)
              : value;
          }
        }

        await tx.vehicle.update({ where: { id }, data });

        const vehicle = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: vehicleDetailSelect,
        });

        const { ownerships: _drop, ...vehicleFields } = vehicle;
        void _drop;
        return { vehicle: vehicleFields, currentOwnership: null };
      });
    },
  );
};

export default vehicleUpdateRoutes;
```

- [ ] **Step 4: Register in `server.ts`**

In `packages/api/src/server.ts`:
1. Add to imports (alphabetical with siblings, after `vehicleRoutes` import):

```typescript
import vehicleUpdateRoutes from './routes/v1/vehicles-update.js';
```

2. Register after `vehicleRoutes` and before `vehicleTimelineRoutes`:

```typescript
  await app.register(vehicleRoutes);
  await app.register(vehicleUpdateRoutes);
  await app.register(vehicleTimelineRoutes);
```

- [ ] **Step 5: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/src/server.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): PATCH /v1/vehicles/:id skeleton (happy path single field)"
```

---

## Task 6: Multi-field update + atomic apply

Verify the partial-update logic correctly applies several fields in one request and leaves untouched fields alone.

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)

- [ ] **Step 1: Add the test**

Inside `describe('happy path', ...)` add:

```typescript
    it('updates multiple fields atomically and leaves others untouched', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-multi`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        make: 'Fiat',
        model: 'Panda',
        year: 2020,
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          color: 'rosso',
          powerKw: 70,
          registrationDate: '2020-06-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const { rows } = await pgAdmin.query<{
        color: string;
        power_kw: number;
        make: string;
        model: string;
        year: number;
        registration_date: Date;
      }>(
        `SELECT color, power_kw, make, model, year, registration_date
         FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(rows[0]!.color).toBe('rosso');
      expect(rows[0]!.power_kw).toBe(70);
      expect(rows[0]!.make).toBe('Fiat');
      expect(rows[0]!.model).toBe('Panda');
      expect(rows[0]!.year).toBe(2020);
      expect(rows[0]!.registration_date.toISOString().slice(0, 10)).toBe('2020-06-01');
    });
```

- [ ] **Step 2: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 2 tests pass (the new one + happy path from Task 5).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "test(api): PATCH multi-field atomic update on vehicles"
```

---

## Task 7: BR-008 — archived vehicle returns 422

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (add status check)

- [ ] **Step 1: Write the failing test**

Append a new `describe` to `vehicles-patch.test.ts`:

```typescript
  describe('BR-008 archived', () => {
    it('returns 422 vehicle.modification.archived when status=archived', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-arc`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'archived',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'rosso' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { code?: string; type?: string };
      // Error handler maps name → code or type depending on convention.
      // Inspect packages/api/src/plugins/error-handler.ts for the exact field.
      expect(JSON.stringify(body)).toContain('vehicle.modification.archived');
    });
  });
```

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: FAIL — currently the handler ignores status and returns 200.

- [ ] **Step 3: Add the BR-008 check + load existing vehicle status**

Edit `vehicles-update.ts`. Add `businessError` import and modify the handler so it loads `status` (and other future-needed fields) BEFORE building the update payload:

```typescript
import { businessError } from '../../lib/business-error.js';
```

Inside `app.withContext` (replace the body of the handler block):

```typescript
        const existing = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: { vin: true, plate: true, plateCountry: true, status: true },
        });

        if (existing.status === 'archived') {
          throw businessError(
            'vehicle.modification.archived',
            422,
            'Veicolo archiviato: non modificabile.',
          );
        }

        // ...rest of payload-build + update + reload (unchanged from Task 5)
```

- [ ] **Step 4: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): BR-008 reject PATCH on archived vehicles"
```

---

## Task 8: BR-005 — VIN immutable on certified, allowed on pending

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add tests)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (add BR-005 check)

- [ ] **Step 1: Write the failing tests**

Append to `vehicles-patch.test.ts`:

```typescript
  describe('BR-005 vin immutable on certified', () => {
    it('returns 422 vehicle.modification.vin_immutable when patching vin on certified', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-vin1`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'certified',
        vin: 'ZFA1230000000ABCD',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA9990000000WXYZ', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain('vehicle.modification.vin_immutable');
    });

    it('allows VIN change on pending vehicles', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-vin2`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
        vin: 'ZFA1230000000ABCD',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA9990000000WXYZ', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { vehicle: { vin: string } };
      expect(body.vehicle.vin).toBe('ZFA9990000000WXYZ');
    });

    it('returns 200 when vin in body equals current vin (no-op)', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-vin3`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId, vin } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'certified',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin, forceNonstandardVin: true, color: 'verde' },
      });

      expect(res.statusCode).toBe(200);
    });
  });
```

- [ ] **Step 2: Run the tests — expect failures**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 2 of the 3 new tests FAIL (the no-op test passes by coincidence).

- [ ] **Step 3: Add the BR-005 check**

In `vehicles-update.ts`, AFTER the BR-008 check and BEFORE the update-payload build:

```typescript
        if (
          body.vin !== undefined &&
          body.vin !== existing.vin &&
          existing.status === 'certified'
        ) {
          throw businessError(
            'vehicle.modification.vin_immutable',
            422,
            'VIN non modificabile su veicolo certificato.',
          );
        }
```

- [ ] **Step 4: Run the tests — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): BR-005 enforce VIN immutability on certified vehicles"
```

---

## Task 9: VIN change — ISO 3779 checksum + duplicate check

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add tests)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (call helpers)

- [ ] **Step 1: Write the failing tests**

Append to `vehicles-patch.test.ts`:

```typescript
  describe('VIN change validation', () => {
    it('returns 400 invalid_vin_checksum when new VIN fails ISO 3779 and forceNonstandardVin=false', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-cks`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'AAAAAAAAAAAAAAAAA' }, // fails ISO 3779
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('vehicle.creation.invalid_vin_checksum');
    });

    it('accepts non-3779 VIN when forceNonstandardVin=true', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-cks2`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'AAAAAAAAAAAAAAAAA', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 409 duplicate_vin when new VIN exists on another vehicle', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-dup`;
      await createUser({ tenantId, cognitoSub, locationId });
      // First vehicle holds the contested VIN.
      await createVehicle({
        createdByTenantId: tenantId,
        vin: 'ZFA1110000000ABCD',
      });
      // Target vehicle (pending so VIN edit is allowed).
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA1110000000ABCD', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.json())).toContain('vehicle.creation.duplicate_vin');
    });
  });
```

- [ ] **Step 2: Run the tests — expect failures**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 3 new tests FAIL — current handler does no checksum or duplicate check.

- [ ] **Step 3: Wire the helpers in `vehicles-update.ts`**

Add imports:

```typescript
import { checkDuplicateVin } from './vehicles.js';
import { validateVinIso3779 } from '../../lib/vin-checksum.js';
```

After the BR-005 block, BEFORE the update-payload build, insert:

```typescript
        if (body.vin !== undefined && body.vin !== existing.vin) {
          if (!body.forceNonstandardVin && !validateVinIso3779(body.vin)) {
            throw businessError(
              'vehicle.creation.invalid_vin_checksum',
              400,
              'Il VIN non rispetta il checksum ISO 3779. Usa forceNonstandardVin=true per veicoli storici o agricoli.',
            );
          }
          await checkDuplicateVin(tx, body.vin);
        }
```

- [ ] **Step 4: Run the tests — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): BR-001 VIN checksum + duplicate check on PATCH"
```

---

## Task 10: Plate change — duplicate warning + force + excludeId no-op

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add tests)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (call helper)

- [ ] **Step 1: Write the failing tests**

Append to `vehicles-patch.test.ts`:

```typescript
  describe('Plate change validation', () => {
    it('returns 409 duplicate_plate_warning when new plate already used and force=false', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-pl1`;
      await createUser({ tenantId, cognitoSub, locationId });
      await createVehicle({ createdByTenantId: tenantId, plate: 'AB123CD' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate: 'AB123CD' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.json())).toContain('vehicle.creation.duplicate_plate_warning');
    });

    it('accepts duplicate plate when force=true', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-pl2`;
      await createUser({ tenantId, cognitoSub, locationId });
      await createVehicle({ createdByTenantId: tenantId, plate: 'AB123CD' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate: 'AB123CD', force: true },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 200 when plate sent is unchanged (excludeId prevents self-collision)', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-pl3`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId, plate } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate, color: 'arancio' },
      });

      expect(res.statusCode).toBe(200);
    });
  });
```

- [ ] **Step 2: Run the tests — expect failures**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 2 of 3 new tests FAIL (the unchanged-plate test passes by coincidence).

- [ ] **Step 3: Wire the plate helper**

In `vehicles-update.ts`, add to imports:

```typescript
import { checkDuplicatePlateWarning } from './vehicles.js';
```

After the VIN block, BEFORE the update-payload build:

```typescript
        const newPlate = body.plate ?? existing.plate;
        const newPlateCountry = body.plateCountry ?? existing.plateCountry;
        const plateChanged = newPlate !== existing.plate || newPlateCountry !== existing.plateCountry;
        if (plateChanged) {
          await checkDuplicatePlateWarning(tx, newPlate, newPlateCountry, body.force, id);
        }
```

- [ ] **Step 4: Run the tests — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): BR-002 plate duplicate warning on PATCH (excludeId)"
```

---

## Task 11: PII filter on `currentOwnership` (BR-151)

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (apply filter)

- [ ] **Step 1: Write the failing test**

```typescript
  describe('BR-151 PII filter', () => {
    it('masks owner PII when tenant has no customer_tenant_relation', async () => {
      // Ownership tenant ≠ patching tenant (cross-tenant scenario).
      // The patching tenant must still own/certify the vehicle so RLS
      // allows the UPDATE; ownership is on a different customer with
      // no relation to it.
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-pii`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { customerId } = await createCustomer({});
      await createOwnership({ vehicleId, customerId });
      // Note: NO customer_tenant_relation insert → BR-151 must mask.

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'nero' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        currentOwnership: { customer: { firstName: string; email: string | null } } | null;
      };
      expect(body.currentOwnership).not.toBeNull();
      // maskCustomer convention: confirm by inspecting lib/pii-filter.ts.
      // Typical pattern: email becomes null and firstName becomes a stub.
      expect(body.currentOwnership!.customer.email).toBeNull();
    });
  });
```

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: FAIL — current handler returns `currentOwnership: null`, not the actual ownership.

- [ ] **Step 3: Wire the PII filter in the response**

In `vehicles-update.ts`:

1. Add imports:

```typescript
import { vehicleOwnershipSelect } from '../../lib/vehicle-shared.js';
import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
```

(The `vehicleOwnershipSelect` import may already be in via the earlier `idParamSchema, vehicleDetailSelect` line — combine into one import if so.)

2. Replace the response section (currently `return { vehicle: vehicleFields, currentOwnership: null };`) with:

```typescript
        const reloaded = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: vehicleDetailSelect,
        });
        const active = reloaded.ownerships[0] ?? null;
        const customerIds = active ? [active.customerId] : [];
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const { ownerships: _drop, ...vehicleFields } = reloaded;
        void _drop;
        return {
          vehicle: vehicleFields,
          currentOwnership: active
            ? {
                id: active.id,
                startedAt: active.startedAt,
                customer: maskCustomer(active.customer, visibleSet.has(active.customerId)),
              }
            : null,
        };
```

(Remove the previous post-update reload since this block now handles both.)

- [ ] **Step 4: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): BR-151 PII filter on PATCH response currentOwnership"
```

---

## Task 12: access_log row with `action='update'`

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)
- Modify: `packages/api/src/routes/v1/vehicles-update.ts` (call recordVehicleAccess)

- [ ] **Step 1: Write the failing test**

```typescript
  describe('access_log', () => {
    it('writes a row with action=update and the right user/tenant/location/ip', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-log`;
      const { userId } = await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'oro' },
      });

      expect(res.statusCode).toBe(200);

      const { rows } = await pgAdmin.query<{
        action: string;
        tenant_id: string;
        user_id: string;
        location_id: string | null;
        ip_address: string | null;
      }>(
        `SELECT action, tenant_id, user_id, location_id, ip_address::text
         FROM access_logs WHERE vehicle_id = $1`,
        [vehicleId],
      );
      const updateLogs = rows.filter((r) => r.action === 'update');
      expect(updateLogs).toHaveLength(1);
      expect(updateLogs[0]!.tenant_id).toBe(tenantId);
      expect(updateLogs[0]!.user_id).toBe(userId);
      expect(updateLogs[0]!.location_id).toBe(locationId);
      expect(updateLogs[0]!.ip_address).not.toBeNull();
    });
  });
```

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: FAIL — handler does not write access_log yet.

- [ ] **Step 3: Wire `recordVehicleAccess` and load `user.id`**

In `vehicles-update.ts`:

1. Add import:

```typescript
import { recordVehicleAccess } from '../../lib/access-log.js';
```

2. Add a `user.findUniqueOrThrow` BEFORE the `existing` load (mirroring the GET handler):

```typescript
        const cognitoSub = request.userId!;
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });
```

3. After the `tx.vehicle.update(...)` call, before the response reload:

```typescript
        await recordVehicleAccess({
          tx,
          vehicleId: id,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'update',
          ipAddress: request.ip,
          log: request.log,
        });
```

- [ ] **Step 4: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-update.ts packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "feat(api): write access_log action=update on PATCH"
```

---

## Task 13: RLS-as-404 for cross-tenant write

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)

No handler change — RLS already enforces.

- [ ] **Step 1: Write the test**

```typescript
  describe('RLS cross-tenant', () => {
    it('returns 404 when the patching tenant is neither created_by nor certified_by', async () => {
      // Vehicle owned by tenant A.
      const { tenantId: tenantA } = await createTenantWithLocation();
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });

      // PATCH attempt by tenant B.
      const { tenantId: tenantB, locationId: locationB } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-rls`;
      await createUser({ tenantId: tenantB, cognitoSub, locationId: locationB });

      const token = signTestToken({ sub: cognitoSub, tenantId: tenantB, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'forbidden' },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).toContain('vehicle.not_found');
    });
  });
```

- [ ] **Step 2: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 15 tests pass. The RLS policy (`vehicles_update USING (created_by_tenant_id = current_tenant_id() OR certified_by_tenant_id = current_tenant_id() OR is_admin_role())`) filters tenant B out → 0 rows updated → Prisma P2025 → handler maps to 404 `vehicle.not_found`.

> **If this test FAILS** with a different status (500, 200, ...) the error handler may not map P2025 from PATCH the same way it does from GET. Inspect `packages/api/src/plugins/error-handler.ts` for the P2025 → 404 path. If the path is GET-only, generalize it (PATCH should follow the same convention). Document the change in the commit body.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "test(api): RLS cross-tenant PATCH returns 404 vehicle.not_found"
```

---

## Task 14: BR-007 year out-of-range + body strict + empty body (Zod-only)

These cases are enforced entirely by `UpdateVehicleSchema`. We assert the HTTP-level surface here.

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add tests)

- [ ] **Step 1: Write the tests**

```typescript
  describe('body validation surface', () => {
    it('returns 400 when year is out of range BR-007', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-yr`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { year: 1800 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when body contains an unknown field (e.g. status)', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-unk`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'archived' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when body has no editable field', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-emp`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });

      const res = await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });
```

- [ ] **Step 2: Run the tests — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 18 tests pass. (Schema enforces all three cases; handler did not need changes.)

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "test(api): PATCH body validation surface (year/strict/non-empty)"
```

---

## Task 15: `updatedAt` advances on PATCH

Sanity test that `@updatedAt` fires (caught a hypothetical regression where `data: {}` is sent without changing anything).

**Files:**
- Modify: `packages/api/tests/integration/vehicles-patch.test.ts` (add test)

- [ ] **Step 1: Write the test**

```typescript
  describe('updatedAt', () => {
    it('advances updatedAt after a PATCH', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const cognitoSub = `sub-${Date.now()}-up`;
      await createUser({ tenantId, cognitoSub, locationId });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const before = await pgAdmin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      // Sleep 5ms so the timestamp can't equal exactly.
      await new Promise((r) => setTimeout(r, 5));

      const token = signTestToken({ sub: cognitoSub, tenantId, pool: 'officine' });
      await server.app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'cremisi' },
      });

      const after = await pgAdmin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        before.rows[0]!.updated_at.getTime(),
      );
    });
  });
```

- [ ] **Step 2: Run the test — expect pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-patch
```

Expected: 19 tests pass (Prisma `@updatedAt` is automatic).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/vehicles-patch.test.ts
git commit -m "test(api): PATCH advances updatedAt timestamp"
```

---

## Task 16: Unit tests for handler body validation

Mirror the integration coverage at unit level (faster) for the Zod surface — what the handler does with stubbed Prisma.

**Files:**
- Modify: `packages/api/tests/unit/routes/v1/vehicles.test.ts` (append `describe`)

- [ ] **Step 1: Append the describe block**

Look at the existing test file's setup block (server build, mock Prisma, mock `recordVehicleAccess`). Append at the bottom — replace placeholders below with the file's actual helpers/mocks:

```typescript
describe('PATCH /v1/vehicles/:id', () => {
  // Reuse whatever before/each block this file already has for the GET tests.

  it('returns 400 when body is empty', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/vehicles/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${validToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body has unknown field (strict)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/vehicles/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when vin length is wrong', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/vehicles/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { vin: 'TOO_SHORT' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when year is out of range', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/vehicles/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { year: 1800 },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

> **Note:** the exact mock-Prisma stub names (`mockTx`, `validToken`, etc.) MUST match what's already in `vehicles.test.ts`. Open the file first and copy the conventions verbatim — these unit tests live alongside existing ones and need to share the same harness.

- [ ] **Step 2: Run the unit tests — expect pass**

```bash
pnpm --filter @garageos/api test:unit -- vehicles
```

Expected: existing tests + 4 new unit tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/unit/routes/v1/vehicles.test.ts
git commit -m "test(api): unit tests for PATCH /vehicles body validation"
```

---

## Task 17: Final verification + smoke

- [ ] **Step 1: Full lint + typecheck + tests**

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
```

Expected: all green.

- [ ] **Step 2: PR-size check**

```bash
git diff --stat main...feat/patch-vehicle-endpoint
```

Expected: < 1200 lines (alert), well under 1500 (hard limit).

- [ ] **Step 3: Manual smoke (optional but recommended)**

```bash
pnpm --filter @garageos/api dev
```

In another terminal (replace `<TOKEN>` and `<UUID>` with values for a vehicle owned by your test tenant):

```bash
curl -X PATCH http://localhost:3000/v1/vehicles/<UUID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"color":"verde scuro"}'
```

Expected: 200 with the updated `vehicle.color`.

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/patch-vehicle-endpoint
gh pr create --title "feat(api): PATCH /v1/vehicles/:id (F-OFF-106)" --body "$(cat <<'EOF'
## What

PATCH /v1/vehicles/:id — modifica dati veicolo (F-OFF-106).

## Why

F-OFF-106 (Modifica dati veicolo) — preludio funzionale a PATCH /interventions/:id (BR-062 wiki window) e copre il caso "errore manifesto" della spec.

Spec: docs/superpowers/specs/2026-04-27-patch-vehicle-design.md
Plan: docs/superpowers/plans/2026-04-27-patch-vehicle-endpoint.md

## Implementation notes

- Nuovo handler thin in `routes/v1/vehicles-update.ts` mirror di `vehicles-timeline.ts`.
- Refactor di setup: `idParamSchema`, `vehicleDetailSelect`, `vehicleOwnershipSelect` estratti in `lib/vehicle-shared.ts`. `businessError` factory estratto in `lib/business-error.ts`.
- `checkDuplicatePlateWarning` esteso con `excludeId?: string` (escludere il record corrente nel PATCH).
- `UpdateVehicleSchema` (Zod .strict + .refine non-empty) in `@garageos/database`.
- RLS `vehicles_update` enforce tenant ownership → forbidden cade come 404 via P2025 (RLS-as-404, no nuovi error code).
- access_log riusa `recordVehicleAccess` con `action='update'`.

## Tests

- [x] Unit (4 nuovi)
- [x] Integration (19 nuovi)
- [x] Smoke locale
- [x] BR-001 (duplicate VIN) verificato
- [x] BR-002 (duplicate plate + force + excludeId) verificato
- [x] BR-005 (VIN immutable on certified) verificato
- [x] BR-007 (year range) verificato
- [x] BR-008 (archived blocked) verificato
- [x] BR-151 (PII filter) verificato

## Out of scope (deferred — vedi tech debt ledger)

- Concurrency control (If-Match) — da rivedere al frontend.
- Audit del "before" (diff campi) — da rivedere al frontend.
EOF
)"
```

- [ ] **Step 5: Update memory checkpoint after merge**

After the PR is merged: update `~/.claude/projects/.../memory/project_resume_checkpoint.md` and `project_next_pr_sequence.md` to reflect that PR 15 (option C) is complete and propose B (transfers) or E (CDK) for PR 16.

---

## Self-review

- **Spec coverage:** every section of the spec has an implementing task.
  - §2 API contract → Tasks 4, 5, 14
  - §3 Authorization → Task 13 (RLS-as-404)
  - §4 Flusso steps 1-12 → Tasks 5-12
  - §5 File touchpoints → Tasks 1-3 (refactors), 4-5 (new files), 12 (server.ts register)
  - §6 Testing — unit → Task 16
  - §6 Testing — integration → Tasks 5-15 (all PATCH tests)
  - §6 Testing — smoke → Task 17
  - §7 Deferred → tech debt already updated during brainstorming, recap in PR body (Task 17)
  - §8 Out of scope → not implemented (correct)
  - §9 PR sizing → Task 17 step 2 verifies
  - §10 Acceptance checklist → Task 17

- **Type consistency:** `UpdateVehicleSchema` shape stable across tasks 4 → 5 → 16. `excludeId?: string` parameter added to `checkDuplicatePlateWarning` in Task 3 and used in Task 10 with same name. `recordVehicleAccess` invocation in Task 12 mirrors `vehicles.ts:596-605` shape.

- **No placeholders:** every code step shows full code; every command step has expected output. Two cautionary notes (`signTestToken` naming convention in Task 5, mock harness names in Task 16) explicitly direct the implementer to inspect existing files rather than guess — these are not placeholders, they are honest scope notes.

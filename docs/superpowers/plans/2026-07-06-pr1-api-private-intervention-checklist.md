# PR-1 (backend) — Private intervention type + checklist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give customer-created private interventions the same structured shape as officina interventions — a catalog `intervention_type_id` with persisted checklist selections (snapshots), plus a customer-facing catalog endpoint — while preserving the free-text ("Altro") fallback. Backend only; the mobile UI is PR-2.

**Architecture:** New customer-scoped table `PrivateInterventionChecklistSelection` mirrors the tenant-scoped `InterventionChecklistSelection` (schema.prisma:512-528). The shared validator `validateChecklistSelection` is generalized to make `tenantId` optional so the customer path reuses it without the tenant-exclusion checks (BR-302/304). A new `GET /v1/me/intervention-types` mirrors the officina `intervention-types.ts` catalog query minus per-tenant exclusions. Create/PATCH on `me-private-interventions.ts` gain a `checklist_item_ids` field with snapshot-on-create and replace-set-on-edit (mirroring `interventions-update.ts:230-283`, BR-303). The read DTOs gain `checklist_items: [{ id, label }]` via the pure `serializeChecklistItems`.

**Spec:** `docs/superpowers/specs/2026-07-06-mobile-private-intervention-type-checklist-design.md`

**LOC budget:** target ~600 net, hard PR limit 1500. Controller checks cumulative LOC after each task; halt and ask at ~80% (1200).

**Tech Stack:** Fastify + TypeScript + Prisma 7 (adapter) + Supabase Postgres (RLS), Zod, Vitest (unit + integration/Testcontainers).

## Global Constraints

- TypeScript strict; no `any` without justified comment.
- Comment headers in **English**; user-facing strings in **Italian** (these endpoints return machine codes + Italian `detail` messages, no i18n table).
- No new npm dependency.
- Conventional Commits, summary ≤ 72 chars (commitlint is a hard CI gate on every commit).
- RLS is the primary boundary but every customer query **also** filters at the app layer (`customerId`) — defense in depth (project memory: RLS-only endpoint leak).
- Migrations are operator-applied (`prisma migrate deploy` on `DIRECT_URL`); deploy.yml ships CDK only. Migration SQL must be portable (no hardcoded role/db).
- Never weaken RLS/schema invariants to make a test pass.

## Deviations from spec (verified against actual code — the code wins)

1. **New endpoint lives in its own file**, `me-intervention-types.ts`, not folded into `me-private-interventions.ts` — single-responsibility, mirrors how `intervention-types.ts` is a standalone plugin. Registered in `server.ts` next to the other `/me` routes.
2. **`assertInterventionTypeExists`** (intervention-shared.ts:83-91) does **not** filter `active`/`tenantId` — it only checks existence. Type-and-active validation for the catalog path is covered separately by `validateChecklistSelection`'s `active: true` membership query, so no change needed there. (Free-text path never calls it.)
3. **"custom_type + checklist" rejection** is enforced as a **Zod refine** on the create schema (fails fast, 400 VALIDATION_ERROR), consistent with the existing XOR refine (me-private-interventions.ts:44-52). On PATCH, where merged state can't be expressed in Zod, it is a handler-side check.
4. Spec said DTO `checklist_items` on detail **and** list; confirmed both share `detailSelect`/`projectDetail`, so one change covers both (Task 3).

## Gotchas the implementer MUST respect (from project memory)

- **Prisma loose `where` silently drops unknown keys** → every `select`/`data`/`where` field must exist with the exact name (verified against schema.prisma in this plan).
- **RLS split lookup**: read-by-id uses `findFirst({ id, customerId })` + manual 404, never `findUniqueOrThrow` (already the pattern in this file).
- **Sequential awaits on one `withContext` tx** — no `Promise.all` on the same interactive transaction (pg "already executing"). The new endpoint does a single `findMany`; create/patch do sequential ops.
- **`createMany`** for bulk selection inserts (not `Promise.all` of `create`).
- **Handler-route change breaks FakePrisma unit mocks** — run `pnpm --filter @garageos/api test:unit` locally after Tasks 2-6 (typecheck won't catch it).
- **Integration test helpers must mirror the exact wire shape** (content-type `application/json`, exact snake_case body) and assert serialized formats exactly (date-only `YYYY-MM-DD`).
- **CHECK/RLS violations surface only on CI** (real Postgres) — the RLS negative test is CI-gated.

## Branch

`feat/api-private-intervention-checklist` off updated `main`.

---

### Task 1: DB — `PrivateInterventionChecklistSelection` model + migration + RLS

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (add model after `PrivateIntervention` at line 627; add relation field to `PrivateIntervention`)
- Create: `packages/database/prisma/migrations/<timestamp>_private_intervention_checklist/migration.sql`
- Test: covered structurally by `prisma validate` + the RLS integration test in Task 5.

**Interfaces:**
- Produces: Prisma model `PrivateInterventionChecklistSelection` with fields `id`, `privateInterventionId`, `customerId`, `checklistItemId (String?)`, `labelSnapshot`, `sortOrderSnapshot (Int?)`, `createdAt`; relation `PrivateIntervention.checklistSelections`.

- [ ] **Step 1: Add the Prisma model + relation.** In `schema.prisma`, add the relation field to `PrivateIntervention` (after line 623, alongside the other relations):

```prisma
  checklistSelections PrivateInterventionChecklistSelection[]
```

Then add the model after `PrivateIntervention` (twin of `InterventionChecklistSelection`, customer-scoped):

```prisma
model PrivateInterventionChecklistSelection {
  id                    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  privateInterventionId String   @map("private_intervention_id") @db.Uuid
  customerId            String   @map("customer_id") @db.Uuid
  checklistItemId       String?  @map("checklist_item_id") @db.Uuid
  labelSnapshot         String   @map("label_snapshot") @db.VarChar(150)
  sortOrderSnapshot     Int?     @map("sort_order_snapshot") @db.SmallInt
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz

  privateIntervention PrivateIntervention        @relation(fields: [privateInterventionId], references: [id], onDelete: Cascade)
  checklistItem       InterventionChecklistItem? @relation(fields: [checklistItemId], references: [id], onDelete: SetNull)

  @@unique([privateInterventionId, checklistItemId], map: "uq_priv_selection_intervention_item")
  @@index([privateInterventionId], map: "idx_priv_selections_intervention")
  @@map("private_intervention_checklist_selections")
}
```

Also add the back-relation on `InterventionChecklistItem` (line 478 area) so Prisma validates:

```prisma
  privateSelections PrivateInterventionChecklistSelection[]
```

- [ ] **Step 2: Validate the schema.**

Run: `pnpm --filter @garageos/database exec prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 3: Author the migration SQL.** Create the migration file. Mirror the FK/index/RLS shape of `intervention_checklist_selections` (migration `20260702130000_checklist_foundation`) but scope RLS to the customer like `private_int_isolation` (migration `20260424100000_...:438-445`). Single `FOR ALL` policy (chosen convention for customer-scoped tables):

```sql
-- Private intervention checklist selections (BR-086 → BR-300/301/303 parity
-- for customer-created private interventions). Customer-scoped, mirroring
-- private_int_isolation. Additive migration, no drops.
CREATE TABLE private_intervention_checklist_selections (
    id                      uuid NOT NULL DEFAULT gen_random_uuid(),
    private_intervention_id uuid NOT NULL,
    customer_id             uuid NOT NULL,
    checklist_item_id       uuid,
    label_snapshot          varchar(150) NOT NULL,
    sort_order_snapshot     smallint,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT private_intervention_checklist_selections_pkey PRIMARY KEY (id)
);

ALTER TABLE private_intervention_checklist_selections
    ADD CONSTRAINT priv_selection_intervention_fkey
    FOREIGN KEY (private_intervention_id)
    REFERENCES private_interventions(id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE private_intervention_checklist_selections
    ADD CONSTRAINT priv_selection_item_fkey
    FOREIGN KEY (checklist_item_id)
    REFERENCES intervention_checklist_items(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX uq_priv_selection_intervention_item
    ON private_intervention_checklist_selections (private_intervention_id, checklist_item_id);
CREATE INDEX idx_priv_selections_intervention
    ON private_intervention_checklist_selections (private_intervention_id);

ALTER TABLE private_intervention_checklist_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_intervention_checklist_selections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS private_int_checklist_isolation ON private_intervention_checklist_selections;
CREATE POLICY private_int_checklist_isolation
    ON private_intervention_checklist_selections
    USING (is_admin_role() OR customer_id = current_customer_id());
```

> Note: no explicit `GRANT` — blanket grants + `ALTER DEFAULT PRIVILEGES` (migration `20260430120000_create_garageos_app_role`) cover new tables. `garageos_app` stays NOBYPASSRLS. The unique index on `(private_intervention_id, checklist_item_id)` treats NULL `checklist_item_id` as distinct (Postgres default) — harmless here since the app never inserts a NULL `checklist_item_id` (only `onDelete: SetNull` produces one, post-insert).

- [ ] **Step 4: Generate the Prisma client & confirm migration name.**

Run: `pnpm --filter @garageos/database exec prisma generate`
Expected: client regenerates without error; `PrivateInterventionChecklistSelection` appears in generated types.

- [ ] **Step 5: Commit.**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "feat(database): private intervention checklist selections table"
```

---

### Task 2: Shared validator — make `tenantId` optional

**Files:**
- Modify: `packages/api/src/lib/intervention-shared.ts:126-201` (`validateChecklistSelection`)
- Test: `packages/api/tests/unit/intervention-shared.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: Prisma models from Task 1 (none directly; uses `interventionChecklistItem`).
- Produces: `validateChecklistSelection(tx, { tenantId?: string | null, interventionTypeId, checklistItemIds }): Promise<{ id, nameIt, sortOrder }[]>`. When `tenantId` is null/undefined the two tenant-exclusion queries are skipped; BR-300 (min 1) and BR-301/302-active membership still enforced.

- [ ] **Step 1: Write the failing unit test.** Assert the customer path (no `tenantId`) skips the exclusion queries and still enforces membership + min-1. Use a FakePrisma-style stub whose `tenantInterventionTypeExclusion`/`tenantChecklistItemExclusion` throw if called:

```ts
it('skips tenant-exclusion checks when tenantId is omitted (customer path)', async () => {
  const tx = {
    tenantInterventionTypeExclusion: { findFirst: () => { throw new Error('must not query exclusions'); } },
    tenantChecklistItemExclusion: { findMany: () => { throw new Error('must not query exclusions'); } },
    interventionChecklistItem: {
      findMany: async () => [{ id: 'a', nameIt: 'Olio', sortOrder: 0 }],
    },
  } as unknown as PrismaClient;

  const found = await validateChecklistSelection(tx, {
    interventionTypeId: 't1',
    checklistItemIds: ['a'],
  });
  expect(found).toEqual([{ id: 'a', nameIt: 'Olio', sortOrder: 0 }]);
});

it('still rejects empty checklist without tenantId (BR-300)', async () => {
  const tx = { interventionChecklistItem: { findMany: async () => [] } } as unknown as PrismaClient;
  await expect(
    validateChecklistSelection(tx, { interventionTypeId: 't1', checklistItemIds: [] }),
  ).rejects.toMatchObject({ code: 'intervention.creation.checklist_required' });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/api test:unit -- intervention-shared`
Expected: FAIL (type error / exclusion stub throws, since `tenantId` is currently required and always queried).

- [ ] **Step 3: Implement the change.** Change the signature to `tenantId?: string | null` and gate both exclusion queries. Keep the BR-300 check and the `findMany` membership check unchanged. The two exclusion blocks become:

```ts
  // BR-302/BR-304 tenant-exclusion checks only apply to the officina
  // (tenant-scoped) path. The customer/private path passes no tenantId —
  // customers are not tenant-scoped, so the global catalog is visible in
  // full — and thus skips these two queries entirely.
  if (tenantId != null) {
    const typeExcluded = await tx.tenantInterventionTypeExclusion.findFirst({ /* unchanged */ });
    if (typeExcluded) { /* unchanged throw */ }
  }
  // ...membership findMany (unchanged, runs for both paths)...
  if (tenantId != null) {
    const exclusions = await tx.tenantChecklistItemExclusion.findMany({ /* unchanged */ });
    if (exclusions.length > 0) { /* unchanged throw */ }
  }
```

Update the JSDoc header to note the customer path. Update the destructure to `const { tenantId, interventionTypeId, checklistItemIds } = args;` (unchanged names).

- [ ] **Step 4: Run tests — new pass, officina callers still compile.**

Run: `pnpm --filter @garageos/api test:unit -- intervention-shared`
Expected: PASS.
Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (officina callers in `interventions.ts`/`interventions-update.ts` still pass `tenantId` — no signature break).

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/lib/intervention-shared.ts packages/api/tests/unit/intervention-shared.test.ts
git commit -m "refactor(api): make checklist validator tenantId optional"
```

---

### Task 3: Read DTO — surface `checklist_items` on detail & list

**Files:**
- Modify: `packages/api/src/routes/v1/me-private-interventions.ts` (`detailSelect` 68-78, `DetailRow` 80-90, `projectDetail` 92-106)
- Test: `packages/api/tests/integration/me-private-interventions.*.test.ts` (existing suite — add an assertion)

**Interfaces:**
- Consumes: `serializeChecklistItems` (intervention-shared.ts:104-124); Task 1 relation `checklistSelections`.
- Produces: every private-intervention DTO now carries `checklist_items: { id: string | null; label: string }[]` (empty array for free-text rows).

- [ ] **Step 1: Write the failing integration assertion.** On an existing free-text ("Altro") private intervention, `GET /v1/me/private-interventions/:id` returns `checklist_items: []`:

```ts
expect(res.json()).toMatchObject({ custom_type: 'Lavaggio', checklist_items: [] });
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: FAIL — `checklist_items` undefined in response.

- [ ] **Step 3: Implement.** Extend `detailSelect` with the relation, extend `DetailRow`, map in `projectDetail`:

```ts
// in detailSelect:
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
  },
```
```ts
// in DetailRow:
  checklistSelections: { checklistItemId: string | null; labelSnapshot: string; sortOrderSnapshot: number | null }[];
```
```ts
// in projectDetail, add to the returned object:
  checklist_items: serializeChecklistItems(r.checklistSelections),
```

Import `serializeChecklistItems` in the existing import block from `../../lib/intervention-shared.js`.

- [ ] **Step 4: Run tests.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: PASS (existing rows now return `checklist_items: []`).

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/routes/v1/me-private-interventions.ts packages/api/tests
git commit -m "feat(api): return checklist_items on private intervention DTOs"
```

---

### Task 4: New endpoint — `GET /v1/me/intervention-types`

**Files:**
- Create: `packages/api/src/routes/v1/me-intervention-types.ts`
- Modify: `packages/api/src/server.ts` (import + `app.register`, next to line 238)
- Test: `packages/api/tests/integration/me-intervention-types.test.ts`

**Interfaces:**
- Consumes: guards `requireAuth`, `requireClientiPool`, `clientiContext`.
- Produces: `GET /v1/me/intervention-types` → `{ data: { id, code, name_it, icon, checklist_items: { id, code, name_it, sort_order }[] }[] }`.

- [ ] **Step 1: Write the failing integration tests.** Cover: (a) 200 shape with checklist items for a customer JWT; (b) BR-305 — a global type with zero active checklist items is omitted; (c) officina pool → 403.

```ts
it('returns the global catalog with checklist items for a customer', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/me/intervention-types', headers: customerAuth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.data[0]).toMatchObject({
    id: expect.any(String), code: expect.any(String), name_it: expect.any(String),
  });
  expect(Array.isArray(body.data[0].checklist_items)).toBe(true);
  expect(body.data[0].checklist_items[0]).toMatchObject({ sort_order: expect.any(Number) });
});

it('omits types with zero active checklist items (BR-305)', async () => {
  // seed a global type with only inactive items → absent from data
});

it('rejects the officina pool with 403', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/me/intervention-types', headers: officinaAuth });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/api test:integration -- me-intervention-types`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement the route.** Mirror `intervention-types.ts:28-79` minus the exclusion queries and the deadline/`custom` fields. Use customer context:

```ts
import type { FastifyPluginAsync } from 'fastify';

import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET /v1/me/intervention-types — customer-facing global intervention-type
// catalog for private interventions. Same source rows as the officina
// GET /v1/intervention-types (global catalog, tenant_id IS NULL, active),
// but WITHOUT per-tenant exclusions (BR-304): customers are not tenant-
// scoped, so they always see the full global catalog. BR-305: a type is
// offered only if it has >=1 active checklist item (so the mobile form can
// satisfy BR-300). RLS on intervention_types is permissive (SELECT USING
// true), so the customer tx can read it.
const meInterventionTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/intervention-types',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const types = await tx.interventionType.findMany({
          where: { tenantId: null, active: true },
          orderBy: [{ nameIt: 'asc' }],
          select: {
            id: true,
            code: true,
            nameIt: true,
            icon: true,
            checklistItems: {
              where: { active: true },
              orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }],
              select: { id: true, code: true, nameIt: true, sortOrder: true },
            },
          },
        });

        const data = types
          .filter((t) => t.checklistItems.length >= 1) // BR-305
          .map((t) => ({
            id: t.id,
            code: t.code,
            name_it: t.nameIt,
            icon: t.icon,
            checklist_items: t.checklistItems.map((i) => ({
              id: i.id,
              code: i.code,
              name_it: i.nameIt,
              sort_order: i.sortOrder,
            })),
          }));

        return { data };
      });
    },
  );
};

export default meInterventionTypesRoutes;
```

Register in `server.ts` (import near line 44, `await app.register(meInterventionTypesRoutes);` near line 238).

- [ ] **Step 4: Run tests.**

Run: `pnpm --filter @garageos/api test:integration -- me-intervention-types`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/routes/v1/me-intervention-types.ts packages/api/src/server.ts packages/api/tests
git commit -m "feat(api): add GET /v1/me/intervention-types catalog endpoint"
```

---

### Task 5: POST create — accept + snapshot checklist

**Files:**
- Modify: `packages/api/src/routes/v1/me-private-interventions.ts` (`createBodySchema` 34-52; POST handler 219-298; imports)
- Test: `packages/api/tests/integration/me-private-interventions.*.test.ts`

**Interfaces:**
- Consumes: `validateChecklistSelection` (Task 2, called with no `tenantId`); Task 1 table.
- Produces: `POST` accepts `checklist_item_ids?: string[]`; catalog-type path persists snapshot rows and returns `checklist_items`; free-text path forbids checklist.

- [ ] **Step 1: Write the failing integration tests.**
  - catalog type + valid `checklist_item_ids` → 201, response `checklist_items` populated, rows exist in `private_intervention_checklist_selections` with correct `label_snapshot`/`sort_order_snapshot`/`customer_id`.
  - catalog type + empty/missing `checklist_item_ids` → 400 `intervention.creation.checklist_required` (BR-300).
  - catalog type + id from a different type → 422 `intervention.creation.checklist_item_invalid` (BR-301).
  - `custom_type` + non-empty `checklist_item_ids` → 400 `VALIDATION_ERROR` (Deviation #3).
  - **RLS negative (CI):** customer B cannot read customer A's selection rows — assert via a cross-customer `GET` detail returning 404 and (structurally) that A's rows are invisible under B's context.

```ts
it('creates a private intervention with catalog type + checklist snapshot', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
    headers: customerAuth,
    payload: {
      intervention_date: '2026-07-01', odometer_km: 1000,
      intervention_type_id: typeId, custom_type: null,
      description: 'Tagliando', checklist_item_ids: [itemId1, itemId2],
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().checklist_items).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: FAIL — `checklist_item_ids` rejected by `.strict()`? (createBodySchema is not strict, so unknown key is dropped, checklist never persists → snapshot assertions fail).

- [ ] **Step 3: Implement.**
  - Extend `createBodySchema` with `checklist_item_ids: z.array(z.uuid()).optional()` and add a second `.refine` (after the XOR refine): if `custom_type !== null` then `checklist_item_ids` must be undefined or empty:

```ts
  .refine(
    (b) => b.custom_type === null || (b.checklist_item_ids ?? []).length === 0,
    { message: 'Le voci checklist non sono ammesse con un tipo libero (Altro)', path: ['checklist_item_ids'] },
  )
```

  - In the handler, after `assertInterventionTypeExists` and before the rate-limit count, when `intervention_type_id !== null` validate the checklist (BR-300/301 via the tenant-less validator):

```ts
let foundItems: { id: string; nameIt: string; sortOrder: number }[] = [];
if (body.intervention_type_id !== null) {
  foundItems = await validateChecklistSelection(tx, {
    interventionTypeId: body.intervention_type_id,
    checklistItemIds: body.checklist_item_ids ?? [],
  });
}
```

  - After `tx.privateIntervention.create(...)`, snapshot the selections (only when `foundItems` non-empty), using `createMany` (project memory: no `Promise.all` on tx):

```ts
if (foundItems.length > 0) {
  await tx.privateInterventionChecklistSelection.createMany({
    data: foundItems.map((it) => ({
      privateInterventionId: row.id,
      customerId,
      checklistItemId: it.id,
      labelSnapshot: it.nameIt,
      sortOrderSnapshot: it.sortOrder,
    })),
  });
}
```

  - The `create` `select: detailSelect` already includes `checklistSelections` (Task 3), but selections are inserted **after** the create — re-fetch the checklist for the response, or move the snapshot insert **before** the response projection by re-selecting. Simplest: after the `createMany`, re-read the selections and merge:

```ts
const selections = foundItems.map((it) => ({
  checklistItemId: it.id, labelSnapshot: it.nameIt, sortOrderSnapshot: it.sortOrder,
}));
reply.code(201);
return { ...projectDetail(row), checklist_items: serializeChecklistItems(selections) };
```

  (`row.checklistSelections` is `[]` at create time since the insert follows; overriding `checklist_items` from the just-inserted `foundItems` avoids a second round-trip. Verify `projectDetail(row)` already sets `checklist_items: []`, then the spread overrides it.)

  Add `validateChecklistSelection` and `serializeChecklistItems` to the imports.

- [ ] **Step 4: Run tests + targeted unit.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: PASS.
Run: `pnpm --filter @garageos/api test:unit`
Expected: PASS (FakePrisma mocks for the new `privateInterventionChecklistSelection.createMany` may need adding — update the fake if unit tests touch POST).

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/routes/v1/me-private-interventions.ts packages/api/tests
git commit -m "feat(api): private intervention create accepts checklist (BR-300)"
```

---

### Task 6: PATCH — replace-set checklist edit

**Files:**
- Modify: `packages/api/src/routes/v1/me-private-interventions.ts` (`patchBodySchema` 54-65; PATCH handler 301-386)
- Test: `packages/api/tests/integration/me-private-interventions.*.test.ts`

**Interfaces:**
- Consumes: `validateChecklistSelection` (tenant-less); Task 1 table; mirrors `interventions-update.ts:230-283`.
- Produces: `PATCH` accepts `checklist_item_ids?`; replace-set semantics with retain-preserve (BR-303); type change requires checklist; switch to `custom_type` clears selections.

- [ ] **Step 1: Write the failing integration tests.**
  - replace-set: PATCH with a new `checklist_item_ids` set → response reflects the new set; removed items' rows deleted; a retained item keeps its **original** `label_snapshot` (BR-303 — mutate the catalog `nameIt` between create and patch and assert the snapshot did NOT change).
  - type change without `checklist_item_ids` → 400 `intervention.creation.checklist_required`.
  - switch to `custom_type` ("Altro") → all selection rows deleted, `checklist_items: []`.

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: FAIL — `checklist_item_ids` rejected by `.strict()` on `patchBodySchema`.

- [ ] **Step 3: Implement.** Mirror `interventions-update.ts:230-283` with `customerId`/`privateInterventionId`.
  - Add `checklist_item_ids: z.array(z.uuid()).optional()` to `patchBodySchema`.
  - Extend the `current` load (line 313) to also compute effective type. After the merged XOR check (line 334), compute `effectiveTypeId = mergedTypeId`.
  - Before building `data`, add the "type changed without checklist" guard (BR-303 parity):

```ts
const typeChanged =
  'intervention_type_id' in body && body.intervention_type_id !== current.interventionTypeId;
if (mergedTypeId !== null && typeChanged && body.checklist_item_ids === undefined) {
  throw businessError(
    'intervention.creation.checklist_required',
    400,
    'Cambiando il tipo di intervento devi riselezionare le voci checklist.',
  );
}
```

  - After `tx.privateIntervention.update(...)`, apply the selection changes:
    - If `mergedCustomType !== null` (switched/staying on Altro): delete all selections for this private intervention.
    - Else if `body.checklist_item_ids !== undefined`: run the replace-set — `validateChecklistSelection(tx, { interventionTypeId: mergedTypeId, checklistItemIds: body.checklist_item_ids })`, load existing selections `{ id, checklistItemId }`, delete those with null id or not in the desired set, `createMany` only genuinely new items (retained rows keep their snapshot). Verbatim algorithm to mirror is `interventions-update.ts:234-283` with `privateInterventionId`/`customerId`.

```ts
if (mergedCustomType !== null) {
  await tx.privateInterventionChecklistSelection.deleteMany({
    where: { privateInterventionId: id },
  });
} else if (body.checklist_item_ids !== undefined) {
  const foundItems = await validateChecklistSelection(tx, {
    interventionTypeId: mergedTypeId!,
    checklistItemIds: body.checklist_item_ids,
  });
  const existingSelections = await tx.privateInterventionChecklistSelection.findMany({
    where: { privateInterventionId: id },
    select: { id: true, checklistItemId: true },
  });
  const desired = new Set(body.checklist_item_ids);
  const toDeleteIds = existingSelections
    .filter((s) => s.checklistItemId === null || !desired.has(s.checklistItemId))
    .map((s) => s.id);
  if (toDeleteIds.length > 0) {
    await tx.privateInterventionChecklistSelection.deleteMany({ where: { id: { in: toDeleteIds } } });
  }
  const existingItemIds = new Set(
    existingSelections.map((s) => s.checklistItemId).filter((v): v is string => v !== null),
  );
  const toAdd = foundItems.filter((it) => !existingItemIds.has(it.id));
  if (toAdd.length > 0) {
    await tx.privateInterventionChecklistSelection.createMany({
      data: toAdd.map((it) => ({
        privateInterventionId: id, customerId,
        checklistItemId: it.id, labelSnapshot: it.nameIt, sortOrderSnapshot: it.sortOrder,
      })),
    });
  }
}
```

  - Re-select the row (or re-read selections) so the response `checklist_items` reflects the post-edit state. Simplest: after the mutations, re-run `tx.privateIntervention.findFirst({ where: { id }, select: detailSelect })` and `projectDetail` it (one extra read, keeps the response authoritative including retained snapshots). Replace the current single `update({ select: detailSelect })` return accordingly.

- [ ] **Step 4: Run tests + targeted unit.**

Run: `pnpm --filter @garageos/api test:integration -- me-private-interventions`
Expected: PASS.
Run: `pnpm --filter @garageos/api test:unit`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/api/src/routes/v1/me-private-interventions.ts packages/api/tests
git commit -m "feat(api): private intervention PATCH replace-set checklist (BR-303)"
```

---

### Task 7: Docs — APPENDICE A / F / G

**Files:**
- Modify: `docs/APPENDICE_A_API.md` (private-intervention endpoints + new catalog endpoint)
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (add BR-086 under the private family, after BR-085 at line 530)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (note reuse — no new codes)

**Interfaces:** documentation only; no code.

- [ ] **Step 1: APPENDICE_A.** Document `GET /v1/me/intervention-types` (response shape from Task 4) and add the `checklist_item_ids` request field + `checklist_items: [{ id, label }]` response field to the private-intervention POST/PATCH/GET specs. Note the XOR: catalog type ⇒ checklist required (≥1); "Altro" (`custom_type`) ⇒ no checklist.

- [ ] **Step 2: APPENDICE_F.** Add:

```markdown
### BR-086 — Checklist negli interventi privati

Un intervento privato con `intervention_type_id` dal catalogo segue le stesse
regole checklist degli interventi officina: **almeno una voce** (BR-300),
appartenenza voce↔tipo e voce attiva (BR-301), **snapshot** etichetta/ordine
congelato al salvataggio con `onDelete: SetNull` (BR-303). Non si applicano le
esclusioni per-tenant (BR-304): il cliente non è tenant-scoped e vede l'intero
catalogo globale. Con il tipo libero (`custom_type`, "Altro") la checklist non
è ammessa. Enforcement: `validateChecklistSelection` (tenantId assente) + tabella
`private_intervention_checklist_selections` (RLS `private_int_checklist_isolation`).
```

- [ ] **Step 3: APPENDICE_G.** Add a note in the `intervention.creation.*` family that `checklist_required` (400) and `checklist_item_invalid` (422) are **also** emitted by the private-intervention create/PATCH paths (no new codes). No table row additions.

- [ ] **Step 4: Commit.**

```bash
git add docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_G_ERROR_CODES.md
git commit -m "docs: private intervention checklist (BR-086) + catalog endpoint"
```

---

## Final gates (after all tasks)

1. `pnpm -r typecheck` (pre-push hook — mandatory local gate).
2. Include the spec doc in this PR: `git add docs/superpowers/specs/2026-07-06-mobile-private-intervention-type-checklist-design.md` and this plan doc.
3. Push branch, open PR (title `feat(api,database): private intervention type + checklist (BR-086)`), fill the CLAUDE.md PR template (link BR-086, BR-300/301/303).
4. **Final whole-branch `/code-review high`** — load-bearing gate. Apply Critical/Important; list Minor in the PR description.
5. CI full matrix green (`gh pr checks --watch`) — the only gate for RLS semantics + real-Postgres CHECK/FK behavior (the RLS negative test runs here).
6. Self-merge (squash) only when CI green + review passed + zero open questions (CLAUDE.md self-merge rules).

No smoke runbook for PR-1 (no UI/device-facing change) — the smoke gate lands with PR-2 (mobile).

## Self-review

- **Spec coverage:** new table (Task 1) ✅; customer catalog endpoint (Task 4) ✅; tenant-less validator (Task 2) ✅; create checklist + snapshot (Task 5) ✅; PATCH replace-set (Task 6) ✅; read DTO checklist_items (Task 3) ✅; Tier-1 tests (Tasks 4-6, incl. RLS negative) ✅; docs (Task 7) ✅. Mobile is out of scope by design (PR-2).
- **Placeholder scan:** none — every step carries concrete SQL/TS/commands. The two "seed a global type…" test bodies (Task 4/5) describe fixture setup by intent, consistent with the repo's existing integration-test seeding; the implementer follows the existing suite helpers.
- **Type consistency:** field names verified against schema.prisma (`checklistItemId`, `labelSnapshot`, `sortOrderSnapshot`, `privateInterventionId`, `customerId`); validator return `{ id, nameIt, sortOrder }` consumed consistently in Tasks 5-6; `serializeChecklistItems` input shape `{ checklistItemId, labelSnapshot, sortOrderSnapshot }` matches `detailSelect` (Task 3) and the create override (Task 5).

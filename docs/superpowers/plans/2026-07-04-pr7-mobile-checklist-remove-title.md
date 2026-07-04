# PR-7 (mobile) — checklist display + title removal, B2C end-to-end — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the intervention-types/checklist redesign to the customer (B2C) surfaces — the last `title` readers before the eventual `DROP COLUMN`. The customer intervention detail (`GET /v1/me/interventions/:id`) gains a checklist ("Voci eseguite") and stops exposing `title`; the vehicle timeline (`GET /v1/vehicles/:id/timeline`) stops selecting/returning `title`; the mobile app renders the type name as the intervention heading and shows the checklist in the detail screen.

**Architecture:** Mirror the already-merged officina detail (`packages/api/src/routes/v1/interventions-detail.ts`) — select `checklistSelections` (frozen snapshot: `labelSnapshot`/`sortOrderSnapshot`), drop `title`, expose items via the shared `serializeChecklistItems(...)`. The web `TimelineRow.tsx:45` already uses `item.type.name_it`; mobile `TimelineRow.tsx` and detail screen are brought to parity. Private interventions (`customType` free-text) are a separate concept (BR-308 / Deviation #9) and are NOT touched.

**Tech Stack:** Fastify + Prisma (API, camelCase `/me` DTO), React Native + Expo + TanStack Query (mobile), Vitest (API tests), Jest + @testing-library/react-native (mobile tests).

**Spec:** `docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md` (arc 7/7). BR-300 (checklist ≥1), BR-303 (label snapshot), BR-308 (title removed).

**LOC budget:** target ~300 net, hard PR limit 1500. Check cumulative LOC after each task; halt and ask at ~80%.

## Global Constraints

- **Comments in English**; user-facing strings in Italian (no i18n system on this list — mobile strings are inline literals matching the existing screen style). No emoji in code/commits.
- **The `title` DB column is NOT dropped in this PR.** `intervention.title String? @db.VarChar(200)` stays (schema.prisma:538). The `DROP COLUMN` is a separate operator-driven contract step *after* this PR merges and deploys (expand → migrate → contract, APPENDICE_B §9.7). This PR only removes the residual *readers*.
- **`checklistItems` DTO field is camelCase** on the `/me` endpoint (matches the existing `/me` wire convention: `partsReplacedCount`, `interventionDate`, `isDisputed`). The officina `GET /v1/interventions/:id` uses snake_case `checklist_items` — both read the same snapshot via `serializeChecklistItems`; the naming difference is per-endpoint convention, not a bug.
- **Item shape:** `serializeChecklistItems` returns `{ id: string | null; label: string }[]` (id = `checklistItemId`, null after a catalog hard-delete; label = `labelSnapshot`). See `packages/api/src/lib/intervention-shared.ts:104`.
- **Test tiers (CLAUDE.md):** Tier 1 (full) for the API route/serializer contracts. Tier 2 (2-3 targeted tests) for mobile screens — happy path + the checklist conditional; no pure-rendering tests.
- **Local gate = typecheck only** (`pnpm -r typecheck`, husky pre-push). After any API route/serializer change run the targeted `pnpm --filter @garageos/api test:unit` (typecheck does NOT catch broken FakePrisma mocks). Do NOT run integration/mobile suites locally beyond quick targeted debugging — CI runs the full matrix.

## Deviations from spec (verified against actual code — the code wins)

- **D1 — BR-308 "Endpoint coperti" omits the customer endpoints.** `docs/APPENDICE_F_BUSINESS_LOGIC.md:1298-1301` lists only `POST /v1/vehicles/:id/interventions`, `PATCH /v1/interventions/:id`, `GET /v1/interventions/:id`. But BR-308:1296 explicitly anticipates PR-7 removing the residual mobile/B2C title readers ("le letture lato mobile/B2C (PR-7) leggono ancora `title`"). This is a planned *extension*, not a conflict: Task 1/Task 2 add `GET /v1/me/interventions/:id` and `GET /v1/vehicles/:id/timeline` to the BR-308 endpoint list.
- **D2 — APPENDICE_A still documents `title` in the customer responses.** §2.4c response JSON (`docs/APPENDICE_A_API.md:673`) and §2.5 response JSON (`:941`) still show `"title": "..."`. The officina sections (§2.2/§2.12a) were already corrected for BR-308 (`:318`, `:1594`, `:1651`). Task 1/Task 2 apply the same correction to §2.4c and §2.5.
- **D3 — no separate `/me` serializer test for the timeline.** The timeline DTO is built inline in the route (no pure serializer), so its unit test (`vehicles-timeline.test.ts`) only covers helper functions and carries `title` as a dead fixture (line 22, never asserted). The timeline's title-removal contract is verified by the **integration** test, which uses `title` as a row discriminator and must switch to `odometer_km` (Task 2).

## Gotchas the implementer MUST respect (from project memory)

- **FakePrisma mock must include `checklistSelections`** (feedback: field-drift / mock-dynamic-input). After adding `checklistSelections` to the route `select`, `serializeChecklistItems(row.checklistSelections)` runs on the mock's return value. If the mock omits the key, `[...undefined]` throws. Every `intervention.findFirst` mock in `me-interventions.test.ts` must return `checklistSelections: [...]`.
- **Test cascade — enumerate ALL title assertions** (feedback: middleware/T7 test cascade). The timeline **integration** test uses `title` as the discriminator at 3 sites (lines ~108-113, ~231-233, ~600-602). Dropping `title` makes `d.title` `undefined` and those assertions silently pass/fail wrong. Switch every discriminator to `odometer_km` (distinct per fixture). This is CI-only — you cannot see it fail locally; get it exactly right in the plan.
- **exactOptionalPropertyTypes** (feedback): mobile fixtures assigned to `TimelineItem`/`ShopInterventionDetail` typed constants will fail excess-property check if they still carry `title` after the type drops it. Remove every `title:` line from typed mobile fixtures.
- **Stale-cache defaulting** (feedback: react-query offline / stale cache): the detail screen already defaults `partsReplaced ?? []` and `generatedDeadlines ?? []` because a persisted cache from a pre-upgrade app version lacks new keys. Add `checklistItems ?? []` for the same reason.
- **Handler-change unit-mock break** (feedback): run `pnpm --filter @garageos/api test:unit` after Task 1 and Task 2 route edits.

## Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/mobile-checklist-remove-title
```
Base: `main` @ `b3eca269` (post PR-6).

---

### Task 1: API — customer intervention detail (add checklist, drop title)

**Files:**
- Modify: `packages/api/src/lib/customer-intervention-detail.ts` (serializer: `RawInterventionRow`, `ShopInterventionDetailDto`, `projectShopInterventionDetail`)
- Modify: `packages/api/src/routes/v1/me-interventions.ts` (Prisma `select`)
- Test: `packages/api/tests/unit/lib/customer-intervention-detail.test.ts`
- Test: `packages/api/tests/unit/routes/v1/me-interventions.test.ts`
- Docs: `docs/APPENDICE_A_API.md` §2.4c (`:663-693`); `docs/APPENDICE_F_BUSINESS_LOGIC.md` BR-308 endpoint list (`:1298-1301`)

**Interfaces:**
- Consumes: `serializeChecklistItems(selections: { checklistItemId: string|null; labelSnapshot: string; sortOrderSnapshot: number|null }[]): { id: string|null; label: string }[]` from `../lib/intervention-shared.js` (already exported, used by `interventions-detail.ts`).
- Produces: `ShopInterventionDetailDto.intervention.checklistItems: { id: string|null; label: string }[]`; the `title` key is REMOVED from `RawInterventionRow` and from the DTO. Mobile Task 3 mirrors this shape.

- [ ] **Step 1: Update the serializer unit test (red).** In `customer-intervention-detail.test.ts`:
  - Add `checklistSelections: []` to `baseRow` (line ~9-21) and remove the `title: 'Tagliando completo'` line.
  - In the first `it` (line ~24-46) `expect(out.intervention).toEqual({...})`: remove the `title: 'Tagliando completo'` property and add `checklistItems: []`.
  - Replace the "handles null title..." test (line ~133-141) with "handles empty/absent partsReplaced defensively" — drop the `title: null` input and the `expect(out.intervention.title).toBeNull()` assertion; keep the `partsReplacedCount === 0` / `isDisputed === false` assertions.
  - Add a new test proving the snapshot passthrough:
    ```typescript
    it('serializes checklist items from the frozen snapshot, sorted', () => {
      const out = projectShopInterventionDetail(
        {
          ...baseRow,
          checklistSelections: [
            { checklistItemId: 'c2', labelSnapshot: 'Cambio filtro', sortOrderSnapshot: 2 },
            { checklistItemId: 'c1', labelSnapshot: 'Cambio olio', sortOrderSnapshot: 1 },
            { checklistItemId: null, labelSnapshot: 'Voce orfana', sortOrderSnapshot: null },
          ],
        },
        [],
      );
      expect(out.intervention.checklistItems).toEqual([
        { id: 'c1', label: 'Cambio olio' },
        { id: 'c2', label: 'Cambio filtro' },
        { id: null, label: 'Voce orfana' },
      ]);
    });
    ```

- [ ] **Step 2: Run the serializer test to confirm it fails.**
  Run: `pnpm --filter @garageos/api test:unit -- customer-intervention-detail`
  Expected: FAIL (`title` still emitted / `checklistItems` undefined / `checklistSelections` not on type).

- [ ] **Step 3: Update the serializer.** In `customer-intervention-detail.ts`:
  - Import `serializeChecklistItems` alongside `normalizePartsReplaced`: `import { normalizePartsReplaced, serializeChecklistItems, type PartReplaced } from './intervention-shared.js';`
  - `RawInterventionRow`: remove `title: string | null;`; add `checklistSelections: { checklistItemId: string | null; labelSnapshot: string; sortOrderSnapshot: number | null }[];`
  - `ShopInterventionDetailDto.intervention`: remove `title: string | null;`; add `checklistItems: { id: string | null; label: string }[];`
  - `projectShopInterventionDetail`: remove `title: row.title,`; add `checklistItems: serializeChecklistItems(row.checklistSelections),`. Add a comment citing BR-308/BR-303 mirroring `interventions-detail.ts:114-117` (checklist is part of the shared logbook, read from the frozen snapshot, not the live catalog).

- [ ] **Step 4: Run the serializer test to confirm it passes.**
  Run: `pnpm --filter @garageos/api test:unit -- customer-intervention-detail`
  Expected: PASS.

- [ ] **Step 5: Update the route mock + assertions.** In `me-interventions.test.ts`:
  - In both `intervention.findFirst` mocks (line ~23-36 and ~82-104) add `checklistSelections: [{ checklistItemId: 'c1', labelSnapshot: 'Cambio olio', sortOrderSnapshot: 1 }],` and remove the `title: 'Tagliando'` lines (harmless input, but remove for clarity and to prove the route no longer reads it).
  - Add an assertion in the first `it` (line ~65-77): `expect((body.intervention as { checklistItems: { label: string }[] }).checklistItems).toEqual([{ id: 'c1', label: 'Cambio olio' }]);` and `expect('title' in body.intervention).toBe(false);` (widen the `body` cast type to include `checklistItems`).

- [ ] **Step 6: Update the route select + confirm route test fails then passes.** In `me-interventions.ts` `intervention.findFirst({ select })`:
  - Remove `title: true,`.
  - Add after `interventionType: { select: { code: true, nameIt: true } },`:
    ```typescript
    // BR-308/BR-303: checklist snapshot replaces the removed free-text title.
    // Frozen label/sort snapshot (never a live catalog join) — mirrors
    // interventions-detail.ts. Visible to the owning customer as part of the
    // shared logbook, like parts_replaced.
    checklistSelections: {
      select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
      orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
    },
    ```
  Run: `pnpm --filter @garageos/api test:unit -- me-interventions`
  Expected: PASS (all 4 existing cases + the new checklist assertion).

- [ ] **Step 7: Typecheck + update docs.**
  Run: `pnpm --filter @garageos/api typecheck` → clean.
  - APPENDICE_A §2.4c response JSON (`:665-693`): remove the `"title": "Tagliando completo"` line; add after the `type` line `"checklistItems": [{ "id": "uuid", "label": "Cambio olio" }],`. Add a one-line note under the JSON mirroring §2.2: title removed (BR-308), heading is `type.name_it`; `checklistItems` from the frozen snapshot (BR-303).
  - APPENDICE_F BR-308 "Endpoint coperti" (`:1298-1301`): append `- \`GET /v1/me/interventions/:id\` — nessun \`title\` in risposta; \`checklistItems: [{ id, label }]\` dallo snapshot (BR-303), camelCase per convenzione /me`.

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/api/src/lib/customer-intervention-detail.ts packages/api/src/routes/v1/me-interventions.ts packages/api/tests/unit/lib/customer-intervention-detail.test.ts packages/api/tests/unit/routes/v1/me-interventions.test.ts docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md
  git commit -m "feat(api): customer intervention detail checklist, drop title (BR-308)"
  ```
  (Summary = 63 chars ≤ 72.)

---

### Task 2: API — vehicle timeline drops title from shop rows

**Files:**
- Modify: `packages/api/src/routes/v1/vehicles-timeline.ts` (`shopRowSelect`, shop DTO branch)
- Test: `packages/api/tests/unit/routes/v1/vehicles-timeline.test.ts` (remove dead fixture)
- Test: `packages/api/tests/integration/vehicles-timeline.test.ts` (switch discriminator title → odometer_km)
- Docs: `docs/APPENDICE_A_API.md` §2.5 response JSON (`:941`)

**Interfaces:**
- Consumes: nothing new.
- Produces: timeline `shop_intervention` items NO LONGER carry `title`. `type.{id,code,name_it}`, `description`, `odometer_km`, `parts_replaced_count`, `tenant`, `wiki_window_open`, `viewer_is_owner` unchanged. Mobile Task 3 `TimelineItem` mirrors this drop.

- [ ] **Step 1: Update the integration test discriminators (red — CI-only).** In `vehicles-timeline.test.ts` integration, at each site that used `title`:
  - Cross-tenant test (~lines 67-121): remove `title: 'Tagliando A'` / `title: 'Tagliando B'` from the two `createIntervention` calls. Replace lines ~108-115:
    ```typescript
    const oks = body.data.map((d) => d.odometer_km);
    expect(oks).toContain(45000);
    expect(oks).toContain(42000);
    const rowA = body.data.find((d) => d.odometer_km === 45000)!; // tenant A
    const rowB = body.data.find((d) => d.odometer_km === 42000)!; // tenant B
    ```
    (Remove `title?: string;` from the inline `body` type at ~line 97.)
  - Tenant-filter test (~lines 200-233): remove `title: 'Solo A'` / `title: 'Solo B'`. Replace line ~233: `expect(body.data.map((d) => d.odometer_km)).toEqual([42000]);` (only tenant B, odometerKm 42000, survives the `tenant_ids` filter). Change the `body` cast at ~231 to `Array<{ odometer_km: number }>`.
  - Date-window test (~lines 568-602): remove `title: 'Old'` / `title: 'Recent'`. Replace line ~602: `expect(body.data[0]!.odometer_km).toBe(45000);` (the 'Recent' row, date 2026-04-15, odometerKm 45000, is the only one in [2026-03-01, 2026-12-31]). Change the `body` cast at ~600 to `Array<{ odometer_km: number }>`.

- [ ] **Step 2: Remove the dead unit fixture.** In `vehicles-timeline.test.ts` unit, delete the `title: 'Tagliando completo',` line (~22) — it is never asserted; removing it keeps the fixture honest post-drop.

- [ ] **Step 3: Drop title from the route.** In `vehicles-timeline.ts`:
  - `shopRowSelect` (~line 80-98): remove `title: true,`.
  - Shop DTO branch (~line 258-287): remove `title: r.title,`.
  - Update the header comment block (~line 13-18) or add a one-liner: `// BR-308: shop rows expose type.name_it as heading; free-text title removed.`

- [ ] **Step 4: Typecheck + targeted unit run.**
  Run: `pnpm --filter @garageos/api typecheck` → clean.
  Run: `pnpm --filter @garageos/api test:unit -- vehicles-timeline` → PASS (unit helpers unaffected). Integration verified on CI.

- [ ] **Step 5: Update docs §2.5.** APPENDICE_A response JSON (`:941`): remove the `"title": "Tagliando completo"` line from the `shop_intervention` example. Add a note near the field table (~972-981): `title` rimosso (BR-308); l'intestazione è `type.name_it`.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/api/src/routes/v1/vehicles-timeline.ts packages/api/tests/unit/routes/v1/vehicles-timeline.test.ts packages/api/tests/integration/vehicles-timeline.test.ts docs/APPENDICE_A_API.md
  git commit -m "feat(api): drop title from vehicle timeline shop rows (BR-308)"
  ```
  (Summary = 62 chars ≤ 72.)

---

### Task 3: Mobile — types, timeline row, detail screen (type-name heading + checklist)

**Files:**
- Modify: `packages/mobile/src/lib/types/intervention.ts` (`ShopInterventionDetail`)
- Modify: `packages/mobile/src/lib/types/vehicle.ts` (`TimelineItem` shop branch)
- Modify: `packages/mobile/src/components/TimelineRow.tsx`
- Modify: `packages/mobile/app/interventions/[id].tsx`
- Test: `packages/mobile/tests/components/TimelineRow.test.tsx`
- Test: `packages/mobile/tests/screens/intervention-detail.test.tsx`

**Interfaces:**
- Consumes: the Task 1/Task 2 DTO shapes — detail `intervention.checklistItems: { id: string|null; label: string }[]` and no `title`; timeline shop items no `title`.
- Produces: mobile UI parity with web — heading = `type.name_it`; "Voci eseguite" section (hidden when empty).

- [ ] **Step 1: Update the mobile types.**
  - `types/intervention.ts` `ShopInterventionDetail.intervention` (~line 44): remove `title: string | null;`; add `checklistItems: { id: string | null; label: string }[];` (place after `type`). Update the top-of-file comment "Mirror of GET /v1/me/interventions/:id" — note title removed / checklist added (BR-308/BR-303).
  - `types/vehicle.ts` `TimelineItem` `shop_intervention` branch (~line 52): remove `title: string;`.
  Run: `pnpm --filter @garageos/mobile typecheck` → EXPECT failures in `TimelineRow.tsx`, `interventions/[id].tsx`, and the two test files (they still reference `title`). This is the red state that drives Steps 2-5.

- [ ] **Step 2: Fix TimelineRow + its test.**
  - `TimelineRow.tsx` line ~12-13: replace
    ```typescript
    // Narrow via discriminant: shop has `title`, private has `custom_type` (nullable).
    const title = isShop ? item.title : (item.custom_type ?? '—');
    ```
    with
    ```typescript
    // Narrow via discriminant: shop heading is the type name (BR-308, free-text
    // title removed); private uses its free-text custom_type (nullable).
    const title = isShop ? item.type.name_it : (item.custom_type ?? '—');
    ```
  - `TimelineRow.test.tsx`: remove the `title:` line from BOTH shop fixtures (~line 11 and ~line 79). Add one Tier-2 assertion in the first `describe` proving the heading derives from the type:
    ```typescript
    it('renders the type name as the shop heading', () => {
      render(<TimelineRow item={shopItem} />);
      expect(screen.getByText('Cambio olio')).toBeOnTheScreen();
    });
    ```
    (The `fireEvent.press(screen.getByText('Tagliando'))` at ~line 101 still works: the second fixture's `name_it` is already `'Tagliando'`.)

- [ ] **Step 3: Update the detail screen — heading + checklist section.** In `app/interventions/[id].tsx`:
  - Line ~40-41 defaults block: add `const checklistItems = intervention.checklistItems ?? [];` (stale-cache safety, same rationale as `partsReplaced`/`generatedDeadlines`).
  - Line ~56 heading: change `{intervention.title ?? intervention.type.name_it}` to `{intervention.type.name_it}`.
  - Insert a new section AFTER the header card `</View>` (line ~63) and BEFORE the `partsReplaced` section (line ~65) — order: header/description → Voci eseguite → Ricambi → scadenze → contestazioni (web parity):
    ```tsx
    {checklistItems.length > 0 ? (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Voci eseguite</Text>
        {checklistItems.map((item, idx) => (
          <Text key={item.id ?? idx} style={styles.checklistItem}>
            {item.label}
          </Text>
        ))}
      </View>
    ) : null}
    ```
  - Add to the `StyleSheet.create` block: `checklistItem: { fontSize: 14, color: colors.fg },`.

- [ ] **Step 4: Update the detail screen test.** In `tests/screens/intervention-detail.test.tsx`:
  - `baseData` fixture (~line 39-40): remove `title: 'Tagliando completo',`; add `checklistItems: [],` (after `type`).
  - In the "stale cached detail" test (~line 128-139): also `delete (stale.intervention as Record<string, unknown>).checklistItems;` and assert `expect(screen.queryByText('Voci eseguite')).toBeNull();`.
  - Add two Tier-2 tests:
    ```typescript
    it('renders the type name as the heading', () => {
      mockDetail.data = baseData();
      render(<InterventionDetailScreen />);
      expect(screen.getByText('Tagliando')).toBeTruthy();
    });

    it('renders the "Voci eseguite" section when checklist items are present', () => {
      mockDetail.data = baseData({
        intervention: {
          ...baseData().intervention,
          checklistItems: [
            { id: 'c1', label: 'Cambio olio' },
            { id: 'c2', label: 'Cambio filtro' },
          ],
        },
      });
      render(<InterventionDetailScreen />);
      expect(screen.getByText('Voci eseguite')).toBeTruthy();
      expect(screen.getByText('Cambio olio')).toBeTruthy();
      expect(screen.getByText('Cambio filtro')).toBeTruthy();
    });
    ```
  - The default `baseData()` (empty `checklistItems`) already proves the section is hidden — no extra negative test needed beyond the stale-cache one.

- [ ] **Step 5: Typecheck + run the mobile suite for the touched files.**
  Run: `pnpm --filter @garageos/mobile typecheck` → clean.
  Run: `pnpm --filter @garageos/mobile test -- TimelineRow intervention-detail` → PASS. (See feedback `local_env_blocks_test_validation` — mobile jest maps `^react$`; runs locally on Windows.)

- [ ] **Step 6: Grep for any residual mobile `title` data reader.**
  Run: `git grep -n "\.title" -- packages/mobile/src packages/mobile/app | grep -iv "styles.title\|Stack.Screen\|screenTitle\|EmptyState\|headerTitle"`
  Expected: no matches referencing intervention/timeline `title` (only style/nav/header noise, if any). If a reader remains, fix it before committing.

- [ ] **Step 7: Commit.**
  ```bash
  git add packages/mobile/src/lib/types/intervention.ts packages/mobile/src/lib/types/vehicle.ts packages/mobile/src/components/TimelineRow.tsx packages/mobile/app/interventions/[id].tsx packages/mobile/tests/components/TimelineRow.test.tsx packages/mobile/tests/screens/intervention-detail.test.tsx
  git commit -m "feat(mobile): intervention checklist display + type-name heading (BR-300,308)"
  ```
  (Summary = 69 chars ≤ 72.)

---

## Post-implementation gates (in order)

1. `pnpm -r typecheck` (pre-push hook) — the only mandatory local gate.
2. **Final whole-branch `/code-review high`** — load-bearing (cross-references schema.prisma, APPENDICE_F/G, cross-task consistency). Apply Critical/Important; list Minor in the PR description.
3. PR + CI full matrix (`gh pr checks --watch`) — the ONLY gate for the timeline integration test (real Postgres) and RLS semantics.
4. **Smoke runbook on a real device (BLOCKER — user executes).** Mobile is pixel-facing; no review replaces it. Runbook after merge (auto-deploys API):
   - Open a vehicle → Storico tab → tap a shop intervention → detail heading shows the **type name** (not a free-text title), and a **"Voci eseguite"** section lists the checklist items.
   - A shop intervention with no checklist items shows **no** "Voci eseguite" section (graceful).
   - Timeline rows show the type name as the shop heading; private interventions still show their `custom_type`.
   - `Contesta intervento` still works end-to-end.

## After PR-7 merges (NOT part of this PR — operator-driven, tracked in checkpoint)

- **DROP COLUMN `title`** on `interventions` — separate migration applied by operator with `DIRECT_URL` (`db:migrate:deploy`; deploy.yml ships CDK only). Pre-flight safety grep: `git grep -n "title" -- packages/*/src | grep -i intervention` must show ZERO residual `select`/DTO readers of `intervention.title` across api/web/mobile.
- **Operator residual D5** (deferred): seed prod 3 tipi + 16 voci + cleanup 12 vecchi tipi/interventi test; re-smoke admin #247/#248 post-deploy.

## Self-review

- **Spec coverage:** BR-308 (title removed) → Tasks 1/2/3 heading + DTO drops. BR-303 (snapshot) → `serializeChecklistItems` reused, no live join. BR-300 (checklist ≥1) → display-only here (creation is officina-side, PR-4/5); customer view renders whatever snapshot exists, hides when empty. Private-intervention exclusion (Deviation #9) → explicitly untouched. ✅
- **Placeholder scan:** none — every step has concrete code/edits. ✅
- **Type consistency:** DTO `checklistItems: { id: string|null; label: string }[]` identical across serializer (Task 1), API doc, and mobile type (Task 3). `serializeChecklistItems` signature matches schema.prisma:516-518 fields. `odometer_km` discriminator values (45000/42000, 45000) verified against the actual integration fixtures. ✅

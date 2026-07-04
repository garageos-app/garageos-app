# PR-6 (PDF) — checklist "Voci eseguite" + title removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two customer-facing PDF endpoints coherent with the checklist model: stop reading/rendering the removed free-text `title`, render the frozen checklist snapshot as a "Voci eseguite" section, and handle the now-optional (possibly empty) `description` without a dangling label/blank line. DB column `title` is **not** dropped in this PR (contract step is operator-driven after PR-7 mobile).

**Architecture:** Two self-contained slices, one per PDF surface. Each slice pairs a renderer (pure `pdf-lib` function) with its route so the interface change (`title` removed, `checklistItems: string[]` added) and its only consumer land together — typecheck stays green at every task boundary. Both routes reuse the existing shared `serializeChecklistItems` (frozen-snapshot sort + null-id survival, `packages/api/src/lib/intervention-shared.ts:104`) mapped to `.label` — the renderer only needs labels, so the sort/snapshot logic stays in the one shared helper. Layout order in both renderers: **Voci eseguite → Descrizione → Ricambi** (checklist is the mandatory itemized body; description is optional).

**Spec:** `docs/superpowers/specs/2026-07-02-intervention-types-checklist-redesign-design.md` (arc-level; PR-6 is slice 6/7).

**LOC budget:** ~250 net across 4 source + 6 test files. Well under the 1500 hard limit — no mid-execution checkpoint expected.

## Deviations from spec (verified against actual code — the code wins)

- **No APPENDICE_A DTO change.** Both endpoints stream a binary `application/pdf` body (`Content-Type: application/pdf`), not a JSON envelope — there is no response schema in APPENDICE_A to update. `title` was never a documented JSON field for these routes.
- **`description` is already optional in the DB path.** Since #251 (`bfb961a5`), `description` can be the empty string `''` (never `null` — column stays `NOT NULL`; create defaults to `''`). Renderers currently call `wrapText('')` which returns `['']` (one empty line, see `pdf-format.ts:33`) — this plan guards on `description.trim() !== ''`.
- **`title` column persists.** Both routes today still `select: { title: true }`; this PR removes those selects (the last PDF readers of `title`). Remaining readers after PR-6: mobile (PR-7) + `vehicles-timeline` (Deviation#2). The column is dropped only after PR-7.

## Gotchas the implementer MUST respect (from project memory)

- **RLS is fine, verified.** `intervention_checklist_selections` has `CREATE POLICY selections_read ... FOR SELECT USING (true)` (migration `20260702130000_checklist_foundation` L100), granted to `garageos_app`. Both officina (`tenantContext`) and customer (`clientiContext`) pools can read it cross-tenant — consistent with BR-150 shared-logbook visibility of `parts_replaced`/`description`. Selections are fetched as a nested relation of interventions already gated (BR-040 ownership on the customer route, `findFirst {id, tenantId}` on the officina route), so **no additional app-layer filter is needed** and none should be added.
- **Prisma select field names are exact.** The `checklistSelections` relation + field names (`checklistItemId`, `labelSnapshot`, `sortOrderSnapshot`) are copied verbatim from the working `interventions-detail.ts:63-66` select. Typecheck does NOT catch a wrong relation/field name in a Prisma `select` — the integration test (real Postgres) is the only gate, so each task seeds a real selection row.
- **Route-handler changes need the targeted unit run.** After each route change run `pnpm --filter @garageos/api test:unit` — typecheck does not catch a broken `FakePrisma` mock shape (`feedback_handler_change_breaks_unit_mock`).
- **`serializeChecklistItems` already sorts.** Do NOT re-sort in the route or renderer; call it and `.map((c) => c.label)`. The DB `orderBy` in the select is a redundant belt-and-suspenders mirror of detail — keep it for parity.
- **Comment headers in English**, user-facing PDF strings in Italian (`Voci eseguite:`, `Descrizione:`, `Ricambi ...`).
- **This is device-facing.** A rendered PDF is a visual artifact — a visual smoke (open one generated PDF) is required before merge, in addition to the final `/code-review`.

## Branch

`feat/pdf-checklist-remove-title` (base: current `main`, `bfb961a5`).

```bash
git checkout main && git pull origin main
git checkout -b feat/pdf-checklist-remove-title
```

---

### Task 1: Single-intervention PDF — `renderInterventionPdf` + `/v1/interventions/:id/pdf`

**Files:**
- Modify: `packages/api/src/lib/intervention-pdf-renderer.ts` (interface + layout: drop `title`, add `checklistItems`, reorder Voci→Descrizione→Ricambi, empty-desc guard)
- Modify: `packages/api/src/routes/v1/interventions-pdf.ts` (select: drop `title`, add `checklistSelections`; map labels via `serializeChecklistItems`)
- Test: `packages/api/tests/unit/lib/intervention-pdf-renderer.test.ts`
- Test: `packages/api/tests/unit/routes/v1/interventions-pdf.test.ts`
- Test: `packages/api/tests/integration/interventions-pdf.test.ts`

**Interfaces:**
- Consumes: `serializeChecklistItems(selections: { checklistItemId: string | null; labelSnapshot: string; sortOrderSnapshot: number | null }[]): { id: string | null; label: string }[]` from `../../lib/intervention-shared.js` (already exists, `intervention-shared.ts:104`).
- Produces: `InterventionPdfData` with `title` **removed** and `checklistItems: string[]` **added** (sorted labels). All other fields unchanged.

- [ ] **Step 1: Update the renderer unit test (RED) — `intervention-pdf-renderer.test.ts`**

In `BASE` (currently `intervention-pdf-renderer.test.ts:50`): remove the `title: 'Tagliando completo 60.000 km',` line; add `checklistItems: ['Cambio olio', 'Controllo freni'],`.

Fix the existing test titled `renders without throwing with no title, no parts, no customer, no logo` (L110): remove the `title: null,` override line (the field no longer exists on the type — leaving it is a typecheck error). Rename the `it(...)` label to `'renders without throwing with no parts, no customer, no logo'`.

Add two new tests inside the `describe('renderInterventionPdf', ...)` block (reuse the file's existing `extractPdfText` helper):

```ts
it('renders checklist labels under "Voci eseguite" and no "Titolo"', async () => {
  const text = extractPdfText(await renderInterventionPdf(BASE));
  expect(text).toMatch(/Voci eseguite/);
  expect(text).toMatch(/Cambio olio/);
  expect(text).toMatch(/Controllo freni/);
  expect(text).not.toMatch(/Titolo/);
});

it('omits the "Descrizione" label when description is empty', async () => {
  const text = extractPdfText(await renderInterventionPdf({ ...BASE, description: '' }));
  expect(text).not.toMatch(/Descrizione/);
  // checklist still renders — it is the mandatory body
  expect(text).toMatch(/Voci eseguite/);
});
```

- [ ] **Step 2: Run the renderer test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/intervention-pdf-renderer.test.ts`
Expected: FAIL — typecheck error on `checklistItems` missing from `InterventionPdfData` and/or `Titolo`/`Descrizione` assertions failing.

- [ ] **Step 3: Update the renderer — `intervention-pdf-renderer.ts`**

In `InterventionPdfData` (L15): remove `title: string | null;`; add (place it right after `typeName: string;`):

```ts
  typeName: string;
  // BR-300/303/308: frozen checklist labels (already sorted by the caller via
  // serializeChecklistItems). Replaces the removed free-text title as the
  // itemized body of the record. Empty only for legacy/global-type rows.
  checklistItems: string[];
  description: string; // may be '' since #251 (optional); '' → section skipped
```

Replace the current "Title / description" block (L149-158, from the `y -= 4;` through the description `for` loop) with the reordered block (Voci → Descrizione):

```ts
  // --- Voci eseguite (checklist) / Descrizione ---
  // TODO(F-OFF-309): v1 single-page only — no overflow guard; long content can
  // exceed the page bottom. Multi-page deferred.
  // BR-308: no free-text title. BR-300/303: the checklist snapshot is the body.
  if (data.checklistItems.length > 0) {
    y -= 4;
    draw('Voci eseguite:', 11, bold);
    for (const label of data.checklistItems) {
      page.drawText(`${DOT} ${label}`, { x: MARGIN + 12, y, size: 10, font });
      y -= LINE - 2;
    }
  }

  // Description is optional (#251): skip the label entirely when empty so no
  // blank line dangles under a "Descrizione:" heading.
  if (data.description.trim() !== '') {
    y -= 4;
    draw('Descrizione:', 11, bold);
    for (const line of wrapText(data.description, font, 10, contentWidth - 12)) {
      page.drawText(line, { x: MARGIN + 12, y, size: 10, font });
      y -= LINE - 2;
    }
  }
```

(The `--- Parts ---` block below stays exactly as-is, including its leading `y -= 4;`.)

- [ ] **Step 4: Run the renderer test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/intervention-pdf-renderer.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Update the route unit test (RED) — `interventions-pdf.test.ts`**

In `interventionRow()` (L29): remove `title: 'Tagliando',`; add after `partsReplaced: [],`:

```ts
    checklistSelections: [
      { checklistItemId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', labelSnapshot: 'Cambio olio', sortOrderSnapshot: 0 },
    ],
```

In the `200 — streams application/pdf` test (after the existing `dataArg` assertions, ~L161) add:

```ts
    expect(dataArg.checklistItems).toEqual(['Cambio olio']);
    expect(dataArg).not.toHaveProperty('title');
```

- [ ] **Step 6: Run the route unit test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/interventions-pdf.test.ts`
Expected: FAIL — `dataArg.checklistItems` is `undefined` (route not updated yet).

- [ ] **Step 7: Update the route — `interventions-pdf.ts`**

Add the import (alongside the existing renderer import):

```ts
import { serializeChecklistItems } from '../../lib/intervention-shared.js';
```

In `interventionPdfSelect` (L29): remove `title: true,`; add (mirror `interventions-detail.ts:63`):

```ts
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
    orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
  },
```

In the `data: InterventionPdfData = { ... }` object (L114): remove `title: row.title,`; add after `typeName: row.interventionType.nameIt,`:

```ts
          // BR-303/308: frozen snapshot labels, sorted by the shared serializer.
          checklistItems: serializeChecklistItems(row.checklistSelections).map((c) => c.label),
```

- [ ] **Step 8: Run the route unit test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/interventions-pdf.test.ts`
Expected: PASS.

- [ ] **Step 9: Add a checklist selection to the integration test — `interventions-pdf.test.ts`**

Copy the two raw-SQL seed helpers `seedChecklistItem` and `seedChecklistSelection` from `interventions-detail.test.ts:33-73` (verbatim — they use `pgAdmin`/`uniqueCode` already imported there; confirm the same imports exist in this file, add `uniqueCode`/`pgAdmin` from `./helpers.js` / `./fixtures.js` if missing — grep the detail test's import block and mirror it).

In **Case 1** (`200 — owner with CustomerTenantRelation`, after `createIntervention` returns `interventionId`, ~L109), seed one item + selection so the real `checklistSelections` join is exercised:

```ts
    const item = await seedChecklistItem({ interventionTypeId: type.id, sortOrder: 0 });
    await seedChecklistSelection({
      interventionId,
      tenantId,
      checklistItemId: item.id,
      labelSnapshot: item.nameIt,
      sortOrderSnapshot: 0,
    });
```

Keep the existing `expect(res.statusCode).toBe(200)` + `%PDF-` assertions (binary body — no text extraction here; the join not 500-ing on the real schema is the assertion of value). Leave the `title:` args in the other `createIntervention` calls untouched (column still exists).

- [ ] **Step 10: Typecheck the package**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (integration tests themselves run on CI, per `feedback_skip_local_integration_tests`).

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/lib/intervention-pdf-renderer.ts \
        packages/api/src/routes/v1/interventions-pdf.ts \
        packages/api/tests/unit/lib/intervention-pdf-renderer.test.ts \
        packages/api/tests/unit/routes/v1/interventions-pdf.test.ts \
        packages/api/tests/integration/interventions-pdf.test.ts
git commit -m "feat(api): intervention PDF renders checklist, drops title (BR-300,308)"
```

---

### Task 2: Vehicle-history PDF — `renderVehicleHistoryPdf` + `/v1/me/vehicles/:id/export.pdf`

**Files:**
- Modify: `packages/api/src/lib/vehicle-history-pdf-renderer.ts` (per-intervention interface + block layout + pagination height calc)
- Modify: `packages/api/src/routes/v1/me-vehicles-export-pdf.ts` (select: drop `title`, add `checklistSelections`; map labels)
- Test: `packages/api/tests/unit/lib/vehicle-history-pdf-renderer.test.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles-export-pdf.test.ts`
- Test: `packages/api/tests/integration/me-vehicles-export-pdf.test.ts`

**Interfaces:**
- Consumes: `serializeChecklistItems` (as Task 1).
- Produces: `VehicleHistoryInterventionData` with `title` **removed** and `checklistItems: string[]` **added**. `VehicleHistoryPdfData` unchanged.

- [ ] **Step 1: Update the renderer unit test (RED) — `vehicle-history-pdf-renderer.test.ts`**

In the `intervention(i)` factory (L50): remove `title: \`Tagliando ${i}\`,`; add `checklistItems: ['Cambio olio', 'Controllo freni'],`.

Add two new tests inside `describe('renderVehicleHistoryPdf', ...)` (reuse the file's `extractPdfText`):

```ts
it('renders checklist labels under "Voci eseguite" and no "Titolo"', async () => {
  const text = extractPdfText(await renderVehicleHistoryPdf(BASE));
  expect(text).toMatch(/Voci eseguite/);
  expect(text).toMatch(/Cambio olio/);
  expect(text).not.toMatch(/Titolo/);
});

it('renders an intervention with an empty description without error', async () => {
  const buf = await renderVehicleHistoryPdf({
    ...BASE,
    interventions: [{ ...intervention(0), description: '' }],
  });
  const pdf = await PDFDocument.load(buf);
  expect(pdf.getPageCount()).toBe(1);
  // checklist still present even when the description is empty
  expect(extractPdfText(buf)).toMatch(/Voci eseguite/);
});
```

- [ ] **Step 2: Run the renderer test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/vehicle-history-pdf-renderer.test.ts`
Expected: FAIL — typecheck error on `checklistItems` missing / `title` still referenced.

- [ ] **Step 3: Update the renderer — `vehicle-history-pdf-renderer.ts`**

In `VehicleHistoryInterventionData` (L17): remove `title: string | null;`; add after `tenantName: string;`:

```ts
  // BR-300/303/308: frozen checklist labels, already sorted by the caller.
  checklistItems: string[];
  description: string; // may be '' since #251
```

Replace the per-intervention block-height computation (L120-127, from `const descLines = ...` through `const blockHeight = ...`) with:

```ts
      const hasDesc = it.description.trim() !== '';
      const descLines = hasDesc ? wrapText(it.description, font, 10, contentWidth - 12) : [];
      const checkLines = it.checklistItems.length;
      const partLines = it.partsReplaced.length;
      const blockLines =
        2 + // date+km row, type+officina row
        (checkLines > 0 ? 1 + checkLines : 0) + // "Voci eseguite:" + one line each
        descLines.length +
        (partLines > 0 ? 1 + partLines : 0);
      const blockHeight = blockLines * (LINE - 2) + 16;
```

Replace the title + description rendering (L154-161, from `if (it.title) { ... }` through the `descLines` `for` loop) with the reordered block (Voci → Descrizione):

```ts
      if (checkLines > 0) {
        page.drawText('Voci eseguite:', { x: MARGIN, y, size: 10, font: bold });
        y -= LINE - 2;
        for (const label of it.checklistItems) {
          page.drawText(`${DOT} ${label}`, { x: MARGIN + 12, y, size: 10, font });
          y -= LINE - 2;
        }
      }
      for (const dl of descLines) {
        page.drawText(dl, { x: MARGIN + 12, y, size: 10, font });
        y -= LINE - 2;
      }
```

(The `Ricambi:` block below stays exactly as-is. `descLines` is `[]` when the description is empty, so nothing is drawn and no blank line dangles.)

- [ ] **Step 4: Run the renderer test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/vehicle-history-pdf-renderer.test.ts`
Expected: PASS (including the existing multi-page and empty-state tests — the height calc still paginates correctly).

- [ ] **Step 5: Update the route unit test (RED) — `me-vehicles-export-pdf.test.ts`**

In `interventionRow()` (L41): remove `title: 'Tagliando',`; add after `partsReplaced: [],`:

```ts
    checklistSelections: [
      { checklistItemId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', labelSnapshot: 'Cambio olio', sortOrderSnapshot: 0 },
    ],
```

In the happy-path test that asserts the renderer received the mapped rows (the one calling `renderVehicleHistoryPdf` — grep for `mock.calls[0]` / the `dataArg`), add:

```ts
    expect(dataArg.interventions[0].checklistItems).toEqual(['Cambio olio']);
    expect(dataArg.interventions[0]).not.toHaveProperty('title');
```

(If the existing happy-path test does not already capture `dataArg`, capture it: `const dataArg = vi.mocked(renderVehicleHistoryPdf).mock.calls[0]![0];`.)

- [ ] **Step 6: Run the route unit test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles-export-pdf.test.ts`
Expected: FAIL — `checklistItems` undefined on the mapped intervention.

- [ ] **Step 7: Update the route — `me-vehicles-export-pdf.ts`**

Add the import:

```ts
import { serializeChecklistItems } from '../../lib/intervention-shared.js';
```

In the `tx.intervention.findMany` select (L69): remove `title: true,`; add:

```ts
            checklistSelections: {
              select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
              orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
            },
```

In the `interventions.map((it) => ({ ... }))` (L93): remove `title: it.title,`; add after `typeName: it.interventionType.nameIt,`:

```ts
            checklistItems: serializeChecklistItems(it.checklistSelections).map((c) => c.label),
```

- [ ] **Step 8: Run the route unit test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles-export-pdf.test.ts`
Expected: PASS.

- [ ] **Step 9: Add a checklist selection to the integration test — `me-vehicles-export-pdf.test.ts`**

Mirror Task 1 Step 9: add the `seedChecklistItem` + `seedChecklistSelection` raw-SQL helpers (copy from `interventions-detail.test.ts:33-73`; verify/add the `pgAdmin`/`uniqueCode` imports). In the happy-path 200 case, after the intervention is created, seed one item + selection scoped to that intervention's tenant/type. Keep the existing 200 + `%PDF-` assertions. Leave other `createIntervention` `title:` args untouched.

- [ ] **Step 10: Typecheck the package**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/lib/vehicle-history-pdf-renderer.ts \
        packages/api/src/routes/v1/me-vehicles-export-pdf.ts \
        packages/api/tests/unit/lib/vehicle-history-pdf-renderer.test.ts \
        packages/api/tests/unit/routes/v1/me-vehicles-export-pdf.test.ts \
        packages/api/tests/integration/me-vehicles-export-pdf.test.ts
git commit -m "feat(api): vehicle-history PDF renders checklist, drops title (BR-300,308)"
```

---

## After both tasks

- [ ] **Whole-package typecheck (pre-push gate):** `pnpm -r typecheck` → green.
- [ ] **Final whole-branch review:** `/code-review high` (load-bearing gate — cross-references schema.prisma select fields, BR citations, cross-task consistency of the `title`→`checklistItems` interface swap). Apply Critical/Important; list Minor in the PR description.
- [ ] **Visual smoke (device-facing BLOCKER):** generate one PDF from each endpoint against a real intervention with checklist items (and one with an empty description) and open it — confirm: heading = intervention type name, a "Voci eseguite" bulleted section, no "Titolo", no dangling "Descrizione:" when the description is empty. Runbook: local `pnpm --filter @garageos/api dev` + authenticated `GET /v1/interventions/:id/pdf` and `/v1/me/vehicles/:id/export.pdf`, or open the generated PDF from a debug script writing the renderer output to disk.
- [ ] **PR:** open, watch CI green (`gh pr checks --watch`) — integration tests (real Postgres) are the RLS/join gate — then squash-merge.
- [ ] **Do NOT drop the `title` column.** Update `project_resume_checkpoint.md` / `.superpowers/sdd/progress.md`: PR-6 done (6/7); remaining title readers = mobile (PR-7) + `vehicles-timeline` Deviation#2; DROP column only after PR-7.
```

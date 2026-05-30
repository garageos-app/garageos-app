# Test-quality bundle round 2 — design

**Date:** 2026-05-30
**Type:** `test(api,web)` — test-quality + cosmetic cleanup, zero behavior-change
**Branch (proposed):** `test/quality-bundle-r2`

## What

A maintenance PR that clears 7 accumulated minor test-quality / cosmetic items
flagged by final-Opus reviews across PR #124–#133. No production behavior
changes. The two production-code touches (#7, #9) are behavior-neutral (dead-code
removal and a de-duplicated lookup), both covered by existing tests.

## Why

After a feature run (#133), the open minor backlog is a good moment to clear
debt before it compounds. Items come from the tech-debt ledger and the #133
Opus review (see `project_resume_checkpoint.md` and `project_tech_debt.md`).

**Explicitly excluded (out of scope — real behavior changes, not test-quality):**

- **#5 QR decode from embedded PDF** — deferred feature, needs PDF parsing; not cleanup.
- **#6 tag button ignores `vehicle.status`** — UI bugfix with BR/UX implications;
  deserves its own brainstorming + smoke, not a "no-behavior" bundle.

## Scope — 7 items

| # | File | Change | Class |
|---|------|--------|-------|
| 1 | `packages/api/tests/unit/routes/v1/interventions-recent.test.ts` (~266-288) | Extract a typed accessor helper (mirror of the existing `whereStatus` pattern) for `select.vehicle/user` instead of the inline duplicated cast literal. `.toEqual` assertions unchanged. | test-quality |
| 2 | `packages/web/src/queries/interventionsRecent.test.tsx` (**new file**) | Add the missing query-layer test, mirroring `deadlinesList.test.tsx` / `customerSearch.test.tsx`: assert `apiFetch` is called with `/v1/interventions/recent?limit=10` and that the hook returns `res.items`. **No change to `interventionsRecent.ts`** — wire stays as-is. | test-only (add) |
| 3 | `packages/api/tests/unit/routes/v1/disputes-open.test.ts` (154-162, 235, 275) | Route the 2 inline casts through the existing `whereStatus` / `isInProgressFilter` helpers; replace the order-dependent `count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)` mocks with `mockImplementation` threaded on `whereStatus` (consistent with lines 168/190). | test-quality |
| 4 | `packages/api/tests/unit/routes/v1/disputes-open.test.ts:15` | Tighten `type StatusFilter = string \| { in: string[] }` → `'open' \| { in: Array<'responded' \| 'escalated'> }` (the real status values). | test-quality (type) |
| 7 | `packages/web/src/lib/deadline-suggestion.ts` (35-40) | Remove the unreachable `\| null` return branch: `formatDeadlineSuggestion` always returns `string` (every caller already gates on `deriveDeadlineSuggestion`, which guarantees ≥1 default). Update the JSDoc. | cosmetic (dead code) |
| 8 | `packages/web/src/components/intervention-form/InterventionForm.test.tsx:133` (+ `DeadlineSection.test.tsx:50`) | Replace the hardcoded `15.000` literal with an expectation computed via `formatDeadlineSuggestion(deriveDeadlineSuggestion(type))`, so the assertion tracks the real formatter and is ICU-independent. | test-quality |
| 9 | `packages/web/src/components/intervention-form/InterventionForm.tsx` (74, 84-85) | Remove the duplicated `interventionTypes.find(...)`: reuse `selectedType` inside the `useEffect` (adding it to the deps array) instead of recomputing it inline. | cosmetic (dedup) |

## Guarantees

- No changes to route handlers, Prisma schema, API wire contract, CDK, or product docs.
- The only production-code edits are **#7** (remove unreachable branch) and **#9**
  (de-duplicate a `find`), both behavior-neutral and covered by existing tests.

## Item interpretation notes (for reviewer)

- **#2** — `interventionsRecent.ts` always sending `?limit=${limit}` is *consistent*
  with siblings (`deadlinesList`, `customerSearch`, `deadlinesUpcoming` all do the
  same). The real gap is the *missing* dedicated query-layer test (the hook is only
  covered indirectly via component mocks). The "test-only" remediation is therefore
  to **add** that test, not to alter the wire. Flagged for confirmation at the spec
  review gate.
- **#8** — the same hardcoded-`15.000` brittleness also exists at
  `DeadlineSection.test.tsx:50`; fixing both in one pass keeps the formatter-driven
  assertion pattern consistent.
- **#9** — reuse approach (thread `selectedType` into the effect) chosen over
  inlining, because it removes the duplicate `find` rather than just relocating it.

## Testing

- `pnpm -r typecheck` (pre-push gate).
- Run the touched suites locally while debugging only:
  - `pnpm --filter @garageos/api test -- interventions-recent disputes-open`
  - `pnpm --filter @garageos/web test -- interventionsRecent InterventionForm DeadlineSection deadline-suggestion`
- CI runs the full matrix on the PR.

## Out of scope

#5 (QR decode from PDF), #6 (tag button status gate). Both remain in the tech-debt
ledger for dedicated PRs.

## Pre-flight notes (active memory patterns)

- #7 touches pure `web/src/lib` (no Radix/jsdom polyfill needed).
- #8 reuses the `formatKm` pattern already present in tests.
- No item touches Vehicle scope, integration mock helpers, or `@updatedAt` tables.

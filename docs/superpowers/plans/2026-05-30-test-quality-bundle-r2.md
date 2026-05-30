# Test-quality bundle round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear 7 accumulated minor test-quality / cosmetic items (PR #124–#133 reviews) in a single `test(api,web)` PR with zero production behavior change.

**Architecture:** Six independent tasks, each touching one concern. Five are test-file edits or a new test; two production touches (#7, #9) are behavior-neutral and guarded by existing passing tests (run-green-before → refactor → run-green-after).

**Tech Stack:** Vitest (api unit + web), Fastify inject, `@testing-library/react` + `renderHook`, React Hook Form, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-05-30-test-quality-bundle-r2-design.md`

**Branch:** `test/quality-bundle-r2` (already created; spec already committed there).

---

## File map

- `packages/web/src/queries/interventionsRecent.test.tsx` — **create** (Task 1, item #2)
- `packages/api/tests/unit/routes/v1/interventions-recent.test.ts` — modify (Task 2, item #1)
- `packages/api/tests/unit/routes/v1/disputes-open.test.ts` — modify (Task 3, items #3 + #4)
- `packages/web/src/lib/deadline-suggestion.ts` — modify (Task 4, item #7)
- `packages/web/src/components/intervention-form/InterventionForm.test.tsx` — modify (Task 5, item #8)
- `packages/web/src/components/intervention-form/DeadlineSection.test.tsx` — modify (Task 5, item #8)
- `packages/web/src/components/intervention-form/InterventionForm.tsx` — modify (Task 6, item #9)

---

## Task 1: Add missing query-layer test for `useInterventionsRecent` (item #2)

The hook is currently only exercised indirectly through component mocks. Siblings
(`deadlinesList`, `customerSearch`, `deadlinesUpcoming`) each have a dedicated
query-layer test asserting the `apiFetch` URL + return shape. Add the missing one,
mirroring `deadlinesList.test.tsx`. **Do not change `interventionsRecent.ts`.**

Note the hook's `queryFn` returns `res.items` (a `RecentIntervention[]`), not the
raw response — assert on the unwrapped array.

**Files:**
- Create: `packages/web/src/queries/interventionsRecent.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useInterventionsRecent } from './interventionsRecent';
import type { InterventionsRecentResponse, RecentIntervention } from './interventionsRecent';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const ITEM: RecentIntervention = {
  id: 'i1',
  createdAt: '2026-05-23T10:00:00.000Z',
  status: 'active',
  summary: 'Tagliando',
  vehicle: { id: 'v1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  operator: { id: 'u1', name: 'Giuseppe Rossi' },
};

describe('useInterventionsRecent', () => {
  it('fires the query with the default limit=10', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/recent?limit=10');
  });

  it('passes a custom limit through to the URL', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(25), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/recent?limit=25');
  });

  it('unwraps and returns res.items', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [ITEM] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([ITEM]);
  });
});
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `pnpm --filter @garageos/web test -- interventionsRecent`
Expected: PASS (3 tests). Production code already produces this behavior.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/queries/interventionsRecent.test.tsx
git commit -m "test(web): add query-layer test for useInterventionsRecent (#2)"
```

---

## Task 2: De-brittle the select-shape assertion in `interventions-recent.test.ts` (item #1)

The last test (`select clause requests vehicle ... and user ...`) hand-casts the
`findMany` call argument with an inline structural type literal. Centralize that
cast into a single typed accessor near the top of the file, mirroring the existing
`whereStatus` idiom used in `disputes-open.test.ts`. Assertions stay identical.

**Files:**
- Modify: `packages/api/tests/unit/routes/v1/interventions-recent.test.ts`

- [ ] **Step 1: Confirm the suite is green before editing**

Run: `pnpm --filter @garageos/api test -- interventions-recent`
Expected: PASS (all existing tests).

- [ ] **Step 2: Add the typed accessor helper**

Insert after the `COGNITO_SUB` constant (around line 39), before `interface FakePrisma`:

```ts
interface FindManySelect {
  vehicle: { select: Record<string, true> };
  user: { select: Record<string, true> };
}

/** Typed accessor for the `select` clause of the findMany call argument. */
function findManySelect(args: unknown): FindManySelect {
  return (args as { select: FindManySelect }).select;
}
```

- [ ] **Step 3: Rewrite the assertion to use the accessor**

Replace the body of the `select clause requests vehicle ... and user ...` test
(the block currently at lines 274-287) with:

```ts
    const select = findManySelect(prisma.intervention.findMany.mock.calls[0]![0]);
    expect(select.vehicle.select).toEqual({
      id: true,
      plate: true,
      make: true,
      model: true,
    });
    expect(select.user.select).toEqual({
      id: true,
      firstName: true,
      lastName: true,
    });
```

- [ ] **Step 4: Run the suite, verify still green**

Run: `pnpm --filter @garageos/api test -- interventions-recent`
Expected: PASS (same test count as Step 1).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/tests/unit/routes/v1/interventions-recent.test.ts
git commit -m "test(api): centralize select-shape accessor in interventions-recent (#1)"
```

---

## Task 3: Route casts through helpers + tighten `StatusFilter` in `disputes-open.test.ts` (items #3 + #4)

Two cast sites bypass the existing `whereStatus` / `isInProgressFilter` helpers, and
two `count` mocks use order-dependent `mockResolvedValueOnce` instead of threading
the filter. Route everything through the helpers, and tighten the lax `StatusFilter`
type to the real status values.

**Files:**
- Modify: `packages/api/tests/unit/routes/v1/disputes-open.test.ts`

- [ ] **Step 1: Confirm the suite is green before editing**

Run: `pnpm --filter @garageos/api test -- disputes-open`
Expected: PASS (all existing tests).

- [ ] **Step 2: Tighten the `StatusFilter` type (item #4)**

Replace line 15:

```ts
type StatusFilter = string | { in: string[] };
```

with:

```ts
type StatusFilter = 'open' | { in: Array<'responded' | 'escalated'> };
```

The helpers stay valid: `isInProgressFilter` still does
`typeof status === 'object' && Array.isArray(status.in)`, and `whereStatus(args) === 'open'`
comparisons remain type-correct.

- [ ] **Step 3: Route the inProgress test casts through the helpers (item #3, site A)**

In the test `inProgress uses status IN (responded, escalated) filter`, replace the
`inProgressCall` discovery + assertion block (currently lines 153-162) with:

```ts
    const calls = prisma.interventionDispute.findMany.mock.calls;
    const inProgressCall = calls.find((c) => isInProgressFilter(whereStatus(c[0])));
    expect(inProgressCall).toBeDefined();
    const status = whereStatus(inProgressCall![0]);
    expect(typeof status === 'object' ? status.in.slice().sort() : null).toEqual([
      'escalated',
      'responded',
    ]);
```

- [ ] **Step 4: Thread the `count` mocks via `whereStatus` (item #3, site B)**

In the test `uses businessName for isBusiness customer when visible` replace
(currently line 235):

```ts
    prisma.interventionDispute.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
```

with:

```ts
    prisma.interventionDispute.count.mockImplementation(async (args: unknown) =>
      whereStatus(args) === 'open' ? 1 : 0,
    );
```

In the test `falls back to "Cliente" when CustomerTenantRelation is missing (BR-151 PII)`
replace the same line (currently line 275) with the identical `mockImplementation` block above.

- [ ] **Step 5: Run the suite, verify still green**

Run: `pnpm --filter @garageos/api test -- disputes-open`
Expected: PASS (same test count as Step 1).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/tests/unit/routes/v1/disputes-open.test.ts
git commit -m "test(api): route disputes-open casts through helpers, tighten StatusFilter (#3,#4)"
```

---

## Task 4: Remove the unreachable `| null` branch in `formatDeadlineSuggestion` (item #7)

`formatDeadlineSuggestion` returns `string | null`, but the `null` branch is
unreachable in production: the only caller (`DeadlineSection.tsx:16`,
`suggestion ? formatDeadlineSuggestion(suggestion) : null`) gates on `suggestion`
truthiness, and `deriveDeadlineSuggestion` guarantees at least one non-null default
on any `DeadlineSuggestion` it produces. Drop the dead branch; the function always
returns `string`. `DeadlineSection` needs no change (`suggestionText && ...` still
works with a non-empty string).

**Files:**
- Modify: `packages/web/src/lib/deadline-suggestion.ts`

- [ ] **Step 1: Confirm green before editing**

Run: `pnpm --filter @garageos/web test -- deadline-suggestion DeadlineSection`
Expected: PASS.

- [ ] **Step 2: Edit the function and its JSDoc**

Replace the `formatDeadlineSuggestion` block (lines 29-41) with:

```ts
/**
 * Human-readable Italian suggestion line, e.g.
 * "Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi."
 * Callers gate on deriveDeadlineSuggestion, which guarantees at least one of
 * km/months is present, so at least one part is always produced.
 */
export function formatDeadlineSuggestion(s: DeadlineSuggestion): string {
  const parts: string[] = [];
  if (s.km != null) parts.push(formatKm(s.km));
  if (s.months != null) parts.push(`${s.months} ${s.months === 1 ? 'mese' : 'mesi'}`);
  return `Suggerito per «${s.typeName}»: prossima scadenza tra ${parts.join(' o ')}.`;
}
```

- [ ] **Step 3: Verify no caller relied on the `null` return**

Run: `pnpm exec grep -rn "formatDeadlineSuggestion" packages/web/src`
Expected: only `deadline-suggestion.ts` (definition) and `DeadlineSection.tsx:16`
(`suggestion ? formatDeadlineSuggestion(suggestion) : null`). No call site compares
the result to `null`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @garageos/web test -- deadline-suggestion DeadlineSection`
Then: `pnpm --filter @garageos/web typecheck`
Expected: PASS, no type errors. (If `deadline-suggestion.test.ts` asserts a `null`
return for an all-null input, delete that now-impossible-to-construct case — a
`DeadlineSuggestion` reaching this function always has ≥1 default.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/deadline-suggestion.ts
git commit -m "refactor(web): drop unreachable null branch in formatDeadlineSuggestion (#7)"
```

---

## Task 5: Make the suggestion-line assertions ICU-independent (item #8)

Two tests hardcode the `15.000` thousands-separator literal, which depends on a
full-ICU Node build producing the `it-IT` separator. Compute the expected string
from the real formatter instead, so the assertion tracks `formatKm` regardless of
ICU availability.

**Files:**
- Modify: `packages/web/src/components/intervention-form/InterventionForm.test.tsx`
- Modify: `packages/web/src/components/intervention-form/DeadlineSection.test.tsx`

- [ ] **Step 1: Confirm green before editing**

Run: `pnpm --filter @garageos/web test -- InterventionForm DeadlineSection`
Expected: PASS.

- [ ] **Step 2: InterventionForm.test.tsx — import the formatter and compute the expected line**

Add to the imports (after line 5):

```ts
import { deriveDeadlineSuggestion, formatDeadlineSuggestion } from '@/lib/deadline-suggestion';
```

In the test `auto-opens and pre-fills the deadline section for a suggesting type`,
replace the hardcoded `getByText('Suggerito per «Tagliando»: ...')` assertion
(currently lines 132-134) with:

```ts
    const expected = formatDeadlineSuggestion(deriveDeadlineSuggestion(types[0]!)!);
    expect(screen.getByText(expected)).toBeInTheDocument();
```

(`types[0]` is the `Tagliando` fixture with `defaultDeadlineMonths: 12`,
`defaultDeadlineKm: 15000`.)

- [ ] **Step 3: DeadlineSection.test.tsx — compute the expected line from the same formatter**

Add to the imports (after line 6):

```ts
import { formatDeadlineSuggestion } from '@/lib/deadline-suggestion';
```

In the test `renders the suggestion line when a suggestion is provided`, replace the
hardcoded assertion (currently lines 49-51) with:

```ts
    const suggestion = { typeName: 'Tagliando', months: 12, km: 15000 };
    render(<Wrap enabled={true} suggestion={suggestion} />);
    expect(screen.getByText(formatDeadlineSuggestion(suggestion))).toBeInTheDocument();
```

(Move the `render(<Wrap ... />)` call so it uses the `suggestion` const; the existing
`render` on line 48 is replaced by this block.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @garageos/web test -- InterventionForm DeadlineSection`
Then: `pnpm --filter @garageos/web typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/intervention-form/InterventionForm.test.tsx packages/web/src/components/intervention-form/DeadlineSection.test.tsx
git commit -m "test(web): compute suggestion-line assertions from formatter, ICU-independent (#8)"
```

---

## Task 6: De-duplicate the type lookup in `InterventionForm.tsx` (item #9)

The component computes `selectedType = interventionTypes.find(...)` at line 74, then
recomputes the identical `find` inside the `useEffect` at lines 84-85. Reuse
`selectedType` in the effect (adding it to the dependency array) to remove the
duplicate lookup.

**Files:**
- Modify: `packages/web/src/components/intervention-form/InterventionForm.tsx`

- [ ] **Step 1: Confirm green before editing**

Run: `pnpm --filter @garageos/web test -- InterventionForm`
Expected: PASS.

- [ ] **Step 2: Reuse `selectedType` inside the effect**

Replace the `useEffect` head (currently lines 83-86):

```ts
  useEffect(() => {
    const suggestion = deriveDeadlineSuggestion(
      interventionTypes.find((t) => t.id === interventionTypeId) ?? null,
    );
```

with:

```ts
  useEffect(() => {
    const suggestion = deriveDeadlineSuggestion(selectedType);
```

Then update the dependency array (currently line 99) from:

```ts
  }, [interventionTypeId, interventionTypes, methods]);
```

to:

```ts
  }, [selectedType, methods]);
```

(`selectedType` is derived from `interventionTypeId` + `interventionTypes`, so the
effect still re-runs on the same triggers; `deadlineSuggestion` at line 75 is
unaffected.)

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm --filter @garageos/web test -- InterventionForm`
Then: `pnpm --filter @garageos/web typecheck`
Expected: PASS (all 8 InterventionForm tests, including the type-change re-apply and
km-only switch cases), no type errors, no exhaustive-deps lint warning.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/intervention-form/InterventionForm.tsx
git commit -m "refactor(web): reuse selectedType in deadline effect, drop duplicate find (#9)"
```

---

## Final verification (before PR)

- [ ] **Full typecheck (pre-push gate):** `pnpm -r typecheck` — expected clean.
- [ ] **Touched suites green:**
  - `pnpm --filter @garageos/api test -- interventions-recent disputes-open`
  - `pnpm --filter @garageos/web test -- interventionsRecent InterventionForm DeadlineSection deadline-suggestion`
- [ ] **Prettier on changed files:** `pnpm exec prettier --check` on the modified/created files (avoid CI `format:check` failure).
- [ ] **Diff sanity:** only the 7 files in the file map are changed; no route handler, schema, wire, CDK, or product-doc edits. Confirm with `git diff --stat origin/main`.
- [ ] Push and open PR with the conventional title `test(api,web): test-quality bundle r2 (#124-#133 minors)` and the PR template from CLAUDE.md, listing items #1,#2,#3,#4,#7,#8,#9 and noting #5/#6 explicitly out of scope.

## Notes / risks

- **No new dependencies.** All tooling (vitest, testing-library, react-query) already present.
- **#7 / #9 are the only production touches**, both behavior-neutral and covered by existing tests run green before and after.
- **Lint exhaustive-deps (#9):** changing the effect deps to `[selectedType, methods]`
  is correct because `selectedType` already encodes `interventionTypeId` + `interventionTypes`.
  If the ESLint `react-hooks/exhaustive-deps` rule flags it (it should not, since
  `selectedType` is the only external value referenced), do not suppress — re-derive
  the deps from the rule's expectation.

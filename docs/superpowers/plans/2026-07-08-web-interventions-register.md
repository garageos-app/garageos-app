# Registro Interventi (web officina) — PR-2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/interventions` page in the officina web app — a paginated, filterable, sortable table of *all* the tenant's interventions — consuming the already-merged `GET /v1/interventions` endpoint (PR-1, #259), and enable the `Interventi` sidebar item + route.

**Architecture:** Single-layer web slice (no backend change). URL query string is the **source of truth** for all filter/sort/page state via react-router `useSearchParams`; a pure parse/serialize pair converts between `URLSearchParams` and a typed params object. A `useInterventionsList` `useQuery` hook mirrors the wire contract, keyed on the full params object with `placeholderData: keepPreviousData` for smooth pagination. Presentational pieces (`InterventionsFilterBar`, `MultiSelectPopover`, `InterventionsTable`, pagination) are hand-rolled following existing patterns (`CustomerList.tsx` table, `CustomerAutocomplete.tsx` Command popover) — this codebase has **no shared Table/Pagination/Checkbox primitive and no i18n** (Italian strings are inline).

**Tech Stack:** React + Vite + TypeScript, @tanstack/react-query v5, react-router-dom v6, shadcn/ui (Radix), Tailwind, vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-08-web-interventions-register-design.md`

**LOC budget:** target ~900 net, hard PR limit 1500. Check cumulative `git diff --stat` after each task; halt and ask at ~80% (~1200).

## Global Constraints

- **No i18n** — user-facing strings are Italian literals inline (convention: `// IT-strings — hardcoded` top-of-file comment). Code comments in English.
- **No new dependency** without justification in the PR description (all primitives below already exist in `packages/web`).
- TypeScript strict; no `any` without a justifying comment.
- Tests: Tier-2 web = 2-3 targeted tests per surface (happy path, error/empty state, conditional logic). **No pure-rendering tests.**
- Commit messages: Conventional Commits, scope `web`, summary ≤72 chars, imperative present, lowercase, no trailing period.
- Branch: `feat/web-interventions-register` (depends on PR-1 #259, already on `main`).

## Deviations from spec (verified against actual code — the code wins)

1. **Operator filter data source (spec §4.1).** The spec says the Operatore multiselect reads `GET /v1/users`. That endpoint is gated `requireSuperAdmin` (`packages/api/src/routes/v1/users-list.ts:18`) — a `mechanic` gets **403**. **Decision (Michele, 2026-07-08): gate the Operatore filter to super_admin only** via `useHasRole('super_admin')`. Mechanics see every other filter but not the operator one. PR-2 stays web-only (no new endpoint). The `Operatore` **table column** is always shown (data comes from the list response, not `/v1/users`).
2. **Checklist-filter guard error code (spec §3.2).** The spec proposed a dedicated error code `intervention.list.checklist_filter_requires_single_type`. PR-1 actually implemented the guard as a plain Zod `.refine` → `VALIDATION_ERROR` (`interventions-list.schema.ts:75-78`). The web page **never sends** `checklistItemIds` unless exactly one `typeId` is selected (the checklist multiselect only renders in that state and is cleared otherwise), so no user-facing error path exists. No web work needed here beyond that invariant.
3. **`q` searches vehicle fields only (spec §3.2 / BR-151).** PR-1 implemented `q` against vehicle `plate`/`make`/`model` only (no customer name) — `interventions-list.ts:59-68`. The table has no customer-name column, so this is invisible to the user. Confirmed, no deviation to resolve.

## Gotchas the implementer MUST respect (from project memory)

- **Wire contract is fixed by PR-1** — mirror `interventions-list.ts:138-159` exactly. Response `{ items, total, page, pageSize }`; item `{ id, interventionDate: 'YYYY-MM-DD', odometerKm: number, status: 'active'|'disputed'|'cancelled', type:{id,nameIt}, vehicle:{id,plate,make,model}, operator:{id,name} }`. `[[feedback_verify_api_contract_against_backend]]`.
- **Gate render with `isLoading || !data`**, not `data!` — a warm-cache offline query can be `success` with `undefined` data. `[[feedback_react_query_data_bang_offline_paused]]`.
- **react-query v5**: use `placeholderData: keepPreviousData` (imported from `@tanstack/react-query`) for pagination continuity; there is no `keepPreviousData: true` option. The codebase is v5 (`customersList.ts` uses `initialPageParam`).
- **Radix Select/Popover/Command in JSDOM**: pointer-capture + scrollIntoView + ResizeObserver are already polyfilled in `packages/web/tests/setup.ts`. Use `userEvent.click`, not `fireEvent`, to open Radix popovers. `[[feedback_radix_tabs_user_event_not_fire_event]]`, `[[feedback_radix_select_jsdom_pointer_polyfill]]`.
- **Enabling the sidebar item breaks `Sidebar.test.tsx:53-56`** (asserts `Interventi` is `aria-disabled`). That test MUST be rewritten in the same task. `[[feedback_new_required_field_breaks_preexisting_happy_tests]]`, `[[feedback_t7_test_cascade]]`.
- **Row-click vs vehicle-link conflict**: the row navigates to `/interventions/:id`; the vehicle cell links to `/vehicles/:id`. The vehicle link's `onClick` MUST `stopPropagation()` so it doesn't also trigger the row navigation.
- **Empty status selection**: PR-1's schema maps `status=` (empty) back to the default `['active','disputed']` (`interventions-list.schema.ts:52-57`). To keep UI and results consistent, when the user clears all status chips the page **removes** the `status` param entirely (both UI display and API fall back to the same default set).

## Branch

```bash
git checkout main && git pull origin main
git checkout -b feat/web-interventions-register
```

---

### Task 1: Query hook `useInterventionsList` + URL param serialization

**Files:**
- Create: `packages/web/src/queries/interventionsList.ts`
- Test: `packages/web/src/queries/interventionsList.test.tsx`

**Interfaces:**
- Consumes: `useApiFetch` from `@/lib/api-client` (returns `apiFetch<T>(path) => Promise<T>`); `keepPreviousData` from `@tanstack/react-query`.
- Produces (later tasks rely on these exact names/types):
  ```ts
  export type InterventionStatus = 'active' | 'disputed' | 'cancelled';
  export type InterventionSort = 'date' | 'status' | 'type' | 'operator' | 'km';
  export type SortOrder = 'asc' | 'desc';

  export interface InterventionListItem {
    id: string;
    interventionDate: string; // 'YYYY-MM-DD'
    odometerKm: number;
    status: InterventionStatus;
    type: { id: string; nameIt: string };
    vehicle: { id: string; plate: string; make: string; model: string };
    operator: { id: string; name: string };
  }
  export interface InterventionsListResponse {
    items: InterventionListItem[];
    total: number;
    page: number;
    pageSize: number;
  }
  // The typed, normalized filter/sort/page state (source of truth = URL).
  export interface InterventionsListParams {
    page: number;
    q: string;                 // '' when unset
    status: InterventionStatus[]; // [] means "default" (active,disputed); page omits param
    typeId: string[];
    checklistItemIds: string[];
    operatorId: string[];
    dateFrom: string;          // '' when unset ('YYYY-MM-DD' otherwise)
    dateTo: string;
    sort: InterventionSort;
    order: SortOrder;
  }
  export const PAGE_SIZE = 25;
  export const DEFAULT_STATUS: InterventionStatus[] = ['active', 'disputed'];
  export function parseInterventionsParams(sp: URLSearchParams): InterventionsListParams;
  export function serializeInterventionsParams(p: InterventionsListParams): URLSearchParams;
  export function useInterventionsList(p: InterventionsListParams): UseQueryResult<InterventionsListResponse, ApiError>;
  ```

**Behavioral contract:**
- `parseInterventionsParams`: read `page` (int ≥1, default 1), `q` (default ''), `status`/`typeId`/`checklistItemIds`/`operatorId` (CSV → trimmed non-empty array; default []), `dateFrom`/`dateTo` (default ''), `sort` (default 'date'), `order` (default 'desc'). Unknown `sort`/`order` fall back to defaults. `status` empty/absent → `[]` (the page treats `[]` as "show default set"; it does not expand to DEFAULT_STATUS here).
- `serializeInterventionsParams`: inverse. Omit any param that is empty/`[]`, omit `page` when 1, omit `sort` when 'date', omit `order` when 'desc' (canonical minimal URL). Arrays joined by ','.
- `useInterventionsList`: builds the API query string from `p` (join arrays with ','; omit empties; **omit `checklistItemIds` unless `typeId.length === 1`** as a defensive guard mirroring the schema refine; always send `pageSize=25`). `queryKey: ['interventions', 'list', p]`. `queryFn: () => apiFetch<InterventionsListResponse>(\`/v1/interventions?${qs}\`)`. `placeholderData: keepPreviousData`, `staleTime: 60_000`.

- [ ] **Step 1: Write failing tests**

Cover, in `interventionsList.test.tsx`:
- `parseInterventionsParams(new URLSearchParams('page=2&q=fiat&status=active,cancelled&typeId=t1&sort=km&order=asc'))` → `{ page:2, q:'fiat', status:['active','cancelled'], typeId:['t1'], checklistItemIds:[], operatorId:[], dateFrom:'', dateTo:'', sort:'km', order:'asc' }`.
- `parseInterventionsParams(new URLSearchParams(''))` → all defaults (`page:1, status:[], sort:'date', order:'desc'`, empties).
- `serializeInterventionsParams({page:1,q:'',status:[],typeId:[],checklistItemIds:[],operatorId:[],dateFrom:'',dateTo:'',sort:'date',order:'desc'}).toString()` → `''` (fully canonical → empty).
- `serializeInterventionsParams({...defaults, page:3, status:['cancelled'], typeId:['a','b']}).toString()` contains `page=3`, `status=cancelled`, `typeId=a%2Cb` and nothing else.
- Hook (via `renderHook` + `QueryClientProvider`, mocking `@/lib/api-client` → `{ useApiFetch: () => apiFetchMock }`, `apiFetchMock.mockResolvedValue(sampleResponse)`): calling `useInterventionsList({...defaults, page:2, typeId:['t1'], checklistItemIds:['c1']})` calls `apiFetch` with a URL containing `page=2`, `pageSize=25`, `typeId=t1`, `checklistItemIds=c1`.
- Guard: `useInterventionsList({...defaults, typeId:['t1','t2'], checklistItemIds:['c1']})` calls `apiFetch` with a URL that does **not** contain `checklistItemIds` (guard dropped it).

- [ ] **Step 2: Run — expect FAIL** (`pnpm --filter @garageos/web test -- interventionsList` → module not found / assertions fail).
- [ ] **Step 3: Implement** `interventionsList.ts` per the contract above. Mirror the hook-shape of `queries/interventionsRecent.ts` and `queries/interventionTypes.ts`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(web): add useInterventionsList hook and url param codec`

---

### Task 2: `MultiSelectPopover` reusable component

**Files:**
- Create: `packages/web/src/components/interventions/MultiSelectPopover.tsx`
- Test: `packages/web/src/components/interventions/MultiSelectPopover.test.tsx`

**Interfaces:**
- Consumes: `Popover, PopoverTrigger, PopoverContent` from `@/components/ui/popover`; `Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty` from `@/components/ui/command`; `Button` from `@/components/ui/button`; `Badge` from `@/components/ui/badge`; `Check`/`ChevronsUpDown` from `lucide-react`.
- Produces:
  ```ts
  export interface MultiSelectOption { value: string; label: string }
  export interface MultiSelectPopoverProps {
    label: string;                 // e.g. "Stato"
    options: MultiSelectOption[];
    selected: string[];
    onChange: (next: string[]) => void;
    searchable?: boolean;          // show CommandInput; default false
    emptyText?: string;            // CommandEmpty text; default "Nessun risultato."
    disabled?: boolean;
  }
  export function MultiSelectPopover(props: MultiSelectPopoverProps): JSX.Element
  ```

**Behavioral contract:**
- Trigger `Button variant="outline"` shows `label` and, when `selected.length > 0`, a count `Badge variant="secondary"` (`{selected.length}`). `ChevronsUpDown` icon at the end.
- `PopoverContent` holds a `Command` (`shouldFilter={searchable}`). Each option is a `CommandItem` toggling membership: `onSelect` → `onChange(selected.includes(v) ? selected.filter(x=>x!==v) : [...selected, v])`. Selected items render a `Check` icon (`opacity-100` vs `opacity-0`).
- `CommandInput` rendered only when `searchable`. `CommandEmpty` shows `emptyText`.
- `disabled` disables the trigger.

- [ ] **Step 1: Write failing tests** — render with 3 options, `selected=[]`; `userEvent.click` the trigger; assert options visible; click an option → `onChange` called with `['<value>']`; re-render with that value selected, click again → `onChange` called with `[]`. Assert count badge shows `2` when `selected=['a','b']`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** per contract (follow `CustomerAutocomplete.tsx` for Command usage).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(web): add MultiSelectPopover for interventions filters`

---

### Task 3: `InterventionsFilterBar`

**Files:**
- Create: `packages/web/src/components/interventions/InterventionsFilterBar.tsx`
- Test: `packages/web/src/components/interventions/InterventionsFilterBar.test.tsx`

**Interfaces:**
- Consumes: `MultiSelectPopover` (Task 2); `InterventionsListParams`, `InterventionStatus` (Task 1); `useInterventionTypes` from `@/queries/interventionTypes`; `useUsers` from `@/queries/users-admin`; `useHasRole` from `@/auth/useHasRole`; `useDebouncedValue` from `@/lib/use-debounced-value`; `Input` from `@/components/ui/input`; `Button` from `@/components/ui/button`.
- Produces:
  ```ts
  export type InterventionFilterValues = Pick<
    InterventionsListParams,
    'q' | 'status' | 'typeId' | 'checklistItemIds' | 'operatorId' | 'dateFrom' | 'dateTo'
  >;
  export interface InterventionsFilterBarProps {
    values: InterventionFilterValues;
    onChange: (patch: Partial<InterventionFilterValues>) => void;
  }
  export function InterventionsFilterBar(props: InterventionsFilterBarProps): JSX.Element
  ```

**Behavioral contract:**
- **Search `q`**: `Input` with local state initialized from `values.q`, debounced 300ms via `useDebouncedValue`; on debounced change → `onChange({ q })`. Placeholder `"Cerca per targa, marca o modello…"`.
- **Stato** (`MultiSelectPopover label="Stato"`): options `[{value:'active',label:'Attivo'},{value:'disputed',label:'Contestato'},{value:'cancelled',label:'Cancellato'}]`. `selected = values.status`. `onChange({ status })`.
- **Tipo** (`MultiSelectPopover label="Tipo" searchable`): options from `useInterventionTypes()` → `data.data.map(t => ({value:t.id, label:t.nameIt}))`. `selected=values.typeId`. On change → `onChange({ typeId, checklistItemIds: [] })` (clear checklist whenever the type set changes). Disabled while types query is pending.
- **Voci checklist** (conditional): render **only** when `values.typeId.length === 1`. Options = the single selected type's `checklistItems.map(c => ({value:c.id, label:c.nameIt}))` (from the already-fetched `useInterventionTypes` data). `label="Voci"`, `searchable`, `selected=values.checklistItemIds`, `onChange({ checklistItemIds })`. If the selected type has no checklist items, render nothing.
- **Date range**: two `Input type="date"` (`values.dateFrom`, `values.dateTo`); native value is `YYYY-MM-DD`. On change → `onChange({ dateFrom })` / `onChange({ dateTo })`. Labels `"Da"` / `"A"`.
- **Operatore** (conditional): render an `<OperatorFilter>` subcomponent **only** when `useHasRole('super_admin')` is true (see Deviation #1). The subcomponent calls `useUsers()` (so the super-admin-only endpoint is hit only for super admins), maps non-deleted users → `{value:u.id, label: [u.firstName,u.lastName].filter(Boolean).join(' ') || u.email}`, and renders `MultiSelectPopover label="Operatore" searchable`. `selected=values.operatorId`, `onChange({ operatorId })`.
- **Reset** `Button variant="ghost"`: `"Azzera filtri"` → `onChange({ q:'', status:[], typeId:[], checklistItemIds:[], operatorId:[], dateFrom:'', dateTo:'' })`. Show only when any filter is non-empty.

- [ ] **Step 1: Write failing tests** (mock `@/queries/interventionTypes`, `@/queries/users-admin`, `@/auth/useHasRole`):
  - With `values.typeId=[]` → the "Voci" control is **not** in the document.
  - With `values.typeId=['t1']` (and mocked types data where `t1` has 2 checklist items) → the "Voci" control **is** present.
  - With `values.typeId=['t1','t2']` → the "Voci" control is **not** present.
  - `useHasRole` mocked `false` → no "Operatore" control; mocked `true` → "Operatore" control present.
  - Changing the type selection fires `onChange` including `checklistItemIds: []`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** per contract.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(web): add interventions filter bar with gated operator filter`

---

### Task 4: `InterventionsTable` + `InterventionsPagination`

**Files:**
- Create: `packages/web/src/components/interventions/InterventionsTable.tsx`
- Create: `packages/web/src/components/interventions/InterventionsPagination.tsx`
- Test: `packages/web/src/components/interventions/InterventionsTable.test.tsx`
- Test: `packages/web/src/components/interventions/InterventionsPagination.test.tsx`

**Interfaces:**
- Consumes: `InterventionListItem`, `InterventionSort`, `SortOrder`, `PAGE_SIZE` (Task 1); `formatDate`, `formatKm` from `@/lib/format`; `Badge` from `@/components/ui/badge`; `Button` from `@/components/ui/button`; `Link, useNavigate` from `react-router-dom`; `ArrowUp`/`ArrowDown`/`ChevronLeft`/`ChevronRight` from `lucide-react`.
- Produces:
  ```ts
  export interface InterventionsTableProps {
    items: InterventionListItem[];
    sort: InterventionSort;
    order: SortOrder;
    onSortChange: (sort: InterventionSort) => void; // page decides asc/desc toggle
  }
  export function InterventionsTable(props: InterventionsTableProps): JSX.Element

  export interface InterventionsPaginationProps {
    page: number;
    total: number;
    onPageChange: (page: number) => void;
  }
  export function InterventionsPagination(props: InterventionsPaginationProps): JSX.Element

  // Shared status labels/variants (export from InterventionsTable.tsx):
  export const STATUS_LABEL: Record<InterventionStatus, string>;
  export const STATUS_VARIANT: Record<InterventionStatus, 'secondary' | 'destructive' | 'outline'>;
  ```

**Behavioral contract (table):**
- Hand-rolled `<table className="w-full text-sm">` inside `<div className="overflow-x-auto"><div className="bg-card border border-border rounded-lg overflow-hidden">` — same wrapper as `CustomerList.tsx:71-104`.
- Columns (in order): **Data** (sort key `date`), **Veicolo** (not sortable), **Tipo** (sort `type`), **Km** (sort `km`), **Operatore** (sort `operator`), **Stato** (sort `status`).
- Sortable `<th>` renders a `<button>` with the header label + an arrow (`ArrowUp` if `order==='asc'`, `ArrowDown` if `'desc'`) **only when it is the active `sort`**; click → `onSortChange(key)`.
- Row (`<tr onClick={() => navigate(\`/interventions/${row.id}\`)} className="cursor-pointer hover:bg-muted/50 transition">`):
  - Data → `formatDate(row.interventionDate)`.
  - Veicolo → `<Link to={\`/vehicles/${row.vehicle.id}\`} onClick={e => e.stopPropagation()} className="font-medium hover:underline">{row.vehicle.plate}</Link>` + a muted `{row.vehicle.make} {row.vehicle.model}` line.
  - Tipo → `row.type.nameIt`.
  - Km → `formatKm(row.odometerKm)`.
  - Operatore → `row.operator.name`.
  - Stato → `<Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge>`.
- `STATUS_LABEL = { active:'Attivo', disputed:'Contestato', cancelled:'Cancellato' }`; `STATUS_VARIANT = { active:'secondary', disputed:'destructive', cancelled:'outline' }`.

**Behavioral contract (pagination):**
- `pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))`.
- `ChevronLeft` prev button (disabled when `page<=1`) → `onPageChange(page-1)`; `ChevronRight` next (disabled when `page>=pageCount`) → `onPageChange(page+1)`. Center label `"Pagina {page} di {pageCount}"` and a muted `"{total} interventi"`.

- [ ] **Step 1: Write failing tests**:
  - Table: render 2 items wrapped in `MemoryRouter`; assert both plates appear, the Tipo/Operatore text appears, the Stato badge label matches `STATUS_LABEL[status]`. Click a sortable header (`Data`) → `onSortChange('date')` called. Assert the active-sort column shows the arrow and non-active columns do not.
  - Pagination: `page=1,total=60` → prev disabled, label `"Pagina 1 di 3"`; click next → `onPageChange(2)`. `page=3,total=60` → next disabled.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** both components.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(web): add sortable interventions table and pagination`

---

### Task 5: `Interventions` page (URL state + wiring)

**Files:**
- Create: `packages/web/src/pages/Interventions.tsx`
- Test: `packages/web/src/pages/Interventions.test.tsx`

**Interfaces:**
- Consumes: `useSearchParams` from `react-router-dom`; `parseInterventionsParams`, `serializeInterventionsParams`, `useInterventionsList`, `InterventionsListParams`, `InterventionSort` (Task 1); `InterventionsFilterBar`, `InterventionFilterValues` (Task 3); `InterventionsTable`, `InterventionsPagination` (Task 4); `Skeleton` from `@/components/ui/skeleton`; `Alert, AlertDescription` from `@/components/ui/alert`; `Button` from `@/components/ui/button`; `Wrench`/`SearchX` from `lucide-react`.
- Produces: `export function Interventions(): JSX.Element` (default-style named export, matching `CustomerList`).

**Behavioral contract:**
- `const [searchParams, setSearchParams] = useSearchParams();`
- `const params = parseInterventionsParams(searchParams);` — URL is source of truth.
- **Effective status for the query**: pass `params` straight to `useInterventionsList(params)`; the hook sends `status=` only when non-empty, and PR-1 maps empty→default. So an empty `status` array yields the default view — consistent.
- **Update helper**:
  ```ts
  const update = (patch: Partial<InterventionsListParams>) => {
    const next = { ...params, ...patch };
    // Any change other than an explicit page navigation resets to page 1.
    if (!('page' in patch)) next.page = 1;
    setSearchParams(serializeInterventionsParams(next), { replace: false });
  };
  ```
- FilterBar `values` = the `InterventionFilterValues` slice of `params`; `onChange={(p) => update(p)}`.
- Table `sort`/`order` from `params`; `onSortChange={(s) => update({ sort: s, order: s === params.sort && params.order === 'desc' ? 'asc' : 'desc' })}` (clicking the active column toggles desc→asc→desc; a new column starts at desc).
- Pagination `page`/`total` from `params` + `data.total`; `onPageChange={(pg) => update({ page: pg })}`.
- **States** (mirror `CustomerList.tsx`): header block `<Wrench/>` + `<h1>Registro interventi</h1>`. Then `query.isPending` → three `Skeleton`; `query.isError` → `Alert variant="destructive"` with `apiError.message` + `Button ... onClick={query.refetch}`>Riprova; success + `data.items.length===0` → centered `SearchX` + `"Nessun intervento trovato."`; else `InterventionsTable` + `InterventionsPagination`. Gate the data branch on `!query.isPending && query.data` (do not use `data!`).
- The FilterBar is always rendered (above the state-dependent body) so filters remain usable during loading/empty.

- [ ] **Step 1: Write failing tests** (mock `@/lib/api-client` → `useApiFetch: () => apiFetchMock`; mock `@/queries/interventionTypes`, `@/queries/users-admin`, `@/auth/useHasRole`; wrap in `MemoryRouter initialEntries={['/interventions']}` + fresh `QueryClient{retry:false}`):
  - **Happy path**: `apiFetchMock.mockResolvedValue({ items:[oneItem], total:1, page:1, pageSize:25 })` → `await waitFor` the plate text is rendered; assert `apiFetch` called with a URL starting `/v1/interventions?`.
  - **Empty**: `mockResolvedValue({ items:[], total:0, page:1, pageSize:25 })` → `"Nessun intervento trovato."` shown.
  - **URL state**: render at `initialEntries={['/interventions?status=cancelled&page=2']}`; assert `apiFetch` called with a URL containing `status=cancelled` and `page=2` (proves URL is the source of truth for the query).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the page.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(web): add interventions register page with url state`

---

### Task 6: Enable sidebar item + register route + fix sidebar test

**Files:**
- Modify: `packages/web/src/components/layout/SidebarNav.tsx:7-19`
- Modify: `packages/web/src/App.tsx` (import + route)
- Modify: `packages/web/src/components/layout/Sidebar.test.tsx:53-57`

**Behavioral contract:**
- `SidebarNav.tsx`: change the `interventions` nav item to `{ id: 'interventions', label: 'Interventi', icon: Wrench, to: '/interventions', enabled: true }`. Add to `isActiveFor`: `if (itemId === 'interventions') return pathname.startsWith('/interventions');` (covers both `/interventions` and `/interventions/:id`). No other nav item changes.
- `App.tsx`: `import { Interventions } from '@/pages/Interventions';` and add `<Route path="/interventions" element={<Interventions />} />` inside the `AppLayout` block, as a sibling **before** the existing `<Route path="/interventions/:id" .../>` (react-router matches the more specific static path regardless of order, but placing it adjacent keeps the file readable).
- `Sidebar.test.tsx`: the test at lines 53-57 (`voci disabilitate ... "Disponibile in v1.1"`) now has **no disabled items left** (all four nav items are enabled). Replace it with a test asserting `Interventi` is an active link:
  ```ts
  it('"Interventi" linka a /interventions ed è attivo su quel path', () => {
    const { unmount } = renderAt('/interventions');
    const link = screen.getByRole('link', { name: /interventi/i });
    expect(link).toHaveAttribute('href', '/interventions');
    expect(link).toHaveAttribute('aria-current', 'page');
    unmount();
  });
  ```

- [ ] **Step 1: Update `Sidebar.test.tsx`** as above; run → expect the NEW test FAILs (item still disabled) and the old assertion is gone.
- [ ] **Step 2: Implement** the `SidebarNav.tsx` + `App.tsx` changes.
- [ ] **Step 3: Run** `pnpm --filter @garageos/web test -- Sidebar` → expect PASS.
- [ ] **Step 4: Typecheck** `pnpm -r typecheck` → expect PASS (catches any route/import mismatch).
- [ ] **Step 5: Commit** — `feat(web): enable interventi sidebar item and route`

---

## Final gates (after all tasks)

1. `pnpm -r typecheck` (pre-push hook — the only mandatory local gate).
2. `pnpm --filter @garageos/web test` — full web suite green (confirms no other sidebar/nav test regressed).
3. Push, open PR (`feat(web): registro interventi page`), `gh pr checks --watch` — full CI matrix.
4. **Final whole-branch `/code-review high`** — load-bearing gate; apply Critical/Important, list Minor in PR description.
5. **Smoke runbook (BLOCKER — UI PR)** on local dev (`pnpm --filter @garageos/web dev`) against a tenant with interventions:
   - Sidebar `Interventi` navigates to `/interventions`; table renders rows.
   - Sort by each column header (arrow flips asc/desc); pagination prev/next changes page and rows.
   - Filter by `q` (plate), by Stato (include `cancelled` → annullati appear), by Tipo → the Voci control appears only with a single type and filters (AND).
   - As super_admin, Operatore filter present and filters; as mechanic, it is absent.
   - Filters/sort/page persist in the URL; browser Back restores prior state; row click → `/interventions/:id`; the vehicle plate link → `/vehicles/:id`.
6. Self-merge (`gh pr merge --squash --delete-branch`) once CI green + final review clean + zero open questions.

## Self-review (spec coverage)

- Spec §3 (backend) — done in PR-1 (#259); this plan consumes it. ✓
- Spec §4.1 structure (filter bar, table columns incl. km, sortable headers, pagination, states) — Tasks 3/4/5. ✓
- Spec §4.2 data fetching (`useInterventionsList`, query key = all params, reuse types hook) — Task 1/3. ✓
- Spec §4.3 URL state (`useSearchParams`, deep-link, back button) — Task 1 (codec) + Task 5. ✓
- Spec §4.4 sidebar + route — Task 6. ✓
- Spec §5.2 Tier-2 tests (happy, empty, checklist-visibility conditional) — Tasks 1-5 tests. ✓
- Operator filter (spec §4.1) — resolved via Deviation #1 (super_admin gate). ✓

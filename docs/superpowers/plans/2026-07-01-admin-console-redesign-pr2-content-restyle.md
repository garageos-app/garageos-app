# Admin Console Redesign — PR2 Content Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the content of the admin console pages to match the polish of the PR1 shell — a reusable `PageHeader` (no duplicate title), a redesigned dashboard with icon stat cards, and consistent skeleton loading + empty/error states across all pages.

**Architecture:** Introduce four small reusable presentation components (`PageHeader`, `EmptyState`, `ErrorState`, `TableSkeleton`) plus a redesigned `StatCard`, then apply them across the five in-shell pages. Behavior (queries, mutations, dialogs, forms) is unchanged — this is a presentation-layer change only.

**Tech Stack:** React 19, react-router-dom v6, TailwindCSS v3 (`darkMode: ['class']`), shadcn/ui (Card, Table, Skeleton — all already vendored), lucide-react, recharts, Vitest + Testing Library (jsdom).

## Global Constraints

- **Scope:** `packages/admin-web` only. No API/DB/BR/error-code changes. No new dependencies (all primitives — Card, Table, Skeleton, lucide icons, recharts — already present).
- **No behavior change:** queries, mutations, dialogs, forms, routing, and toast handling are byte-unchanged. This PR only changes presentation (markup/classes/components).
- **No duplicate page titles:** the Topbar (PR1) already shows the page-type title (`titleForPath`). Content pages must NOT render an `<h1>` that repeats it. `PageHeader` carries a **contextual** title only where it adds information beyond the Topbar (the tenant business name on TenantDetail); list/dashboard/create pages use `PageHeader` with description/actions only, or omit it.
- **User-facing strings are Italian, hardcoded** (`// IT-strings`). Comments in English. No emoji.
- **TypeScript strict**; no `any` without an inline justification comment.
- **Testing = Tier 2** (UI): implement first, then 2-3 targeted tests per unit (happy path, the error state, conditional logic that gates data). No pure-rendering tests. Existing page tests must keep passing (update queries only where markup they assert on changed).
- **Local gate:** `pnpm -r typecheck` (husky pre-push). Targeted `pnpm --filter @garageos/admin-web test` while working; `npx vitest run tests/<file>` for a single file (`pnpm test -- <name>` filtering does NOT work in this repo). The `create-tenant.test` can time out under parallel load — re-run in isolation to confirm the known flake.
- **Commit style:** Conventional Commits, scope `admin-web`, subject <= 72 chars. Branch `feat/admin-console-restyle` (create from up-to-date `main`).
- **Node:** use Node 22 via fnm for pnpm commands.
- **Deviation from the design spec note:** the spec listed `PageHeader (title + breadcrumb + action slot)`. Per the PR2 brainstorming decision, `PageHeader` carries **no breadcrumb and no page-type title** (both live in the Topbar); it exposes an optional contextual `title`, a `description`, and an `actions` slot. This avoids the double-title regression fixed in PR1.

---

### Task 1: Reusable presentation components (`PageHeader`, `EmptyState`, `ErrorState`, `TableSkeleton`)

The shared building blocks the page tasks consume. Small, dependency-light, individually testable.

**Files:**
- Create: `packages/admin-web/src/components/layout/PageHeader.tsx`
- Create: `packages/admin-web/src/components/feedback/EmptyState.tsx`
- Create: `packages/admin-web/src/components/feedback/ErrorState.tsx`
- Create: `packages/admin-web/src/components/feedback/TableSkeleton.tsx`
- Test: `packages/admin-web/tests/feedback-components.test.tsx`

**Interfaces produced (later tasks consume these):**
- `PageHeader({ title?: string; description?: string; actions?: React.ReactNode })` — a content-area header: optional contextual title (NOT the page-type title), optional description, optional right-aligned actions slot. Renders nothing structural if all props are empty.
- `EmptyState({ icon?: LucideIcon; title: string; description?: string })` — centered empty placeholder with an optional icon.
- `ErrorState({ message: string })` — the reusable `role="alert"` error block (replaces the copy-pasted destructive div).
- `TableSkeleton({ rows?: number; columns: number })` — a `<Table>`-shaped skeleton using the shadcn `Skeleton`.

- [ ] **Step 1: Write the failing test**

`packages/admin-web/tests/feedback-components.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';

describe('feedback components', () => {
  it('PageHeader renders title, description, and actions', () => {
    render(
      <PageHeader title="Officina Rossi" description="Dettaglio" actions={<button>Azione</button>} />,
    );
    expect(screen.getByRole('heading', { name: 'Officina Rossi' })).toBeInTheDocument();
    expect(screen.getByText('Dettaglio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Azione' })).toBeInTheDocument();
  });

  it('EmptyState shows the message and icon', () => {
    render(<EmptyState icon={Inbox} title="Nessuna officina" description="Crea la prima." />);
    expect(screen.getByText('Nessuna officina')).toBeInTheDocument();
    expect(screen.getByText('Crea la prima.')).toBeInTheDocument();
  });

  it('ErrorState renders an alert with the message', () => {
    render(<ErrorState message="Errore nel caricamento." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento.');
  });

  it('TableSkeleton renders the requested number of skeleton rows', () => {
    const { container } = render(<TableSkeleton rows={3} columns={4} />);
    // 3 body rows (header row uses <th>, body uses <td>)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feedback-components.test.tsx` (from `packages/admin-web`)
Expected: FAIL — cannot resolve `@/components/layout/PageHeader`.

- [ ] **Step 3: Create the components**

`packages/admin-web/src/components/layout/PageHeader.tsx`:

```tsx
import type { ReactNode } from 'react';

interface PageHeaderProps {
  // Contextual title only (e.g. an entity name). The page-type title lives in
  // the Topbar; do NOT pass it here or it will duplicate.
  title?: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  if (!title && !description && !actions) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        {title && <h2 className="text-xl font-semibold tracking-tight">{title}</h2>}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```

`packages/admin-web/src/components/feedback/EmptyState.tsx`:

```tsx
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
}

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
      {Icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
```

`packages/admin-web/src/components/feedback/ErrorState.tsx`:

```tsx
interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
```

`packages/admin-web/src/components/feedback/TableSkeleton.tsx`:

```tsx
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

interface TableSkeletonProps {
  rows?: number;
  columns: number;
}

export function TableSkeleton({ rows = 5, columns }: TableSkeletonProps) {
  return (
    <Table>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }).map((_, c) => (
              <TableCell key={c}>
                <Skeleton className="h-4 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feedback-components.test.tsx`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add packages/admin-web/src/components/layout/PageHeader.tsx packages/admin-web/src/components/feedback packages/admin-web/tests/feedback-components.test.tsx
git commit -m "feat(admin-web): add PageHeader, EmptyState, ErrorState, TableSkeleton"
```

---

### Task 2: Redesign `StatCard` + dashboard layout

Give the dashboard a real "SaaS dashboard" feel: icon-accented stat cards and a cleaner layout, with a skeleton loading state and a reusable error state.

**Files:**
- Modify: `packages/admin-web/src/components/StatCard.tsx`
- Modify: `packages/admin-web/src/pages/PlatformConsole.tsx`
- Modify: `packages/admin-web/src/components/InterventionsTrendChart.tsx` (subtitle polish only)
- Test: `packages/admin-web/tests/platform-console.test.tsx` (update — keep metric-value + error assertions, add skeleton-loading assertion)

**Interfaces:**
- Consumes: `ErrorState` (Task 1); `Skeleton` from `@/components/ui/skeleton`; lucide icons.
- Produces: `StatCard({ label: string; value: string | number; hint?: string; icon: LucideIcon })` — icon is now required.

- [ ] **Step 1: Write the failing test (update platform-console test)**

Replace the loading behavior assertion in `packages/admin-web/tests/platform-console.test.tsx`. Add a test that when the metrics query is loading, skeleton placeholders render instead of the old "Caricamento metriche..." text. Keep the existing happy-path (values `7`, `420`, trend chart) and metrics-error tests. Add:

```tsx
  it('shows skeleton cards while metrics are loading', () => {
    // Never resolve — keep the query in loading state.
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<PlatformConsole />, { wrapper: makeWrapper() });
    // 5 stat-card skeletons render while loading.
    expect(container.querySelectorAll('[data-testid="stat-skeleton"]').length).toBe(5);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-console.test.tsx`
Expected: FAIL — no `[data-testid="stat-skeleton"]` elements yet.

- [ ] **Step 3: Redesign `StatCard.tsx`**

```tsx
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
}

export function StatCard({ label, value, hint, icon: Icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 p-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold leading-none">{value}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Redesign `PlatformConsole.tsx`**

Replace the return body. Loading → 5 skeleton cards; error → `ErrorState`; success → icon stat cards + trend. Assign an icon per metric.

```tsx
import { useQuery } from '@tanstack/react-query';
import { Building2, Users, Wrench, Car, Contact } from 'lucide-react';
import { useApiFetch } from '@/lib/api-client';
import { StatCard } from '@/components/StatCard';
import { InterventionsTrendChart } from '@/components/InterventionsTrendChart';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { PlatformMetrics } from '@/lib/metrics-types';

export function PlatformConsole() {
  const apiFetch = useApiFetch();

  const metricsQuery = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => apiFetch<PlatformMetrics>('/v1/admin/metrics'),
  });

  const metrics = metricsQuery.data;

  if (metricsQuery.error) {
    return <ErrorState message="Errore nel caricamento delle metriche. Riprova." />;
  }

  if (metricsQuery.isLoading || !metrics) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} data-testid="stat-skeleton">
            <CardContent className="flex items-start gap-4 p-6">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-10" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={Building2}
          label="Officine"
          value={metrics.tenants.total}
          hint={`${metrics.tenants.active} attive · ${metrics.tenants.suspended} sospese`}
        />
        <StatCard icon={Users} label="Utenti officine" value={metrics.usersTotal} />
        <StatCard
          icon={Wrench}
          label="Interventi"
          value={metrics.interventions.total}
          hint={`${metrics.interventions.last30d} ultimi 30 giorni`}
        />
        <StatCard icon={Car} label="Veicoli" value={metrics.vehiclesTotal} />
        <StatCard icon={Contact} label="Clienti" value={metrics.customersTotal} />
      </div>

      <InterventionsTrendChart data={metrics.trend} />
    </div>
  );
}
```

- [ ] **Step 5: Polish `InterventionsTrendChart.tsx` header**

Add a muted subtitle under the title (no logic change). Change the `CardHeader` block to:

```tsx
      <CardHeader>
        <CardTitle className="text-base">Interventi per settimana</CardTitle>
        <p className="text-sm text-muted-foreground">Ultime 8 settimane</p>
      </CardHeader>
```

(Keep the `CardTitle` import; the chart body and `data-testid="trend-chart"` are unchanged so the existing test keeps passing.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/platform-console.test.tsx` then `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS (skeleton, values, error tests) + clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-web/src/components/StatCard.tsx packages/admin-web/src/components/InterventionsTrendChart.tsx packages/admin-web/src/pages/PlatformConsole.tsx packages/admin-web/tests/platform-console.test.tsx
git commit -m "feat(admin-web): redesign dashboard stat cards and loading state"
```

---

### Task 3: Apply restyle to `TenantList`

Skeleton loading, `EmptyState`, `ErrorState`, and a `PageHeader` with a "Crea officina" action (the sidebar CTA still exists; a page-level action button is standard on a list view and does not duplicate a title).

**Files:**
- Modify: `packages/admin-web/src/pages/TenantList.tsx`
- Test: `packages/admin-web/tests/tenant-list.test.tsx` (update only if an assertion referenced the old loading/empty text)

**Interfaces consumed:** `PageHeader`, `EmptyState`, `ErrorState`, `TableSkeleton` (Task 1); `Building2`/`Plus` lucide icons; `Link` (already imported).

- [ ] **Step 1: Replace the error guard** (`TenantList.tsx:153-159`)

```tsx
  if (error) {
    return <ErrorState message="Errore nel caricamento delle officine." />;
  }
```

- [ ] **Step 2: Replace the loading guard** (`TenantList.tsx:163-165`)

```tsx
  if (isLoading || !data) {
    return <TableSkeleton columns={7} />;
  }
```

- [ ] **Step 3: Add a `PageHeader` with the create action and replace the empty state**

At the top of the returned `<div className="space-y-6">` (before the status filter block), add:

```tsx
      <PageHeader
        description="Gestisci le officine della piattaforma."
        actions={
          <Button asChild>
            <Link to="/officine/nuova">
              <Plus className="mr-2 h-4 w-4" />
              Crea officina
            </Link>
          </Button>
        }
      />
```

Replace the empty branch (`TenantList.tsx:192`) `<p className="text-muted-foreground">Nessuna officina.</p>` with:

```tsx
        <EmptyState icon={Building2} title="Nessuna officina" description="Crea la prima officina per iniziare." />
```

- [ ] **Step 4: Add imports**

Add to the import block:
```tsx
import { Building2, Plus } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/tenant-list.test.tsx` and `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS. If a test asserted on the literal "Caricamento…" or "Nessuna officina." text with different surrounding markup, update the query to match `EmptyState`'s output (title text "Nessuna officina" is preserved). The `Button asChild` + `Link` renders a single link named "Crea officina" — if a test counts links, account for it.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-web/src/pages/TenantList.tsx packages/admin-web/tests/tenant-list.test.tsx
git commit -m "feat(admin-web): restyle tenant list states and header"
```

---

### Task 4: Apply restyle to `AuditLogs`

Same treatment: skeleton loading, `EmptyState`, `ErrorState`. (No page-level action — Audit is read-only.)

**Files:**
- Modify: `packages/admin-web/src/pages/AuditLogs.tsx`
- Test: `packages/admin-web/tests/AuditLogs.test.tsx` (update only if it asserted on old loading/empty text)

**Interfaces consumed:** `EmptyState`, `ErrorState`, `TableSkeleton` (Task 1); `ScrollText` lucide icon.

- [ ] **Step 1: Replace the error guard** (`AuditLogs.tsx:106-108`)

```tsx
      <ErrorState message="Errore nel caricamento del registro." />
```
(inside the existing `if (error) return (...)`, or return `<ErrorState .../>` directly.)

- [ ] **Step 2: Replace the loading guard** (`AuditLogs.tsx:113-114`)

```tsx
  if (isLoading || !data) {
    return <TableSkeleton columns={6} />;
  }
```
(Use the actual column count of the audit table — verify against the `<TableHead>` count in the file and set `columns` to match.)

- [ ] **Step 3: Replace the empty state** (`AuditLogs.tsx:217`)

Replace `<p className="text-muted-foreground">Nessun evento.</p>` with:

```tsx
        <EmptyState icon={ScrollText} title="Nessun evento" description="Nessun evento corrisponde ai filtri selezionati." />
```

- [ ] **Step 4: Add imports**

```tsx
import { ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TableSkeleton } from '@/components/feedback/TableSkeleton';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/AuditLogs.test.tsx` and `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS. Update any assertion that keyed off the old loading/empty text (the empty title "Nessun evento" is preserved).

- [ ] **Step 6: Commit**

```bash
git add packages/admin-web/src/pages/AuditLogs.tsx packages/admin-web/tests/AuditLogs.test.tsx
git commit -m "feat(admin-web): restyle audit log states"
```

---

### Task 5: Apply restyle to `TenantDetail` + `CreateTenant`

`TenantDetail`: replace the standalone `<h1>` with a `PageHeader` (contextual title = business name), plus `ErrorState` and a loading skeleton. `CreateTenant`: reconcile the card title that duplicates the Topbar and use `ErrorState` for the submit error.

**Files:**
- Modify: `packages/admin-web/src/pages/TenantDetail.tsx`
- Modify: `packages/admin-web/src/pages/CreateTenant.tsx`
- Test: `packages/admin-web/tests/tenant-detail.test.tsx`, `packages/admin-web/tests/create-tenant.test.tsx` (update only where asserted markup changed)

**Interfaces consumed:** `PageHeader`, `ErrorState` (Task 1); `Skeleton`.

- [ ] **Step 1: `TenantDetail` — error + loading guards**

Replace the error block (`TenantDetail.tsx:249`, the `role="alert"` destructive div) with `<ErrorState message="Errore nel caricamento dell'officina." />` (keep any surrounding contextual back-link if present in that branch). Replace the loading `<p className="text-muted-foreground">Caricamento…</p>` (`TenantDetail.tsx:265`) with a simple skeleton block:

```tsx
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-48 w-full" />
        </div>
```

- [ ] **Step 2: `TenantDetail` — replace the `<h1>` with `PageHeader`**

Replace `<h1 className="text-2xl font-bold">{data.tenant.businessName}</h1>` (`TenantDetail.tsx:291`) with:

```tsx
      <PageHeader title={data.tenant.businessName} description="Dettaglio e gestione officina." />
```

(The business name is contextual — it does NOT duplicate the Topbar's generic "Dettaglio officina", so it stays. Keep the existing "← Officine" back-link exactly where it is.)

- [ ] **Step 3: `TenantDetail` — imports**

```tsx
import { PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
```

- [ ] **Step 4: `CreateTenant` — reconcile duplicate title + error state**

The form card's `CardTitle` "Crea officina" (`CreateTenant.tsx:115`) duplicates the Topbar title. Remove the `CardHeader`/`CardTitle` from the form card (the Topbar already titles the page); keep the card body/form. Replace the submit-error `role="alert"` block (`CreateTenant.tsx:120`) with `<ErrorState message={<the existing error message expression>} />`. Leave the confirmation view's `CardTitle` "Officina creata" (`CreateTenant.tsx:87`) — that is a distinct success-state title, not a duplicate of "Crea officina", so it stays.

Add import: `import { ErrorState } from '@/components/feedback/ErrorState';`

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/tenant-detail.test.tsx tests/create-tenant.test.tsx` and `pnpm --filter @garageos/admin-web typecheck`
Expected: PASS. If `tenant-detail.test` asserted on the business-name `<h1>`, the `PageHeader` renders it as an `<h2>` — update the query to `getByRole('heading', { name: <businessName> })` (level-agnostic) or `getByText`. If `create-tenant.test` asserted on the "Crea officina" card title (now removed), update it to assert on a still-present element (e.g. the submit button "Crea officina" or a field label). Re-run `create-tenant.test` in isolation if it times out under parallel load (known flake).

- [ ] **Step 6: Full suite + typecheck + build**

Run:
```bash
pnpm --filter @garageos/admin-web test
pnpm --filter @garageos/admin-web typecheck
pnpm --filter @garageos/admin-web build
```
Expected: all green (re-run any single file that flakes on timeout in isolation).

- [ ] **Step 7: Commit**

```bash
git add packages/admin-web/src/pages/TenantDetail.tsx packages/admin-web/src/pages/CreateTenant.tsx packages/admin-web/tests/tenant-detail.test.tsx packages/admin-web/tests/create-tenant.test.tsx
git commit -m "feat(admin-web): restyle tenant detail and create forms"
```

---

## Post-implementation (outside task loop)

- **Whole-branch review:** `/code-review high` on the branch (final gate for a medium single-layer slice).
- **Smoke (mandatory, ship-blocker for shell/layout/visual PRs):** after merge + auto-deploy, browser-smoke prod — dashboard icon cards + skeleton on slow load, tables with skeleton/empty/error states, TenantDetail PageHeader (business name, no duplicate Topbar title), CreateTenant form without the duplicated card title, dark mode intact, console clean.
- This closes the admin-console redesign arc (PR1 shell + PR2 content).

## Self-Review notes

- **Spec coverage:** PageHeader (Task 1, no-title reconciliation per constraint), richer dashboard + icon stat cards (Task 2), skeleton loading + curated empty/error states across all five pages (Tasks 2-5), no behavior change (Tasks 3-5 touch only presentation guards + headers), Tier-2 tests each task. The auth pages (Login/SetPassword) are out of scope (not in the shell).
- **Type consistency:** `StatCard` icon prop is required from Task 2 onward and every call site in Task 2 passes one; `PageHeader`/`EmptyState`/`ErrorState`/`TableSkeleton` signatures match between Task 1 definitions and Tasks 3-5 usage.
- **No placeholders:** component code is complete; page edits cite exact files + line anchors + the exact replacement markup. Where a page's column count or a test's assertion must be confirmed against the live file, the step says so explicitly (Task 4 Step 2 column count; test-update steps).
- **LOC watch:** all hand-written, no vendored bulk — expected well under the 1500 hard limit. If Task 5's combined edits push the branch over, it is still a single cohesive presentation slice; note it in the PR description rather than splitting.

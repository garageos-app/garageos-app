# F-OFF-503 PR2 — Location filter web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global sede selector (TopBar) that lets a super_admin restrict the dashboard views (interventi/scadenze/dispute) to one location, persisted across sessions; the selector is hidden for mechanics and for single-location tenants.

**Architecture:** A `LocationFilterProvider` (React Context, mounted in `AppLayout`) holds `selectedLocationId`, persisted to `localStorage` under a tenant-scoped key and validated against the tenant's active locations. It reads role + tenantId from `useProfileMe()` and fetches locations via `useLocations()` **only for super_admin**. A `LocationSelector` widget in `TopBar` renders only when `super_admin && ≥2 active locations`. The four dashboard query hooks read `selectedLocationId`, append `&location_id=` to the request, and include it in their `queryKey` so React Query refetches on change. The PR1 API already enforces BR-205 server-side, so the wiring is purely additive and safe for mechanics (whose param is ignored server-side anyway).

**Tech Stack:** React, TypeScript, @tanstack/react-query, react-router, shadcn/ui (Radix Select), Vitest + Testing Library (JSDOM).

**Spec:** `docs/superpowers/specs/2026-06-01-F-OFF-503-location-filter-design.md` (§Web design)

---

## File Structure

Mirror the existing `src/theme/` layout (Context + hook + widget):

**Source (create):**
- `packages/web/src/location-filter/LocationFilterContext.tsx` — context + `LocationFilterProvider`.
- `packages/web/src/location-filter/useLocationFilter.ts` — `useLocationFilter()` hook.
- `packages/web/src/location-filter/LocationSelector.tsx` — TopBar widget (Radix Select).

**Source (modify):**
- `packages/web/src/queries/users-admin.ts` — add optional `enabled` to `useLocations` (backward-compatible).
- `packages/web/src/components/layout/AppLayout.tsx` — wrap content in `LocationFilterProvider`.
- `packages/web/src/components/layout/TopBar.tsx` — render `<LocationSelector />`.
- `packages/web/src/queries/interventionsRecent.ts` — consume `selectedLocationId`.
- `packages/web/src/queries/deadlinesUpcoming.ts` — consume `selectedLocationId`.
- `packages/web/src/queries/deadlinesList.ts` — consume `selectedLocationId`.
- `packages/web/src/queries/disputesOpen.ts` — consume `selectedLocationId`.

**Tests:**
- `packages/web/src/location-filter/LocationFilterContext.test.tsx` — **new**.
- `packages/web/src/location-filter/LocationSelector.test.tsx` — **new**.
- `packages/web/src/components/layout/TopBar.test.tsx` — add a mock for `LocationSelector`.
- `packages/web/src/queries/interventionsRecent.test.tsx` — mock `useLocationFilter`; add location_id test.
- `packages/web/src/queries/deadlinesUpcoming.test.tsx` — same.
- `packages/web/src/queries/deadlinesList.test.tsx` — same.
- `packages/web/src/queries/disputesOpen.test.tsx` — **new** (no existing file).

**No API/DB/infra change** (all server-side work landed in PR1 #142).

---

## Pre-flight (verified during planning)

- `useProfileMe()` exposes `role: 'super_admin' | 'mechanic'`, `tenantId`, `locationId` (`queries/profileMe.ts`).
- `useLocations()` → `{ locations: TenantLocation[] }`, `queryKey ['tenant-locations']`; endpoint `GET /v1/tenants/me/locations` returns **only active** locations and is **super_admin-gated (403 for mechanic)** — the provider must gate the call with `enabled`.
- `TenantLocation = { id, name, addressLine, city, province, postalCode, country, phone, email, isPrimary }` (`queries/users-admin.ts:43`).
- Radix `Select` (`components/ui/select`) forbids an empty-string `SelectItem` value — use a sentinel `'__all__'` for "Tutte le sedi". JSDOM tests must drive it with `userEvent` (`feedback_radix_tabs_user_event_not_fire_event`).
- Provider tree: `App.tsx` → `QueryClientProvider > AuthProvider > Routes`; `AppLayout` wraps authed routes and renders `TopBar` + `<Outlet/>`. Mounting the provider in `AppLayout` covers both the selector and all consumer pages.
- Consumer hooks' current queryKeys: `['interventions-recent', limit]`, `['deadlines-upcoming', daysAhead]`, `['deadlines-list-tenant', filters]`, `['disputes-open']`.

---

## Task 1: LocationFilterContext + useLocationFilter hook

**Files:**
- Create: `packages/web/src/location-filter/LocationFilterContext.tsx`
- Create: `packages/web/src/location-filter/useLocationFilter.ts`
- Modify: `packages/web/src/queries/users-admin.ts`
- Test: `packages/web/src/location-filter/LocationFilterContext.test.tsx`

- [ ] **Step 1: Make `useLocations` gateable (backward-compatible)**

In `packages/web/src/queries/users-admin.ts`, replace the `useLocations` definition:

```ts
/** GET /v1/tenants/me/locations — list active locations for the tenant (super_admin only). */
export function useLocations(options?: { enabled?: boolean }) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['tenant-locations'],
    queryFn: () => apiFetch<{ locations: TenantLocation[] }>('/v1/tenants/me/locations'),
    enabled: options?.enabled ?? true,
  });
}
```

Existing callers (`InviteUserDialog`, `EditUserDialog`, `LocationManagement`, `ReactivateSection`) pass no argument → `enabled: true` (unchanged behavior).

- [ ] **Step 2: Write the context + hook**

Create `packages/web/src/location-filter/useLocationFilter.ts`:

```ts
import { createContext, useContext } from 'react';

import type { TenantLocation } from '@/queries/users-admin';

export interface LocationFilterValue {
  /** The sede the super_admin narrowed to, or null = "Tutte le sedi". */
  selectedLocationId: string | null;
  setSelectedLocationId: (id: string | null) => void;
  /** Active locations of the tenant (empty for non-super_admin). */
  locations: TenantLocation[];
  /** True when the caller is a super_admin (the only role that can filter). */
  isSuperAdmin: boolean;
}

export const LocationFilterContext = createContext<LocationFilterValue | null>(null);

export function useLocationFilter(): LocationFilterValue {
  const ctx = useContext(LocationFilterContext);
  if (!ctx) {
    throw new Error('useLocationFilter must be used within a LocationFilterProvider');
  }
  return ctx;
}
```

Create `packages/web/src/location-filter/LocationFilterContext.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useProfileMe } from '@/queries/profileMe';
import { useLocations } from '@/queries/users-admin';

import { LocationFilterContext, type LocationFilterValue } from './useLocationFilter';

const STORAGE_PREFIX = 'garageos:location-filter:';

function storageKey(tenantId: string): string {
  return `${STORAGE_PREFIX}${tenantId}`;
}

export function LocationFilterProvider({ children }: { children: React.ReactNode }) {
  const profile = useProfileMe();
  const role = profile.data?.role;
  const tenantId = profile.data?.tenantId;
  const isSuperAdmin = role === 'super_admin';

  // Only super_admin may list locations (endpoint is super_admin-gated; a
  // mechanic would get 403). Gate the fetch on the resolved role.
  const locationsQ = useLocations({ enabled: isSuperAdmin });
  const locations = useMemo(() => locationsQ.data?.locations ?? [], [locationsQ.data]);

  const [selectedLocationId, setSelectedLocationIdState] = useState<string | null>(null);

  // Hydrate from localStorage once tenantId is known. Wrapped in try/catch
  // because localStorage can throw (private mode / disabled storage).
  useEffect(() => {
    if (!tenantId || !isSuperAdmin) return;
    try {
      const stored = window.localStorage.getItem(storageKey(tenantId));
      if (stored) setSelectedLocationIdState(stored);
    } catch {
      // ignore — fall back to "Tutte le sedi"
    }
  }, [tenantId, isSuperAdmin]);

  // Reset to "all" if the persisted location is no longer an active sede
  // (e.g. it was deactivated). Only runs once locations have loaded.
  useEffect(() => {
    if (!selectedLocationId || locations.length === 0) return;
    if (!locations.some((l) => l.id === selectedLocationId)) {
      setSelectedLocationIdState(null);
      if (tenantId) {
        try {
          window.localStorage.removeItem(storageKey(tenantId));
        } catch {
          // ignore
        }
      }
    }
  }, [selectedLocationId, locations, tenantId]);

  const setSelectedLocationId = useCallback(
    (id: string | null) => {
      setSelectedLocationIdState(id);
      if (!tenantId) return;
      try {
        if (id) window.localStorage.setItem(storageKey(tenantId), id);
        else window.localStorage.removeItem(storageKey(tenantId));
      } catch {
        // ignore
      }
    },
    [tenantId],
  );

  const value = useMemo<LocationFilterValue>(
    () => ({ selectedLocationId, setSelectedLocationId, locations, isSuperAdmin }),
    [selectedLocationId, setSelectedLocationId, locations, isSuperAdmin],
  );

  return <LocationFilterContext.Provider value={value}>{children}</LocationFilterContext.Provider>;
}
```

> Note: `useCallback`/`useMemo`/`useEffect`/`useState` are named React imports (the project uses the automatic JSX runtime; no `import React` needed — match the existing `theme/ThemeContext.tsx` import style if it differs).

- [ ] **Step 3: Write the failing test**

Create `packages/web/src/location-filter/LocationFilterContext.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { LocationFilterProvider } from './LocationFilterContext';
import { useLocationFilter } from './useLocationFilter';

const profileRef = { current: { data: undefined as unknown } };
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => profileRef.current,
}));

const locationsRef = { current: { data: undefined as unknown } };
const useLocationsMock = vi.fn(() => locationsRef.current);
vi.mock('@/queries/users-admin', () => ({
  useLocations: (opts?: { enabled?: boolean }) => useLocationsMock(opts),
}));

const TENANT = 'tenant-aaaa';
const LOC_A = { id: 'loc-a', name: 'Sede A', isPrimary: true };
const LOC_B = { id: 'loc-b', name: 'Sede B', isPrimary: false };

function wrap({ children }: { children: ReactNode }) {
  return <LocationFilterProvider>{children}</LocationFilterProvider>;
}

describe('LocationFilterProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLocationsMock.mockClear();
    profileRef.current = { data: { role: 'super_admin', tenantId: TENANT } };
    locationsRef.current = { data: { locations: [LOC_A, LOC_B] } };
  });

  it('defaults to null (Tutte le sedi) and persists a selection under a tenant-scoped key', async () => {
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(result.current.selectedLocationId).toBeNull();

    act(() => result.current.setSelectedLocationId('loc-b'));
    expect(result.current.selectedLocationId).toBe('loc-b');
    expect(window.localStorage.getItem(`garageos:location-filter:${TENANT}`)).toBe('loc-b');
  });

  it('hydrates the persisted selection on mount', async () => {
    window.localStorage.setItem(`garageos:location-filter:${TENANT}`, 'loc-b');
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    await waitFor(() => expect(result.current.selectedLocationId).toBe('loc-b'));
  });

  it('resets to null when the persisted location is no longer active', async () => {
    window.localStorage.setItem(`garageos:location-filter:${TENANT}`, 'loc-gone');
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    await waitFor(() => expect(result.current.selectedLocationId).toBeNull());
    expect(window.localStorage.getItem(`garageos:location-filter:${TENANT}`)).toBeNull();
  });

  it('does not fetch locations for a mechanic (enabled=false)', () => {
    profileRef.current = { data: { role: 'mechanic', tenantId: TENANT } };
    renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(useLocationsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('exposes isSuperAdmin and the active locations', () => {
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(result.current.isSuperAdmin).toBe(true);
    expect(result.current.locations.map((l) => l.id)).toEqual(['loc-a', 'loc-b']);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @garageos/web test -- LocationFilterContext`
Expected: PASS (5 tests). If it fails on import of `useLocations` shape, ensure Step 1 added the `enabled` option.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/location-filter/LocationFilterContext.tsx packages/web/src/location-filter/useLocationFilter.ts packages/web/src/queries/users-admin.ts packages/web/src/location-filter/LocationFilterContext.test.tsx
git commit -m "feat(web): LocationFilterProvider with localStorage persistence (F-OFF-503)"
```

---

## Task 2: LocationSelector widget

**Files:**
- Create: `packages/web/src/location-filter/LocationSelector.tsx`
- Test: `packages/web/src/location-filter/LocationSelector.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/location-filter/LocationSelector.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LocationSelector } from './LocationSelector';
import type { LocationFilterValue } from './useLocationFilter';

const filterRef = { current: {} as LocationFilterValue };
vi.mock('./useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));

const LOC_A = { id: 'loc-a', name: 'Sede A', isPrimary: true, city: 'Milano' };
const LOC_B = { id: 'loc-b', name: 'Sede B', isPrimary: false, city: 'Roma' };

describe('LocationSelector', () => {
  it('renders nothing for a mechanic', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [],
      isSuperAdmin: false,
    };
    const { container } = render(<LocationSelector />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a super_admin with a single location', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [LOC_A] as never,
      isSuperAdmin: true,
    };
    const { container } = render(<LocationSelector />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the selector for a super_admin with ≥2 locations', () => {
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: vi.fn(),
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    render(<LocationSelector />);
    expect(screen.getByRole('combobox', { name: /sede/i })).toBeInTheDocument();
  });

  it('selecting a sede calls setSelectedLocationId with its id', async () => {
    const setFn = vi.fn();
    filterRef.current = {
      selectedLocationId: null,
      setSelectedLocationId: setFn,
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    const user = userEvent.setup();
    render(<LocationSelector />);
    await user.click(screen.getByRole('combobox', { name: /sede/i }));
    await user.click(await screen.findByText(/Sede B/));
    expect(setFn).toHaveBeenCalledWith('loc-b');
  });

  it('selecting "Tutte le sedi" calls setSelectedLocationId with null', async () => {
    const setFn = vi.fn();
    filterRef.current = {
      selectedLocationId: 'loc-b',
      setSelectedLocationId: setFn,
      locations: [LOC_A, LOC_B] as never,
      isSuperAdmin: true,
    };
    const user = userEvent.setup();
    render(<LocationSelector />);
    await user.click(screen.getByRole('combobox', { name: /sede/i }));
    await user.click(await screen.findByText(/Tutte le sedi/));
    expect(setFn).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- LocationSelector`
Expected: FAIL — `LocationSelector` does not exist.

- [ ] **Step 3: Implement the widget**

Create `packages/web/src/location-filter/LocationSelector.tsx`:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useLocationFilter } from './useLocationFilter';

// Radix Select forbids an empty-string item value, so "Tutte le sedi" uses
// a sentinel that maps to null (no filter).
const ALL = '__all__';

export function LocationSelector() {
  const { selectedLocationId, setSelectedLocationId, locations, isSuperAdmin } =
    useLocationFilter();

  // BR-205: only a super_admin can filter; for a single-location tenant the
  // selector is pure noise. Render nothing in both cases.
  if (!isSuperAdmin || locations.length < 2) return null;

  return (
    <Select
      value={selectedLocationId ?? ALL}
      onValueChange={(v) => setSelectedLocationId(v === ALL ? null : v)}
    >
      <SelectTrigger aria-label="Sede" className="h-9 w-[200px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Tutte le sedi</SelectItem>
        {locations.map((loc) => (
          <SelectItem key={loc.id} value={loc.id}>
            {loc.name}
            {loc.isPrimary ? ' (principale)' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- LocationSelector`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/location-filter/LocationSelector.tsx packages/web/src/location-filter/LocationSelector.test.tsx
git commit -m "feat(web): LocationSelector widget gated to super_admin + multi-location"
```

---

## Task 3: Mount provider + render selector

**Files:**
- Modify: `packages/web/src/components/layout/AppLayout.tsx`
- Modify: `packages/web/src/components/layout/TopBar.tsx`
- Modify: `packages/web/src/components/layout/TopBar.test.tsx`

- [ ] **Step 1: Guard the existing TopBar tests with a LocationSelector mock**

The TopBar will render `<LocationSelector />`, which calls `useLocationFilter()` and would throw without a provider in the existing tests. Mock it (the established "header mocks its data-fetching child" pattern). Add near the other `vi.mock` calls at the top of `packages/web/src/components/layout/TopBar.test.tsx`:

```ts
// LocationSelector pulls from LocationFilterProvider (not mounted in these
// unit tests); stub it — its own behavior is covered in LocationSelector.test.tsx.
vi.mock('@/location-filter/LocationSelector', () => ({
  LocationSelector: () => null,
}));
```

- [ ] **Step 2: Run TopBar tests to confirm still green (pre-implementation)**

Run: `pnpm --filter @garageos/web test -- TopBar`
Expected: PASS (mock has no effect yet; guards against the next step).

- [ ] **Step 3: Render the selector in TopBar**

In `packages/web/src/components/layout/TopBar.tsx`, add the import:

```ts
import { LocationSelector } from '@/location-filter/LocationSelector';
```

Render it in the right-hand controls cluster — before `<ThemeToggle />`:

```tsx
      <div className="flex items-center gap-2">
        <LocationSelector />
        <ThemeToggle />
```

- [ ] **Step 4: Mount the provider in AppLayout**

Replace `packages/web/src/components/layout/AppLayout.tsx`:

```tsx
import { Outlet } from 'react-router-dom';

import { LocationFilterProvider } from '@/location-filter/LocationFilterContext';

import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppLayout() {
  return (
    <LocationFilterProvider>
      <div className="min-h-screen grid grid-cols-[220px_1fr] bg-background text-foreground">
        <Sidebar />
        <div className="flex flex-col min-h-screen">
          <TopBar />
          <main className="flex-1 bg-background">
            <div className="max-w-[1600px] mx-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </LocationFilterProvider>
  );
}
```

- [ ] **Step 5: Run the layout tests + typecheck**

Run: `pnpm --filter @garageos/web test -- TopBar`
Expected: PASS.
Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/layout/AppLayout.tsx packages/web/src/components/layout/TopBar.tsx packages/web/src/components/layout/TopBar.test.tsx
git commit -m "feat(web): mount LocationFilterProvider + render selector in TopBar"
```

---

## Task 4: Wire `interventionsRecent` + `deadlinesUpcoming`

**Files:**
- Modify: `packages/web/src/queries/interventionsRecent.ts`
- Modify: `packages/web/src/queries/deadlinesUpcoming.ts`
- Test: `packages/web/src/queries/interventionsRecent.test.tsx`
- Test: `packages/web/src/queries/deadlinesUpcoming.test.tsx`

- [ ] **Step 1: Update the failing tests**

In `packages/web/src/queries/interventionsRecent.test.tsx`, add a mock for `useLocationFilter` near the existing `vi.mock('@/lib/api-client', ...)`:

```ts
const filterRef = { current: { selectedLocationId: null as string | null } };
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));
```

Add to the existing `describe('useInterventionsRecent', ...)`:

```ts
  it('appends location_id when a sede is selected, and keys the query by it', async () => {
    filterRef.current = { selectedLocationId: 'loc-b' };
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ items: [] } satisfies InterventionsRecentResponse);
    const { result } = renderHook(() => useInterventionsRecent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/interventions/recent?limit=10&location_id=loc-b');
    filterRef.current = { selectedLocationId: null }; // reset for other tests
  });
```

> The existing tests assert the URL is exactly `/v1/interventions/recent?limit=10`. With `selectedLocationId: null` (the default in the ref) and `URLSearchParams`, the URL stays `?limit=10` — those tests remain green. Make sure the mock's default is `null`.

In `packages/web/src/queries/deadlinesUpcoming.test.tsx`, add the same `useLocationFilter` mock, and add a test asserting `location_id=loc-b` is present in the requested URL when selected (mirror the file's existing URL assertion style — it asserts on the `apiFetch` argument with `status=open&limit=50`).

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `pnpm --filter @garageos/web test -- interventionsRecent deadlinesUpcoming`
Expected: FAIL on the new `location_id` cases (not yet implemented). Existing cases still pass.

- [ ] **Step 3: Implement `interventionsRecent.ts`**

Replace the hook body in `packages/web/src/queries/interventionsRecent.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import { useLocationFilter } from '@/location-filter/useLocationFilter';

// ... (interfaces unchanged) ...

export function useInterventionsRecent(limit = 10) {
  const apiFetch = useApiFetch();
  const { selectedLocationId } = useLocationFilter();
  return useQuery({
    queryKey: ['interventions-recent', limit, selectedLocationId] as const,
    queryFn: async (): Promise<RecentIntervention[]> => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (selectedLocationId) params.set('location_id', selectedLocationId);
      const res = await apiFetch<InterventionsRecentResponse>(
        `/v1/interventions/recent?${params.toString()}`,
      );
      return res.items;
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 4: Implement `deadlinesUpcoming.ts`**

In `packages/web/src/queries/deadlinesUpcoming.ts`, add the import and consume the filter. Replace the hook head:

```ts
import { useLocationFilter } from '@/location-filter/useLocationFilter';
// ... existing imports ...

export function useDeadlinesUpcoming(daysAhead: number) {
  const apiFetch = useApiFetch();
  const { selectedLocationId } = useLocationFilter();
  return useQuery({
    queryKey: ['deadlines-upcoming', daysAhead, selectedLocationId] as const,
    queryFn: async (): Promise<Array<TenantDeadline & { dueDate: string }>> => {
      const params = new URLSearchParams();
      params.set('status', 'open');
      params.set('limit', '50');
      if (selectedLocationId) params.set('location_id', selectedLocationId);
      const res = await apiFetch<DeadlinesListResponse>(`/v1/deadlines?${params.toString()}`);
      // ... rest of the body (today/horizon filter + sort) UNCHANGED ...
```

Leave the post-fetch windowing/sort logic exactly as-is.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @garageos/web test -- interventionsRecent deadlinesUpcoming`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/interventionsRecent.ts packages/web/src/queries/deadlinesUpcoming.ts packages/web/src/queries/interventionsRecent.test.tsx packages/web/src/queries/deadlinesUpcoming.test.tsx
git commit -m "feat(web): location filter on interventionsRecent + deadlinesUpcoming"
```

---

## Task 5: Wire `deadlinesList` + `disputesOpen`

**Files:**
- Modify: `packages/web/src/queries/deadlinesList.ts`
- Modify: `packages/web/src/queries/disputesOpen.ts`
- Test: `packages/web/src/queries/deadlinesList.test.tsx`
- Test: `packages/web/src/queries/disputesOpen.test.tsx` (**new**)

- [ ] **Step 1: Update / write the failing tests**

In `packages/web/src/queries/deadlinesList.test.tsx`, add the `useLocationFilter` mock (default `selectedLocationId: null`) and a test that, when `selectedLocationId: 'loc-b'`, the fetched URL contains `location_id=loc-b` and the `queryKey` includes the location. Mirror the file's existing assertion style (it is an infinite query — assert on the `apiFetch` call argument for the first page).

Create `packages/web/src/queries/disputesOpen.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useDisputesOpen } from './disputesOpen';
import type { DisputesOpenResponse } from './disputesOpen';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

const filterRef = { current: { selectedLocationId: null as string | null } };
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: DisputesOpenResponse = {
  pendingResponse: { count: 0, items: [] },
  inProgress: { count: 0, items: [] },
};

describe('useDisputesOpen', () => {
  it('fetches without location_id when no sede is selected', async () => {
    filterRef.current = { selectedLocationId: null };
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDisputesOpen(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/disputes/open');
  });

  it('appends location_id and keys the query by the selected sede', async () => {
    filterRef.current = { selectedLocationId: 'loc-b' };
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { result } = renderHook(() => useDisputesOpen(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/disputes/open?location_id=loc-b');
    filterRef.current = { selectedLocationId: null };
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @garageos/web test -- deadlinesList disputesOpen`
Expected: FAIL on the new location cases.

- [ ] **Step 3: Implement `disputesOpen.ts`**

Replace the hook in `packages/web/src/queries/disputesOpen.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import { useLocationFilter } from '@/location-filter/useLocationFilter';

// ... (interfaces unchanged) ...

export function useDisputesOpen() {
  const apiFetch = useApiFetch();
  const { selectedLocationId } = useLocationFilter();
  return useQuery({
    queryKey: ['disputes-open', selectedLocationId] as const,
    queryFn: async (): Promise<DisputesOpenResponse> => {
      const url = selectedLocationId
        ? `/v1/disputes/open?location_id=${selectedLocationId}`
        : '/v1/disputes/open';
      return apiFetch<DisputesOpenResponse>(url);
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 4: Implement `deadlinesList.ts`**

Replace the hook in `packages/web/src/queries/deadlinesList.ts`:

```ts
import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import { useLocationFilter } from '@/location-filter/useLocationFilter';

import type { DeadlinesListResponse } from './types';

interface DeadlinesFilters {
  interventionTypeId?: string;
}

export function useDeadlinesList(filters: DeadlinesFilters) {
  const apiFetch = useApiFetch();
  const { selectedLocationId } = useLocationFilter();
  return useInfiniteQuery({
    queryKey: ['deadlines-list-tenant', filters, selectedLocationId] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('status', 'open');
      if (filters.interventionTypeId) {
        search.set('intervention_type_id', filters.interventionTypeId);
      }
      search.set('limit', '50');
      if (selectedLocationId) search.set('location_id', selectedLocationId);
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<DeadlinesListResponse>(`/v1/deadlines?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @garageos/web test -- deadlinesList disputesOpen`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/deadlinesList.ts packages/web/src/queries/disputesOpen.ts packages/web/src/queries/deadlinesList.test.tsx packages/web/src/queries/disputesOpen.test.tsx
git commit -m "feat(web): location filter on deadlinesList + disputesOpen"
```

---

## Task 6: Full web suite, typecheck, push, PR, watch CI

- [ ] **Step 1: Run the full web test suite + typecheck**

Run: `pnpm --filter @garageos/web test`
Expected: all green (existing + new).
Run: `pnpm -r typecheck`
Expected: all packages green.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/location-filter-web
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(web): global location filter selector (F-OFF-503 PR2)" --body "<fill from CLAUDE.md template>"
```

PR body must cover:
- **What:** global sede selector in TopBar; restricts interventi/scadenze/dispute to one sede; persisted; hidden for mechanics + single-location tenants.
- **Why:** F-OFF-503 (spec link); completes the slice on top of PR1 #142.
- **Implementation notes:** `LocationFilterProvider` (Context + localStorage, tenant-scoped key, reset-on-deactivated); `useLocations` gated to super_admin via `enabled` (mechanic would 403); `LocationSelector` Radix Select with `__all__` sentinel; 4 consumer hooks key+param wired; TopBar test mocks `LocationSelector` (header-mocks-child pattern).
- **Tests:** provider (persistence/hydrate/reset/role-gate), selector (visibility matrix + selection), 4 hook wirings.

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on red.

---

## Self-Review (completed by plan author)

**Spec coverage (design §Web):**
- `LocationFilterProvider` Context + localStorage, tenant-scoped key, validate/reset → Task 1. ✓
- Selector in TopBar, super_admin + ≥2 active locations only → Task 2 (visibility) + Task 3 (mount). ✓
- Radix Select + `userEvent` in JSDOM → Task 2 tests. ✓
- 4 consumer hooks read selectedLocationId, append `location_id`, include in queryKey → Tasks 4-5. ✓
- Mechanic still constrained server-side; web wiring additive → noted; provider gates `useLocations` to super_admin (Task 1) so a mechanic never calls the 403 endpoint. ✓

**Placeholder scan:** only the PR body `<fill>` (deliberate). No TODO/TBD in code/tests. ✓

**Type/name consistency:** `useLocationFilter()` returns `{ selectedLocationId, setSelectedLocationId, locations, isSuperAdmin }` — defined Task 1, consumed identically in Tasks 2/4/5. `LocationFilterValue` shared type. Sentinel `ALL='__all__'` local to LocationSelector. queryKeys extended with `selectedLocationId` consistently (recent/upcoming/list/disputes). `useLocations({ enabled })` — option added Task 1, used by provider same task. ✓

**Risks addressed:**
- Mechanic 403 on `useLocations` → gated by `enabled: isSuperAdmin` (Task 1) + test (Task 1 Step 3). ✓
- Existing TopBar tests break (provider absent) → `LocationSelector` mocked (Task 3 Step 1), per header-mocks-child pattern (`feedback_subagent_driven_review_loop`, PR #136). ✓
- Existing hook tests assert exact URL → with `selectedLocationId: null` default the URL is unchanged (`URLSearchParams` yields `?limit=10`); new tests reset the ref to null (Tasks 4-5). ✓
- Radix Select empty-value crash → `__all__` sentinel (Task 2). ✓
- localStorage throwing (private mode) → all access in try/catch (Task 1). ✓
- Cross-session leak on tenant switch → tenant-scoped key (Task 1). ✓

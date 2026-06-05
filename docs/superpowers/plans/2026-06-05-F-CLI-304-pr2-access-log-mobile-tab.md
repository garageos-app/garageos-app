# F-CLI-304 PR2 — Tab "Accessi" mobile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere una 4ª tab "Accessi" allo screen dettaglio veicolo del cliente, che consuma `GET /v1/me/vehicles/:id/access-log` (PR1 #157) con paginazione cursor a bottone "Carica altri", completando la UI di F-CLI-106.

**Architecture:** Solo `packages/mobile`. Un nuovo formatter `formatDateTime`, i tipi della response, un hook `useInfiniteQuery` (lazy, gated dalla tab attiva), un componente riga `AccessLogRow`, un componente presentazionale `AccessLogTab` (estratto a file proprio perché ha la logica di paginazione, a differenza dei tab inline esistenti), e il wiring nello screen `app/(tabs)/vehicles/[id].tsx`. Zero backend/schema/dipendenze nuove.

**Tech Stack:** React Native (Expo), TanStack Query v5 (`useInfiniteQuery`), TypeScript, Jest + @testing-library/react-native.

---

## File Structure

- **Create** `packages/mobile/src/lib/types/accessLog.ts` — tipi della response (`CustomerAccessEntry`, `AccessLogPage`).
- **Modify** `packages/mobile/src/lib/format.ts` — aggiunge `formatDateTime`.
- **Create** `packages/mobile/src/queries/meVehicleAccessLog.ts` — hook `useMeVehicleAccessLog` (`useInfiniteQuery`).
- **Create** `packages/mobile/src/components/AccessLogRow.tsx` — riga informativa di un accesso.
- **Create** `packages/mobile/src/components/AccessLogTab.tsx` — contenuto presentazionale della tab (stati + lista + "Carica altri").
- **Modify** `packages/mobile/app/(tabs)/vehicles/[id].tsx` — 4ª tab + hook + onRefresh + branch di render.
- **Create** tests: `tests/lib/format.test.ts` (append), `tests/queries/meVehicleAccessLog.test.tsx`, `tests/components/AccessLogRow.test.tsx`, `tests/components/AccessLogTab.test.tsx`.

**Test run convention (mobile, da memoria):** l'output del run jest viene auto-backgroundato e l'output-file tarda. Pattern affidabile:

```bash
cd packages/mobile && pnpm jest <path> > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt
```

poi leggere `/tmp/jest-out.txt` (loop fino a trovare `__EXIT`).

---

## Task 1: `formatDateTime` formatter

**Files:**
- Modify: `packages/mobile/src/lib/format.ts`
- Test: `packages/mobile/tests/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

Append a `describe('formatDateTime', …)` block inside `tests/lib/format.test.ts`, and add `formatDateTime` to the import on line 1 (`import { formatDate, formatDateTime, formatDueUrgency, formatKm, formatTimeAgo } from '@/lib/format';`):

```ts
describe('formatDateTime', () => {
  it('formats a summer (DST +02:00) UTC instant in Europe/Rome', () => {
    expect(formatDateTime('2026-06-05T12:32:00.000Z')).toBe('05/06/2026 14:32');
  });

  it('formats a winter (no DST +01:00) instant and rolls the date over', () => {
    expect(formatDateTime('2026-01-15T23:30:00.000Z')).toBe('16/01/2026 00:30');
  });

  it('returns the fallback for invalid input', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('returns the fallback for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm jest tests/lib/format.test.ts > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: FAIL — `formatDateTime is not a function` (and a TS error on the import).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/mobile/src/lib/format.ts`:

```ts
// Absolute date+time for an audit log entry: occurredAt is a full ISO
// timestamp (with time-of-day), unlike the date-only @db.Date fields above.
// We render it in Europe/Rome regardless of the device timezone so the value
// is deterministic in tests and correct for the Italian audience. hourCycle
// 'h23' avoids the it-IT "24:00" rendering for midnight.
export function formatDateTime(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mobile && pnpm jest tests/lib/format.test.ts > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: PASS (all formatDateTime cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/lib/format.ts packages/mobile/tests/lib/format.test.ts
git commit -F - <<'EOF'
feat(mobile): add formatDateTime Europe/Rome formatter

For the access-log audit rows (occurredAt is a full ISO timestamp). Renders
DD/MM/YYYY HH:mm in Europe/Rome via Intl, deterministic in tests.
EOF
```

---

## Task 2: Access-log response types

**Files:**
- Create: `packages/mobile/src/lib/types/accessLog.ts`

No test (type-only module); verified by `pnpm -r typecheck` and by Task 3 which imports it.

- [ ] **Step 1: Create the types file**

```ts
// Mirrors the GET /v1/me/vehicles/:id/access-log response (camelCase, like
// /me, /me/vehicles, /me/deadlines). BR-155 redaction (no ip/userAgent/ids) is
// enforced server-side; mechanicName is present only when a customer_tenant_relation
// exists (BR-151). Cursor pagination: meta.cursor is set only when has_more.
export type CustomerAccessAction = 'view' | 'new_intervention';

export interface CustomerAccessEntry {
  action: CustomerAccessAction;
  tenantName: string;
  locationCity: string | null;
  occurredAt: string;
  mechanicName?: string;
}

export interface AccessLogPage {
  data: CustomerAccessEntry[];
  meta: { has_more: boolean; cursor?: string };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd packages/mobile && pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/src/lib/types/accessLog.ts
git commit -F - <<'EOF'
feat(mobile): add access-log response types

Mirrors GET /me/vehicles/:id/access-log (camelCase, cursor pagination).
EOF
```

---

## Task 3: `useMeVehicleAccessLog` hook

**Files:**
- Create: `packages/mobile/src/queries/meVehicleAccessLog.ts`
- Test: `packages/mobile/tests/queries/meVehicleAccessLog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/queries/meVehicleAccessLog.test.tsx`:

```tsx
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeVehicleAccessLog } from '@/queries/meVehicleAccessLog';
import type { AccessLogPage } from '@/lib/types/accessLog';
import * as apiClientHook from '@/lib/use-api-client';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const page1: AccessLogPage = {
  data: [
    { action: 'view', tenantName: 'Officina Rossi', locationCity: 'Torino', occurredAt: '2026-06-05T12:00:00.000Z' },
  ],
  meta: { has_more: true, cursor: 'c1' },
};
const page2: AccessLogPage = {
  data: [
    { action: 'new_intervention', tenantName: 'Officina Verdi', locationCity: null, occurredAt: '2026-06-01T09:00:00.000Z', mechanicName: 'Mario Bianchi' },
  ],
  meta: { has_more: false },
};

describe('useMeVehicleAccessLog', () => {
  it('flattens pages and paginates with the cursor', async () => {
    const apiFetch = jest.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });

    const { result } = renderHook(() => useMeVehicleAccessLog('v1', { enabled: true }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.tenantName).toBe('Officina Rossi');
    expect(result.current.hasNextPage).toBe(true);
    expect(apiFetch).toHaveBeenLastCalledWith('/v1/me/vehicles/v1/access-log');

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
    expect(apiFetch).toHaveBeenLastCalledWith('/v1/me/vehicles/v1/access-log?cursor=c1');
  });

  it('does not fetch when disabled', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    renderHook(() => useMeVehicleAccessLog('v1', { enabled: false }), { wrapper: makeWrapper() });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm jest tests/queries/meVehicleAccessLog.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: FAIL — cannot find module `@/queries/meVehicleAccessLog`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/queries/meVehicleAccessLog.ts`:

```ts
// useMeVehicleAccessLog — infinite query for GET /v1/me/vehicles/:id/access-log
// (F-CLI-304 / BR-155). Cursor pagination consumed via a "Carica altri" button
// (not onEndReached: the tab renders inside a parent ScrollView). select()
// flattens the pages to a flat CustomerAccessEntry[]. Lazy: enabled is driven by
// the active tab so the call only fires when the customer opens the Accessi tab.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { AccessLogPage, CustomerAccessEntry } from '@/lib/types/accessLog';

export function useMeVehicleAccessLog(vehicleId: string, opts: { enabled: boolean }) {
  const api = useApiClient();
  return useInfiniteQuery<
    AccessLogPage,
    Error,
    CustomerAccessEntry[],
    readonly unknown[],
    string | undefined
  >({
    queryKey: ['me', 'vehicle', vehicleId, 'access-log'],
    queryFn: ({ pageParam }) =>
      api.fetch<AccessLogPage>(
        `/v1/me/vehicles/${vehicleId}/access-log${
          pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last.meta.has_more ? last.meta.cursor : undefined),
    select: (data) => data.pages.flatMap((p) => p.data),
    enabled: opts.enabled && vehicleId.length > 0,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mobile && pnpm jest tests/queries/meVehicleAccessLog.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: PASS (both cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/queries/meVehicleAccessLog.ts packages/mobile/tests/queries/meVehicleAccessLog.test.tsx
git commit -F - <<'EOF'
feat(mobile): add useMeVehicleAccessLog infinite query

useInfiniteQuery over GET /me/vehicles/:id/access-log; flattens pages, exposes
cursor pagination for the Carica altri button. Lazy via enabled.
EOF
```

---

## Task 4: `AccessLogRow` component

**Files:**
- Create: `packages/mobile/src/components/AccessLogRow.tsx`
- Test: `packages/mobile/tests/components/AccessLogRow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/AccessLogRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import { AccessLogRow } from '@/components/AccessLogRow';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

const base: CustomerAccessEntry = {
  action: 'view',
  tenantName: 'Officina Rossi',
  locationCity: 'Torino',
  occurredAt: '2026-06-05T12:32:00.000Z',
};

describe('AccessLogRow', () => {
  it('renders the view action label, tenant and city', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.getByText('Consultazione libretto')).toBeOnTheScreen();
    expect(screen.getByText(/Officina Rossi/)).toBeOnTheScreen();
    expect(screen.getByText(/Torino/)).toBeOnTheScreen();
  });

  it('renders the new_intervention action label', () => {
    render(<AccessLogRow entry={{ ...base, action: 'new_intervention' }} />);
    expect(screen.getByText('Nuovo intervento registrato')).toBeOnTheScreen();
  });

  it('omits the city separator when locationCity is null', () => {
    render(<AccessLogRow entry={{ ...base, locationCity: null }} />);
    expect(screen.getByText('Officina Rossi')).toBeOnTheScreen();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('renders the mechanic name when present', () => {
    render(<AccessLogRow entry={{ ...base, mechanicName: 'Giuseppe Verdi' }} />);
    expect(screen.getByText('Tecnico: Giuseppe Verdi')).toBeOnTheScreen();
  });

  it('omits the mechanic line when absent', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.queryByText(/Tecnico:/)).toBeNull();
  });

  it('renders the absolute datetime', () => {
    render(<AccessLogRow entry={base} />);
    expect(screen.getByText('05/06/2026 14:32')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm jest tests/components/AccessLogRow.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: FAIL — cannot find module `@/components/AccessLogRow`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/components/AccessLogRow.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';
import { formatDateTime, formatTimeAgo } from '@/lib/format';
import type { CustomerAccessAction, CustomerAccessEntry } from '@/lib/types/accessLog';

// User-facing IT labels (inline, like DeadlineRow — no i18n framework here).
const ACTION_LABEL: Record<CustomerAccessAction, string> = {
  view: 'Consultazione libretto',
  new_intervention: 'Nuovo intervento registrato',
};

export function AccessLogRow({ entry }: { entry: CustomerAccessEntry }) {
  return (
    <View style={styles.row}>
      <View style={styles.body}>
        <Text style={styles.title}>{ACTION_LABEL[entry.action]}</Text>
        <Text style={styles.tenant}>
          {entry.tenantName}
          {entry.locationCity ? ` · ${entry.locationCity}` : ''}
        </Text>
        {entry.mechanicName ? (
          <Text style={styles.mechanic}>Tecnico: {entry.mechanicName}</Text>
        ) : null}
      </View>
      <View style={styles.right}>
        <Text style={styles.ago}>{formatTimeAgo(entry.occurredAt)}</Text>
        <Text style={styles.datetime}>{formatDateTime(entry.occurredAt)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { flex: 1, gap: spacing.xs },
  title: { fontSize: 15, fontWeight: '600', color: colors.fg },
  tenant: { fontSize: 13, color: colors.muted },
  mechanic: { fontSize: 13, color: colors.fg },
  right: { alignItems: 'flex-end', gap: spacing.xs },
  ago: { fontSize: 13, color: colors.fg },
  datetime: { fontSize: 12, color: colors.muted },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mobile && pnpm jest tests/components/AccessLogRow.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components/AccessLogRow.tsx packages/mobile/tests/components/AccessLogRow.test.tsx
git commit -F - <<'EOF'
feat(mobile): add AccessLogRow component

Informational audit row: action label + tenant/city, mechanic name (BR-151),
relative + absolute timestamp. Mirrors DeadlineRow.
EOF
```

---

## Task 5: `AccessLogTab` component

**Files:**
- Create: `packages/mobile/src/components/AccessLogTab.tsx`
- Test: `packages/mobile/tests/components/AccessLogTab.test.tsx`

Extracted to its own file (unlike the inline HistoryTab/DeadlinesTab) because it carries the pagination logic and deserves isolated tests. Purely presentational: takes plain props, no query/router knowledge.

- [ ] **Step 1: Write the failing test**

Create `tests/components/AccessLogTab.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react-native';
import { AccessLogTab } from '@/components/AccessLogTab';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

const entry: CustomerAccessEntry = {
  action: 'view',
  tenantName: 'Officina Rossi',
  locationCity: 'Torino',
  occurredAt: '2026-06-05T12:32:00.000Z',
};

const baseProps = {
  entries: [entry],
  isLoading: false,
  isError: false,
  errorCode: undefined as string | undefined,
  onRetry: () => {},
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: () => {},
};

describe('AccessLogTab', () => {
  it('renders the access rows', () => {
    render(<AccessLogTab {...baseProps} />);
    expect(screen.getByText('Consultazione libretto')).toBeOnTheScreen();
  });

  it('shows the empty state when there are no entries', () => {
    render(<AccessLogTab {...baseProps} entries={[]} />);
    expect(screen.getByText('Nessun accesso registrato')).toBeOnTheScreen();
  });

  it('shows the loading skeleton when loading', () => {
    render(<AccessLogTab {...baseProps} isLoading entries={[]} />);
    expect(screen.getByLabelText('Caricamento elenco')).toBeOnTheScreen();
  });

  it('shows the error state with a retry that fires onRetry', () => {
    const onRetry = jest.fn();
    render(<AccessLogTab {...baseProps} isError errorCode="me.error" entries={[]} onRetry={onRetry} />);
    fireEvent.press(screen.getByText('Riprova'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows Carica altri when hasNextPage and fires onLoadMore', () => {
    const onLoadMore = jest.fn();
    render(<AccessLogTab {...baseProps} hasNextPage onLoadMore={onLoadMore} />);
    fireEvent.press(screen.getByText('Carica altri'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('hides Carica altri when there is no next page', () => {
    render(<AccessLogTab {...baseProps} hasNextPage={false} />);
    expect(screen.queryByText('Carica altri')).toBeNull();
  });

  it('hides the Carica altri label while fetching the next page', () => {
    render(<AccessLogTab {...baseProps} hasNextPage isFetchingNextPage />);
    expect(screen.queryByText('Carica altri')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm jest tests/components/AccessLogTab.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: FAIL — cannot find module `@/components/AccessLogTab`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mobile/src/components/AccessLogTab.tsx`:

```tsx
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { AccessLogRow } from '@/components/AccessLogRow';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

type Props = {
  entries: CustomerAccessEntry[];
  isLoading: boolean;
  isError: boolean;
  errorCode?: string;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
};

export function AccessLogTab({
  entries,
  isLoading,
  isError,
  errorCode,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: Props) {
  if (isLoading) return <LoadingState variant="list" />;
  if (isError) return <ErrorState message={mapErrorToUserMessage(errorCode)} onRetry={onRetry} />;
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nessun accesso registrato"
        body="Non risultano ancora accessi al libretto di questo veicolo."
      />
    );
  }
  return (
    <FlatList
      data={entries}
      keyExtractor={(e, i) => `${e.occurredAt}-${i}`}
      renderItem={({ item }) => <AccessLogRow entry={item} />}
      scrollEnabled={false}
      ListFooterComponent={
        hasNextPage ? (
          <Pressable
            style={styles.loadMore}
            accessibilityRole="button"
            disabled={isFetchingNextPage}
            onPress={onLoadMore}
          >
            {isFetchingNextPage ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.loadMoreText}>Carica altri</Text>
            )}
          </Pressable>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  loadMore: {
    margin: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
  },
  loadMoreText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mobile && pnpm jest tests/components/AccessLogTab.test.tsx > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components/AccessLogTab.tsx packages/mobile/tests/components/AccessLogTab.test.tsx
git commit -F - <<'EOF'
feat(mobile): add AccessLogTab presentational component

States (loading/error/empty/list) + cursor pagination via a Carica altri
footer button. Pure props, unit-tested in isolation.
EOF
```

---

## Task 6: Wire the "Accessi" tab into the vehicle detail screen

**Files:**
- Modify: `packages/mobile/app/(tabs)/vehicles/[id].tsx`

No new automated test (the repo has no `[id]` screen test; the tab/onRefresh wiring is verified by typecheck, the full mobile suite, and the device smoke). The tab's logic is already covered by Task 5's `AccessLogTab.test.tsx`.

- [ ] **Step 1: Add imports**

In `app/(tabs)/vehicles/[id].tsx`, after the existing component imports (around line 12), add:

```tsx
import { useMeVehicleAccessLog } from '@/queries/meVehicleAccessLog';
import { AccessLogTab } from '@/components/AccessLogTab';
```

- [ ] **Step 2: Widen the tab union and add the access-log hook**

Change line 24 from:

```tsx
  const [tab, setTab] = useState<'history' | 'deadlines' | 'tech'>('history');
```

to:

```tsx
  const [tab, setTab] = useState<'history' | 'deadlines' | 'tech' | 'access'>('history');
```

After the `const deadlines = useMeDeadlines();` line (line 29), add:

```tsx
  const accessLog = useMeVehicleAccessLog(validId, { enabled: tab === 'access' });
```

- [ ] **Step 3: Include the access log in pull-to-refresh**

Replace the `onRefresh` callback (lines 31-38) with:

```tsx
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const tasks = [detail.refetch(), timeline.refetch(), deadlines.refetch()];
      if (tab === 'access') tasks.push(accessLog.refetch());
      await Promise.all(tasks);
    } finally {
      setRefreshing(false);
    }
  }, [detail, timeline, deadlines, accessLog, tab]);
```

- [ ] **Step 4: Add the 4th tab button**

In the `tabsRow` View, after the "Dati tecnici" Pressable (closes at line 104), add:

```tsx
          <Pressable
            onPress={() => setTab('access')}
            style={[styles.tabButton, tab === 'access' && styles.tabButtonActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === 'access' && styles.tabTextActive]}>Accessi</Text>
          </Pressable>
```

- [ ] **Step 5: Add the render branch**

Replace the tab content ternary (lines 107-113) with:

```tsx
        {tab === 'history' ? (
          <HistoryTab vehicleId={validId} timeline={timeline} />
        ) : tab === 'deadlines' ? (
          <DeadlinesTab vehicleId={validId} deadlines={deadlines} />
        ) : tab === 'tech' ? (
          <TechTab vehicle={v} />
        ) : (
          <AccessLogTab
            entries={accessLog.data ?? []}
            isLoading={accessLog.isLoading}
            isError={accessLog.isError}
            errorCode={accessLog.error instanceof ApiError ? accessLog.error.code : undefined}
            onRetry={accessLog.refetch}
            hasNextPage={accessLog.hasNextPage}
            isFetchingNextPage={accessLog.isFetchingNextPage}
            onLoadMore={() => {
              void accessLog.fetchNextPage();
            }}
          />
        )}
```

(`ApiError` is already imported at the top of the file.)

- [ ] **Step 6: Typecheck and run the full mobile suite**

Run: `cd packages/mobile && pnpm typecheck > /tmp/tc-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/tc-out.txt`
Expected: PASS (no errors).

Run: `cd packages/mobile && pnpm jest > /tmp/jest-out.txt 2>&1; echo "__EXIT $?__" >> /tmp/jest-out.txt`
Expected: PASS — all suites green (existing + the 3 new ones).

- [ ] **Step 7: Repo-wide typecheck**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS (this is the husky pre-push gate).

- [ ] **Step 8: Commit**

```bash
git add packages/mobile/app/\(tabs\)/vehicles/\[id\].tsx
git commit -F - <<'EOF'
feat(mobile): add Accessi tab to vehicle detail (F-CLI-304)

4th tab consuming GET /me/vehicles/:id/access-log via useMeVehicleAccessLog
(lazy, gated by the active tab). Completes the F-CLI-106 vehicle-detail UI.
EOF
```

---

## Self-Review

**Spec coverage:**
- formatDateTime (spec §1) → Task 1 ✅
- types accessLog.ts (spec §2) → Task 2 ✅
- useInfiniteQuery hook, lazy, cursor, select flatten (spec §3) → Task 3 ✅
- AccessLogRow: labels, tenant/city, mechanic, relative+absolute (spec §4, §5) → Task 4 ✅
- AccessLogTab: states + Carica altri (spec §6) → Task 5 ✅
- Screen wiring: 4th tab, lazy enable, onRefresh, render branch (spec §6) → Task 6 ✅
- Tests (spec §test) → covered in Tasks 1/3/4/5 (screen wiring intentionally smoke-verified)

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `CustomerAccessEntry` / `AccessLogPage` / `CustomerAccessAction` defined in Task 2 and used identically in Tasks 3/4/5. `useMeVehicleAccessLog(vehicleId, { enabled })` signature used consistently in Task 3 (def) and Task 6 (call). `AccessLogTab` prop names (`entries`, `isLoading`, `isError`, `errorCode`, `onRetry`, `hasNextPage`, `isFetchingNextPage`, `onLoadMore`) identical in Task 5 (def + test) and Task 6 (call). Action labels identical in spec §5, Task 4 impl, and Task 4 test.

## Pre-flight / gotcha reminders

- Nessuna nuova route Expo → nessun churn `.expo/types/router.d.ts`.
- Nessuna dipendenza nuova.
- `jest` mobile run via file + `__EXIT` (output-file backgroundato tarda).
- Commit message via `git commit -F -` (here-string `@'...'@` è PowerShell, rompe nel tool Bash); header ≤72, body ≤100; scope `mobile`.
- Endpoint camelCase (come /me, /me/vehicles, /me/deadlines).

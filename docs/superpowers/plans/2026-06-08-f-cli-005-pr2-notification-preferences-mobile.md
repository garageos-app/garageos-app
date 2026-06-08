# F-CLI-005 PR2 — Mobile Notification Preferences Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mobile screen that lets a B2C customer view and edit the four editable email notification preferences exposed by the API shipped in PR1 (#171).

**Architecture:** A standalone Expo Router route (`app/notification-preferences.tsx`, mirroring `claim-vehicle.tsx`) reached from a "Notifiche" row in the Profilo tab. Data flows through two react-query hooks in `src/queries/notificationPreferences.ts`: a GET query and a per-toggle optimistic PATCH mutation. Types mirror the API projection.

**Tech Stack:** React Native (Expo), expo-router, @tanstack/react-query v5, TypeScript, Jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-08-f-cli-005-pr2-notification-preferences-mobile-design.md`

**Wire shape (from PR1):**
- `GET /v1/me/notification-preferences` → `{ "email": { "intervention_updates": bool, "deadline_reminder": bool, "ownership_transfer": bool, "marketing": bool } }`
- `PATCH` body (deep-merge, single key OK): `{ "email": { "marketing": true } }` → returns same shape.

**Editable keys (order matters, mirrors API `EDITABLE_EMAIL_KEYS`):** `intervention_updates`, `deadline_reminder`, `ownership_transfer`, `marketing`.

**Conventions reminders:**
- Branch already created: `feat/mobile-notification-preferences-ui`.
- Commit scope `mobile`; header ≤72 chars; imperative present.
- New Expo route → delete `packages/mobile/.expo/types/router.d.ts` before typecheck so typed-routes regenerate (Task 4).
- Mobile `ApiError` mirrors RFC7807 (`code`/`status`/`detail`) — constructor `new ApiError(code, status, detail)`.
- Pre-push hook runs `pnpm -r typecheck`. Run `pnpm --filter @garageos/mobile test` for the new tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/mobile/src/lib/types/notification-preferences.ts` (new) | `EditableEmailKey` union, `EDITABLE_EMAIL_KEYS` ordered const, `NotificationPreferences` shape |
| `packages/mobile/src/queries/notificationPreferences.ts` (new) | `useNotificationPreferences` (GET) + `useUpdateNotificationPreference` (optimistic PATCH) |
| `packages/mobile/app/notification-preferences.tsx` (new) | Screen: 4 toggles, loading/error states, BR-260 hint, inline header |
| `packages/mobile/app/(tabs)/profile.tsx` (modify) | "Notifiche" nav row → `router.push('/notification-preferences')` |
| `packages/mobile/tests/queries/notificationPreferences.test.tsx` (new) | GET + PATCH-single-key + optimistic + revert |
| `packages/mobile/tests/screens/notification-preferences.test.tsx` (new) | render toggles, flip calls mutate, loading/error states |

---

## Task 1: Types module

**Files:**
- Create: `packages/mobile/src/lib/types/notification-preferences.ts`

This is a pure type/const module (no runtime branching) — it is exercised by the Task 2 tests, so no separate test here.

- [ ] **Step 1: Create the types module**

```typescript
// Mobile mirror of the API projection in
// packages/api/src/lib/notification-preferences.ts. The editable surface is the
// 4 email keys a customer may toggle (F-CLI-005); transfer_invitation (BR-260),
// dispute_response, and push.* are intentionally excluded.

export const EDITABLE_EMAIL_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
  'marketing',
] as const;

export type EditableEmailKey = (typeof EDITABLE_EMAIL_KEYS)[number];

export interface NotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: PASS (no usages yet, file compiles).

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/src/lib/types/notification-preferences.ts
git commit -m "feat(mobile): notification preferences types (F-CLI-005)"
```

---

## Task 2: Query + mutation hooks

**Files:**
- Create: `packages/mobile/src/queries/notificationPreferences.ts`
- Test: `packages/mobile/tests/queries/notificationPreferences.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/queries/notificationPreferences';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { NotificationPreferences } from '@/lib/types/notification-preferences';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const QUERY_KEY = ['me', 'notification-preferences'];

const PREFS: NotificationPreferences = {
  email: {
    intervention_updates: true,
    deadline_reminder: true,
    ownership_transfer: true,
    marketing: false,
  },
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useNotificationPreferences', () => {
  it('fetches /v1/me/notification-preferences', async () => {
    const apiFetch = jest.fn().mockResolvedValue(PREFS);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.email.intervention_updates).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences');
  });
});

describe('useUpdateNotificationPreference', () => {
  it('PATCHes a single-key email body and invalidates the query', async () => {
    const apiFetch = jest.fn().mockResolvedValue(PREFS);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ key: 'marketing', value: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences', {
      method: 'PATCH',
      body: { email: { marketing: true } },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: QUERY_KEY });
  });

  it('optimistically updates the cache before the request resolves', async () => {
    let resolve!: (v: NotificationPreferences) => void;
    const apiFetch = jest
      .fn()
      .mockReturnValue(new Promise<NotificationPreferences>((r) => (resolve = r)));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    qc.setQueryData(QUERY_KEY, PREFS);
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    act(() => {
      result.current.mutate({ key: 'marketing', value: true });
    });
    await waitFor(() =>
      expect(qc.getQueryData<NotificationPreferences>(QUERY_KEY)?.email.marketing).toBe(true),
    );
    // settle the in-flight request so no act() warning leaks
    act(() => resolve(PREFS));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('reverts the cache when the request fails', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('boom', 500, 'x'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    qc.setQueryData(QUERY_KEY, PREFS);
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ key: 'marketing', value: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<NotificationPreferences>(QUERY_KEY)?.email.marketing).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/mobile test notificationPreferences.test`
Expected: FAIL — `Cannot find module '@/queries/notificationPreferences'`.

- [ ] **Step 3: Implement the hooks**

Create `packages/mobile/src/queries/notificationPreferences.ts`:

```typescript
// useNotificationPreferences — GET /v1/me/notification-preferences (customer
// notification settings, F-CLI-005). useUpdateNotificationPreference — PATCH a
// single email key with an optimistic cache update + revert on failure, so the
// toggle responds instantly despite Lambda cold start. Mirrors me.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  EditableEmailKey,
  NotificationPreferences,
} from '@/lib/types/notification-preferences';

const QUERY_KEY = ['me', 'notification-preferences'] as const;

export function useNotificationPreferences() {
  const api = useApiClient();
  return useQuery<NotificationPreferences, Error>({
    queryKey: QUERY_KEY,
    queryFn: () => api.fetch<NotificationPreferences>('/v1/me/notification-preferences'),
  });
}

interface UpdateVars {
  key: EditableEmailKey;
  value: boolean;
}

interface MutationContext {
  previous?: NotificationPreferences;
}

export function useUpdateNotificationPreference() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<NotificationPreferences, Error, UpdateVars, MutationContext>({
    mutationFn: ({ key, value }) =>
      api.fetch<NotificationPreferences>('/v1/me/notification-preferences', {
        method: 'PATCH',
        body: { email: { [key]: value } },
      }),
    onMutate: async ({ key, value }) => {
      // Cancel in-flight refetches so they don't clobber the optimistic write.
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const previous = qc.getQueryData<NotificationPreferences>(QUERY_KEY);
      if (previous) {
        qc.setQueryData<NotificationPreferences>(QUERY_KEY, {
          email: { ...previous.email, [key]: value },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(QUERY_KEY, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/mobile test notificationPreferences.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/queries/notificationPreferences.ts packages/mobile/tests/queries/notificationPreferences.test.tsx
git commit -m "feat(mobile): notification preferences query hooks (F-CLI-005)"
```

---

## Task 3: Notification preferences screen

**Files:**
- Create: `packages/mobile/app/notification-preferences.tsx`
- Test: `packages/mobile/tests/screens/notification-preferences.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react-native';
import NotificationPreferencesScreen from '../../app/notification-preferences';

const mutate = jest.fn();
let prefsState: ReturnType<typeof makeState>;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
    data: {
      email: {
        intervention_updates: true,
        deadline_reminder: false,
        ownership_transfer: true,
        marketing: false,
      },
    },
    ...overrides,
  };
}

jest.mock('@/queries/notificationPreferences', () => ({
  useNotificationPreferences: () => prefsState,
  useUpdateNotificationPreference: () => ({ mutate }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));

describe('NotificationPreferences screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prefsState = makeState();
  });

  it('renders the 4 toggles reflecting current values', () => {
    render(<NotificationPreferencesScreen />);
    expect(screen.getByTestId('toggle-intervention_updates').props.value).toBe(true);
    expect(screen.getByTestId('toggle-deadline_reminder').props.value).toBe(false);
    expect(screen.getByTestId('toggle-ownership_transfer').props.value).toBe(true);
    expect(screen.getByTestId('toggle-marketing').props.value).toBe(false);
  });

  it('flipping a toggle calls mutate with key and new value', () => {
    render(<NotificationPreferencesScreen />);
    fireEvent(screen.getByTestId('toggle-marketing'), 'valueChange', true);
    expect(mutate).toHaveBeenCalledWith({ key: 'marketing', value: true });
  });

  it('shows the loading state (no toggles)', () => {
    prefsState = makeState({ isLoading: true, data: undefined });
    render(<NotificationPreferencesScreen />);
    expect(screen.queryByTestId('toggle-marketing')).toBeNull();
  });

  it('shows the error state with the fallback message', () => {
    prefsState = makeState({ isError: true, data: undefined });
    render(<NotificationPreferencesScreen />);
    expect(screen.getByText('Si è verificato un errore. Riprova più tardi.')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/mobile test notification-preferences.test`
Expected: FAIL — `Cannot find module '../../app/notification-preferences'`.

- [ ] **Step 3: Implement the screen**

Create `packages/mobile/app/notification-preferences.tsx`:

```tsx
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/queries/notificationPreferences';
import {
  EDITABLE_EMAIL_KEYS,
  type EditableEmailKey,
} from '@/lib/types/notification-preferences';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

// Italian labels for the editable email channels. Order follows
// EDITABLE_EMAIL_KEYS so the screen output is deterministic.
const LABELS: Record<EditableEmailKey, string> = {
  intervention_updates: 'Aggiornamenti interventi',
  deadline_reminder: 'Promemoria scadenze',
  ownership_transfer: 'Trasferimenti di proprietà',
  marketing: 'Novità e promozioni',
};

export default function NotificationPreferencesScreen() {
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreference();

  if (prefs.isLoading) return <LoadingState variant="fullscreen" />;
  if (prefs.isError) {
    const code = prefs.error instanceof ApiError ? prefs.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={prefs.refetch} />;
  }

  const email = prefs.data!.email;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Notifiche' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {EDITABLE_EMAIL_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.label}>{LABELS[key]}</Text>
            <Switch
              testID={`toggle-${key}`}
              accessibilityLabel={LABELS[key]}
              value={email[key]}
              onValueChange={(value) => update.mutate({ key, value })}
            />
          </View>
        ))}
        {/* BR-260: transfer-invitation and other service emails are always sent. */}
        <Text style={styles.hint}>
          Alcune comunicazioni di servizio (es. inviti al trasferimento di un veicolo) vengono
          sempre inviate.
        </Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
  },
  label: { fontSize: 16, color: colors.fg, flex: 1, paddingRight: spacing.md },
  hint: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/mobile test notification-preferences.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/notification-preferences.tsx packages/mobile/tests/screens/notification-preferences.test.tsx
git commit -m "feat(mobile): notification preferences screen (F-CLI-005)"
```

---

## Task 4: Profilo tab entry point

**Files:**
- Modify: `packages/mobile/app/(tabs)/profile.tsx`

No unit test: there is no existing Profilo screen test harness, and the change is a single navigation row. It is covered by typecheck (typed route) and the smoke pass. Adding a full `useMe`/`useAuth`/`AuthProvider` mock harness for one `router.push` line is not worth it for this slice.

- [ ] **Step 1: Add `useRouter` and `Ionicons` imports**

In `packages/mobile/app/(tabs)/profile.tsx`, change the top imports. Current line 1-2:

```tsx
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
```

Add the router and icon imports immediately after the react-native import:

```tsx
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
```

- [ ] **Step 2: Get the router inside the component**

Find the line `const { signOut } = useAuth();` (currently line 14) and add the router below it:

```tsx
  const { signOut } = useAuth();
  const router = useRouter();
```

- [ ] **Step 3: Add the "Notifiche" nav row**

In the non-editing return block, insert the nav row between the Telefono card (the `View` whose label is "Telefono") and the "Modifica" `Pressable`. Insert this immediately after the closing `</View>` of the Telefono card:

```tsx
      <Pressable
        onPress={() => router.push('/notification-preferences')}
        accessibilityRole="button"
        accessibilityLabel="Notifiche"
        style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
      >
        <Text style={styles.navLabel}>Notifiche</Text>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Pressable>
```

- [ ] **Step 4: Add the nav-row styles**

In the `StyleSheet.create({ ... })` block, add these entries (e.g. after the `hint` entry):

```tsx
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
  },
  navRowPressed: { opacity: 0.7 },
  navLabel: { fontSize: 16, color: colors.fg },
```

- [ ] **Step 5: Regenerate typed routes and typecheck**

The new route must be picked up by expo-router's typed-routes generator, or `router.push('/notification-preferences')` will not typecheck.

Run (PowerShell):
```powershell
Remove-Item packages/mobile/.expo/types/router.d.ts -ErrorAction SilentlyContinue
pnpm --filter @garageos/mobile typecheck
```
Expected: PASS. (`.expo/types/router.d.ts` is regenerated and now includes `/notification-preferences`.)

- [ ] **Step 6: Commit**

```bash
git add "packages/mobile/app/(tabs)/profile.tsx"
git commit -m "feat(mobile): link notification preferences from Profilo (F-CLI-005)"
```

---

## Task 5: Final verification and PR

**Files:** none (verification + push).

- [ ] **Step 1: Run the full mobile test suite**

Run: `pnpm --filter @garageos/mobile test`
Expected: PASS — all suites green, including the two new files (8 new tests total).

- [ ] **Step 2: Run the workspace typecheck (pre-push gate)**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/mobile-notification-preferences-ui
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(mobile): notification preferences screen (F-CLI-005)" --body "<see template below>"
```

PR body must include What / Why (F-CLI-005, BR-226, BR-260) / Implementation notes (per-toggle optimistic, standalone route from Profilo) / Tests checklist / no-screenshots note (or attach a smoke screencap if captured).

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: all checks green. Fix-forward with follow-up commits if anything fails.

---

## Self-Review

**Spec coverage:**
- GET hook + screen render → Task 2 (`useNotificationPreferences`) + Task 3 (render test). ✔
- Per-toggle optimistic PATCH + revert → Task 2 (optimistic + revert tests). ✔
- 4 editable keys / Italian labels / deterministic order → Task 1 const + Task 3 `LABELS`. ✔
- BR-260 hint → Task 3 hint `Text`. ✔
- Standalone route + inline header (no `_layout.tsx` change) → Task 3 `Stack.Screen`. ✔
- Entry point row in Profilo → Task 4. ✔
- Loading/error states via `LoadingState`/`ErrorState`/`mapErrorToUserMessage` → Task 3. ✔
- No API/infra/schema/dep changes → confirmed; only mobile files touched. ✔

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✔

**Type consistency:** `EditableEmailKey`, `EDITABLE_EMAIL_KEYS`, `NotificationPreferences` defined in Task 1 and used identically in Tasks 2–3. Query key `['me', 'notification-preferences']` consistent across hook, tests, optimistic, and invalidate. Mutation input `{ key, value }` consistent between hook, screen `onValueChange`, and tests. PATCH body `{ email: { [key]: value } }` consistent between hook and Task 2 assertion. ✔

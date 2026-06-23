# Mobile push-permission prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt the customer to enable OS notifications in-app (a priming "soft-ask" modal at first login, plus a contextual reminder banner on value screens) instead of forcing them to enable notifications manually in the phone Settings.

**Architecture:** Pure mobile slice, no backend changes. The OS permission status (`granted | denied | blocked`) becomes the single reactive source of truth via a React Query query (`usePushPermissionStatus`), invalidated after every enable attempt and on every foreground return (`AppState`). The "enable push" flow currently inlined in `app/notification-preferences.tsx` is extracted into a reusable `useEnablePush()` hook consumed by the preferences toggle, the soft-ask modal, and the reminder banner. A `softAskSeen` flag (AsyncStorage) makes the modal one-time.

**Tech Stack:** React Native + Expo, expo-notifications, @tanstack/react-query, expo-secure-store (existing), @react-native-async-storage/async-storage (existing).

**Spec:** None — small/medium single-layer slice. Per `CLAUDE.md` § "Right-sizing the workflow to the task", the brainstorming conversation (this session) + this lightweight plan are the design record. No `docs/superpowers/specs/*.md`.

**LOC budget:** target ~350 net, hard PR limit 1500. Controller checks cumulative LOC after each task; halt and ask at ~80% of the limit.

## Decisions captured from brainstorming

- **Scope: notifications only.** Camera is already requested in-context by `expo-camera` when the QR scanner opens (`app.config.js:30`) — not touched.
- **UX: lightweight soft-ask (priming) modal**, not a full onboarding screen. Shown once, after the first login lands on the `(tabs)` shell.
- **Re-ask policy: one-time soft-ask + a contextual reminder banner.** The banner is independent of the soft-ask flag.
- **Banner placement: Scadenze tab + public workshop intervention detail.** (See Deviations — the private intervention screen is an edit form and out of scope.)
- **`softAskSeen` is NOT cleared on `signOut`** — the soft-ask is a one-time device event; a second account on the same device is still covered by the contextual banner.

## Deviations from spec (verified against actual code — the code wins)

- **Banner not placed on `app/private-interventions/[id].tsx`.** Verified `private-interventions/[id].tsx:21-41`: it is an edit form (`PrivateInterventionForm`) for the user's own private logbook, not a surface that receives `intervention_updates` push events (those concern workshop interventions, shown on the read-only `app/interventions/[id].tsx`). Placing a "enable notifications for intervention updates" banner there would be misleading. Banner goes on `app/interventions/[id].tsx` instead.
- **`getPushPermissionStatus()` already collapses the three states correctly** (`src/lib/push.ts:24-28`): `granted`; `blocked` = denied + `canAskAgain === false`; `denied` = still-askable. The plan relies on this exact mapping — `denied` always means "the OS prompt will still appear". No change to `push.ts` permission helpers.
- **`useRegisterPushToken` already persists the server row id** in its `onSuccess` via `writePushTokenId` (`src/queries/pushTokens.ts:14-16`). `useEnablePush` must NOT write the id again — it would double-write. It only calls `register.mutateAsync(...)`.

## Gotchas the implementer MUST respect (from project memory)

- **Async-mount clobber** (`feedback_async_mount_init_clobbers_user_action`): the current screen guards a concurrent toggle with an `interacted` ref. Modeling permission state as a React Query query removes that whole class of bug — do NOT reintroduce ad-hoc `setState`-on-mount that can overwrite a user action. Read status from the query everywhere.
- **react-query `data!` offline crash** (`feedback_react_query_data_bang_offline_paused`): never assume `usePushPermissionStatus().data` is defined; gate on `status === undefined`. The query reads a local OS API (no network) so it resolves fast, but treat `undefined` as "unknown → render nothing".
- **signOut clears queryClient** (`feedback_signout_clear_query_cache`): `queryClient.clear()` is already called on signOut in this app's auth flow path; the push-permission query key will be dropped on logout and re-fetched fresh on next login — desired.
- **Mobile ApiError RFC7807** (`feedback_mobile_apierror_rfc7807_mismatch`): not directly relevant (no new API), but `useEnablePush` must swallow registration errors best-effort exactly like the current toggle (`notification-preferences.tsx:100-106`).
- **jest mock default import needs `__esModule`** (`feedback_jest_mock_default_import_needs_esmodule`): when a test mocks a module imported as default, use `{ __esModule: true, default: {...} }`.
- **Expo Go vs dev build** (`feedback_cognito_srp_expo_go_bridgeless`): `expo-notifications` permission APIs require a dev build; the smoke runbook must run on the real dev build, not Expo Go.
- **adb reverse / stale bundle** (`feedback_adb_reverse_drops_stale_bundle`): re-assert `adb reverse tcp:8081` before suspecting code during smoke.

## Pre-flight checklist (run before implementing — mobile-relevant subset)

- [x] No Prisma / schema / RLS / migration / CDK changes — pure mobile UI slice. The DB/infra checklist sections are N/A.
- [x] No new error codes — `APPENDICE_G` grep N/A (no API surface added).
- [x] No new `BR-XXX` — this is UX, not a coded business rule. `APPENDICE_F` grep N/A. (BR-260 "service emails always sent" is unrelated and untouched.)
- [x] Target file paths grepped: `lib/push-prompt-storage.ts`, `queries/pushPermission.ts`, `lib/useEnablePush.ts`, `components/PushReminderBanner.tsx`, `components/PushSoftAskModal.tsx` do NOT yet exist (confirmed via Glob during planning). All are "Create new".
- [x] `PushPermission` type = `'granted' | 'denied' | 'blocked'` (`src/lib/types/push.ts:8`).
- [ ] No new dependency: `@react-native-async-storage/async-storage` is already a dependency (used by the query persister in `app/_layout.tsx:11`). Confirm with `grep async-storage packages/mobile/package.json` before Task 1.
- [ ] Comment headers in English; user-facing strings in Italian (verbatim strings are in this plan).

## Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/mobile-push-permission-prompt
```

(Current branch `feat/google-signin-pr3-mobile` is a separate, not-yet-merged arc — do NOT build on top of it.)

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/mobile/src/lib/push-prompt-storage.ts` | Create | Read/write the one-time `softAskSeen` flag (AsyncStorage). |
| `packages/mobile/src/queries/pushPermission.ts` | Create | `usePushPermissionStatus()` query + `useInvalidatePushPermission()` + `AppState`-foreground invalidation. Single reactive source of truth. |
| `packages/mobile/src/lib/useEnablePush.ts` | Create | `useEnablePush()` — runs `ensurePushPermission → getDevicePushToken → register`, invalidates the permission query. Extracted from the screen. |
| `packages/mobile/src/components/PushReminderBanner.tsx` | Create | Reusable, per-session-dismissible banner; action depends on `denied` (enable) vs `blocked` (open settings). |
| `packages/mobile/src/components/PushSoftAskModal.tsx` | Create | One-time priming modal hosted in the authenticated shell. |
| `packages/mobile/app/notification-preferences.tsx` | Modify | Consume `useEnablePush` + `usePushPermissionStatus`; drop inline enable logic and the `interacted` ref. |
| `packages/mobile/app/(tabs)/_layout.tsx` | Modify | Mount `<PushSoftAskModal/>`. |
| `packages/mobile/app/(tabs)/deadlines.tsx` | Modify | Mount `<PushReminderBanner/>` at the top. |
| `packages/mobile/app/interventions/[id].tsx` | Modify | Mount `<PushReminderBanner/>` at the top of the ScrollView. |
| `docs/superpowers/runbooks/2026-06-23-push-permission-prompt-smoke.md` | Create | Device smoke runbook (BLOCKER for merge). |

---

## Task 1: One-time soft-ask flag storage

**Files:**
- Create: `packages/mobile/src/lib/push-prompt-storage.ts`
- Test: `packages/mobile/tests/lib/push-prompt-storage.test.ts`

**Interfaces:**
- Produces:
  - `readSoftAskSeen(): Promise<boolean>` — `true` iff the flag was previously written.
  - `markSoftAskSeen(): Promise<void>` — persists the flag.

**Contract:** Backed by AsyncStorage under key `garageos.push.softAskSeen`, value `'1'`. Non-sensitive → AsyncStorage (not SecureStore). `readSoftAskSeen` returns `false` when the key is absent or storage throws (best-effort: a read failure must not block the UI).

- [ ] **Step 1: Write the failing test.** Mock `@react-native-async-storage/async-storage`. Cases:
  - `readSoftAskSeen()` returns `false` when `getItem` resolves `null`.
  - after `markSoftAskSeen()`, `setItem` was called with `('garageos.push.softAskSeen', '1')`.
  - `readSoftAskSeen()` returns `true` when `getItem` resolves `'1'`.
  - `readSoftAskSeen()` returns `false` (not throw) when `getItem` rejects.
- [ ] **Step 2: Run the test, verify it fails** (`module not found`).
  Run: `pnpm --filter @garageos/mobile test -- push-prompt-storage`
- [ ] **Step 3: Implement** the two functions over `AsyncStorage` with a `try/catch` in `readSoftAskSeen` returning `false` on error. English header comment explaining why AsyncStorage (non-sensitive) vs SecureStore.
- [ ] **Step 4: Run the test, verify it passes.**
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/mobile/src/lib/push-prompt-storage.ts packages/mobile/tests/lib/push-prompt-storage.test.ts
  git commit -m "feat(mobile): add one-time push soft-ask seen flag storage"
  ```

---

## Task 2: Reactive push-permission status query

**Files:**
- Create: `packages/mobile/src/queries/pushPermission.ts`
- Test: `packages/mobile/tests/queries/pushPermission.test.tsx`

**Interfaces:**
- Consumes: `getPushPermissionStatus(): Promise<PushPermission>` from `@/lib/push` (`src/lib/push.ts:24`).
- Produces:
  - `PUSH_PERMISSION_KEY = ['push', 'permission'] as const`
  - `usePushPermissionStatus(): UseQueryResult<PushPermission>` — `queryKey: PUSH_PERMISSION_KEY`, `queryFn: getPushPermissionStatus`, `staleTime: 0` (status is cheap and can change out-of-band).
  - `useInvalidatePushPermission(): () => Promise<void>` — invalidates `PUSH_PERMISSION_KEY` via the active `queryClient`.

**Contract:** The query also wires an `AppState` listener (inside the hook, `useEffect`) that invalidates `PUSH_PERMISSION_KEY` whenever app state transitions to `'active'` — this is what makes the banner update after the user returns from the OS Settings. The listener is registered once per `usePushPermissionStatus` mount and removed on unmount.

- [ ] **Step 1: Write the failing test.** Use a real `QueryClient` + `QueryClientProvider` wrapper and `renderHook` from `@testing-library/react-native`. Mock `@/lib/push` so `getPushPermissionStatus` returns a controllable value. Mock `react-native`'s `AppState.addEventListener` to capture the handler. Cases:
  - `usePushPermissionStatus()` eventually exposes `data === 'denied'` when the lib returns `'denied'`.
  - firing the captured `AppState` handler with `'active'` triggers a refetch (e.g. `getPushPermissionStatus` called a second time).
  - `useInvalidatePushPermission()` returns a function that, when called, causes a refetch.
- [ ] **Step 2: Run the test, verify it fails.**
  Run: `pnpm --filter @garageos/mobile test -- pushPermission`
- [ ] **Step 3: Implement** `pushPermission.ts`. Header comment: "Single reactive source of truth for the OS notification permission. AppState-active invalidation covers the user granting via system Settings while the app was backgrounded." Use `useQueryClient` for the invalidator; in the hook's `useEffect`, `AppState.addEventListener('change', s => { if (s === 'active') void qc.invalidateQueries({ queryKey: PUSH_PERMISSION_KEY }); })` and return `sub.remove`.
- [ ] **Step 4: Run the test, verify it passes.**
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/mobile/src/queries/pushPermission.ts packages/mobile/tests/queries/pushPermission.test.tsx
  git commit -m "feat(mobile): add reactive push-permission status query"
  ```

---

## Task 3: Extract `useEnablePush` and refactor the preferences screen

**Files:**
- Create: `packages/mobile/src/lib/useEnablePush.ts`
- Test: `packages/mobile/tests/lib/useEnablePush.test.tsx`
- Modify: `packages/mobile/app/notification-preferences.tsx` (replace inline enable logic at `:50-118`)
- Modify (tests): `packages/mobile/tests/screens/notification-preferences-push.test.tsx`, `packages/mobile/tests/screens/notification-preferences.test.tsx`

**Interfaces:**
- Consumes: `ensurePushPermission`, `getDevicePushToken`, `buildRegistrationPayload` from `@/lib/push`; `useRegisterPushToken` from `@/queries/pushTokens`; `useInvalidatePushPermission` from `@/queries/pushPermission`.
- Produces:
  - `useEnablePush(): { enable: () => Promise<PushPermission> }`
  - `enable()` runs: `const perm = await ensurePushPermission()`; if `perm === 'granted'`, `await register.mutateAsync(buildRegistrationPayload(await getDevicePushToken()))` (best-effort: swallow registration errors); then `await invalidate()`; return `perm` (`'granted' | 'denied' | 'blocked'`).

**Contract:** This is the extraction of the existing enable path in `notification-preferences.tsx:86-106`. The comparison of removed lines (per pre-flight: "compare removed lines for inline guards") must show every behavior preserved: the `blocked` short-circuit, the `!== 'granted'` no-op, the try/catch around token registration. The screen, after refactor, derives the toggle's ON state from `usePushPermissionStatus()` + `readPushTokenId()` instead of the mount effect + `interacted` ref. **Do NOT** call `writePushTokenId` in `enable()` — `useRegisterPushToken.onSuccess` already does (Deviations).

- [ ] **Step 1: Write the failing test for `useEnablePush`.** `renderHook` with a QueryClient wrapper. Mock `@/lib/push`, `@/queries/pushTokens`, `@/queries/pushPermission`. Cases:
  - `granted` → `register.mutateAsync` called with the built payload, invalidate called, returns `'granted'`.
  - `denied` → `register.mutateAsync` NOT called, returns `'denied'`.
  - `blocked` → `register.mutateAsync` NOT called, returns `'blocked'`.
  - registration rejects → `enable()` still resolves `'granted'` (best-effort), does not throw.
- [ ] **Step 2: Run the test, verify it fails.**
  Run: `pnpm --filter @garageos/mobile test -- useEnablePush`
- [ ] **Step 3: Implement `useEnablePush.ts`.**
- [ ] **Step 4: Run, verify the hook test passes.**
- [ ] **Step 5: Refactor `notification-preferences.tsx`** to consume `useEnablePush` (toggle-on path) and `usePushPermissionStatus` (initial ON/blocked state). Remove the mount `useEffect` token-refresh + `interacted` ref. Toggle-on: call `enable()`, set local UI from the returned `PushPermission` (`blocked` → show the Settings hint that already exists at `:145-151`). Toggle-off: unchanged (`del.mutateAsync` path at `:107-117`). Keep the existing `testID`s (`toggle-device-push`) and the blocked-hint copy verbatim.
- [ ] **Step 6: Update the two screen tests** to mock `@/lib/useEnablePush` (`{ enable }`) and `@/queries/pushPermission` (`usePushPermissionStatus` returning `{ data: 'denied' }`, `useInvalidatePushPermission` returning a noop). Preserve the existing assertions' intent: granted registers, blocked shows the Settings hint and does not register.
- [ ] **Step 7: Run all notification-preferences + useEnablePush tests, verify green.**
  Run: `pnpm --filter @garageos/mobile test -- notification-preferences useEnablePush`
- [ ] **Step 8: Commit.**
  ```bash
  git add packages/mobile/src/lib/useEnablePush.ts packages/mobile/tests/lib/useEnablePush.test.tsx packages/mobile/app/notification-preferences.tsx packages/mobile/tests/screens/notification-preferences-push.test.tsx packages/mobile/tests/screens/notification-preferences.test.tsx
  git commit -m "refactor(mobile): extract useEnablePush from notification prefs"
  ```

---

## Task 4: Reminder banner + placement on Scadenze and intervention detail

**Files:**
- Create: `packages/mobile/src/components/PushReminderBanner.tsx`
- Test: `packages/mobile/tests/components/PushReminderBanner.test.tsx`
- Modify: `packages/mobile/app/(tabs)/deadlines.tsx` (mount banner in the root `View`, above `SegmentedControl`)
- Modify: `packages/mobile/app/interventions/[id].tsx` (mount banner at the top of the `ScrollView` content, after the loaded gate)

**Interfaces:**
- Consumes: `usePushPermissionStatus` from `@/queries/pushPermission`; `useEnablePush` from `@/lib/useEnablePush`; `Linking` from `react-native`.
- Produces: `export function PushReminderBanner(): JSX.Element | null`

**Contract / visibility:**
- `status === undefined` (unknown) → render `null`.
- `status === 'granted'` → render `null`.
- per-session dismissed (local `useState`) → render `null`.
- `status === 'denied'` → show banner; press body → `await enable()` (triggers OS prompt; the query invalidation flips visibility on grant).
- `status === 'blocked'` → show banner; press body → `void Linking.openSettings()`.
- A "×" dismiss control (`accessibilityLabel="Chiudi"`, `testID="push-banner-dismiss"`) sets the per-session dismissed state.

**Verbatim Italian copy:**
- denied body: `Attiva le notifiche per ricevere aggiornamenti sui tuoi interventi e promemoria per le scadenze.`
- blocked body: `Le notifiche sono disattivate. Apri le impostazioni per abilitarle.`
- root `testID="push-reminder-banner"`. Styling: reuse `colors.warningBg`/`colors.warningFg` + `spacing` from `@/theme/colors` (a soft, non-blocking row — not an `Alert`).

- [ ] **Step 1: Write the failing test.** Mock `@/queries/pushPermission`, `@/lib/useEnablePush`, and `react-native`'s `Linking.openSettings`. Cases (no pure-render assertions — only behavior/visibility gates per CLAUDE.md Tier 2):
  - `granted` → `queryByTestId('push-reminder-banner')` is `null`.
  - `denied` → banner present; pressing it calls `enable`.
  - `blocked` → pressing it calls `Linking.openSettings`.
  - pressing `push-banner-dismiss` hides the banner (`denied` start → after press, `queryByTestId` null).
- [ ] **Step 2: Run, verify it fails.**
  Run: `pnpm --filter @garageos/mobile test -- PushReminderBanner`
- [ ] **Step 3: Implement** `PushReminderBanner.tsx`.
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Mount the banner** in `deadlines.tsx` (inside the root `View` at `:46-48`, before `SegmentedControl`) and in `interventions/[id].tsx` (top of the `ScrollView` content at `:45-46`, before the first card). Import is side-effect-free; render adds one line each.
- [ ] **Step 6: Typecheck the two screens compile.**
  Run: `pnpm --filter @garageos/mobile typecheck`
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/mobile/src/components/PushReminderBanner.tsx packages/mobile/tests/components/PushReminderBanner.test.tsx "packages/mobile/app/(tabs)/deadlines.tsx" "packages/mobile/app/interventions/[id].tsx"
  git commit -m "feat(mobile): add push reminder banner on deadlines and intervention"
  ```

---

## Task 5: One-time soft-ask priming modal in the authenticated shell

**Files:**
- Create: `packages/mobile/src/components/PushSoftAskModal.tsx`
- Test: `packages/mobile/tests/components/PushSoftAskModal.test.tsx`
- Modify: `packages/mobile/app/(tabs)/_layout.tsx` (render `<PushSoftAskModal/>` inside `Tabs`' parent — alongside, not as a `Tabs.Screen`)

**Interfaces:**
- Consumes: `usePushPermissionStatus` from `@/queries/pushPermission`; `useEnablePush` from `@/lib/useEnablePush`; `readSoftAskSeen` / `markSoftAskSeen` from `@/lib/push-prompt-storage`; `Modal` from `react-native`.
- Produces: `export function PushSoftAskModal(): JSX.Element | null`

**Contract / visibility:** On mount, `void readSoftAskSeen()` into local state `seen: boolean | undefined`. Render `null` until `seen` is resolved AND `status` is resolved. Show the modal iff `status === 'denied' && seen === false`. (`granted`, `blocked`, or `seen` → never show. `blocked` is excluded because the OS prompt would not appear.)
- **"Attiva notifiche"** (`testID="softask-enable"`) → `await enable()`, then `await markSoftAskSeen()`, then hide. (Whatever `enable()` returns, mark seen — we do not re-prompt automatically.)
- **"Non ora"** (`testID="softask-dismiss"`) → `await markSoftAskSeen()`, hide. Does NOT call `enable()` (does not burn the one OS prompt).

**Verbatim Italian copy:**
- title: `Attiva le notifiche`
- body: `Ti avvisiamo quando ci sono aggiornamenti sui tuoi interventi e promemoria per le scadenze dei tuoi veicoli.`
- primary button: `Attiva notifiche`
- secondary button: `Non ora`

- [ ] **Step 1: Write the failing test.** Mock `@/queries/pushPermission`, `@/lib/useEnablePush`, `@/lib/push-prompt-storage`. Cases (visibility logic = the load-bearing part):
  - `denied` + `readSoftAskSeen→false` → modal content present (`findByText('Attiva le notifiche')`).
  - `granted` + not seen → `queryByText('Attiva le notifiche')` null.
  - `blocked` + not seen → null.
  - `denied` + `readSoftAskSeen→true` → null.
  - press `softask-enable` → `enable` called AND `markSoftAskSeen` called.
  - press `softask-dismiss` → `markSoftAskSeen` called AND `enable` NOT called.
- [ ] **Step 2: Run, verify it fails.**
  Run: `pnpm --filter @garageos/mobile test -- PushSoftAskModal`
- [ ] **Step 3: Implement** `PushSoftAskModal.tsx` using RN `Modal` (`transparent`, `animationType="fade"`). Reuse `colors`/`spacing`.
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Mount** `<PushSoftAskModal/>` in `(tabs)/_layout.tsx`. Since `Tabs` only accepts `Tabs.Screen` children, wrap the return in a fragment: `<><PushSoftAskModal/><Tabs ...>...</Tabs></>`. Verify it still renders the redirect/loading guards unchanged (`:9-12`).
- [ ] **Step 6: Typecheck + run the modal test.**
  Run: `pnpm --filter @garageos/mobile typecheck && pnpm --filter @garageos/mobile test -- PushSoftAskModal`
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/mobile/src/components/PushSoftAskModal.tsx packages/mobile/tests/components/PushSoftAskModal.test.tsx "packages/mobile/app/(tabs)/_layout.tsx"
  git commit -m "feat(mobile): add one-time push soft-ask priming modal"
  ```

---

## Task 6: Device smoke runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-06-23-push-permission-prompt-smoke.md`

**Contract:** A device smoke runbook (BLOCKER for merge — see CLAUDE.md). Must run on the **dev build** (not Expo Go — `expo-notifications` permission APIs need it) with `adb reverse tcp:8081` re-asserted. Cases:
1. **Fresh install / first login → soft-ask appears.** New device state (or after clearing app data so `softAskSeen` is unset) with notifications not yet granted → after login lands on the veicoli tab, the priming modal shows.
2. **"Attiva notifiche" → OS prompt → grant.** Modal primary button triggers the system dialog; granting hides the modal and the banner everywhere; the device push toggle in Notifiche prefs reads ON.
3. **"Non ora" → no OS prompt, modal gone for good.** Relaunch → modal does not reappear.
4. **Reminder banner on Scadenze + intervention detail** appears while notifications are off; tapping (denied) shows the OS prompt; "×" dismisses for the session; relaunch shows it again.
5. **Blocked path:** deny twice (or toggle off in OS) so status is `blocked` → banner tap opens system Settings; after enabling there and returning to the app, the banner disappears (AppState invalidation). Verify the modal does NOT appear in the blocked state.
6. **Regression:** the existing Notifiche preferences toggle still enables/disables push and shows the Settings hint when blocked.

- [ ] **Step 1: Write the runbook** following the structure of an existing runbook (e.g. `docs/superpowers/runbooks/notification-tap-smoke.md`), including the `adb reverse` / dev-build preconditions and a "clear app data to reset softAskSeen" note.
- [ ] **Step 2: Commit.**
  ```bash
  git add docs/superpowers/runbooks/2026-06-23-push-permission-prompt-smoke.md
  git commit -m "docs(mobile): add push permission prompt smoke runbook"
  ```

---

## Review gates (in order)

1. No per-task reviewer required (no new public API surface, no RLS/migration). 
2. `pnpm -r typecheck` — pre-push hook, mandatory local gate.
3. **Final whole-branch `/code-review high`** — load-bearing, never skip. Cross-checks the refactor of `notification-preferences.tsx` (removed-guard comparison), visibility-logic consistency across modal/banner, and the `denied`/`blocked` mapping.
4. CI full matrix (`gh pr checks --watch`).
5. **Smoke runbook on a real dev build — BLOCKER** before self-merge. No review stage replaces it.

## PR

Title: `feat(mobile): in-app notification permission prompt (soft-ask + reminder)`
Body per CLAUDE.md PR template. Tests checklist: Tier 2 component visibility tests + `useEnablePush` logic tests; manual smoke pending. Note the one Deviation (banner not on the private-intervention edit form) in "Implementation notes".

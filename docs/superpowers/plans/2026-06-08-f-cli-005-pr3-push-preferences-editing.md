# F-CLI-005 PR3 — Push preferences editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unlock per-event push notification preferences (`push.intervention_updates`, `push.deadline_reminder`, `push.ownership_transfer`) for editing through the customer notification-preferences surface — API editable keys + PATCH + mobile UI.

**Architecture:** Storage shape (`customer.notification_preferences.push.*`), BR-226 defaults, and the delivery gate (`isPushEnabled`) already exist from F-CLI-302 PR1/PR2. This PR only widens the *editable* surface: a new `EDITABLE_PUSH_KEYS` constant, a `push` branch in the projection, a `push` key in the PATCH schema/merge, and a new "Push" section in the mobile screen mirroring the existing "Email" section. No migration, no new dependency, no deploy.

**Tech Stack:** Fastify + Zod + Prisma (API, Vitest); React Native + Expo Router + react-query (mobile, Jest).

---

## Cascade warnings (read before starting)

Two existing tests assert the *old* (email-only) behaviour and MUST be updated as part of their owning task — they are not separate cleanup:

- `packages/api/tests/unit/lib/notification-preferences.test.ts` — `projectNotificationPreferences` expectations are email-only and one test asserts `push` is *ignored*. Updated in **Task 1**.
- `packages/api/tests/integration/me-notification-preferences.test.ts:120` — `PATCH with a push.* key returns 422`. push.* becomes valid; updated in **Task 2**.

Mobile cascades (same principle) are folded into Tasks 4 and 5.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/api/src/lib/notification-preferences.ts` | modify | Add `EDITABLE_PUSH_KEYS` + project `push` |
| `packages/api/tests/unit/lib/notification-preferences.test.ts` | modify | Cover push projection + fallback |
| `packages/api/src/routes/v1/me-notification-preferences.ts` | modify | PATCH accepts + merges `push` |
| `packages/api/tests/integration/me-notification-preferences.test.ts` | modify | push PATCH / merge / 422 cases |
| `packages/mobile/src/lib/types/notification-preferences.ts` | modify | Mirror `EDITABLE_PUSH_KEYS` + `push` type |
| `packages/mobile/src/queries/notificationPreferences.ts` | modify | Channel-aware mutation, preserve other channel |
| `packages/mobile/tests/queries/notificationPreferences.test.tsx` | modify | push body + cross-channel optimistic |
| `packages/mobile/app/notification-preferences.tsx` | modify | Push section (3 toggles) |
| `packages/mobile/tests/screens/notification-preferences.test.tsx` | modify | Render + flip push toggles |
| `docs/APPENDICE_A_API.md:2574` | modify | Note push editable |

---

## Task 1: API — editable push keys + projection

**Files:**
- Modify: `packages/api/src/lib/notification-preferences.ts`
- Test: `packages/api/tests/unit/lib/notification-preferences.test.ts`

- [ ] **Step 1: Update the failing tests**

Replace the entire body of `packages/api/tests/unit/lib/notification-preferences.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';

import { projectNotificationPreferences } from '../../../src/lib/notification-preferences.js';

const EMAIL_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
  marketing: false,
};
const PUSH_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
};

describe('projectNotificationPreferences', () => {
  it('returns email + push defaults for an empty object', () => {
    expect(projectNotificationPreferences({})).toEqual({
      email: EMAIL_DEFAULTS,
      push: PUSH_DEFAULTS,
    });
  });

  it('returns defaults for null / non-object / malformed json', () => {
    const expected = { email: EMAIL_DEFAULTS, push: PUSH_DEFAULTS };
    expect(projectNotificationPreferences(null)).toEqual(expected);
    expect(projectNotificationPreferences('nope')).toEqual(expected);
    expect(projectNotificationPreferences([1, 2])).toEqual(expected);
    expect(projectNotificationPreferences({ email: 'bad', push: 'bad' })).toEqual(expected);
  });

  it('reflects partial email + push overrides and fills the rest from defaults', () => {
    expect(
      projectNotificationPreferences({
        email: { intervention_updates: false, marketing: true },
        push: { deadline_reminder: false },
      }),
    ).toEqual({
      email: { ...EMAIL_DEFAULTS, intervention_updates: false, marketing: true },
      push: { ...PUSH_DEFAULTS, deadline_reminder: false },
    });
  });

  it('ignores non-boolean values and non-editable keys on both channels', () => {
    expect(
      projectNotificationPreferences({
        email: { deadline_reminder: 'yes', transfer_invitation: false, dispute_response: false },
        push: { ownership_transfer: 'no', transfer_invitation: false, dispute_response: false },
      }),
    ).toEqual({ email: EMAIL_DEFAULTS, push: PUSH_DEFAULTS });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/api test:unit -- notification-preferences`
Expected: FAIL — projection returns `{ email }` only (no `push` key), so `toEqual` mismatches.

- [ ] **Step 3: Implement the push branch**

In `packages/api/src/lib/notification-preferences.ts`, after the `EDITABLE_EMAIL_KEYS` block add:

```ts
// The subset of push channels a customer may edit via F-CLI-005. These are the
// only push keys with real delivery today (NotificationEventPrefKey, gated by
// isPushEnabled). Excludes transfer_invitation (BR-260, no push template) and
// dispute_response (no consumer); push has no `marketing`.
export const EDITABLE_PUSH_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
] as const;

export type EditablePushKey = (typeof EDITABLE_PUSH_KEYS)[number];
```

Replace the `ProjectedNotificationPreferences` interface and `projectNotificationPreferences` function with:

```ts
export interface ProjectedNotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
  push: Record<EditablePushKey, boolean>;
}

function subObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Effective preferences for the editable keys: stored value when it is a
// boolean, otherwise the BR-226 default. Mirrors the defensive fallback in
// lib/notifications/preferences.ts (missing/malformed/partial -> default).
export function projectNotificationPreferences(
  stored: Prisma.JsonValue,
): ProjectedNotificationPreferences {
  const root = subObject(stored);

  const emailObj = subObject(root.email);
  const email = {} as Record<EditableEmailKey, boolean>;
  for (const key of EDITABLE_EMAIL_KEYS) {
    const value = emailObj[key];
    email[key] = typeof value === 'boolean' ? value : DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }

  const pushObj = subObject(root.push);
  const push = {} as Record<EditablePushKey, boolean>;
  for (const key of EDITABLE_PUSH_KEYS) {
    const value = pushObj[key];
    push[key] = typeof value === 'boolean' ? value : DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }

  return { email, push };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/api test:unit -- notification-preferences`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/notification-preferences.ts packages/api/tests/unit/lib/notification-preferences.test.ts
git commit -F - <<'EOF'
feat(api): project editable push.* notification keys

Add EDITABLE_PUSH_KEYS and a push branch to projectNotificationPreferences
so GET /me/notification-preferences returns effective push values (F-CLI-005).
EOF
```

---

## Task 2: API — PATCH accepts and merges push

**Files:**
- Modify: `packages/api/src/routes/v1/me-notification-preferences.ts`
- Test: `packages/api/tests/integration/me-notification-preferences.test.ts`

- [ ] **Step 1: Update the integration tests**

In `packages/api/tests/integration/me-notification-preferences.test.ts`:

(a) After the `DEFAULTS` const (line ~17) add:

```ts
const PUSH_DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
};
```

(b) Replace the test `'PATCH with a push.* key returns 422'` (lines ~120-123) with these tests:

```ts
  it('GET returns push effective defaults too', async () => {
    const { token } = await authCustomer({});
    const res = await get(token);
    expect((res.json() as { push: unknown }).push).toEqual(PUSH_DEFAULTS);
  });

  it('PATCH updates a push key and GET reflects it', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { push: { deadline_reminder: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { push: unknown }).push).toEqual({
      ...PUSH_DEFAULTS,
      deadline_reminder: false,
    });
  });

  it('PATCH merges push onto existing prefs and preserves non-editable push keys', async () => {
    // dispute_response is a stored push key outside the editable surface; it must
    // survive the merge. intervention_updates seeded off proves merge (not replace).
    const { token } = await authCustomer({
      push: { intervention_updates: false, dispute_response: true },
    });
    const patchRes = await patch(token, { push: { ownership_transfer: false } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { push: unknown }).push).toEqual({
      ...PUSH_DEFAULTS,
      intervention_updates: false,
      ownership_transfer: false,
    });
  });

  it('PATCH can update email and push in one body', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, {
      email: { marketing: true },
      push: { intervention_updates: false },
    });
    expect(patchRes.statusCode).toBe(200);
    const body = patchRes.json() as { email: Record<string, boolean>; push: Record<string, boolean> };
    expect(body.email.marketing).toBe(true);
    expect(body.push.intervention_updates).toBe(false);
  });

  it('PATCH with an unknown push key returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { marketing: true } })).statusCode).toBe(422);
  });

  it('PATCH with {push:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: {} })).statusCode).toBe(422);
  });

  it('PATCH with {email:{},push:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: {}, push: {} })).statusCode).toBe(422);
  });

  it('PATCH with a non-boolean push value returns 400 (ZodError)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { deadline_reminder: 'yes' } })).statusCode).toBe(400);
  });
```

(Leave the existing email tests untouched — they still pass.)

- [ ] **Step 2: (Optional) eyeball the test file compiles**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (the route does not yet accept push, but the test file only sends payloads — no type coupling). If it fails, fix typos before proceeding.

> Note: the integration suite needs Docker/Testcontainers and runs on CI, not locally (per CLAUDE.md). Do not run `test:integration` locally. Verification is the CI run after push.

- [ ] **Step 3: Implement push in the route**

In `packages/api/src/routes/v1/me-notification-preferences.ts`:

(a) Extend the import from `../../lib/notification-preferences.js` to include the push symbols:

```ts
import {
  EDITABLE_EMAIL_KEYS,
  EDITABLE_PUSH_KEYS,
  projectNotificationPreferences,
  type EditableEmailKey,
  type EditablePushKey,
} from '../../lib/notification-preferences.js';
```

(b) Replace the schema block (the `editableEmailSchema` + `patchBodySchema` consts) with:

```ts
const editableEmailSchema = z
  .object(
    Object.fromEntries(EDITABLE_EMAIL_KEYS.map((k) => [k, z.boolean()])) as Record<
      EditableEmailKey,
      z.ZodBoolean
    >,
  )
  .partial()
  .strict();

const editablePushSchema = z
  .object(
    Object.fromEntries(EDITABLE_PUSH_KEYS.map((k) => [k, z.boolean()])) as Record<
      EditablePushKey,
      z.ZodBoolean
    >,
  )
  .partial()
  .strict();

const patchBodySchema = z
  .object({ email: editableEmailSchema, push: editablePushSchema })
  .partial()
  .strict();
```

(c) Replace the empty-body check (the `const email = ...` + `if (Object.keys(email)...` block) with:

```ts
      const email = parsed.data.email ?? {};
      const push = parsed.data.push ?? {};
      if (Object.keys(email).length + Object.keys(push).length === 0) {
        throw businessError(
          'me.notification-preferences.update.empty_body',
          422,
          'Specifica almeno una preferenza da aggiornare.',
        );
      }
```

(d) Replace the merge block inside `withContext` (from `const storedEmail = ...` through `const merged = ...`) with:

```ts
        const storedEmail =
          stored.email && typeof stored.email === 'object' && !Array.isArray(stored.email)
            ? (stored.email as Record<string, unknown>)
            : {};
        const storedPush =
          stored.push && typeof stored.push === 'object' && !Array.isArray(stored.push)
            ? (stored.push as Record<string, unknown>)
            : {};

        const mergedEmail = { ...storedEmail, ...email };
        const mergedPush = { ...storedPush, ...push };
        const merged = { ...stored, email: mergedEmail, push: mergedPush };
```

- [ ] **Step 4: Run typecheck + the route's email unit regression**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

> The push behaviour is covered by the integration suite (CI). There is no unit test for this route; the email integration tests remain green and the new push tests verify the new paths on CI.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-notification-preferences.ts packages/api/tests/integration/me-notification-preferences.test.ts
git commit -F - <<'EOF'
feat(api): accept push.* in PATCH /me/notification-preferences

PATCH now validates and deep-merges the push channel alongside email,
preserving non-editable push keys. Empty-body check spans both channels.
EOF
```

---

## Task 3: Mobile — mirror editable push keys in types

**Files:**
- Modify: `packages/mobile/src/lib/types/notification-preferences.ts`

- [ ] **Step 1: Update the type module**

Replace the body below the leading comment with:

```ts
export const EDITABLE_EMAIL_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
  'marketing',
] as const;

export type EditableEmailKey = (typeof EDITABLE_EMAIL_KEYS)[number];

// Mirror of the API EDITABLE_PUSH_KEYS — the 3 push events with real delivery.
export const EDITABLE_PUSH_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
] as const;

export type EditablePushKey = (typeof EDITABLE_PUSH_KEYS)[number];

export interface NotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
  push: Record<EditablePushKey, boolean>;
}
```

- [ ] **Step 2: Run typecheck (expect downstream breaks)**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: FAIL in `queries/notificationPreferences.ts` and `app/notification-preferences.tsx` (they don't reference `push` yet). These are fixed in Tasks 4 and 5. This is expected — do not fix here.

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/src/lib/types/notification-preferences.ts
git commit -F - <<'EOF'
feat(mobile): add EDITABLE_PUSH_KEYS to notification-preferences types
EOF
```

---

## Task 4: Mobile — channel-aware mutation

**Files:**
- Modify: `packages/mobile/src/queries/notificationPreferences.ts`
- Test: `packages/mobile/tests/queries/notificationPreferences.test.tsx`

- [ ] **Step 1: Update the failing tests**

In `packages/mobile/tests/queries/notificationPreferences.test.tsx`:

(a) Add `push` to the `PREFS` fixture (after the `email` block, before the closing `}`):

```ts
  push: {
    intervention_updates: true,
    deadline_reminder: true,
    ownership_transfer: true,
  },
```

(b) Replace the test `'PATCHes a single-key email body and invalidates the query'` body's `mutate` + assertion lines so the call is channel-aware:

```ts
    result.current.mutate({ channel: 'email', key: 'marketing', value: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences', {
      method: 'PATCH',
      body: { email: { marketing: true } },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: QUERY_KEY });
```

(c) In the optimistic test, change the `mutate` call to:

```ts
    act(() => {
      result.current.mutate({ channel: 'email', key: 'marketing', value: true });
    });
```

(d) In the revert test, change the `mutate` call to:

```ts
    result.current.mutate({ channel: 'email', key: 'marketing', value: true });
```

(e) Add a new test at the end of the `describe('useUpdateNotificationPreference', ...)` block:

```ts
  it('PATCHes a push body and the optimistic write preserves the email channel', async () => {
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
      result.current.mutate({ channel: 'push', key: 'deadline_reminder', value: false });
    });
    await waitFor(() => {
      const data = qc.getQueryData<NotificationPreferences>(QUERY_KEY);
      expect(data?.push.deadline_reminder).toBe(false);
      // email channel must be untouched by a push write
      expect(data?.email.intervention_updates).toBe(true);
    });
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences', {
      method: 'PATCH',
      body: { push: { deadline_reminder: false } },
    });
    act(() => resolve(PREFS));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/mobile test -- notificationPreferences`
Expected: FAIL — `UpdateVars` has no `channel`; the new push test sees the old `onMutate` clobbering `email`.

- [ ] **Step 3: Implement the channel-aware mutation**

In `packages/mobile/src/queries/notificationPreferences.ts`:

(a) Extend the type import:

```ts
import type {
  EditableEmailKey,
  EditablePushKey,
  NotificationPreferences,
} from '@/lib/types/notification-preferences';
```

(b) Replace the `UpdateVars` interface with a discriminated union:

```ts
type UpdateVars =
  | { channel: 'email'; key: EditableEmailKey; value: boolean }
  | { channel: 'push'; key: EditablePushKey; value: boolean };
```

(c) Replace `mutationFn` and `onMutate` with:

```ts
    mutationFn: ({ channel, key, value }) =>
      api.fetch<NotificationPreferences>('/v1/me/notification-preferences', {
        method: 'PATCH',
        body: { [channel]: { [key]: value } },
      }),
    onMutate: async ({ channel, key, value }) => {
      // Cancel in-flight refetches so they don't clobber the optimistic write.
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const previous = qc.getQueryData<NotificationPreferences>(QUERY_KEY);
      if (previous) {
        qc.setQueryData<NotificationPreferences>(QUERY_KEY, {
          ...previous,
          [channel]: { ...previous[channel], [key]: value },
        });
      }
      return { previous };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test -- notificationPreferences`
Expected: PASS (queries suite green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/queries/notificationPreferences.ts packages/mobile/tests/queries/notificationPreferences.test.tsx
git commit -F - <<'EOF'
feat(mobile): channel-aware notification preference mutation

useUpdateNotificationPreference now takes a channel ('email'|'push') and the
optimistic cache write preserves the untouched channel.
EOF
```

---

## Task 5: Mobile — Push section in the screen

**Files:**
- Modify: `packages/mobile/app/notification-preferences.tsx`
- Test: `packages/mobile/tests/screens/notification-preferences.test.tsx`

- [ ] **Step 1: Update the failing tests**

In `packages/mobile/tests/screens/notification-preferences.test.tsx`:

(a) Add `push` to the `data` object inside `makeState` (after the `email` block):

```ts
      push: {
        intervention_updates: true,
        deadline_reminder: false,
        ownership_transfer: true,
      },
```

(b) Change the existing flip assertion (test `'flipping a toggle calls mutate with key and new value'`) to be channel-aware:

```ts
  it('flipping an email toggle calls mutate with the email channel', () => {
    render(<NotificationPreferencesScreen />);
    fireEvent(screen.getByTestId('toggle-marketing'), 'valueChange', true);
    expect(mockMutate).toHaveBeenCalledWith({ channel: 'email', key: 'marketing', value: true });
  });
```

(c) Add two new tests after it:

```ts
  it('renders the push toggles reflecting current values', () => {
    render(<NotificationPreferencesScreen />);
    expect(screen.getByTestId('toggle-push-intervention_updates').props.value).toBe(true);
    expect(screen.getByTestId('toggle-push-deadline_reminder').props.value).toBe(false);
    expect(screen.getByTestId('toggle-push-ownership_transfer').props.value).toBe(true);
  });

  it('flipping a push toggle calls mutate with the push channel', () => {
    render(<NotificationPreferencesScreen />);
    fireEvent(screen.getByTestId('toggle-push-deadline_reminder'), 'valueChange', true);
    expect(mockMutate).toHaveBeenCalledWith({
      channel: 'push',
      key: 'deadline_reminder',
      value: true,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/mobile test -- screens/notification-preferences`
Expected: FAIL — no `toggle-push-*` elements; email flip still sends `{ key, value }` without `channel`.

- [ ] **Step 3: Implement the Push section**

In `packages/mobile/app/notification-preferences.tsx`:

(a) Extend the type import to include push symbols:

```ts
import {
  EDITABLE_EMAIL_KEYS,
  EDITABLE_PUSH_KEYS,
  type EditableEmailKey,
  type EditablePushKey,
} from '@/lib/types/notification-preferences';
```

(b) After the `LABELS` const add a push labels map:

```ts
// Italian labels for the editable push events. Order follows EDITABLE_PUSH_KEYS.
const PUSH_LABELS: Record<EditablePushKey, string> = {
  intervention_updates: 'Aggiornamenti interventi',
  deadline_reminder: 'Promemoria scadenze',
  ownership_transfer: 'Trasferimenti di proprietà',
};
```

(c) After `const email = prefs.data.email;` add:

```ts
  const push = prefs.data.push;
```

(d) Change the email toggle's `onValueChange` (inside the `EDITABLE_EMAIL_KEYS.map`) to be channel-aware:

```tsx
              onValueChange={(value) => update.mutate({ channel: 'email', key, value })}
```

(e) Insert a new Push section between the device `{blocked && ...}` block and the `<Text style={styles.sectionTitle}>Email</Text>` line:

```tsx
        <Text style={styles.sectionTitle}>Push</Text>
        <Text style={styles.hint}>
          Le notifiche push richiedono anche le notifiche abilitate su questo dispositivo (sopra).
        </Text>
        {EDITABLE_PUSH_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.label}>{PUSH_LABELS[key]}</Text>
            <Switch
              testID={`toggle-push-${key}`}
              accessibilityLabel={`Push: ${PUSH_LABELS[key]}`}
              value={push[key]}
              onValueChange={(value) => update.mutate({ channel: 'push', key, value })}
            />
          </View>
        ))}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test -- screens/notification-preferences`
Expected: PASS. Also run the push-device suite to confirm no regression:
Run: `pnpm --filter @garageos/mobile test -- notification-preferences-push`
Expected: PASS (the device toggle `toggle-device-push` is unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/notification-preferences.tsx packages/mobile/tests/screens/notification-preferences.test.tsx
git commit -F - <<'EOF'
feat(mobile): push preferences section in notification settings

Adds a Push section with the 3 per-event toggles, mirroring the Email
section. Account-level prefs (F-CLI-005), independent of the device toggle.
EOF
```

---

## Task 6: Docs — note push editable in APPENDICE_A

**Files:**
- Modify: `docs/APPENDICE_A_API.md` (line ~2574)

- [ ] **Step 1: Update the PATCH row**

Change the table row:

```md
| PATCH | `/me/notification-preferences` | F-CLI-005 | Customer | Modifica preferenze |
```

to:

```md
| PATCH | `/me/notification-preferences` | F-CLI-005 | Customer | Modifica preferenze (email + push per-evento) |
```

- [ ] **Step 2: Format the doc (avoid CI format:check failure)**

Run: `pnpm exec prettier --write docs/APPENDICE_A_API.md`
Expected: file formatted (markdown table normalized).

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_A_API.md
git commit -F - <<'EOF'
docs: note push.* editable in /me/notification-preferences
EOF
```

---

## Task 7: Final verification

- [ ] **Step 1: Full repo typecheck (the pre-push gate)**

Run: `pnpm -r typecheck`
Expected: PASS across all workspaces. This runs automatically on `git push` (husky).

- [ ] **Step 2: Targeted api unit regression (route + projection)**

Run: `pnpm --filter @garageos/api test:unit -- notification-preferences`
Expected: PASS.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/push-preferences-editing
```

Then open a PR with the F-CLI-005 / F-CLI-302 references and the checklist from CLAUDE.md. Watch CI:

Run: `gh pr checks --watch`
Expected: all checks green (integration suite exercises the new push PATCH paths).

> Integration + unit:web + cdk-synth all run on CI — do not run them locally (CLAUDE.md). If CI fails, fix and push a follow-up commit.

---

## Self-review notes

- **Spec coverage:** EDITABLE_PUSH_KEYS (T1), projection (T1), PATCH schema/empty-body/merge (T2), mobile types (T3), channel-aware mutation + cross-channel optimistic (T4), Push section UI + hint (T5), docs (T6). All spec sections mapped.
- **Cascades captured:** unit projection test (T1), integration `push.* → 422` test (T2), mobile PREFS fixture + flip assertions (T4/T5). No stranded old assertions.
- **Type consistency:** `EditablePushKey` / `EDITABLE_PUSH_KEYS` used identically across api lib, api route, mobile types, mobile query, mobile screen. Mutation shape `{ channel, key, value }` consistent between query impl (T4) and screen call sites (T5) and tests.
- **No migration / dep / deploy** — storage shape and delivery already exist (F-CLI-302 PR1/PR2).

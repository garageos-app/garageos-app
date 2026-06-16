# F-CLI-306 PR2 — Personal deadlines: notifications e2e + daily cron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personal-deadline reminders materialized in PR1 actually deliver. Add the `personal_deadline.reminder` notification event (email + push), a global customer preference key `personal_deadline_reminder` on the F-CLI-005 surface, a daily EventBridge cron that sweeps due reminder rows and dispatches them (with the BR-292 per-deadline × global channel AND, BR-298 `open→overdue` flip, and stale-row cleanup), and a BR-297 hook that cancels a previous owner's personal deadlines when a vehicle changes hands.

**Architecture:** Everything mirrors the already-shipped `transfer-expiry` cron (singleton `CfnSchedule` → top-level-`source` Lambda guard → `withContext({role:'admin'})` set-based sweep handler) and the existing notification dispatch fan-out (`dispatchNotification` → `dispatchEmail` + `dispatchPush`, both pref-gated). The reminders are scanned daily (NO per-row EventBridge schedules). The per-deadline channel flags (`notifyPush`/`notifyEmail`) are threaded into dispatch via a new optional `channels` mask on `DispatchInput` (default = both on → every existing caller is unaffected); the global pref AND is the existing `isEmailEnabled`/`isPushEnabled` check.

**Spec:** `docs/superpowers/specs/2026-06-16-personal-vehicle-deadlines-design.md` (§4 notifications, §5 cron, §6 BR-297 transfer hook, §8 BR-292/297/298).

**LOC budget:** target ~450 net production code; tests will dominate (channel matrix, sweep branches, transfer-cancel, infra). Expected total ~1100–1300. Hard PR limit 1500. **Controller checks cumulative `git diff --stat` after each task; halt and ask the user at ~1200 lines.** A new `CfnSchedule` is a known `resourceCountIs` cascade (Task 8) — CI-only, invisible to typecheck.

---

## Deviations from spec (verified against actual code — the code wins)

1. **Preference key name — spec is RIGHT, a research pass was wrong.** The new key is **`personal_deadline_reminder`** (distinct from the officina `deadline_reminder` that gates `deadline.reminder`). This is already mandated by **BR-292** which shipped in PR1 (`docs/APPENDICE_F_BUSINESS_LOGIC.md:1089-1097`, verbatim: "chiave `personal_deadline_reminder` in `notification_preferences.push` / `notification_preferences.email`"). Do **not** reuse `deadline_reminder` — that would conflate two independent features and contradict shipped BR-292.

2. **`personal_deadline.invalid_reminder_config` (422) is NOT added.** Spec §6 listed it as a candidate; APPENDICE_G does not register it and PR2 introduces no new validation that needs it (the lead/tail caps live in `CreatePersonalDeadlineSchema`/`UpdatePersonalDeadlineSchema`, already enforced in PR1). YAGNI — skip it.

3. **`channels` mask is a new param, not a spec artifact.** Spec §4/§5.3 says "lo sweep handler calcola i canali effettivi e li passa al dispatch" but `dispatchNotification` has no channel override today (`packages/api/src/lib/notifications/dispatcher.ts:50-60`). We add an optional `channels?: { email: boolean; push: boolean }` to `DispatchInput`; absent ⇒ both on. This is the single seam for the per-deadline AND.

4. **Docs are already mostly written (PR1).** APPENDICE_F BR-292/297/298, APPENDICE_G `personal_deadline.*` family, and APPENDICE_A §2.4d already exist. PR2 docs work is therefore small: remove the "⚠️ Implementato in PR2 — non ancora attivo" banners from BR-297/BR-298, add the `personal_deadline_reminder` key to the BR-226 default-preferences JSON + F-CLI-005 editable surface, and document the cron in APPENDICE_C. Do NOT re-add BRs.

5. **BR-298 flip ordering.** Spec §5.3 step 1 filters delivery on `deadline.status='open'`. We run the `open→overdue` flip (BR-298) **first** in the sweep, then the delivery query naturally excludes the just-flipped overdue deadlines (their reminders are all in the past anyway). Leftover pending rows on overdue deadlines are reaped by the stale-cancel branch.

## Gotchas the implementer MUST respect (from project memory)

- **New `CfnSchedule` breaks `resourceCountIs` in `infrastructure/tests/main-stack.test.ts` — CI-only, invisible to `pnpm -r typecheck`** ([[feedback_infra_schedule_count_assertion_cascade]], #182). Task 8 bumps the count 2→3 and adds `hasResourceProperties`.
- **Scheduler invocations carry no JWT** — the sweep MUST run under `withContext({ role: 'admin' })`; an empty `{}` context silently denies RLS writes ([[feedback_withcontext_empty_blocks_rls_writes]]).
- **`dispatchNotification` NEVER throws** — branch on the returned `DispatchResult`, never try/catch for control flow (`dispatcher.ts:64`).
- **No `Promise.all` over a Prisma tx** ([[project_resume_checkpoint]] Promise.all-on-tx) — the sweep iterates reminders sequentially (or uses set-based `updateMany`), never `Promise.all(tx ops)`.
- **Three exhaustive switches** over `NotificationEvent.type` have NO default case → TS enforces the new member in all three: `event-preference-key.ts`, `dispatcher.ts` (`dispatchEmail`), `push-templates.ts` (`renderPushPayload`). Forgetting one is a typecheck error (good).
- **Mobile mirror exhaustiveness:** `packages/mobile/app/notification-preferences.tsx` renders labels from a `Record<EditableEmailKey, string>` / `Record<EditablePushKey, string>` — adding the key to mobile's `EDITABLE_*_KEYS` forces a label or mobile typecheck fails.
- **Route-handler / dispatcher changes:** run `pnpm --filter @garageos/api test:unit` for the touched area — typecheck does not catch broken FakePrisma mocks ([[feedback_handler_change_breaks_unit_mock]]).
- **`@db.Date` columns:** `scheduledFor`/`dueDate` come back as `Date` at UTC midnight; serialize/compare as bare `YYYY-MM-DD`. Integration tests must assert the exact string, not just row counts ([[feedback_db_date_serialized_as_iso]]).
- **English comments**, Italian only for user-facing strings; the email/push copy goes through the existing template pattern (hardcoded Italian in templates is the established convention — see `templates/intervention-created.ts`).
- **CDK monorepo:** explicit `.js` import extensions (NodeNext) ([[feedback_cdk_monorepo_gotchas]]).
- **New migrations are operator-applied** — but PR2 adds **NO migration** (all tables/enums/columns shipped in PR1). Verify: no `prisma migrate` step anywhere in this plan.

## Branch

`feat/personal-deadlines-notifications-cron` off updated `main`.

---

## Pre-flight checklist (run / already run BEFORE dispatching implementers)

### Schema & Prisma
- [x] `PersonalDeadline`, `PersonalDeadlineReminder`, enums `PersonalDeadlineCategory`/`PersonalDeadlineStatus`/`PersonalDeadlineReminderKind`, and reused `NotificationDeliveryStatus` all exist in `schema.prisma` (PR1). Fields used by the sweep — `status`, `dueDate`, `customerId`, `vehicleId`, `notifyPush`, `notifyEmail`, `category`, `customLabel`; reminder `scheduledFor`, `deliveryStatus`, `kind`, `personalDeadlineId`, `sentAt`, `failureReason` — all confirmed present.
- [x] **No schema field rename, no new column, NO migration.** PR2 is read+update over PR1's tables only.
- [x] Prisma methods used: `updateMany` (overdue flip, stale-cancel, channel-off, transfer-cancel), `findMany` (due reminders with `deadline` + `customer` includes), `update` (per-row status). Grep `packages/api/tests/` only adds NEW assertions — no existing FakePrisma method names change.

### Docs cross-reference (BR / error codes / API)
- [x] BR-290…298 all registered in `APPENDICE_F` (`:1077-1145`); BR-298 is the ceiling — no collision. BR-292 (channel AND), BR-297 (transfer cancel), BR-298 (overdue flip) cited verbatim in this plan.
- [x] `APPENDICE_G` `personal_deadline.*` family registered (5 codes, `:429-433`). PR2 adds NO new error code (sweep/cron throw nothing customer-facing; transfer hook is internal).
- [x] `APPENDICE_A` §2.4d documents the endpoints (`:745`). No API surface change in PR2.

### RLS & DB constraints
- [x] `personal_deadlines` / `personal_deadline_reminders` RLS is `USING(true)` (PR1) — sweep runs `role:'admin'` (cross-tenant, no JWT); no per-customer filter needed inside the admin sweep, but the transfer-cancel helper runs inside the existing transfer tx context and scopes by `vehicleId` + previous-owner `customerId`.
- [x] No new GET `/:id` route → no new cross-tenant 404 test required.

### Tests & refactors
- [x] `dispatchNotification` gains an optional param — all existing callsites (`interventions.ts`, `scheduler-invocation.ts`, update/cancel/transfer dispatchers) keep compiling because the param defaults to both-channels-on. Grep callsites in Task 3 to confirm none pass positional args that shift.
- [x] Sweep unit tests use FakePrisma threading dynamic reminder rows via `mockImplementation`, never hardcoded fixtures ([[feedback_integration_test_mock_dynamic_input]]).

### Infra & runbooks
- [x] New `AWS::Scheduler::Schedule` → Task 8 bumps `resourceCountIs(...,2)`→`3` and adds `hasResourceProperties` (CI-only check).
- [x] No new IAM: the sweep reuses the existing Lambda + `SchedulerRole` `lambda:InvokeFunction` grant (the schedule targets the same `garageos-api` Lambda, like `transfer-expiry`). Confirm in Task 8 — no `lambda-api.ts` grant change.
- [x] No new migration in deploy. The schedule is created by the CDK auto-deploy of `main`; note the operator step (it activates only when `warmingEnabled`).

### Style & process
- [x] Email/push copy in Italian via the template files; all comments English.
- [x] After shipping BR-297/298, grep their call sites/headers — only the new sweep + transfer hook cite them.

---

## File structure

**Create:**
- `packages/api/src/lib/notifications/templates/personal-deadline-reminder.ts` — email subject/html/text.
- `packages/api/src/lib/personal-deadlines/sweep.ts` — `processPersonalDeadlineSweep` (overdue flip, stale-cancel, deliver loop).
- `packages/api/src/lib/personal-deadlines/cancel-on-transfer.ts` — `cancelPersonalDeadlinesForVehicleTransfer` shared helper (BR-297).
- `packages/api/src/lambda-personal-deadline-sweep.ts` — `withPersonalDeadlineSweepGuard`.
- Test files mirroring each (see tasks).

**Modify:**
- `packages/api/src/lib/notifications/types.ts` — `NotificationEvent` union member; `EmailEnabledKey` + `NotificationEventPrefKey` += `personal_deadline_reminder`.
- `packages/api/src/lib/notifications/dispatcher.ts` — `channels` mask on `DispatchInput`, gating in `dispatchEmail`; new `personal_deadline.reminder` email case + template imports.
- `packages/api/src/lib/notifications/push-channel.ts` — honor `channels.push` mask.
- `packages/api/src/lib/notifications/push-templates.ts` — `personal_deadline.reminder` case.
- `packages/api/src/lib/notifications/event-preference-key.ts` — `personal_deadline.reminder` → `personal_deadline_reminder`.
- `packages/api/src/lib/notification-preferences.ts` — `DEFAULT_NOTIFICATION_PREFERENCES` (email+push), `EDITABLE_EMAIL_KEYS`, `EDITABLE_PUSH_KEYS`.
- `packages/api/src/index.ts` — wire `withPersonalDeadlineSweepGuard` + handler into the guard chain.
- `packages/api/src/lib/transfer-swap.ts` — call the BR-297 helper after the seller's ownership closes.
- `packages/api/src/lib/ownership-transfer.ts` — call the BR-297 helper after the current ownership closes.
- `infrastructure/lib/constructs/scheduler.ts` — `PersonalDeadlineSweepSchedule` `CfnSchedule` + public field.
- `infrastructure/tests/main-stack.test.ts` — count bump + new schedule assertion.
- `packages/mobile/src/lib/types/notification-preferences.ts` + `packages/mobile/app/notification-preferences.tsx` — mirror the new editable key + Italian label.
- `docs/APPENDICE_F_BUSINESS_LOGIC.md` (un-defer BR-297/298, add key to BR-226 default), `docs/APPENDICE_C_INFRASTRUCTURE.md` (cron).

---

## Task 1 — `personal_deadline.reminder` event type + preference-key types + channel mask

**Files:**
- Modify: `packages/api/src/lib/notifications/types.ts`
- Modify: `packages/api/src/lib/notifications/dispatcher.ts:50-60` (`DispatchInput`)
- Test: `packages/api/tests/unit/lib/notifications/event-preference-key.test.ts` (extended in Task 4); type-only task — verified by typecheck.

**Contract:**
- Add a discriminated-union member to `NotificationEvent`. Carry exactly the template data from spec §4:
  ```ts
  | {
      type: 'personal_deadline.reminder';
      personalDeadlineId: string;
      category: PersonalDeadlineCategory;   // import the Zod-derived type from @garageos/database
      customLabel: string | null;
      dueDate: string;                      // bare YYYY-MM-DD
      vehiclePlate: string;
      vehicleMakeModel: string;             // `${make} ${model}`
      kind: 'lead' | 'tail';
      daysUntilDue: number;                 // dueDate − today(Rome); may be 0 or negative (tail/overdue)
    }
  ```
- Extend `EmailEnabledKey` and `NotificationEventPrefKey` to include `'personal_deadline_reminder'` (both unions, `types.ts:91-104`).
- Add optional `channels` to `DispatchInput`:
  ```ts
  // Per-event channel mask AND-ed with the customer's global preference
  // (BR-292). Absent ⇒ both channels enabled (every existing caller). The
  // personal-deadline sweep passes the deadline's notifyEmail/notifyPush flags.
  channels?: { email: boolean; push: boolean };
  ```
- Extend the `skipped` literal in `DispatchResult` (email outcome) and `PushDispatchResult` to include `'channel-off'` (currently `'pref-off'` / `'pref-off'|'no-token'`). Verify both in `types.ts`.

- [ ] **Step 1:** Add the union member, extend both key unions, add `channels` to `DispatchInput`, extend the two `skipped` literals. Import `PersonalDeadlineCategory` type from `@garageos/database`.
- [ ] **Step 2:** Run `pnpm --filter @garageos/api typecheck`. Expected: **FAIL** with non-exhaustive switch errors in `event-preference-key.ts`, `dispatcher.ts`, `push-templates.ts` (the three switches now miss a case). This proves the union member is wired and the compiler is enforcing exhaustiveness.
- [ ] **Step 3:** Commit.

```bash
git add packages/api/src/lib/notifications/types.ts packages/api/src/lib/notifications/dispatcher.ts
git commit -m "feat(api): add personal_deadline.reminder event type and channel mask"
```

---

## Task 2 — Email template `personal-deadline-reminder.ts`

**Files:**
- Create: `packages/api/src/lib/notifications/templates/personal-deadline-reminder.ts`
- Test: `packages/api/tests/unit/lib/notifications/templates/personal-deadline-reminder.test.ts`

**Contract:** Mirror `templates/intervention-created.ts` exactly (recipient display-name helper, `getAppLink`, `escapeHtml`, subject const + `render…Html`/`render…Text`). Export `renderPersonalDeadlineReminderSubject(event)`, `renderPersonalDeadlineReminderHtml({recipient, event})`, `renderPersonalDeadlineReminderText({recipient, event})`. Italian copy. The deadline label = `customLabel` when `category==='other'`, else the Italian category name from a `Record<PersonalDeadlineCategory,string>` map (defined locally in this file):

```
insurance → "Assicurazione", road_tax → "Bollo", inspection → "Revisione",
service → "Tagliando", tires → "Pneumatici", timing_belt → "Cinghia di distribuzione",
other → (use customLabel)
```

Subject (verbatim Italian): `` `Promemoria scadenza: ${label} — ${vehiclePlate}` ``.
Body must include: the deadline label, the vehicle (`vehicleMakeModel` + `vehiclePlate`), and a human due phrasing driven by `daysUntilDue`:
- `> 0` → `` `Scade tra ${daysUntilDue} giorni (${dueDateFormatted}).` `` (use `1 giorno` singular).
- `=== 0` → `Scade oggi.`
- `< 0` → `` `Era in scadenza il ${dueDateFormatted}.` `` (overdue tail).

Format `dueDate` (YYYY-MM-DD) to `DD/MM/YYYY` with a small local helper. App link reuses `https://app.garageos.aifollyadvisor.com/...` (mirror the constant in `intervention-created.ts`); a deep link target for the deadlines tab is fine as a plain string — PR3 owns mobile routing.

**Test cases (TDD red→green):**
- Subject contains label + plate.
- `category==='other'` → uses `customLabel`; a known category → uses the Italian map value (not the enum string).
- `daysUntilDue` of 7 / 1 / 0 / -2 produce the four distinct phrasings (1 = singular).
- html escapes a `customLabel` containing `<`/`&`.
- text and html both contain the vehicle plate.

- [ ] **Step 1:** Write the failing test file with the cases above (import the not-yet-existing render fns).
- [ ] **Step 2:** Run `pnpm --filter @garageos/api test:unit -- personal-deadline-reminder` → FAIL (module not found).
- [ ] **Step 3:** Implement the template file.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lib/notifications/templates/personal-deadline-reminder.ts packages/api/tests/unit/lib/notifications/templates/personal-deadline-reminder.test.ts
git commit -m "feat(api): personal deadline reminder email template"
```

---

## Task 3 — Wire dispatch: push template, email case, channel mask gating

**Files:**
- Modify: `packages/api/src/lib/notifications/push-templates.ts` (add `personal_deadline.reminder` case to `renderPushPayload`)
- Modify: `packages/api/src/lib/notifications/dispatcher.ts` (import template; add email switch case; honor `channels.email`)
- Modify: `packages/api/src/lib/notifications/push-channel.ts` (honor `channels.push`)
- Test: `packages/api/tests/unit/lib/notifications/dispatcher.test.ts` (or a new `dispatcher-personal-deadline.test.ts` mirroring `dispatcher-deadline.test.ts`)

**Contract:**
- **Push case** (`renderPushPayload`): Italian, mirror the `deadline.reminder` case. `title: 'Scadenza in arrivo'` (or `'Scadenza oggi'` when `daysUntilDue===0`), `body` = `` `${label} per ${vehiclePlate} è in scadenza.` ``, `data: { type: 'personal_deadline.reminder', personalDeadlineId, vehicleId }` (use the event's plate; the label helper can be duplicated minimally or imported — prefer a tiny shared `personalDeadlineLabel(event)` exported from the template file to avoid drift).
- **Email case** in `dispatchEmail`'s switch: `subject = renderPersonalDeadlineReminderSubject(event)`, html/text via the new renderers (pass `{recipient, event}`).
- **Channel mask gating** — the single BR-292 per-deadline seam:
  - In `dispatchEmail`, BEFORE the `isEmailEnabled` check (or right after destructuring), add: `if (args.channels && !args.channels.email) return { sent: false, skipped: 'channel-off' };`
  - In `dispatchPush` (`push-channel.ts`), add a symmetric early return when `input.channels?.push === false` → `{ attempted: 0, sent: 0, skipped: 'channel-off', deactivated: 0, appInstalledCleared: false }`. Thread `channels` from `dispatchNotification` into `dispatchPush` (add it to the push input object).
  - In `dispatchNotification`, pass `channels: input.channels` into both `dispatchEmail` and `dispatchPush`.
- The global pref check (`isEmailEnabled`/`isPushEnabled`) stays — the effective channel is `channels.<ch>` AND global pref AND (push) has-token. This is exactly the BR-292 AND.

**Test cases:**
- `personal_deadline.reminder` with `channels` absent + prefs on → email sent, push attempted (back-compat).
- `channels: {email:false, push:true}` → email skipped `'channel-off'`, push attempted.
- `channels: {email:true, push:false}` → push skipped `'channel-off'`, email sent.
- Global pref off for `personal_deadline_reminder` (recipient prefs) + `channels.email:true` → email skipped `'pref-off'` (global master-kill still wins).
- An existing event (`intervention.created`) with no `channels` still dispatches both — guard against regression.

- [ ] **Step 1:** Write failing tests (the matrix above) using the existing dispatcher test harness (sesMock + FakePrisma push tokens). RED.
- [ ] **Step 2:** Run targeted test → FAIL.
- [ ] **Step 3:** Implement the push case, email case, and the `channels` gating in dispatcher + push-channel.
- [ ] **Step 4:** Run `pnpm --filter @garageos/api typecheck` (all three switches now exhaustive → green) and the targeted tests → PASS.
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lib/notifications/push-templates.ts packages/api/src/lib/notifications/dispatcher.ts packages/api/src/lib/notifications/push-channel.ts packages/api/tests/unit/lib/notifications/
git commit -m "feat(api): dispatch personal_deadline.reminder with per-deadline channel mask"
```

---

## Task 4 — Preference key surface (`event-preference-key` + defaults + editable keys)

**Files:**
- Modify: `packages/api/src/lib/notifications/event-preference-key.ts` (`preferenceKeyForEvent` switch)
- Modify: `packages/api/src/lib/notification-preferences.ts` (`DEFAULT_NOTIFICATION_PREFERENCES`, `EDITABLE_EMAIL_KEYS`, `EDITABLE_PUSH_KEYS`)
- Test: `packages/api/tests/unit/lib/notifications/event-preference-key.test.ts`, `packages/api/tests/unit/lib/notification-preferences.test.ts`, `packages/api/tests/unit/routes/v1/me-notification-preferences.test.ts`, `packages/api/tests/integration/me-notification-preferences.test.ts`

**Contract:**
- `preferenceKeyForEvent`: add `case 'personal_deadline.reminder': return 'personal_deadline_reminder';`
- `DEFAULT_NOTIFICATION_PREFERENCES`: add `personal_deadline_reminder: true` to BOTH `.email` and `.push`.
- `EDITABLE_EMAIL_KEYS` and `EDITABLE_PUSH_KEYS`: append `'personal_deadline_reminder'` (both — it has real delivery on both channels). This auto-extends the dynamically-built Zod schema in `me-notification-preferences.ts` (no route code change) and the GET projection.
- Confirm `EditableEmailKey`/`EditablePushKey` are `(typeof …KEYS)[number]` so the types update for free.

**Test cases:**
- `preferenceKeyForEvent({type:'personal_deadline.reminder', …})` → `'personal_deadline_reminder'`.
- Projection (`projectNotificationPreferences` or equivalent) includes `personal_deadline_reminder` with default `true` on both channels.
- PATCH `/v1/me/notification-preferences` with `{email:{personal_deadline_reminder:false}}` → accepted (200) and round-trips on GET (integration).
- A new customer (auth-signup integration, if it asserts defaults) carries the new key — extend that assertion if present.

- [ ] **Step 1:** Write/extend failing tests.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (switch case + defaults + editable arrays).
- [ ] **Step 4:** `pnpm --filter @garageos/api typecheck` + targeted unit tests → PASS. (Integration runs on CI.)
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lib/notifications/event-preference-key.ts packages/api/src/lib/notification-preferences.ts packages/api/tests/
git commit -m "feat(api): add personal_deadline_reminder global preference key"
```

---

## Task 5 — Mobile preference mirror + Italian label (F-CLI-005 surface)

**Files:**
- Modify: `packages/mobile/src/lib/types/notification-preferences.ts` (`EDITABLE_EMAIL_KEYS`, `EDITABLE_PUSH_KEYS`)
- Modify: `packages/mobile/app/notification-preferences.tsx` (label `Record`s)
- Test: extend the existing `notification-preferences` screen test (Tier 2 — add ONE assertion that the new toggle row renders; no new test file).

**Contract:** Append `'personal_deadline_reminder'` to the mobile mirrors of `EDITABLE_EMAIL_KEYS`/`EDITABLE_PUSH_KEYS`, and add the Italian label to the label `Record<EditableEmailKey,string>` / `Record<EditablePushKey,string>` — value: **`Scadenze personali`** (or `Promemoria scadenze personali` if it fits the row). Mobile typecheck enforces the label exists. No new query/endpoint — the screen already PATCHes whatever keys it renders.

**Test case (Tier 2):** the screen renders a toggle labelled "Scadenze personali" in both the email and push sections (one assertion each is enough; no pure-rendering padding).

- [ ] **Step 1:** Add the failing screen assertion. RED.
- [ ] **Step 2:** Run `pnpm --filter @garageos/mobile test -- notification-preferences` → FAIL.
- [ ] **Step 3:** Add key to mirrors + labels.
- [ ] **Step 4:** `pnpm --filter @garageos/mobile typecheck` + the screen test → PASS.
- [ ] **Step 5:** Commit.

```bash
git add packages/mobile/src/lib/types/notification-preferences.ts packages/mobile/app/notification-preferences.tsx packages/mobile/
git commit -m "feat(mobile): expose personal deadline reminder preference toggle"
```

---

## Task 6 — Sweep handler `processPersonalDeadlineSweep`

**Files:**
- Create: `packages/api/src/lib/personal-deadlines/sweep.ts`
- Test (unit): `packages/api/tests/unit/lib/personal-deadlines/sweep.test.ts`
- Test (integration): `packages/api/tests/integration/personal-deadline-sweep.test.ts`

**Contract:** Mirror `lib/transfers/expire-transfers.ts` for shape (local `AppLike`, `withContext({role:'admin'})`, propagate DB errors so EventBridge retries) and `lib/deadlines/scheduler-invocation.ts` for the per-row delivery state machine and idempotency. Export:

```ts
export interface PersonalDeadlineSweepResult {
  overdueFlipped: number;
  staleCancelled: number;
  channelsOffCancelled: number;
  sent: number;
  failed: number;
}
export async function processPersonalDeadlineSweep(input: { app: AppLike }): Promise<PersonalDeadlineSweepResult>;
```

Algorithm, all inside one `withContext({ role: 'admin' }, async (tx) => …)`:

1. **Compute `todayRome`** — the Europe/Rome calendar date as a `@db.Date`-comparable UTC-midnight `Date`. Reuse the Rome date extraction from `lib/deadlines/compute-reminders.ts` (the `Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Rome'})` date parts → `new Date(`${y}-${m}-${d}T00:00:00.000Z`)`). If a small exported helper doesn't already exist, add `romeTodayDateOnly()` to `compute-reminders.ts` (behavior-preserving export, like PR1's `romeDayAtHourUtc` extraction) and unit-test it.
2. **BR-298 overdue flip (FIRST):** `tx.personalDeadline.updateMany({ where: { status: 'open', dueDate: { lt: todayRome } }, data: { status: 'overdue' } })` → `overdueFlipped`.
3. **Stale-cancel:** reminders with `deliveryStatus: 'pending'` AND `scheduledFor < todayRome − STALE_DAYS` (define `const STALE_DAYS = 3`): `updateMany` → `deliveryStatus:'cancelled', failureReason:'stale'`. `staleCancelled`. (Independent of parent status — reaps leftovers on now-overdue deadlines.)
4. **Fetch due reminders:** `findMany` where `deliveryStatus:'pending'`, `scheduledFor: { lte: todayRome }`, and `personalDeadline.status: 'open'` (the flip already removed overdue ones). `include`/`select` the parent deadline (`id, dueDate, category, customLabel, notifyEmail, notifyPush, vehicle{plate, make, model}`) and the owning customer (`id, email, firstName, businessName, isBusiness, notificationPreferences` — the `CustomerForNotification` shape `resolveCurrentOwner` returns; here the owner IS `personalDeadline.customer`, no ownership resolution needed).
5. **Per reminder (sequential — NO Promise.all over tx):**
   - effective pre-gate: if `!deadline.notifyEmail && !deadline.notifyPush` → `update` row to `cancelled`/`failureReason:'channels_off'`; increment `channelsOffCancelled`; continue.
   - compute `daysUntilDue = round((dueDate − todayRome)/86400000)` and `vehicleMakeModel = `${make} ${model}``.
   - `const result = await dispatchNotification({ event: { type:'personal_deadline.reminder', personalDeadlineId, category, customLabel, dueDate: dueDateIso, vehiclePlate, vehicleMakeModel, kind, daysUntilDue }, recipient: customer, logger: app.log, tx, channels: { email: deadline.notifyEmail, push: deadline.notifyPush } });`
   - **Outcome resolution** (helper `resolveSweepOutcome(result)` — pure, unit-tested with a matrix):
     - `emailSent = result.sent === true`; `pushSent = (result.push?.sent ?? 0) > 0`.
     - any sent → `update` `deliveryStatus:'sent', sentAt: new Date()`; `sent++`.
     - else if `result.error || result.push?.error` → `deliveryStatus:'failed', failureReason: result.error ?? result.push?.error`; `failed++`. (Terminal: a daily batch does not re-sweep `failed` rows — matches the stale-recovery design; document inline.)
     - else (nothing sent, no error: pref-off/channel-off/no-token) → `deliveryStatus:'cancelled', failureReason:'not_delivered'`; treat as `channelsOffCancelled++` for the counter (or add a `notDelivered` counter — keep the struct above; reuse `channelsOffCancelled`).
6. `app.log.info({ personalDeadlineSweep: result })`; return `result`.

**BR citations in comments:** BR-292 (channel AND, pre-gate + mask), BR-295 (timing already baked into `scheduledFor`), BR-298 (flip), and the stale/recovery rationale.

**Unit test cases (FakePrisma + sesMock/push mock):**
- overdue flip: an `open` deadline with `dueDate` yesterday → `updateMany` called with `status:'open', dueDate:{lt:today}`; counter reflects it.
- stale-cancel: a pending reminder `scheduledFor` 5 days ago → cancelled `stale`.
- delivery happy: a pending reminder due today, deadline open, both channels on, prefs on → `sent`, row updated `sent`+`sentAt`.
- channels_off pre-gate: deadline `notifyEmail:false, notifyPush:false` → cancelled `channels_off`, **dispatch NOT called**.
- single channel: `notifyPush:false` → dispatch called with `channels.push:false`; push skipped channel-off, email sent → row `sent`.
- failure: dispatch returns `{sent:false, error:'SES boom'}` and no push → row `failed`, reason `SES boom`.
- idempotency: a reminder already `sent` is not in the `findMany` (gate on `pending`) — assert the where filter includes `deliveryStatus:'pending'`.
- `resolveSweepOutcome` matrix: (emailSent,pushSent,error) combinations → expected status.

**Integration test cases (real Postgres, `personal-deadline-sweep.test.ts`):**
- Seed a customer-owned vehicle + `PersonalDeadline (open, dueDate yesterday)` + a pending reminder `scheduledFor` today → run sweep → deadline flips `overdue`? (No: dueDate yesterday → overdue; its reminder scheduledFor today but parent now overdue → excluded from delivery, and not stale (today) → stays pending. Assert that explicitly so the ordering contract is pinned.) Prefer two separate seeds: (a) deadline dueDate today + reminder today → delivered `sent`; (b) deadline dueDate yesterday → flipped `overdue`.
- channel matrix end-to-end with the sesMock asserting recipient address.
- assert `scheduled_for`/`due_date` exact `YYYY-MM-DD` where surfaced.

- [ ] **Step 1:** Write failing unit tests (+ `resolveSweepOutcome` matrix). RED.
- [ ] **Step 2:** Run `pnpm --filter @garageos/api test:unit -- personal-deadlines/sweep` → FAIL.
- [ ] **Step 3:** Implement `sweep.ts` (+ `romeTodayDateOnly` export if needed).
- [ ] **Step 4:** Run unit tests → PASS; `pnpm --filter @garageos/api typecheck`. Write the integration test (runs on CI).
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lib/personal-deadlines/sweep.ts packages/api/src/lib/deadlines/compute-reminders.ts packages/api/tests/
git commit -m "feat(api): personal deadline daily sweep handler (BR-292/295/298)"
```

---

## Task 7 — Lambda guard + index.ts wiring

**Files:**
- Create: `packages/api/src/lambda-personal-deadline-sweep.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/tests/unit/lambda-personal-deadline-sweep.test.ts` (mirror `lambda-transfer-expiry` guard tests)

**Contract:**
- `withPersonalDeadlineSweepGuard(inner, handler)`: exact mirror of `withTransferExpiryGuard` (`lambda-transfer-expiry.ts`) — match top-level `source === 'personal-deadline-sweep'`; `handler` type `() => Promise<PersonalDeadlineSweepResult>`. Disjoint from `'warming'`, `'transfer-expiry'`, `'aws.scheduler'`.
- `index.ts`: import the guard + `processPersonalDeadlineSweep`; build `const personalDeadlineSweepHandler = () => processPersonalDeadlineSweep({ app: { withContext: app.withContext.bind(app), log: app.log } });`; insert into the chain. Order (outermost→innermost): `withWarmingGuard( withTransferExpiryGuard( withPersonalDeadlineSweepGuard( withSchedulerGuard(schedulerHandler)(awsLambdaFastify(app)), personalDeadlineSweepHandler ), transferExpiryHandler ), warmup )`. (Position relative to transfer-expiry doesn't matter — sources are disjoint — but keep it adjacent for readability.)

**Test cases:**
- event `{source:'personal-deadline-sweep'}` → calls `handler`, returns its result, `inner` NOT called.
- event `{source:'warming'}` / `{source:'transfer-expiry'}` / APIGW-shaped event → `inner` called, `handler` NOT.

- [ ] **Step 1:** Write failing guard test. RED.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement guard + wire `index.ts`.
- [ ] **Step 4:** Guard test → PASS; `pnpm --filter @garageos/api typecheck`.
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lambda-personal-deadline-sweep.ts packages/api/src/index.ts packages/api/tests/unit/lambda-personal-deadline-sweep.test.ts
git commit -m "feat(api): personal-deadline-sweep lambda guard and wiring"
```

---

## Task 8 — CDK `PersonalDeadlineSweepSchedule` + infra test cascade

**Files:**
- Modify: `infrastructure/lib/constructs/scheduler.ts`
- Modify: `infrastructure/tests/main-stack.test.ts`

**Contract:** Add `public readonly personalDeadlineSweepSchedule: scheduler.CfnSchedule;` and create it as an exact mirror of `transferExpirySchedule`:
```ts
this.personalDeadlineSweepSchedule = new scheduler.CfnSchedule(this, 'PersonalDeadlineSweepSchedule', {
  name: 'garageos-personal-deadline-sweep',
  groupName: 'default',
  description: 'Daily sweep: deliver due personal-deadline reminders and flip open→overdue (F-CLI-306, BR-292/295/298)',
  state: props.warmingEnabled ? 'ENABLED' : 'DISABLED',
  scheduleExpression: 'cron(0 6 * * ? *)',   // ~08:00 Europe/Rome, DST drift accepted (spec §5.1)
  scheduleExpressionTimezone: 'UTC',
  flexibleTimeWindow: { mode: 'OFF' },
  target: {
    arn: props.lambdaFunction.functionArn,
    roleArn: this.schedulerRole.roleArn,
    input: JSON.stringify({ source: 'personal-deadline-sweep' }),
    retryPolicy: { maximumRetryAttempts: 2 },
  },
});
```
No new IAM (same Lambda target, existing `SchedulerRole` `lambda:InvokeFunction` grant covers it). NodeNext `.js` extensions already in the file's imports — none added.

**Infra test (`main-stack.test.ts`):**
- Bump `template.resourceCountIs('AWS::Scheduler::Schedule', 2)` → `3` and update the test name/comment ("warming + transfer-expiry + personal-deadline-sweep").
- Add a new `it(...)` with `hasResourceProperties('AWS::Scheduler::Schedule', Match.objectLike({ Name: 'garageos-personal-deadline-sweep', GroupName: 'default', ScheduleExpression: 'cron(0 6 * * ? *)', ScheduleExpressionTimezone: 'UTC', Target: Match.objectLike({ Input: JSON.stringify({ source: 'personal-deadline-sweep' }) }) }))`.

- [ ] **Step 1:** Add the schedule + public field.
- [ ] **Step 2:** Update the count assertion + add the new `hasResourceProperties` test.
- [ ] **Step 3:** `pnpm -r typecheck` (catches CDK type errors). Note: infra `test:unit` is **CI-only** (freezes Windows) — do NOT run locally; CI is the gate for `resourceCountIs`.
- [ ] **Step 4:** Commit.

```bash
git add infrastructure/lib/constructs/scheduler.ts infrastructure/tests/main-stack.test.ts
git commit -m "feat(infra): daily personal-deadline-sweep EventBridge schedule"
```

---

## Task 9 — BR-297 cancel-on-transfer hook

**Files:**
- Create: `packages/api/src/lib/personal-deadlines/cancel-on-transfer.ts`
- Modify: `packages/api/src/lib/transfer-swap.ts` (after seller ownership closes)
- Modify: `packages/api/src/lib/ownership-transfer.ts` (after current ownership closes)
- Test (unit): `packages/api/tests/unit/lib/personal-deadlines/cancel-on-transfer.test.ts`
- Test (integration): extend `packages/api/tests/integration/transfer-swap*`/`me-transfers*` AND the officina `ownership-transfer`/`vehicles` transfer integration test with a personal-deadline-on-transfer assertion.

**Contract:**
```ts
// BR-297: when a vehicle changes owner, the previous owner's still-active
// (open|overdue) personal deadlines on that vehicle become cancelled, and
// their pending reminders cancelled. completed/cancelled deadlines are
// immutable history (untouched). Runs inside the caller's existing tx.
export async function cancelPersonalDeadlinesForVehicleTransfer(
  tx: PrismaClient,
  args: { vehicleId: string; previousOwnerCustomerId: string },
): Promise<{ cancelledDeadlines: number; cancelledReminders: number }>;
```
Implementation: find the previous owner's `open|overdue` deadline ids on that vehicle (`findMany({ where: { vehicleId, customerId: previousOwnerCustomerId, status: { in: ['open','overdue'] } }, select: { id: true } })`); if none, return zeros. Then `personalDeadlineReminder.updateMany({ where: { personalDeadlineId: { in: ids }, deliveryStatus: 'pending' }, data: { deliveryStatus: 'cancelled', failureReason: 'ownership_transferred' } })` and `personalDeadline.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled' } })`. Sequential, no Promise.all.

**Wiring:**
- `transfer-swap.ts` (`confirmTransferSwap`): call **after** Step 2 closes the seller's ownership (`fromCustomerId`), before/after Step 3 — pass `previousOwnerCustomerId: fromCustomerId`. Uses the same `tx` (customer `role:'user'` context). RLS on personal_deadlines is `USING(true)` so the write is permitted.
- `ownership-transfer.ts` (`performOwnershipTransfer`): call **after** Step 5 closes `currentOwnership`, before Step 6 — pass `previousOwnerCustomerId: currentOwnership.customerId`. Same `tx` (officina `role:'admin'` context). Confirm the select on `currentOwnership` includes `customerId` (it does per the PR1 research — `select:{id,customerId,startedAt}` / the update reads `currentOwnership.customerId`); if not present, add it.

**Test cases:**
- helper: previous owner has 1 open + 1 overdue + 1 completed deadline on the vehicle, each with pending+sent reminders → cancels the 2 active deadlines and only their PENDING reminders; completed deadline and sent reminders untouched; returns `{2, …}`.
- helper: a deadline belonging to a DIFFERENT customer on the same vehicle is NOT touched (scope by `previousOwnerCustomerId`).
- integration (customer transfer confirm): seller had an open personal deadline → after confirm, it is `cancelled`; buyer's deadlines (none) unaffected; the vehicle ownership swap still succeeds.
- integration (officina-mediated transfer): same assertion through `performOwnershipTransfer`.

- [ ] **Step 1:** Write failing helper unit tests. RED.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement helper; wire both call sites.
- [ ] **Step 4:** Unit tests → PASS; `pnpm --filter @garageos/api typecheck` + the touched transfer unit tests (`test:unit`). Add integration assertions (CI gate).
- [ ] **Step 5:** Commit.

```bash
git add packages/api/src/lib/personal-deadlines/cancel-on-transfer.ts packages/api/src/lib/transfer-swap.ts packages/api/src/lib/ownership-transfer.ts packages/api/tests/
git commit -m "feat(api): cancel personal deadlines on vehicle ownership transfer (BR-297)"
```

---

## Task 10 — Docs

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` — remove the "⚠️ Implementato in PR2 — non ancora attivo in PR1" banners from BR-297 and BR-298 (they ship now); add `"personal_deadline_reminder": true` to the BR-226 default-preferences JSON (both `email` and `push` blocks) and to the F-CLI-005 editable-keys note.
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md` — document the `garageos-personal-deadline-sweep` schedule (singleton, daily `cron(0 6 * * ? *)` UTC, payload `{source:'personal-deadline-sweep'}`, gated by `warmingEnabled`, reuses `SchedulerRole`) alongside `garageos-transfer-expiry`. Note it is created by the CDK auto-deploy of `main` and activates only when `warmingEnabled`.

**Contract:** Docs match shipped behavior; no new BR, no new error code. Verify BR-226 JSON stays valid and the editable-keys list matches `EDITABLE_*_KEYS` in code (Task 4).

- [ ] **Step 1:** Edit the three doc sections.
- [ ] **Step 2:** Commit.

```bash
git add docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_C_INFRASTRUCTURE.md
git commit -m "docs: personal deadline notifications, cron, and BR-297/298 activation"
```

---

## Review gates (in order)

1. **Per-task review** only for the riskiest tasks: Task 6 (sweep state machine + channel AND), Task 9 (BR-297 hook inside two ownership-swap transactions). Others rely on the final gate.
2. `pnpm -r typecheck` (pre-push hook) — the only mandatory local gate. Plus the targeted `pnpm --filter @garageos/api test:unit` runs called out in Tasks 3, 6, 9.
3. **Final whole-branch `/code-review high`** — load-bearing. It is the only gate that cross-references the three exhaustive switches, the BR-292 AND across dispatcher+push+sweep, and the transfer-hook placement against `schema.prisma`. Apply Critical/Important; Minor → PR description.
4. CI full matrix (`gh pr checks --watch`) — the only gate for the `resourceCountIs` cascade (Task 8), real-Postgres RLS, and `@db.Date` serialization in the sweep integration test.
5. **No device smoke in PR2** — there is no UI here beyond the preference toggle (covered by the Tier 2 screen test). Real push+email delivery is smoked in **PR3** (BLOCKER there: new EAS build), per spec §10.

## Self-review (run against the spec after writing — done)

- **Coverage:** §4 → Tasks 1–4 (event, templates, dispatch, pref key) + Task 5 (F-CLI-005 surface). §5.1 → Task 8. §5.2 → Task 7. §5.3 → Task 6 (incl. stale recovery, idempotency, BR-292 AND). §6 BR-297 → Task 9. §8 BR-298 → Task 6 (flip). §10 testing → per-task Tier-1 cases. ✅ no gap.
- **Type consistency:** `personal_deadline.reminder` (event type) vs `personal_deadline_reminder` (pref key) used consistently; `processPersonalDeadlineSweep` / `PersonalDeadlineSweepResult` / `withPersonalDeadlineSweepGuard` / `cancelPersonalDeadlinesForVehicleTransfer` names match across Tasks 6/7/9. `channels: {email,push}` shape identical in Tasks 1/3/6.
- **Placeholder scan:** verbatim limited to wire/Italian/cron/test-count per template policy; every "implement X" has a contract + test list. ✅

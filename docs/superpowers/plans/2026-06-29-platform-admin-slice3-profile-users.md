# Platform Admin Slice 3 — Tenant Profile + Cross-Tenant User Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the platform-admin console the ability to, for any tenant, view + edit the workshop profile (incl. correcting the VAT), and view + manage its staff users (disable/reactivate, change role, invite a new user/owner) — built on a single extracted core so business invariants (BR-203/204) cannot diverge between the officine and admin surfaces. Separately, remove the now-redundant officine onboarding wizard so a freshly-invited owner lands directly in the app.

**Architecture:** New `/v1/admin/tenants/:id/*` routes, platform-admin-only, DB access under `withContext({ role: 'admin' })`, `tenantId` from the path. The **only** cross-surface invariant logic (user role/status update: BR-203 last-super_admin lock, BR-204 mechanic-location, Cognito sync) is extracted from `users-admin-update.ts` into `lib/user-management/update-user.ts` and called by both the officine route (thin wrapper) and the new admin route. Profile-edit, user-list and invite are standalone admin handlers reusing existing DTOs/helpers (`TENANT_ME_SELECT`/`serializeTenantMe`, `USER_ADMIN_SELECT`/`serializeUserAdmin`, `createInternalInvitation`, `adminTenantRateLimitConfig`, `VatNumberSchema`). admin-web gains a `TenantDetail` page at `/officine/:id`. Mirrors sibling patterns: `admin-tenants-lifecycle.ts`, `admin-tenants-create.ts`, `TenantList.tsx`.

**Spec:** `docs/superpowers/specs/2026-06-29-platform-admin-slice3-profile-users-design.md`

**LOC budget:** target ~900–1200 net across 3 PRs; hard PR limit 1500. Controller checks cumulative `git diff --stat` after each task; halt and ask at ~80% of a PR's limit. Split is PR-A (backend) → PR-B (admin-web) → PR-C (wizard removal); each is independently shippable.

---

## Deviations from spec (verified against actual code — the code wins)

1. **Error codes already exist; spec invented `admin.tenant.*`.** The real codes (from `admin-tenants-lifecycle.ts`, `admin-tenants-create.ts`) are: `tenant.not_found` (404, anti-enum: invalid UUID and unknown UUID both 404), `tenant.invalid_status` (409), `tenant.vat_number_duplicate` (409 P2002), `tenant.vat_number_invalid` (400 format). User codes (`users-admin-update.ts`): `user.not_found` (404), `user.last_super_admin` (409), `user.location_required_for_mechanic` (422), `user.location_invalid` (422). Invite (`invitation-creation.ts` / create): `user.invitation.duplicate_pending` (409), `user.invitation.email_in_other_tenant` (409), `auth.cognito_unavailable` (502). **No new error codes are minted in this slice.**
2. **Core extraction is ×1, not ×3.** Spec §2 listed `updateOfficineUser`, `listOfficineUsers`, `updateTenantProfile`. Only `updateOfficineUser` carries cross-surface invariants. The user-list "helper" is just `USER_ADMIN_SELECT` + `serializeUserAdmin` (already shared) — the admin list route reuses them inline. The profile-update is **not** extractable as a mirror: the officine `PATCH /v1/tenants/me` (`tenants-update.ts:25-58`) deliberately **excludes `vatNumber`**, but the admin must be able to **correct the VAT** (an explicit driving need). So the admin profile handler is standalone with a superset body (adds `vatNumber` + format check + P2002), reusing only `TENANT_ME_SELECT`/`serializeTenantMe`.
3. **Address fields live on the `Tenant` table, not `Location`.** `tenants-update.ts:97-103` writes `addressLine/city/province/postalCode/phone` directly via `tx.tenant.update`. `TENANT_ME_SELECT` selects them from `Tenant`. The separate `Location` row (created by `admin-tenants-create.ts:150-162` with placeholder address) is used only for multi-location/mechanic assignment. The admin profile PATCH therefore writes `Tenant` directly — same columns as the officine route, plus `vatNumber`.
4. **No new IAM/CDK.** The admin routes run in the **same** API Lambda as the officine routes (Slice 0: "reuse, do not duplicate the API"). `admin-tenants-create.ts` already calls Cognito on the officine pool, and `users-admin-update.ts` already calls `AdminUpdateUserAttributes` / `AdminUserGlobalSignOut` / `AdminDisableUser` / `AdminEnableUser` on the officine pool from that same Lambda. The grants therefore already exist. Pre-flight verifies; no CDK task.
5. **No new RLS policy.** `users_read` is `SELECT USING (true)`, `users_write` is `USING (is_admin_role() OR tenant_id = current_tenant_id())`, and the `tenants` write policy already admits the admin context (Slices 1/2). Verified in migration `20260428100000_split_users_and_intervention_revisions_rls`. App-layer `tenantId` filter remains mandatory on reads.

## Gotchas the implementer MUST respect (from project memory)

- **Cross-tenant scoping is app-layer, not RLS.** `users_read USING(true)` means a `GET`/`PATCH` on `:userId` MUST filter `where: { id, tenantId, deletedAt: null }` and 404 on miss — never `findUniqueOrThrow`. A cross-tenant `404` integration test is mandatory (`[[feedback_rls_only_endpoint_leaks_in_prod]]`, `[[feedback_rls_split_changes_endpoint_semantics]]`).
- **Behavior-preserving extraction:** diff the removed `-` lines from `users-admin-update.ts`; every inline guard (BR-203 lock, BR-204, location validation, per-dimension audit) must reappear in the helper (`[[feedback_preserve_inline_guards_on_extract]]`). After the extraction, run the targeted `pnpm --filter @garageos/api test:unit` — typecheck does not catch broken FakePrisma mocks (`[[feedback_handler_change_breaks_unit_mock]]`).
- **Empty JSON body:** the admin-web `apiFetch` always sets `Content-Type: application/json`; POST/PATCH with no body must send `JSON.stringify({})` or Fastify rejects with `FST_ERR_CTP_EMPTY_JSON_BODY` (`[[feedback_fastify_empty_body_under_json_content_type]]`).
- **No `.default()` under `.partial()`** in the profile PATCH body — it auto-populates `{}` and defeats empty-body detection (`[[feedback_zod_default_under_partial_defeats_empty_body]]`). Mirror `tenants-update.ts` `.partial().strict()` + manual empty-body 422.
- **`exactOptionalPropertyTypes`:** build the update patch with `'key' in body` guards (mirror `tenants-update.ts:88-93`), no `as any` (`[[feedback_exact_optional_property_types_prisma_in_body]]`).
- **Cognito calls OUTSIDE the tx** (P2028) — the existing route already does this post-tx; the helper preserves it (`[[feedback_cognito_call_outside_postgres_tx]]`).
- **Rate-limit test isolation:** unique key/IP per `describe` block (`[[feedback_integration_test_rate_limit_isolation]]`).
- **shadcn CLI:** if adding components, verify no literal `@/` dir is created (`[[feedback_shadcn_cli_literal_alias_path]]`). `table`, `badge`, `alert-dialog`, `dialog`, `input`, `label`, `card`, `button` already exist in admin-web (`packages/admin-web/src/components/ui/`). A `select`/`form`/`tabs` may be new.
- **react-query offline guard:** `if (isLoading || !data)` before `data!` (`[[feedback_react_query_data_bang_offline_paused]]`).
- **commitlint** lints every commit; scope must be in the enum (`api`, `web`, `admin-web`?, …). Verify `admin-web` is an allowed scope before using it — if not, use `web` or no-scope `docs:` (`[[feedback_ci_commitlint_all_commits_scope]]`). (Slice 2 PR-B title was `feat(admin-web): …` — so `admin-web` is allowed.)

## Branch

PR-A: `feat/admin-slice3-backend` · PR-B: `feat/admin-slice3-web` · PR-C: `chore/remove-onboarding-wizard`. All branch from updated `main`. This plan doc lands on the first branch (or its own `docs/` branch, merged first).

---

## Pre-flight checklist (run BEFORE dispatching implementers)

### Schema & Prisma
- [ ] Grep `schema.prisma` `model Tenant`: confirm columns `businessName, vatNumber, email, phone, addressLine, city, province, postalCode, status, plan, billingStatus, createdAt, settings, deletedAt` exist with these exact names (consumed by profile GET/PATCH + `TENANT_ME_SELECT`).
- [ ] Grep `schema.prisma` `model User`: confirm `role, status, locationId, tenantId, cognitoSub, deletedAt` (consumed by the update-user core + list).
- [ ] Grep `schema.prisma` `model Location`: confirm `isPrimary, tenantId, status, deletedAt` (consumed by the "primary location" lookup for BR-204 defaulting).
- [ ] Grep `schema.prisma` `model Invitation`: confirm the partial unique index name `uq_invitations_pending_internal` still backs the P2002 in `createInternalInvitation`.
- [ ] Confirm `VatNumberSchema` is exported from `@garageos/database` (used by `admin-tenants-create.ts:21`).

### Docs cross-reference (BR / error codes / API)
- [ ] Grep `APPENDICE_F` for **BR-203, BR-204, BR-210** — cite their exact text in code comments; do NOT mint new BR numbers (the cross-tenant surface reuses them).
- [ ] Grep `APPENDICE_G` to confirm every code in "Deviations #1" is already registered; add the new **routes** (not codes) to `APPENDICE_A`.
- [ ] Grep target paths before "Create": `admin-tenant-detail.ts`, `admin-tenant-users.ts`, `admin-tenant-users-invitations.ts`, `lib/user-management/update-user.ts`, `pages/TenantDetail.tsx` — confirm none pre-exist.

### RLS & DB constraints
- [ ] Confirm `users_read` = `USING (true)` and `users_write` = `is_admin_role() OR tenant_id = current_tenant_id()` in migration `20260428100000_*` (drives the app-layer-filter + cross-tenant-404 requirement).
- [ ] Every new `GET`/`PATCH` on `:id`/`:userId` uses `findFirst({ where: { id, tenantId } })` + manual 404, never `findUniqueOrThrow`.

### Tests & refactors
- [ ] For the `updateOfficineUser` extraction, compare removed lines of `users-admin-update.ts` for dropped guards; run `pnpm --filter @garageos/api test:unit` after.
- [ ] Integration test helpers mirror the exact wire (content-type + body); rate-limit tests use per-`describe` keys.

### Infra & runbooks
- [ ] Grep `infrastructure/lib/constructs/lambda-api.ts` (or equivalent): confirm `cognito-idp:AdminUpdateUserAttributes`, `AdminUserGlobalSignOut`, `AdminDisableUser`, `AdminEnableUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminGetUser` are granted on the **officine** pool (expected present — used by existing officine routes in the same Lambda). If any is missing, that is a separate infra fix, not part of this slice — flag it.

### Style & process
- [ ] Comment headers in English; user-facing strings in Italian.
- [ ] Confirm `admin-web` is in the commitlint scope enum.

---

# PR-A — Backend (API)

Branch `feat/admin-slice3-backend`. Test-first (TDD red→green) for all API/core. Integration tests are CI-only (Docker/Testcontainers); write them, do not run locally (`[[feedback_skip_local_integration_tests]]`). Targeted `test:unit` after route-handler tasks.

### Task A1: Extract `updateOfficineUser` core (behavior-preserving)

**Files:**
- Create: `packages/api/src/lib/user-management/update-user.ts`
- Modify: `packages/api/src/routes/v1/users-admin-update.ts` (becomes a thin wrapper)
- Test (existing, must stay green **unchanged**): `packages/api/tests/integration/users-admin-update.test.ts`, `packages/api/tests/unit/routes/v1/users-admin-update.test.ts` (if present)

**Interfaces — Produces:**
```ts
// lib/user-management/update-user.ts
export type UpdateUserActor =
  | { type: 'user'; cognitoSub: string }      // officine super_admin: audit actorType='user', actorId=DB uuid (looked up)
  | { type: 'system'; cognitoSub: string };   // platform admin: audit actorType='system', actorId=null, metadata.actorCognitoSub

export interface UpdateUserInput {
  tenantId: string;
  targetId: string;
  body: { role?: 'super_admin' | 'mechanic'; locationId?: string | null; status?: 'active' | 'inactive' };
  actor: UpdateUserActor;
  ip: string;
}

// Orchestrates: withContext({role:'admin'}) tx (target lookup + BR-204 + BR-203 lock + location validation
// + update + per-dimension audit), THEN best-effort Cognito sync (role/location attrs; global signout + disable
// on active→inactive). Returns the serialized user DTO. Throws businessError for the documented codes.
export async function updateOfficineUser(
  app: FastifyInstance,
  input: UpdateUserInput,
  log: FastifyBaseLogger,
): Promise<UserAdminWireDto>;
```

**Contract / behavior:**
- Move the entire tx body of `users-admin-update.ts:69-209` and the post-tx Cognito sync block `:211-256` into the helper **verbatim**, parameterized by `input`. The only branch on `actor.type`: inside the audit-write, `type==='user'` looks up `actorId` by `{ cognitoSub: actor.cognitoSub, tenantId }` (current behavior); `type==='system'` sets `actorId: null` and adds `actorCognitoSub: actor.cognitoSub` to each audit row's `metadata`.
- Error codes unchanged: `user.not_found` (404), `user.location_required_for_mechanic` (422), `user.last_super_admin` (409), `user.location_invalid` (422). Cite **BR-203** and **BR-204** in comments (copy the existing comment block).
- The officine route becomes: parse params/body (same zod schemas, keep them in the route), then `return reply.code(200).send({ user: await updateOfficineUser(app, { tenantId: request.tenantId!, targetId, body, actor: { type: 'user', cognitoSub: request.userId! }, ip: request.ip }, request.log) })`.

**Tests (no new test code — the gate is the EXISTING suite staying green):**
- [ ] Run the existing `users-admin-update` integration + unit suites after the refactor: **all pass unchanged**. This proves behavior preservation (`[[feedback_preserve_inline_guards_on_extract]]`).
- [ ] `pnpm --filter @garageos/api test:unit` (FakePrisma mock check).

**Commit:** `refactor(api): extract updateOfficineUser core for cross-tenant reuse`

### Task A2: `GET` + `PATCH /v1/admin/tenants/:id` (tenant detail + profile edit)

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenant-detail.ts`
- Test: `packages/api/tests/integration/admin-tenant-detail.test.ts`

**Contract:**
- Both routes: `preHandler: [requireAuth, requirePlatformAdminsPool]`, DB under `withContext({ role: 'admin' })`. `:id` zod-validated; **invalid OR unknown UUID → `tenant.not_found` 404** (anti-enum, mirror `admin-tenants-lifecycle.ts:38-42`).
- **GET:** `findFirst({ where: { id, deletedAt: null }, select: TENANT_ME_SELECT })`; null → 404. Respond `200 { tenant: serializeTenantMe(rowWithSettings) }` — note: use `TENANT_ME_SELECT_WITH_SETTINGS` so `serializeTenantMe` can run (it strips `settings`). No rate-limit.
- **PATCH:** body = officine editable set **plus `vatNumber`**:
  ```ts
  // mirror tenants-update.ts body, add vatNumber; .partial().strict(); NO .default()
  businessName: z.string().trim().min(1).max(200)
  vatNumber: z.string().trim().min(1).max(20)
  email: z.email('Email non valida')
  phone: z.string().regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido').nullable()
  addressLine: z.string().trim().max(255).nullable()
  city: z.string().trim().max(100).nullable()
  province: z.string().trim().transform(s=>s.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/,'Provincia: 2 lettere')).nullable()
  postalCode: z.string().regex(/^[0-9]{5}$/,'CAP: 5 cifre').nullable()
  ```
  - Unknown key → `tenants.me.update.unknown_field` 422 (reuse, mirror `tenants-update.ts:69-72`). Empty body → `tenants.me.update.empty_body` 422.
  - If `vatNumber` present: `VatNumberSchema.safeParse` → else `tenant.vat_number_invalid` 400 (mirror create).
  - Load tenant (`findFirst {id, deletedAt:null}`) → null → `tenant.not_found` 404.
  - Build patch via `'key' in body` guards (EDITABLE_KEYS incl. `vatNumber`). `tx.tenant.update`; catch P2002 → `tenant.vat_number_duplicate` 409.
  - Audit `tenant_profile_updated`, `actorType:'system'`, `actorId:null`, `metadata:{ actorCognitoSub: request.jwt?.sub, changed: Object.keys(patch) }`, `ipAddress`. Respond `200 { tenant: serializeTenantMe(updatedWithSettings) }`.

**Tests (TDD):**
- [ ] GET: existing tenant → 200 with all fields; unknown UUID → 404; invalid UUID → 404.
- [ ] GET/PATCH: officine JWT → 403; clienti JWT → 403; platform-admin JWT → 200 (auth isolation).
- [ ] PATCH: edits `businessName`+`phone` → 200, row updated, audit row written.
- [ ] PATCH: `vatNumber` to another tenant's VAT → `tenant.vat_number_duplicate` 409.
- [ ] PATCH: malformed `vatNumber` → `tenant.vat_number_invalid` 400; unknown key → 422; empty body → 422.

**Commit:** `feat(api): admin tenant detail + profile edit endpoints`

### Task A3: `GET` + `PATCH /v1/admin/tenants/:id/users` (list + update user)

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenant-users.ts`
- Test: `packages/api/tests/integration/admin-tenant-users.test.ts`

**Contract:**
- Both: `preHandler: [requireAuth, requirePlatformAdminsPool]`. `:id` validated; first load the tenant (`findFirst {id, deletedAt:null}`) → null → `tenant.not_found` 404 (so actions on an unknown tenant fail before touching users).
- **GET `/:id/users`:** under `withContext({role:'admin'})`, `tx.user.findMany({ where: { tenantId: id }, select: USER_ADMIN_SELECT, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] })` (mirror `users-list.ts`; includes soft-deleted for "Disattivati" display — filter client-side). Respond `200 { users: rows.map(serializeUserAdmin) }`. **App-layer `tenantId` filter is the cross-tenant guard.** No rate-limit.
- **PATCH `/:id/users/:userId`:** `:userId` zod UUID. Body `{ role?, locationId?, status? }`, at-least-one-required (reuse the schema from `users-admin-update.ts`). For BR-204 defaulting: if the effective role is `mechanic` and no `locationId` is provided/known, resolve the tenant's primary location (`tx.location.findFirst({ where: { tenantId: id, isPrimary: true, status: 'active', deletedAt: null } })`) and pass its id; if none exists, let the core raise `user.location_required_for_mechanic` 422. Delegate to `updateOfficineUser(app, { tenantId: id, targetId: userId, body: effectiveBody, actor: { type:'system', cognitoSub: request.jwt!.sub }, ip: request.ip }, request.log)`. Respond `200 { user }`.

**Tests (TDD):**
- [ ] GET: lists only the path tenant's users; auth isolation (403 officine/clienti).
- [ ] **Cross-tenant scoping (security core):** `PATCH /tenants/:A/users/:userOfB` → `user.not_found` 404 (the load runs under A's filter). Mandatory.
- [ ] **BR-203 cross-tenant:** demote/deactivate the last active super_admin → `user.last_super_admin` 409; with a second super_admin present → 200.
- [ ] **BR-204 cross-tenant:** demote super_admin→mechanic with no explicit location → succeeds, assigned to primary location; if tenant has no primary location → 422.
- [ ] Audit rows written with `actorType:'system'` + `metadata.actorCognitoSub`, `tenantId` = path tenant.
- [ ] Unknown tenant id → `tenant.not_found` 404; unknown userId → `user.not_found` 404.
- [ ] Run targeted `pnpm --filter @garageos/api test:unit` (handler change).

**Commit:** `feat(api): admin list + manage tenant users endpoints`

### Task A4: `POST /v1/admin/tenants/:id/users/invitations` (invite user/owner)

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenant-users-invitations.ts`
- Test: `packages/api/tests/integration/admin-tenant-users-invitations.test.ts`

**Contract:**
- `preHandler: [requireAuth, requirePlatformAdminsPool]`, `config: { rateLimit: adminTenantRateLimitConfig }` (30/h per admin sub; reuse from `lib/admin-tenant-rate-limit.ts`).
- Body: `{ email, firstName, lastName, role: 'super_admin' | 'mechanic' }` (trim/lowercase email, mirror `admin-tenants-create.ts:37-44` field rules).
- Load tenant (`findFirst {id, deletedAt:null}`) → 404 `tenant.not_found`. (Optionally require `status==='active'`, mirroring regenerate; reuse `tenant.invalid_status` 409 if so — decide at implementation; default: allow invite regardless of status, simplest.)
- **Cognito + pending pre-checks OUTSIDE tx** (mirror `admin-tenants-create.ts:68-123`): `getOfficineUserByEmail` → exists → `user.invitation.email_in_other_tenant` 409; `CognitoUnavailableError` → `auth.cognito_unavailable` 502; pending-elsewhere invitation → `user.invitation.email_in_other_tenant` 409.
- In tx under `withContext({role:'admin'})`: resolve `locationId` (primary location for `mechanic`, `null` allowed for `super_admin`), call `createInternalInvitation(tx, { tenantId: id, targetEmail: email, firstName, lastName, role, locationId })` (handles P2002 → `user.invitation.duplicate_pending` 409). Audit `user_invited`, `actorType:'system'`, `actorId:null`, `metadata:{ actorCognitoSub, role }`.
- Post-tx best-effort `sendInvitationEmail` (mirror create; `invitedByName` = admin JWT name). Respond `200`:
  ```jsonc
  { "invitation": { "email": "<targetEmail>", "role": "super_admin|mechanic",
    "expiresAt": "<ISO>", "emailSent": true|false,
    "magicLinkUrl": "https://app.garageos.aifollyadvisor.com/invitations/<token>" } }
  ```
  (the single place a plaintext token is returned, to an authenticated admin, shown once — mirror Slice 2 regenerate).

**Tests (TDD):**
- [ ] Invite mechanic → 200, invitation row created with primary `locationId`, `magicLinkUrl` returned, email attempted; audit row.
- [ ] Invite super_admin (new owner) → 200, `locationId` null acceptable.
- [ ] Duplicate pending for same (tenant,email) → `user.invitation.duplicate_pending` 409.
- [ ] Email already in officine pool / pending elsewhere → `user.invitation.email_in_other_tenant` 409.
- [ ] Unknown tenant → `tenant.not_found` 404; auth isolation 403.
- [ ] Rate-limit 30/h enforced (per-`describe` isolation key).

**Commit:** `feat(api): admin invite tenant user/owner endpoint`

### Task A5: Register routes + docs

**Files:**
- Modify: `packages/api/src/server.ts` (register `adminTenantDetailRoutes`, `adminTenantUsersRoutes`, `adminTenantUsersInvitationsRoutes` next to the other `adminTenants*` registrations at `:178-182`).
- Modify: `docs/APPENDICE_A_API.md` (5 new admin routes), `docs/APPENDICE_F_BUSINESS_LOGIC.md` (note BR-203/204/210 enforced cross-tenant from the admin console), `docs/APPENDICE_G_ERROR_CODES.md` (confirm no new codes — add a note that admin routes reuse the `tenant.*` / `user.*` families).

**Tests:** none new (covered by A2–A4). `pnpm -r typecheck`.

**Commit:** `feat(api): register admin tenant profile/users routes + docs`

---

# PR-B — admin-web (tenant detail page)

Branch `feat/admin-slice3-web`. Implement-first, then Tier-2 targeted tests (`[[feedback_right_size_process_to_task]]`). Reuse `useApiFetch`/`ApiError` (`@/lib/api-client`), Sonner, shadcn. Mirror `TenantList.tsx` / `CreateTenant.tsx` patterns exactly.

### Task B1: types + error map + API hooks

**Files:**
- Create: `packages/admin-web/src/lib/tenant-detail-types.ts` (`TenantProfile` = mirror of `TenantMeDto` wire shape; `AdminUser` = mirror of `UserAdminWireDto`; `InviteResult`).
- Modify: `packages/admin-web/src/lib/tenant-actions.ts` — extend `ACTION_ERROR_MESSAGES` with the user/profile codes: `user.last_super_admin`, `user.location_required_for_mechanic`, `user.location_invalid`, `user.not_found`, `tenant.vat_number_duplicate` ("P.IVA già in uso."), `tenant.vat_number_invalid`, `user.invitation.duplicate_pending`, `user.invitation.email_in_other_tenant`, `auth.cognito_unavailable` — all Italian.

**Contract:** types only mirror the backend wire shapes verbatim (verify field names against `tenant-me.ts` / `user-admin.ts`). No logic.

**Commit:** `feat(admin-web): tenant detail types + error messages`

### Task B2: `TenantDetail` page — profile section

**Files:**
- Create: `packages/admin-web/src/pages/TenantDetail.tsx`
- Modify: `packages/admin-web/src/App.tsx` (add `<Route path="/officine/:id" element={<TenantDetail />} />` inside `ProtectedRoute`, after `/officine`).
- Modify: `packages/admin-web/src/pages/TenantList.tsx` (make the business-name cell a link / row `onClick` → `navigate('/officine/' + tenant.id)`; keep existing per-row action buttons working — `stopPropagation` on the actions cell).

**Contract:**
- `useParams` → `id`. `useQuery(['admin-tenant', id], () => apiFetch('/v1/admin/tenants/' + id))` for profile; loading/error/`!data` guards (mirror `TenantList.tsx:152-174`). Back-link to `/officine`.
- Header: businessName + status `Badge` (reuse `STATUS_BADGE`).
- Profile form: react-hook-form + zod mirroring the PATCH body (incl. `vatNumber`); fields with Italian labels (Ragione sociale, P.IVA, Email, Telefono, Indirizzo, Città, Provincia, CAP). Submit → `useMutation` PATCH → `invalidateQueries(['admin-tenant', id])` + Sonner success; `onError` → `handleMutationError` (reuse the `ApiError` code map).

**Tests (Tier 2, after impl):** `TenantDetail.test.tsx` — happy path (profile renders from query), error state. No pure-render assertions.

**Commit:** `feat(admin-web): tenant detail page with profile editing`

### Task B3: `TenantDetail` — users section + actions

**Files:**
- Modify: `packages/admin-web/src/pages/TenantDetail.tsx` (add users table + action dialogs).
- Possibly add shadcn `select` for the role picker (`pnpm dlx shadcn@latest add select` in `packages/admin-web`; verify no literal `@/` dir).

**Contract:**
- `useQuery(['admin-tenant-users', id], () => apiFetch('/v1/admin/tenants/' + id + '/users'))`. Table: Nome (`firstName lastName`), Email, Ruolo (`Badge`), Stato (attivo / disabilitato (`deletedAt` or `status==='inactive'`) / — ). Per-row actions in `alert-dialog`:
  - **Disabilita** (status active) → `PATCH .../users/:userId` body `{ status: 'inactive' }`. **Riattiva** (inactive) → `{ status: 'active' }`.
  - **Cambia ruolo** (`alert-dialog` or `select`) → `{ role }`. Surface `user.last_super_admin` via the error map when the API rejects.
  - All mutations send real JSON body (PATCH has a body, so no `{}` issue); `invalidateQueries(['admin-tenant-users', id])` + toast.
- **Invita utente** button → `Dialog` with email/firstName/lastName/role → `POST .../users/invitations` (body present) → on success show the `magicLinkUrl` in a result `Dialog` with a **Copia** button (mirror `TenantList.tsx:371-409` regenerate dialog + clipboard fix). `invalidateQueries(['admin-tenant-users', id])`.

**Tests (Tier 2):** add to `TenantDetail.test.tsx` — users render; conditional action gating (Disabilita shows for active, Riattiva for inactive); invite dialog submit calls the mutation. No pure-render.

**Commit:** `feat(admin-web): tenant user management (disable/role/invite)`

---

# PR-C — Remove officine onboarding wizard

Branch `chore/remove-onboarding-wizard`. Pure deletion; the Settings tabs the wizard wrapped stay. **Smoke = BLOCKER** (`[[feedback_smoke_mandatory_for_shell_layout_pr]]`).

### Task C1: remove the onboarding API endpoint

**Files:**
- Delete: `packages/api/src/routes/v1/tenants-onboarding.ts`, `packages/api/tests/integration/tenants-onboarding.test.ts`, `packages/api/tests/unit/routes/v1/tenants-onboarding.test.ts`.
- Modify: `packages/api/src/server.ts` (remove `tenantsOnboardingRoutes` import + `app.register` at `:185`).
- Modify: `docs/APPENDICE_A_API.md` (remove `POST /v1/tenants/me/onboarding/complete`).

**Contract:** `onboardingCompletedAt` stays inert in `tenant.settings` JSON (no migration). `serializeTenantMe`/`extractOnboardingCompletedAt` may stay (harmless) or be cleaned — keep for now to minimize churn; the web no longer reads it.

**Tests:** `pnpm -r typecheck` (confirms no dangling import).

**Commit:** `chore(api): remove onboarding wizard complete endpoint`

### Task C2: remove the officine wizard UI + gate

**Files:**
- Delete: `packages/web/src/auth/OnboardingGate.tsx` (+`.test.tsx`), `packages/web/src/pages/OnboardingWizard.tsx` (+`.test.tsx`), `packages/web/src/queries/tenantOnboarding.ts` (+`.test.tsx`), `packages/web/src/lib/onboardingSkip.ts` (+`.test.ts`).
- Modify: `packages/web/src/App.tsx` (remove the `/onboarding` route + `OnboardingGate` wrapper; super_admins now land directly in `AppLayout`).
- Modify: `packages/web/src/pages/Settings.tsx` (remove the "Riavvia configurazione guidata" button block `:145-149`).
- Grep & clean any remaining imports of the deleted modules (`tenantOnboarding`, `onboardingSkip`, `OnboardingGate`, `OnboardingWizard`) in `AuthContext.tsx`, `accountInactiveFlag.ts`, tests.

**Contract:** a freshly-invited super_admin logs in → no redirect → lands in the app → edits data + invites from Settings tabs.

**Tests (Tier 2):**
- [ ] Add/keep a routing test asserting an un-onboarded super_admin is **not** redirected to `/onboarding` (the route no longer exists; lands on the app shell).
- [ ] Deleted wizard/gate tests are removed (not skipped).
- [ ] `pnpm -r typecheck`.

**Smoke (BLOCKER):** on a real browser — invite a new owner via the admin console (or reuse a pending invite) → accept → log into the officine app → confirm direct landing (no wizard, no bounce loop) → edit officina data + invite a mechanic from Settings.

**Commit:** `chore(web): remove onboarding wizard and gate`

---

## Review gates (in order)
1. Per-task review on the **riskiest** tasks only: **A1** (core extraction), **A3** (cross-tenant scoping + BR-203/204), **A4** (invite/Cognito pre-checks).
2. `pnpm -r typecheck` (pre-push hook) per branch.
3. **Final whole-branch `/code-review high`** per PR — load-bearing, never skip. It cross-references `schema.prisma`, `APPENDICE_F`/`APPENDICE_G`, and cross-task consistency.
4. CI full matrix (`gh pr checks --watch`) — the only gate for RLS semantics + real-Postgres BR-203 lock behavior.
5. **Smoke runbook for PR-C** (and a quick admin-web click-through for PR-B) — BLOCKER.

## Self-review notes (spec coverage)
- Spec §1.1–1.5 → Tasks A2 (detail+profile), A3 (list+update), A4 (invite). ✅
- Spec §2 core extraction → Task A1 (reduced to ×1, see Deviations #2). ✅
- Spec §3 security/RLS/audit/IAM → folded into A1–A4 contracts + pre-flight (RLS/IAM = verify-only, Deviations #4/#5). ✅
- Spec §4 admin-web → Tasks B1–B3. ✅
- Spec §5 wizard removal → Tasks C1–C2. ✅
- Spec §6 testing → per-task TDD + Tier-2 + smoke. ✅
- Spec §7 sizing/PR split → PR-A/B/C. ✅

# Platform Admin — Slice 3: Tenant Profile + Cross-Tenant User Management (design)

**Date:** 2026-06-29
**Status:** Approved for implementation
**Type:** Vertical slice of the multi-PR arc (large, cross-layer)
**Arc spec:** `docs/superpowers/specs/2026-06-27-platform-admin-tenant-provisioning-design.md` (§ "Slice 3 — Profile & users per tenant")
**Builds on:** Slice 0 (#220/#221) infra+auth, Slice 1 (#223) create-tenant, Slice 2 (#224/#225) list+lifecycle.

## Problem

Slice 1+2 gave the platform-admin console the ability to create a workshop and
manage its lifecycle (list, suspend/reactivate, regenerate the owner link). It
still cannot:

- **Correct a workshop's data** — business name / VAT / email / phone / address
  entered wrong at creation, with no way to fix them from the console.
- **See or manage a tenant's users** — the exact support scenarios the operator
  hits on the phone: "the owner can't log in", "my colleague left, remove their
  access", "we need a new account", "promote/demote someone".

Separately, the original Slice 1 design parked real address data in the
officine-side **onboarding wizard** (F-OFF-003/F-OFF-002): tenants are created
with a placeholder address and the workshop completes it through a guided wizard
gated on first login. That wizard is now redundant — the officine **Settings**
page already exposes every capability it wrapped (edit tenant data, manage users,
edit location) — and it adds a redirect gate that complicates the login path.
The target lifecycle is simpler: **admin creates the tenant → the owner logs into
the officine app → no wizard → edits workshop data and invites mechanics from
Settings.**

## Goal

From the admin console an operator can, for any tenant:

1. **View** the full profile and the list of staff users.
2. **Edit** the profile (mirror of the fields the super_admin already edits in the
   officine "Officina" tab).
3. **Manage users:** disable/reactivate, change role (super_admin ⇄ mechanic),
   and invite a new user / new owner (returns + emails a magic-link).

And the officine app **no longer shows the onboarding wizard** — it is removed
entirely; the post-invite super_admin lands directly in the app.

Consistent with the arc: same Fastify API, `/v1/admin/*` prefix, `platform-admins`
pool, operator-driven, no automatic registration. **Customers (B2C clienti) are
out of scope** — this console manages workshop staff only.

---

## Decisions (locked in brainstorming 2026-06-29)

- **Cross-tenant access model = the already-established pattern, unchanged.**
  `withContext({ role: 'admin' })` sets the GUC `app.current_role='admin'`; RLS
  policies have `is_admin_role()` branches; all within the `garageos_app`
  **NOBYPASSRLS** runtime role. No DB role that bypasses RLS, no new RLS policy.
  The arc spec framed this as an open decision ("dedicated DB role vs explicit
  queries"); Slices 1+2 already resolved it. Slice 3 **applies** it, it does not
  re-decide it.
- **Build cross-tenant endpoints on shared core helpers extracted from the
  existing officine routes** (Approach A), not parallel reimplementations. Every
  business invariant (BR-203, BR-204, VAT uniqueness) lives in one place, called
  by both the officine and admin surfaces. Rationale: the #1 historical
  cross-tenant failure is sibling endpoints diverging
  (`[[feedback_cross_tenant_read_audit_sibling_endpoints]]`); a single source of
  truth structurally prevents it. Same pattern as `provisionCustomer` and Slice
  2's `createInternalInvitation`.
- **Profile edit = mirror of the officine `TenantForm`** (business name, VAT,
  email, phone, address). No `plan`/`billing_status` editing (out of scope).
- **Admin user-management UI = a tenant detail page** (`/officine/:id`), not
  inline expansion of the Slice 2 list row.
- **Onboarding wizard = removed** (officine web): gate, wizard, route, complete
  endpoint, skip flag, "restart wizard" button. The downstream Settings tabs that
  the wizard wrapped already exist and stay.
- **"Sedi" (multi-location) removal is a SEPARATE slice** (its own brainstorm +
  spec): it is a schema migration (Location table, FKs, RLS, expand→migrate→
  contract). Not bundled here. For Slice 3, locations still exist; admin actions
  on mechanics default to the tenant's primary location (see §3, BR-204).

---

## 1. API surface

All routes: `preHandler: [requireAuth, requirePlatformAdminsPool]`, **no**
`tenantContext`/`requireOfficinaPool` (platform admins are cross-tenant), DB
access under `withContext({ role: 'admin' })`. `:id` (tenant) and `:userId`
validated as UUID (zod); unknown tenant ⇒ `404 admin.tenant.not_found`. Mirrors
`admin-tenants-list.ts` / `admin-tenants-lifecycle.ts`.

| Method | Route | Purpose | Reuses |
|---|---|---|---|
| `GET`   | `/v1/admin/tenants/:id` | Tenant detail (full profile) | tenant serializer |
| `PATCH` | `/v1/admin/tenants/:id` | Edit profile (mirror officine form) | core from `tenant-update.ts` |
| `GET`   | `/v1/admin/tenants/:id/users` | List the tenant's staff users | core from `users-list.ts` |
| `PATCH` | `/v1/admin/tenants/:id/users/:userId` | Change role / disable / reactivate | **core from `users-admin-update.ts`** |
| `POST`  | `/v1/admin/tenants/:id/users/invitations` | Invite new user / new owner | `createInternalInvitation` (Slice 2-F6) |

### 1.1 `GET /v1/admin/tenants/:id`

Returns the full profile under admin context, filtered to the path `:id`. Fields
mirror the officine tenant DTO (`businessName`, `vatNumber`, `email`, `phone`,
`addressLine`, `city`, `province`, `postalCode`, `status`, `plan`, `billingStatus`,
`createdAt`). 404 if absent or soft-deleted. Read-only; no rate-limit.

### 1.2 `PATCH /v1/admin/tenants/:id`

Body = the editable subset (mirror of officine `TenantForm`): `businessName`,
`vatNumber`, `email`, `phone`, `addressLine`, `city`, `province`, `postalCode` —
all optional, at-least-one-required (reuse the officine validator;
`[[feedback_zod_default_under_partial_defeats_empty_body]]` — no `.default()` in a
partial body, and `[[feedback_fastify_empty_body_under_json_content_type]]`).

Behavior: load tenant (404 if absent), `UPDATE` the provided fields, audit
`tenant_profile_updated` (metadata = changed fields). VAT is `@unique`: catch
P2002 ⇒ `409 admin.tenant.vat_already_exists` (same code as Slice 1 create).
Response `200 { tenant: {...} }`.

### 1.3 `GET /v1/admin/tenants/:id/users`

List the tenant's non-deleted staff users under admin context, **filtered
app-layer by `tenantId`** (the `users_read` RLS is `USING (true)` — the `where`
does the scoping, not RLS; `[[feedback_rls_only_endpoint_leaks_in_prod]]`). Each
row: `id`, `firstName`, `lastName`, `email`, `role`, `status`, `locationId`, and
(if useful) a derived "pending invitation" marker. Reuse the officine
`users-list` serializer/select. Read-only; no rate-limit.

### 1.4 `PATCH /v1/admin/tenants/:id/users/:userId`

The cross-tenant analogue of `PATCH /v1/users/:id`. Body: `{ role?, locationId?,
status? }`, at-least-one-required. Delegates to the **extracted core**
(`updateOfficineUser`, see §2) with `tenantId` from the path and
`actor = { type:'system', cognitoSub }`. The core enforces:

- **BR-204** — mechanic requires a location (admin defaults to the tenant's
  primary location when demoting/inviting a mechanic without an explicit one).
- **BR-203** — race-safe last-super_admin guard (`FOR UPDATE` lock over all
  active super_admins) ⇒ `409 user.last_super_admin`.
- `404 user.not_found` if `:userId` is absent **or belongs to another tenant**
  (the app-layer `tenantId` filter; this is the cross-tenant scoping guard).
- Best-effort Cognito sync on the **officine** pool (role/location attrs;
  global sign-out + disable on active→inactive) — identical to the officine route.

Audit rows: `user_role_changed` / `user_status_changed`, `actorType:'system'`,
`actorId:null`, `metadata` includes `actorCognitoSub`, `tenantId` = the target
tenant. Response `200 { user: {...} }`.

### 1.5 `POST /v1/admin/tenants/:id/users/invitations`

Invite a new staff user (mechanic) or a new owner (super_admin). Body:
`{ email, firstName, lastName, role: 'super_admin' | 'mechanic' }`. Under admin
context in one tx, reuse `createInternalInvitation(tx, { tenantId, targetEmail,
firstName, lastName, role, locationId })` — `locationId` defaults to the tenant's
primary location for a mechanic (BR-204), `null` is acceptable for a super_admin.
P2002 duplicate-pending ⇒ the helper's existing `user.invitation.duplicate_pending`
mapping. Audit `user_invited` (cross-tenant). Post-tx best-effort
`sendInvitationEmail`. Response `200 { invitation: { email, role, expiresAt,
emailSent, magicLinkUrl } }` — same shape as Slice 2 regenerate but with a
generic `email` field (the invitee may be a mechanic, not an owner); the plaintext
token is shown once to an authenticated admin. Rate-limited 30/h per admin key
(mirror Slice 2, `[[feedback_integration_test_rate_limit_isolation]]`).

---

## 2. The core extraction (Approach A — the main backend work)

Move the business logic out of the officine route handlers into context-
parameterized helpers under `packages/api/src/lib/user-management/`, each with a
signature shaped like `(tx, { tenantId, ...input, actor }) => result`. The
officine routes and the admin routes both become thin wrappers.

The `actor` discriminant carries the only real difference between the two
surfaces:

```ts
type Actor =
  | { type: 'user'; dbId: string; ip: string }      // officine super_admin
  | { type: 'system'; cognitoSub: string; ip: string }; // platform admin
```

The audit-writing inside the core branches on `actor.type` to set
`actorType`/`actorId`/`metadata.actorCognitoSub` (mirroring Slice 1/2 for
`system`). Everything else — BR-203 lock, BR-204 check, location validation, the
per-dimension audit rows, the post-tx Cognito sync block — is shared verbatim.

Helpers to extract (one per existing officine concern):

- `updateOfficineUser` ← `users-admin-update.ts` (role/location/status, BR-203/204,
  Cognito sync). **The riskiest extraction** — gets per-task review.
- `listOfficineUsers` ← `users-list.ts` (select + serializer; trivial).
- `updateTenantProfile` ← `tenant-update.ts` (editable-fields update + P2002).
- Invitation creation already lives in `createInternalInvitation`
  (`lib/invitation-creation.ts`, Slice 2-F6) — reused directly, no new extraction.

**Behavior-preserving constraint:** the existing officine integration + unit
tests (`users-admin-update`, `users-list`, `tenant-update`,
`users-invitations-create`) must stay green **unchanged**. That green run is the
proof the refactor changed no behavior. Diff the `-` lines to confirm no
inline guard/validation is dropped in the move
(`[[feedback_preserve_inline_guards_on_extract]]`,
`[[feedback_handler_change_breaks_unit_mock]]` — run the targeted officine
`test:unit` after the extraction, FakePrisma mocks break silently under tsc).

---

## 3. Security, RLS, invariants, audit

### Access model (established, unchanged)

`withContext({ role:'admin' })` → GUC `app.current_role='admin'` → `is_admin_role()`
RLS branches, inside `garageos_app` **NOBYPASSRLS**
(`[[feedback_least_privilege_db_role]]`). Relevant existing policies, no change
required:

- `users_read` = `FOR SELECT USING (true)` ⇒ **app-layer `tenantId` filter is
  mandatory** on every read; RLS does not scope here.
- `users_write` = `USING (is_admin_role() OR tenant_id = current_tenant_id())` ⇒
  admin writes cross-tenant already permitted.
- Pre-flight (plan): confirm the `tenants` UPDATE policy admits the admin update
  (Slices 1/2 established admin insert/update on `tenants`).

Do **not** weaken any tenant-scoped policy to make a test pass
(`[[feedback_dont_loosen_schema_for_tests]]`).

### Invariants (reused via the core, not reimplemented)

- **BR-203** last-super_admin race-safe guard.
- **BR-204** mechanic-requires-location (admin defaults to primary location).
- **VAT uniqueness** → P2002 → `409 admin.tenant.vat_already_exists`.

### Negative / boundary tests (Tier 1, security core)

- **Auth-plugin isolation:** officine/clienti JWT on `/v1/admin/tenants/:id/*`
  ⇒ `403`; platform-admins JWT ⇒ `200`.
- **Cross-tenant scoping:** `PATCH .../tenants/:A/users/:userOfTenantB` ⇒
  `404 user.not_found` (the app-layer filter holds despite `users_read USING(true)`).
  This is the test that prevents the leak.

### Audit

Every mutation writes one row per changed dimension: `actorType:'system'`,
`actorId:null`, `metadata={ actorCognitoSub, ...changes }`, `ipAddress`,
`tenantId` = **target** tenant (the admin has no tenant). Actions:
`tenant_profile_updated`, `user_role_changed`, `user_status_changed`,
`user_invited`.

### PII

The users here are **workshop staff**, not B2C customers. An operator seeing
staff name/email is inherent to support; no DTO redaction needed. The discipline
that remains is the app-layer `tenantId` filter on every read.

### Cognito IAM (recurring gap — pre-flight)

Admin status/role mutations sync the **officine** pool
(`COGNITO_OFFICINE_POOL_ID`: AdminUpdateUserAttributes, AdminUserGlobalSignOut,
AdminDisableUser, AdminEnableUser) and invitations create users in it. The admin
API Lambda must hold those grants and env vars
(`[[feedback_lambda_iam_admin_enable_user_gap]]`,
`[[feedback_lambda_reuses_api_env_schema_needs_all_vars]]`) — silent-fail in prod
otherwise, caught only by device/browser smoke. Verify in the plan's pre-flight
and in the CDK construct.

---

## 4. Frontend — admin-web tenant detail page

Stack in place (React Router v6, react-query v5, RHF+zod, shadcn/ui, Sonner,
`useApiFetch`/`ApiError`, Italian copy).

### 4.1 Route `/officine/:id` → `pages/TenantDetail.tsx`

The Slice 2 `TenantList` row becomes clickable → navigates here. Back-link to the
list.

- **Header:** business name + status `Badge` (reuse `TenantList`'s) + the existing
  lifecycle actions (Sospendi / Riattiva / Rigenera link) — moved or shared here
  from the list (decision at implementation; prefer a shared actions component).
- **"Dati officina" section:** profile form mirroring the officine `TenantForm`
  fields → `PATCH /v1/admin/tenants/:id`. Map P2002 → "P.IVA già in uso".
- **"Utenti" section:** table from `GET .../users` — Nome, Email, Ruolo (badge),
  Stato (attivo / disabilitato / invito pendente). Per-row actions in
  `alert-dialog` / `dialog`:
  - **Disabilita / Riattiva** (gated on current status).
  - **Cambia ruolo** (super_admin ⇄ mechanic; surface the BR-203 error from the
    API when it is the last admin).
  - **Invita utente** (section button) → dialog (email/nome/ruolo) →
    `POST .../users/invitations` → result dialog showing `magicLinkUrl` with a
    **Copia** button + `emailSent` note (identical to Slice 2 regenerate).

All mutations: targeted `invalidateQueries` + Sonner toast; `ApiError` code →
Italian message map. New shadcn components only if missing; verify no literal
`@/` dir (`[[feedback_shadcn_cli_literal_alias_path]]`).

### Tier 2 tests

`TenantDetail`: 2–3 tests — happy path (profile + users render from queries),
error state, conditional action gating (which action shows for which
status/role). No pure-render assertions.

---

## 5. Onboarding wizard removal (web officine)

Clean deletion; the downstream Settings tabs (Officina / Utenti / Sedi) the wizard
wrapped already exist and stay functional.

**Delete:** `auth/OnboardingGate.tsx` (+test), `pages/OnboardingWizard.tsx`
(+test), the `/onboarding` route in `App.tsx`, `queries/tenantOnboarding.ts`
(+test), `lib/onboardingSkip.ts` (+test), the "Riavvia configurazione guidata"
button in `pages/Settings.tsx`, and the API route
`POST /v1/tenants/me/onboarding/complete` (`tenants-onboarding.ts` + tests).

**`onboardingCompletedAt`:** left inert in the `settings` JSON — **no migration**
(we do not drop data). Remove only its use in the gate; its serialization in
`serializeTenantMe` may stay or be cleaned (minor, decided at plan).

**Effect:** a freshly-invited super_admin logs in → lands directly in the app →
completes workshop/location data and invites mechanics from the Settings tabs. No
redirect, no gate, no bounce loop.

**Smoke = BLOCKER** (`[[feedback_smoke_mandatory_for_shell_layout_pr]]`): this
touches the officine login path and the first post-invite entry — exactly the UX
drift only device/browser smoke catches.

---

## 6. Testing summary (Tier 1 mandatory, test-first for API/core)

- **Core extraction behavior-preserving:** existing officine `users-admin-update`,
  `users-list`, `tenant-update`, `users-invitations-create` tests stay green
  unchanged.
- **BR-203 cross-tenant:** demote/disable last super_admin via admin route ⇒
  `409`; with ≥2 ⇒ success; race-safe lock test.
- **BR-204 cross-tenant:** mechanic invite/demote without location ⇒ defaults to
  primary (or `422` if none).
- **VAT uniqueness:** `PATCH` profile with another tenant's VAT ⇒ `409`.
- **Auth isolation + cross-tenant scoping:** as §3 (the `404` cross-tenant guard
  is the load-bearing security test).
- **Audit rows** written with `actorType:'system'` + `actorCognitoSub` + target
  `tenantId`.
- **Invite:** returns `magicLinkUrl`, emails best-effort, creates in the officine
  pool; rate-limit 30/h with per-`describe` isolation.
- **API contract:** status codes + RFC 7807 envelope + error codes per route.
- **Wizard removal:** a test that the officine login no longer redirects to
  `/onboarding`; deleted wizard/gate tests removed.

### Pre-flight (in the plan, per `PLAN_TEMPLATE.md`)

- Grep `APPENDICE_G` for existing `admin.tenant.*` / `user.*` codes before
  minting any (`[[feedback_preflight_must_grep_appendice_g_codes]]`).
- Grep `APPENDICE_F`: cite BR-203/204 in the cross-tenant context; no new BR
  expected (`[[feedback_br_number_collision_in_doc]]`).
- Grep `schema.prisma` for every Prisma op (`[[feedback_verify_plan_against_schema]]`):
  `Tenant` editable fields, `User.role/status/locationId/tenantId`, primary
  `Location` lookup.
- Confirm the `tenants` UPDATE + `users` write RLS admits the admin context
  (Slices 1/2 established it).
- Verify the admin API Lambda's Cognito IAM grants + env vars on the officine
  pool.

---

## 7. Process & sizing

Large cross-layer slice (~9 tasks: core extraction ×3, profile GET+PATCH, users
GET+PATCH, invite, `TenantDetail` page, user-action UI, wizard removal).
Therefore: **subagent-driven** implementation; per-task review only on the
riskiest tasks (the `updateOfficineUser` extraction, cross-tenant scoping, the
invite endpoint); final **`/code-review high`** on the whole branch; smoke
**browser BLOCKER**.

### PR split (likely exceeds the 1500-LOC hard limit)

- **PR-A — backend (§1-3, §6):** core extraction + all admin endpoints.
  Independently shippable (curl-testable); holds the risk (cross-tenant scoping)
  → lands first.
- **PR-B — admin-web (§4):** `TenantDetail` page + user/profile actions.
- **PR-C — officine wizard removal (§5):** independent deletion, smoke-gated; may
  run in parallel with PR-B.

Final split decided at plan-time, not pre-committed
(`[[feedback_pr_size_tracking]]` — `git diff --stat` checkpoints).

### Docs to update

- `APPENDICE_A_API.md`: the 5 new admin routes + removal of the onboarding
  complete endpoint.
- `APPENDICE_G_ERROR_CODES.md`: reused/new `admin.tenant.*` / `user.*` codes.
- `APPENDICE_F_BUSINESS_LOGIC.md`: BR-203/204 cited in the cross-tenant context.

## 8. Out of scope (roadmap)

"Sedi" (multi-location) removal — its own slice (schema migration). Usage metrics
+ platform audit views — Slice 4. B2C customers — never in this console.
`plan`/`billing_status` editing. Cognito-level session kill beyond the existing
best-effort sync.

## Open questions

None blocking. Exact error-code names resolve at the plan's pre-flight greps, not
as design choices.

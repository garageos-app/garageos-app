# Platform Admin — Slice 2: Tenant List + Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the platform-admin console a tenant list with lifecycle controls — suspend/reactivate a workshop (enforcing the existing-but-inert `TenantStatus`), regenerate the owner's magic-link (returning a copyable link), plus two debt cleanups (F6 shared invitation helper, F4 rate-limit) that this slice makes ripe.

**Architecture:** Same Fastify API, `/v1/admin/*` prefix guarded by `[requireAuth, requirePlatformAdminsPool]`, cross-tenant DB access via `withContext({ role: 'admin' })` — all mirroring `admin-tenants-create.ts` (Slice 1). Suspension is enforced as a **DB guard** in `tenant-context.ts` (one joined query, no Cognito user enumeration). Frontend mirrors `packages/web`/Slice-1 admin-web patterns (React Router v6, react-query v5, shadcn/ui, `useApiFetch` + `ApiError`).

**Tech Stack:** Fastify + TypeScript + Prisma 7 (pg adapter); `@fastify/rate-limit` (already registered `global:false`); Vite + React + Tailwind + shadcn/ui + @tanstack/react-query in `packages/admin-web`.

**Spec:** `docs/superpowers/specs/2026-06-29-platform-admin-slice2-tenant-list-lifecycle-design.md`

**LOC budget:** target ~900 net across backend+frontend; hard PR limit 1500. Controller checks cumulative `git diff --stat` after each task; halt and ask at ~80% (1200). **Likely a 2-PR split** (PR-A backend T1–T6+T9-backend-docs, PR-B frontend T7–T8) — decide at the LOC checkpoint after T6, not pre-committed.

## Global Constraints

- **No new npm deps** without justification in PR desc. All needed libs (rate-limit, react-query, shadcn primitives) already present; only shadcn component *files* (`table`, `badge`, `alert-dialog`, `dialog`) are scaffolded — not new packages.
- **TypeScript strict**, no `any` without a justifying comment.
- **Comments in English**; user-facing strings in **Italian** (admin-web has no i18n framework — inline Italian literals, mirroring `CreateTenant.tsx`).
- **No emoji** in code or commit messages.
- **Conventional Commits**, summary ≤ 72 chars (commitlint is a hard CI gate on every PR commit; scope ∈ `api|web|admin-web|database|infra|shared|e2e|deps|docs`).
- **Local gate = `pnpm -r typecheck` only** (husky pre-push). Do NOT run integration tests locally (machine-freeze). For route-handler tasks also run the targeted `pnpm --filter @garageos/api test:unit` (typecheck misses broken FakePrisma mocks). Full matrix runs on CI.
- **Plaintext invitation token** only ever appears in: the email body, and (new this slice) the regenerate response. Never in the create response, never in a DB column beyond its SHA-256 hash, never logged.

---

## Deviations from spec (verified against actual code — the code wins)

1. **BR is NOT new — it already exists.** Spec §6 proposed "BR-SUSPEND (new)". `APPENDICE_F_BUSINESS_LOGIC.md:886` already defines **BR-210 — Suspension tenant**. We implement and cite **BR-210**; no new BR number is minted. (Avoids the recurring BR-collision bug.)
2. **Error codes mostly already exist** (`APPENDICE_G_ERROR_CODES.md`). Spec §8 guessed `admin.tenant.not_found` / `admin.tenant.invalid_status` / `admin.tenant.invitation_not_pending`. Reality + the `tenant.*`/`user.invitation.*` convention Slice 1 already follows:
   - tenant unknown id → reuse **`tenant.not_found`** (404, `APPENDICE_G:201`).
   - accept-while-suspended → reuse **`auth.tenant.suspended`** (403, `APPENDICE_G:194`, "Tenant sospeso").
   - regenerate, no invitation row (legacy tenant) → reuse **`user.invitation.not_found`** (404, `APPENDICE_G:234`).
   - regenerate, already accepted → reuse **`user.invitation.already_accepted`** (410, `APPENDICE_G:240`).
   - **Only ONE new code minted: `tenant.invalid_status`** (409) — bad lifecycle transition (suspend a non-active / reactivate a non-suspended / regenerate on a non-active tenant).
3. **BR-210 is implemented PARTIALLY this slice — the login-block portion only.** BR-210 also mandates: existing interventions stay visible to customers (✅ untouched — the customer read path does not go through `tenant-context.ts`), no new interventions (✅ officine blocked by the guard), **future notification schedules cancelled** and **90-day auto-cancel**. The latter two touch the EventBridge scheduler subsystem (separate construct; orphan-schedule footgun per `[[feedback_cancel_pending_reminders_failed_orphan]]`) and are **DEFERRED** — a console-managed tenant created via Slice 1 has zero reminders, so there is no behavior gap today. Documented as a deferred follow-up; flagged to the user. The plan implements BR-210's "utenti non possono fare login".
4. **`Invitation` has no `updatedAt`** (`schema.prisma:799-819` — only `createdAt`). The regenerate UPDATE sets `tokenHash` + `expiresAt` explicitly; do NOT reference a non-existent `updatedAt` (the Slice-1 CI failure was exactly an invented `invitations.updated_at`).
5. **Tenant-status enforcement is purely DB** (decision locked in brainstorming) — no `AdminDisableUser`/`GlobalSignOut` on suspend. `lib/cognito.ts` disable/enable helpers exist but are intentionally NOT used here.

---

## Gotchas the implementer MUST respect (from project memory)

- `withContext({ role: 'admin' })` is required for any cross-tenant read/write (RLS `NOBYPASSRLS` runtime role); `withContext({})` blocks writes (`[[feedback_withcontext_empty_blocks_rls_writes]]`). Slice 1 already proved admin context permits `tenants`/`invitations` INSERT+UPDATE.
- Network calls (Cognito/email) must be **outside** the Postgres tx (P2028) — `[[feedback_cognito_call_outside_postgres_tx]]`. Email send stays post-tx best-effort.
- On refactor extraction, diff the `-` lines to confirm no inline guard/validation is dropped — `[[feedback_preserve_inline_guards_on_extract]]`.
- Integration tests with rate-limited routes: unique key/IP per `describe` block — `[[feedback_integration_test_rate_limit_isolation]]`.
- `findFirst({ id, tenantId/…})` + manual null→404, never `findUniqueOrThrow`, for RLS-permissive reads — `[[feedback_rls_split_changes_endpoint_semantics]]`. For cross-tenant admin reads under `role:'admin'`, RLS is permissive — still prefer explicit `findFirst` + null check for clean error codes.
- shadcn CLI can create a literal `@/` directory — verify and clean (`[[feedback_shadcn_cli_literal_alias_path]]`).
- Prisma `update({ data: {} })` may emit no SQL — never assert on a non-existent `@updatedAt`. Audit rows are separate inserts, so transitions are always observable via the audit table.
- Route-handler unit tests use `FakePrisma` — after changing a handler, run `pnpm --filter @garageos/api test:unit` (`[[feedback_handler_change_breaks_unit_mock]]`).
- admin-web `ApiError` parser keys off `body.code` then `body.name` then `http.${status}` — error-code→Italian maps must use the **exact** server code strings (`[[feedback_mobile_apierror_rfc7807_mismatch]]` class).

## Branch

`feat/platform-admin-slice2-tenant-lifecycle` (already created; spec committed at `2aebfdb`).

---

## Task 1: Extract `createInternalInvitation` helper (F6)

Pure, behavior-preserving refactor. Two existing callers (`admin-tenants-create.ts`, `users-invitations-create.ts`) build an `internal_user` invitation identically (token gen + `expiresAt` + `invitation.create` + P2002→`duplicate_pending`). Extract that core so the regenerate endpoint (Task 5) and these two share it.

**Files:**
- Create: `packages/api/src/lib/invitation-creation.ts`
- Modify: `packages/api/src/routes/v1/admin-tenants-create.ts:163-194` (replace the inline token+create block with a helper call)
- Modify: `packages/api/src/routes/v1/users-invitations-create.ts:170-202` (same)
- Test: `packages/api/tests/unit/invitation-creation.test.ts` (new unit test for the helper) + the EXISTING integration suites for both callers must stay green unchanged.

**Interfaces:**
- Produces:
  ```ts
  // packages/api/src/lib/invitation-creation.ts
  import type { Prisma } from '@garageos/database';
  import type { InvitationAdminRow } from './dtos/invitation.js';

  export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  export interface CreateInternalInvitationInput {
    tenantId: string;
    targetEmail: string;
    firstName: string;
    lastName: string;
    role: 'super_admin' | 'mechanic';
    locationId: string | null;
  }

  // Throws businessError('user.invitation.duplicate_pending', 409, …) on P2002.
  // tx is a withContext({role:'admin'}) transaction client.
  export async function createInternalInvitation(
    tx: Prisma.TransactionClient,
    input: CreateInternalInvitationInput,
  ): Promise<{ invitation: InvitationAdminRow; tokenPlaintext: string }>;
  ```
- Consumes: `generateInvitationToken` (`lib/secure-tokens.ts`), `businessError` (`lib/business-error.js`), `INVITATION_ADMIN_SELECT` (`lib/dtos/invitation.js`), `Prisma` (`@garageos/database`).

**Behavioral contract (must match current code exactly):**
- Generate `{ plaintext, hash }` via `generateInvitationToken()`.
- `expiresAt = new Date(Date.now() + INVITATION_TTL_MS)`.
- `tx.invitation.create({ data: { tenantId, invitationType: 'internal_user', targetEmail, firstName, lastName, role, locationId, tokenHash, expiresAt }, select: INVITATION_ADMIN_SELECT })`.
- On `Prisma.PrismaClientKnownRequestError` code `P2002` → `throw businessError('user.invitation.duplicate_pending', 409, 'Esiste già un invito pendente per questa email.')`.
- Return `{ invitation, tokenPlaintext: plaintext }`.
- Email send and audit log stay in the **callers** (their `invitedByName`/`emailSent` handling differs).
- Both callers replace their local `const INVITATION_TTL_MS = …` with the import from `invitation-creation.js` (DRY the constant too). `WEB_BASE_URL` stays in callers (used for the URL).

**Caller rewrites (verify the `-` diff drops no guard):**
- `users-invitations-create.ts`: keep BR-204 mechanic check, the existing-user collision, the Cognito early-check, the locationId-belongs-to-tenant check, and the audit insert — only the token+`invitation.create`+P2002 block becomes `const { invitation, tokenPlaintext } = await createInternalInvitation(tx, { tenantId, targetEmail: body.email, firstName: body.firstName, lastName: body.lastName, role: body.role, locationId: body.locationId });`. The serializer call (`serializeInvitationAdmin(result)`) still works since the helper returns the `INVITATION_ADMIN_SELECT` shape.
- `admin-tenants-create.ts`: keep tenant+location creation and the `tenant_created` audit; the invitation block becomes `const { invitation, tokenPlaintext } = await createInternalInvitation(tx, { tenantId: tenant.id, targetEmail: body.ownerEmail, firstName: body.ownerFirstName, lastName: body.ownerLastName, role: 'super_admin', locationId: location.id });`. `invitation.expiresAt` is still available from the returned row.

- [ ] **Step 1: Write the failing unit test.** In `invitation-creation.test.ts`, with a FakePrisma/`tx` stub: (a) calls `tx.invitation.create` with `invitationType:'internal_user'` and the passed fields + a 64-hex `tokenHash` + an `expiresAt ≈ now+7d`; returns `{ invitation, tokenPlaintext }` where `tokenPlaintext` is 68 chars and `hashToken(tokenPlaintext) === ` the stored hash. (b) a `tx.invitation.create` that throws a `P2002` `PrismaClientKnownRequestError` makes the helper throw a `businessError` with code `user.invitation.duplicate_pending` / status 409.
- [ ] **Step 2: Run → fail.** `pnpm --filter @garageos/api test:unit -- invitation-creation` → FAIL (module not found).
- [ ] **Step 3: Implement** `invitation-creation.ts` per the contract.
- [ ] **Step 4: Refactor both callers** to use it; remove their duplicated TTL const + token/create/P2002 block.
- [ ] **Step 5: Run.** `pnpm --filter @garageos/api test:unit` (helper + both callers' unit specs green) and `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `refactor(api): extract createInternalInvitation helper (F6)`

---

## Task 2: DB guard — suspended tenant blocks officine login + accept (BR-210)

The security core. Extend the existing per-request user lookup in `tenant-context.ts` with a joined tenant-status filter, and add a tenant-active check to the public invitation-accept endpoint.

**Files:**
- Modify: `packages/api/src/middleware/tenant-context.ts:85-100` (add `tenant: { is: { status: 'active' } }` to the `findFirst` where)
- Modify: `packages/api/src/routes/v1/invitations-public-accept.ts:65-110` (Phase 1: load tenant status, throw `auth.tenant.suspended` if not active)
- Test: `packages/api/tests/integration/tenant-context-suspension.test.ts` (new) + add cases to the existing invitation-accept integration suite.

**Interfaces:** No new exports. Behavior change only.

**Behavioral contract:**
- `tenant-context.ts`: the `prisma.user.findFirst` where-clause becomes
  ```ts
  where: {
    cognitoSub: parsed.data.sub,
    tenantId: parsed.data['custom:tenant_id'],
    status: 'active',
    deletedAt: null,
    tenant: { is: { status: 'active' } }, // BR-210: suspended tenant blocks login
  },
  ```
  Null → existing `unauthorizedError('User inactive or not found')` (401). **Do NOT** introduce a distinct "tenant suspended" message here — anti-enumeration; the officine client must not learn the difference (comment must cite BR-210 + this rationale). One query, no extra round-trip.
- `invitations-public-accept.ts` Phase 1: extend the `findUnique` select with `tenant: { select: { status: true } }`; after the existing not-found/expired/consumed guard, add: `if (inv.tenant.status !== 'active') throw businessError('auth.tenant.suspended', 403, 'Officina sospesa. Contatta il supporto.');`. (Cite BR-210. A reactivated, non-expired link then works again.)

**Test cases (Tier 1, integration / real Postgres — CI):**
- Officine JWT for an **active** tenant → normal tenant route (e.g. `GET /v1/users` or any tenant-scoped route the suite already exercises) → 200.
- Same user, after `UPDATE tenants SET status='suspended'` → **401** on the same route.
- After `UPDATE tenants SET status='active'` again → 200 (reversible).
- A user whose tenant is active but whose own `status='inactive'` → still 401 (regression: didn't weaken the existing user guard).
- Accept a valid pending invite whose tenant is `suspended` → **403 `auth.tenant.suspended`**; flip tenant to active → accept succeeds (200/201 per the suite's existing shape).
- Negative: suspended-tenant officine JWT on `/v1/admin/*` is still 403 (pool isolation unchanged — assert one existing admin route).

- [ ] **Step 1: Write failing integration tests** per the cases above (seed an active tenant+user, toggle `tenants.status` with raw `UPDATE`, assert status codes). Mirror the existing tenant-context integration setup for JWT minting.
- [ ] **Step 2: Run → fail.** Suspended-tenant case currently returns 200. (Note: integration is CI-only; locally just `pnpm -r typecheck`. If reproducing, `pnpm --filter @garageos/api test:integration` — heavy, CI preferred.)
- [ ] **Step 3: Implement** the two where-clause/guard changes.
- [ ] **Step 4: Run** `pnpm -r typecheck` (PASS) and push to let CI run the integration matrix.
- [ ] **Step 5: Commit.** `feat(api): block suspended-tenant login and invite accept (BR-210)`

---

## Task 3: `GET /v1/admin/tenants` — tenant list endpoint + DTO

**Files:**
- Create: `packages/api/src/lib/dtos/tenant-admin.ts`
- Create: `packages/api/src/routes/v1/admin-tenants-list.ts`
- Modify: `packages/api/src/server.ts:62,176` (import + `await app.register(adminTenantsListRoutes)` next to the other admin routes)
- Test: `packages/api/tests/integration/admin-tenants-list.test.ts`

**Interfaces:**
- Produces (DTO):
  ```ts
  export const TENANT_ADMIN_LIST_SELECT = {
    id: true, businessName: true, vatNumber: true, email: true,
    status: true, createdAt: true,
  } as const satisfies Prisma.TenantSelect;

  export type TenantAdminInvitationStatus = 'pending' | 'accepted' | 'expired';
  export interface TenantAdminListItem {
    id: string;
    businessName: string;
    vatNumber: string;
    email: string | null;
    status: 'active' | 'suspended' | 'pending' | 'cancelled';
    createdAt: string; // ISO-8601
    owner: { email: string; invitationStatus: TenantAdminInvitationStatus } | null;
  }
  // serializeTenantAdminList(tenantRow, ownerInvitationRowOrNull, now): TenantAdminListItem
  ```

**Behavioral contract:**
- Auth: `preHandler: [requireAuth, requirePlatformAdminsPool]`. No rate-limit (read).
- Under `withContext({ role: 'admin' })`:
  1. `tx.tenant.findMany({ where: { deletedAt: null }, select: TENANT_ADMIN_LIST_SELECT, orderBy: { createdAt: 'desc' } })`.
  2. If any tenants: `tx.invitation.findMany({ where: { tenantId: { in: ids }, invitationType: 'internal_user', role: 'super_admin' }, select: { tenantId: true, targetEmail: true, acceptedAt: true, expiresAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } })`. (Single query, no N+1.)
- In memory: for each tenant, pick the **most recent** matching invitation (first in the desc list grouped by `tenantId`). Derive `owner`:
  - no invitation → `null` (legacy tenants from `rebuild-tenants.mjs`).
  - `acceptedAt != null` → `{ email: targetEmail, invitationStatus: 'accepted' }`.
  - else `expiresAt < now` → `'expired'`.
  - else → `'pending'`.
- Response `200 { tenants: TenantAdminListItem[] }`.

**Test cases (Tier 1, integration):**
- Platform-admins JWT → 200; seed 3 tenants with: (a) pending invite, (b) accepted invite (`acceptedAt` set), (c) expired invite (`expiresAt` in past), and (d) a legacy tenant with NO invitation → `owner: null`. Assert each `invitationStatus` + that suspended tenants still appear (status field present). Assert `createdAt` is an ISO string, ordering desc.
- officine JWT → 403; clienti JWT → 403; no-auth → 401 (pool isolation).
- Soft-deleted tenant (`deletedAt` set) excluded.

- [ ] **Step 1:** Write failing integration test (seed the 4 tenant shapes, assert the wire DTO).
- [ ] **Step 2:** Run → fail (route 404).
- [ ] **Step 3:** Implement DTO + route; register in `server.ts`.
- [ ] **Step 4:** `pnpm --filter @garageos/api test:unit` (if any unit added) + `pnpm -r typecheck`; push for CI integration.
- [ ] **Step 5: Commit.** `feat(api): add GET /v1/admin/tenants list endpoint`

---

## Task 4: Suspend + reactivate endpoints (`tenant.invalid_status` new code)

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenants-lifecycle.ts` (both routes in one plugin — they are symmetric and trivially small)
- Modify: `packages/api/src/server.ts` (register `adminTenantsLifecycleRoutes`)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (add `tenant.invalid_status`)
- Test: `packages/api/tests/integration/admin-tenants-lifecycle.test.ts`

**Interfaces:** Produces `adminTenantsLifecycleRoutes: FastifyPluginAsync`.

**Behavioral contract:**
- Both: `preHandler: [requireAuth, requirePlatformAdminsPool]`; `:id` validated as UUID (zod; invalid → `tenant.not_found` 404, anti-enum, OR a 400 validation error — use `tenant.not_found` 404 to avoid leaking existence). Under `withContext({ role: 'admin' })`, in one tx:
- **`POST /v1/admin/tenants/:id/suspend`:**
  - `findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } })`; null → `tenant.not_found` 404.
  - `status !== 'active'` → `businessError('tenant.invalid_status', 409, "L'officina non è in uno stato che permette la sospensione.")`.
  - `tx.tenant.update({ where: { id }, data: { status: 'suspended' } })`.
  - audit `tenant_suspended`, `actorType:'system'`, `actorId:null`, `entityType:'tenant'`, `entityId:id`, `metadata:{ actorCognitoSub: request.jwt?.sub ?? null }`, `ipAddress`.
  - `200 { tenant: { id, status: 'suspended' } }`.
- **`POST /v1/admin/tenants/:id/reactivate`:** symmetric; requires `status === 'suspended'` (else `tenant.invalid_status` 409); sets `status: 'active'`; audit `tenant_reactivated`; `200 { tenant: { id, status: 'active' } }`. Cite BR-210.
- New error code row in `APPENDICE_G` (alphabetical in the `tenant.*` block, after `tenant.billing.past_due`): `| \`tenant.invalid_status\` | 409 | info | Operazione non consentita per lo stato attuale dell'officina | POST /v1/admin/tenants/:id/suspend|reactivate|regenerate-invitation — transizione di stato illegale | Slice 2 |` and add `tenant.invalid_status` to the flat code list (~line 998).

**Test cases (Tier 1, integration):**
- suspend an active tenant → 200 `status:'suspended'`; audit row `tenant_suspended` written.
- suspend an already-suspended tenant → 409 `tenant.invalid_status`.
- reactivate a suspended tenant → 200 `status:'active'`; audit `tenant_reactivated`.
- reactivate an active tenant → 409 `tenant.invalid_status`.
- unknown UUID → 404 `tenant.not_found`; non-UUID `:id` → 404 `tenant.not_found`.
- officine/clienti JWT → 403; no-auth → 401.

- [ ] **Step 1:** Write failing integration tests per cases.
- [ ] **Step 2:** Run → fail (routes 404).
- [ ] **Step 3:** Implement both routes + register + `APPENDICE_G` rows.
- [ ] **Step 4:** `pnpm -r typecheck`; push for CI.
- [ ] **Step 5: Commit.** `feat(api): add tenant suspend/reactivate endpoints (BR-210)`

---

## Task 5: Regenerate-invitation endpoint (returns copyable link + sends email)

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenants-regenerate-invitation.ts`
- Modify: `packages/api/src/server.ts` (register)
- Test: `packages/api/tests/integration/admin-tenants-regenerate-invitation.test.ts`

**Interfaces:** Consumes `generateInvitationToken` (`lib/secure-tokens.js`), `INVITATION_TTL_MS` (`lib/invitation-creation.js`), `sendInvitationEmail` (`lib/ses-client.js`), `businessError`, `env`. (In-place UPDATE — not the create helper; it shares only token-gen + TTL.)

**Behavioral contract:**
- Auth: `[requireAuth, requirePlatformAdminsPool]`. Rate-limit added in Task 6.
- `:id` UUID (invalid → `tenant.not_found` 404).
- Under `withContext({ role: 'admin' })`, one tx:
  1. `tx.tenant.findFirst({ where: { id, deletedAt: null }, select: { id, status, businessName } })`; null → `tenant.not_found` 404.
  2. `status !== 'active'` → `tenant.invalid_status` 409 (a suspended/cancelled tenant must not onboard; cite BR-210 + the accept guard in Task 2).
  3. Find the owner invitation: `tx.invitation.findFirst({ where: { tenantId: id, invitationType: 'internal_user', role: 'super_admin' }, orderBy: { createdAt: 'desc' }, select: { id, targetEmail, firstName, lastName, acceptedAt } })`.
     - null → `user.invitation.not_found` 404 (legacy tenant; "Nessun invito da rigenerare per questa officina.").
     - `acceptedAt != null` → `user.invitation.already_accepted` 410 ("L'invito è già stato accettato.").
  4. `const { plaintext, hash } = generateInvitationToken(); const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);` then `tx.invitation.update({ where: { id: invitation.id }, data: { tokenHash: hash, expiresAt } })`. (No `updatedAt` on Invitation — do not set it.) The old `tokenHash` is overwritten → dead.
  5. audit `tenant_invitation_regenerated`, `actorType:'system'`, `entityType:'invitation'`, `entityId: invitation.id`, `metadata:{ actorCognitoSub, ownerEmail: targetEmail }`, `ipAddress`.
  6. Return `{ invitation: { id, targetEmail, firstName, lastName }, tenant: { businessName }, tokenPlaintext: plaintext, expiresAt }` to the outer scope.
- **Post-tx, best-effort email** (mirror Slice 1): `sendInvitationEmail({ toAddress: targetEmail, invitedFirstName: firstName ?? '', invitedByName: <admin name from jwt given/family or 'GarageOS'>, tenantName: businessName, role: 'super_admin', magicLinkUrl })` where `magicLinkUrl = \`${WEB_BASE_URL}/invitations/${tokenPlaintext}\``. try/catch → `emailSent` flag.
- Response `200`:
  ```jsonc
  {
    "invitation": {
      "ownerEmail": "string",
      "expiresAt": "ISO-8601",
      "emailSent": true,
      "magicLinkUrl": "https://app.garageos.aifollyadvisor.com/invitations/<token>"
    }
  }
  ```
  This is the ONLY response in the system that returns a plaintext token (comment must say so + why: explicit authenticated platform-admin recovery action).

**Test cases (Tier 1, integration):**
- regenerate on an active tenant with a pending invite → 200; response `magicLinkUrl` ends with a 68-char token; the OLD token no longer resolves at `POST /v1/invitations/:oldToken/accept` (404) while the NEW token does resolve (Phase-1 lookup succeeds); `expiresAt ≈ now+7d`; audit `tenant_invitation_regenerated` written.
- regenerate when the invite is already accepted → 410 `user.invitation.already_accepted`.
- regenerate on a tenant with no invitation (legacy) → 404 `user.invitation.not_found`.
- regenerate on a suspended tenant → 409 `tenant.invalid_status`.
- unknown tenant id → 404 `tenant.not_found`.
- officine/clienti JWT → 403; no-auth → 401.
- email transport stubbed to throw → still 200 with `emailSent:false` and a valid `magicLinkUrl` (the whole point: link usable even when email breaks).

- [ ] **Step 1:** Write failing integration tests.
- [ ] **Step 2:** Run → fail (route 404).
- [ ] **Step 3:** Implement route + register.
- [ ] **Step 4:** `pnpm --filter @garageos/api test:unit` + `pnpm -r typecheck`; push for CI.
- [ ] **Step 5: Commit.** `feat(api): add regenerate owner invitation endpoint`

---

## Task 6: Rate-limit create + regenerate (F4)

**Files:**
- Modify: `packages/api/src/routes/v1/admin-tenants-create.ts:46-51` (add `config.rateLimit`)
- Modify: `packages/api/src/routes/v1/admin-tenants-regenerate-invitation.ts` (add `config.rateLimit`)
- Test: add a rate-limit case to each route's integration suite.

**Behavioral contract:** add to both route option objects:
```ts
config: {
  rateLimit: {
    max: 30,
    timeWindow: '1 hour',
    keyGenerator: (request) => `admin-tenant:${request.userId ?? request.ip}`,
  },
}
```
Update the create-route header comment (currently "no rate-limit … may be added in a later slice") to reflect the limit. `suspend`/`reactivate`/`GET` stay unlimited. Note: `request.userId` on these admin routes is set by `requireAuth` from the platform-admin JWT sub (no `tenantContext` runs) — confirm `requireAuth` populates `request.userId`; if not, key by `request.jwt?.sub ?? request.ip`. **Verify against `require-auth.ts` during implementation** and use whichever field holds the admin sub.

**Test cases (Tier 1, integration — unique key per `describe`):**
- 31st create call within the window from the same admin key → 429 (RFC 7807 envelope). Use a dedicated admin sub/IP for this `describe` block to avoid cross-test bleed.
- A single create/regenerate under the limit → normal 201/200 (sanity, not rate-limited).

- [ ] **Step 1:** Write failing rate-limit integration test (loop to exceed `max`, assert 429).
- [ ] **Step 2:** Run → fail (no limit; all 200/201).
- [ ] **Step 3:** Add `config.rateLimit` to both routes; verify the key source against `require-auth.ts`.
- [ ] **Step 4:** `pnpm -r typecheck`; push for CI.
- [ ] **Step 5: Commit.** `feat(api): rate-limit tenant create and regenerate routes (F4)`

> **LOC CHECKPOINT (after Task 6):** run `git diff --stat main...HEAD`. If net > ~1200, STOP and split: open **PR-A** now (T1–T6 + the API-doc portion of T9), get it green + reviewed + merged, then continue T7–T8 on a fresh branch off updated main as **PR-B**. Otherwise continue on the same branch.

---

## Task 7: admin-web — Tenant list page (read)

**Files:**
- Create via shadcn CLI: `packages/admin-web/src/components/ui/{table,badge,alert-dialog,dialog}.tsx` (run `npx shadcn@latest add table badge alert-dialog dialog`; **verify no literal `@/` dir created**, clean if so).
- Create: `packages/admin-web/src/pages/TenantList.tsx`
- Create: `packages/admin-web/src/lib/tenant-status.ts` (status/invitation badge label+variant maps — shared by list and actions)
- Modify: `packages/admin-web/src/App.tsx` (add `<Route path="/officine" element={<ProtectedRoute><TenantList/></ProtectedRoute>} />`)
- Modify: `packages/admin-web/src/pages/PlatformConsole.tsx` (add an "Officine" nav button → `navigate('/officine')`, beside "Crea officina")
- Test: `packages/admin-web/src/pages/TenantList.test.tsx`

**Interfaces:**
- Consumes API: `GET /v1/admin/tenants` → `{ tenants: TenantAdminListItem[] }` (shape from Task 3). Mirror the `AdminMe` query pattern in `PlatformConsole.tsx`.
- Produces: a client-side type mirroring `TenantAdminListItem`; `tenant-status.ts` exports `STATUS_BADGE: Record<status, {label:string; variant:string}>` and `INVITATION_BADGE: Record<invitationStatus,{label,variant}>`.

**Behavioral contract:**
- `const apiFetch = useApiFetch(); const { data, isLoading, error } = useQuery({ queryKey: ['admin-tenants'], queryFn: () => apiFetch<{tenants: TenantAdminListItem[]}>('/v1/admin/tenants') });`
- Render a shadcn `Table`: columns **Officina** (businessName), **P.IVA** (vatNumber), **Email titolare** (`owner?.email ?? '—'`), **Stato** (status `Badge` — active→default/green, suspended→destructive/amber, pending/cancelled→secondary), **Invito** (`owner ? INVITATION_BADGE[owner.invitationStatus].label : '—'`; pending→secondary, accepted→default, expired→destructive), **Creata** (`new Date(createdAt).toLocaleDateString('it-IT')`), **Azioni** (empty in T7 — filled in T8).
- Client-side status filter: a small segmented control / `<select>` — `Tutte | Attive | Sospese` — filtering the rendered rows (`status === 'active' | 'suspended'`). Default `Tutte`.
- States: `isLoading` → "Caricamento…"; `error` → destructive alert "Errore nel caricamento delle officine."; empty list → "Nessuna officina." Guard `isLoading || !data` before reading `data.tenants` (`[[feedback_react_query_data_bang_offline_paused]]`).
- Italian copy inline. No i18n framework here.

**Test cases (Tier 2 — 2-3, no pure-render):**
- Happy path: mock `apiFetch` to resolve 2 tenants (one active+pending owner, one suspended+accepted) → both rows render with the right status + invito labels.
- Filter gating (conditional logic): selecting "Sospese" hides the active row.
- Error state: `apiFetch` rejects → the error alert renders (not a crash).

- [ ] **Step 1:** Scaffold shadcn components; verify/clean `@/`. Commit scaffold separately is optional — fold into Step 5.
- [ ] **Step 2:** Write failing `TenantList.test.tsx` (mock `useApiFetch`/`apiFetch`, mock react-query as the existing admin-web tests do).
- [ ] **Step 3:** Run → fail. `pnpm --filter @garageos/admin-web test -- TenantList`
- [ ] **Step 4:** Implement `tenant-status.ts`, `TenantList.tsx`, route + nav.
- [ ] **Step 5:** Run tests + `pnpm -r typecheck` → PASS.
- [ ] **Step 6: Commit.** `feat(admin-web): tenant list page with status filter`

---

## Task 8: admin-web — Lifecycle actions (suspend/reactivate/regenerate)

**Files:**
- Modify: `packages/admin-web/src/pages/TenantList.tsx` (fill the Azioni column + dialogs + mutations)
- Create: `packages/admin-web/src/lib/tenant-actions.ts` (error-code→Italian message map + small action helpers, mirroring `CreateTenant`'s `API_ERROR_MESSAGES`)
- Modify: `packages/admin-web/src/pages/CreateTenant.tsx` (update the confirmation note: the regenerate path now lives at the tenant list)
- Test: extend `packages/admin-web/src/pages/TenantList.test.tsx`

**Behavioral contract:**
- Three `useMutation`s via `apiFetch`, each `onSuccess` → `queryClient.invalidateQueries({ queryKey: ['admin-tenants'] })` + Sonner success toast; `onError` (ApiError) → Sonner error toast using the code→Italian map.
  - **Sospendi** — rendered when `status === 'active'` → `alert-dialog` confirm ("Sospendere {businessName}? Gli utenti dell'officina non potranno più accedere.") → `POST /v1/admin/tenants/${id}/suspend`.
  - **Riattiva** — when `status === 'suspended'` → confirm → `POST .../reactivate`.
  - **Rigenera link** — when `owner && owner.invitationStatus !== 'accepted' && status === 'active'` → `POST .../regenerate-invitation`; on success open a `Dialog` showing the `magicLinkUrl` in a read-only field + a **Copia** button (`navigator.clipboard.writeText`) + an `emailSent` note ("Email inviata a {ownerEmail}." / "Email non inviata — copia il link e invialo manualmente.").
- Error-code map (exact server strings): `tenant.invalid_status` → "Operazione non consentita per lo stato attuale dell'officina.", `tenant.not_found` → "Officina non trovata.", `user.invitation.not_found` → "Nessun invito da rigenerare.", `user.invitation.already_accepted` → "L'invito è già stato accettato.", plus a generic fallback.
- `CreateTenant.tsx`: change the existing amber note ("il re-invio del link sarà disponibile a breve (Slice 2)") to "Se l'email non arriva, rigenera il link dalla lista Officine." with a link/`navigate('/officine')`.

**Test cases (Tier 2 — extend, conditional-action gating):**
- Action gating: an active+pending row shows **Sospendi** + **Rigenera link** (not Riattiva); a suspended row shows **Riattiva** only; an accepted-owner active row shows **Sospendi** but NOT **Rigenera link**.
- Regenerate success: mock `apiFetch` resolve `{ invitation: { magicLinkUrl, emailSent:true, ... } }` → the link dialog renders with the URL.
- (Optional) suspend confirm → mutation called with the right URL.

- [ ] **Step 1:** Write failing tests for action gating + regenerate dialog.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement actions, dialogs, mutations, `tenant-actions.ts`, `CreateTenant` note.
- [ ] **Step 4:** Run tests + `pnpm -r typecheck` → PASS.
- [ ] **Step 5: Commit.** `feat(admin-web): tenant suspend/reactivate/regenerate actions`

---

## Task 9: Docs — APPENDICE_A (routes) + cross-references

**Files:**
- Modify: `docs/APPENDICE_A_API.md` (document the 4 new routes)
- (`APPENDICE_G` already updated in Task 4; `APPENDICE_F` BR-210 already exists — add an implementation note pointing at the Slice 2 endpoints + the deferred reminder-cancellation portion.)

**Contract:**
- `APPENDICE_A`: add the platform-admin section entries: `GET /v1/admin/tenants`, `POST /v1/admin/tenants/:id/suspend`, `POST /v1/admin/tenants/:id/reactivate`, `POST /v1/admin/tenants/:id/regenerate-invitation` — each with auth (platform-admins pool), request/response shape (copy the wire JSON from Tasks 3/4/5), and error codes. Note the regenerate endpoint is the single token-returning response.
- `APPENDICE_F` BR-210: append "**Implementazione (Slice 2, 2026-06-29):** login-block via `tenant-context.ts` + accept-block in `invitations-public-accept.ts`; suspend/reactivate via `POST /v1/admin/tenants/:id/{suspend,reactivate}`. **Deferred:** cancellazione schedule notifiche + auto-cancel a 90 giorni (nessun tenant gestito dalla console ha reminder oggi)."

- [ ] **Step 1:** Update `APPENDICE_A` with the 4 routes (verbatim wire shapes from the implemented handlers — verify against the actual code, the code wins).
- [ ] **Step 2:** Append the BR-210 implementation note.
- [ ] **Step 3:** `prettier --write` the touched `.md` (lint-staged covers `.md`, but run once to be safe).
- [ ] **Step 4: Commit.** `docs: document slice 2 platform-admin tenant routes`

---

## Review gates (in order)

1. **Per-task review** only on the risky tasks: **T1** (refactor extraction — diff dropped guards), **T2** (security boundary — the login/accept guard), **T5** (returns a plaintext token). T3/T4/T6/T7/T8/T9 ride the final gate.
2. `pnpm -r typecheck` — mandatory local gate (pre-push hook).
3. **Final whole-branch `/code-review high`** — load-bearing; cross-references `schema.prisma`, `APPENDICE_F`/`G`, and cross-task consistency (e.g. error-code strings shared between API and admin-web maps). Never skip.
4. CI full matrix (`gh pr checks --watch`) — the only gate for RLS semantics + real-Postgres behavior (the suspension toggle, rate-limit 429, token regeneration).
5. **Smoke runbook — BLOCKER** (UI + officine-login-facing): in the admin console, list officine; suspend a test tenant and confirm its officine login is blocked (web app 401/locked out); reactivate and confirm login restored; regenerate a pending tenant's link, copy it, and confirm the new magic-link pre-fills accept while the old one 404s; confirm email also arrives. Browser via claude-in-chrome (console already logged in). No review stage replaces it.

## PR description must list

- Deviations applied (BR-210 reused not minted; single new error code `tenant.invalid_status`; **BR-210 reminder-cancellation + 90-day auto-cancel DEFERRED** with rationale).
- Any Minor `/code-review` findings left unapplied (one-pass policy).
- The Tier-2 UI test scope (happy + error + gating; no pure-render).

---

## Self-review (against the spec)

**Spec coverage:** §1 API surface → T3 (list), T4 (suspend/reactivate), T5 (regenerate). §2 DB guard → T2. §3 F6 helper → T1. §4 accept-while-suspended → T2. §5 rate-limit → T6. §6 BR → T2/T4 cite **BR-210** (deviation: existing, not new). §7 frontend → T7/T8. §8 testing/docs → per-task Tier-1 tests + T9 docs + the pre-flight greps run above. All sections mapped.

**Placeholder scan:** no TBD/TODO; every step has concrete code or a named test contract; Italian strings are verbatim; error codes are exact.

**Type consistency:** `TenantAdminListItem`/`invitationStatus` (T3) reused verbatim in T7/T8; `createInternalInvitation` signature (T1) consumed in T1 caller rewrites (T5 deliberately uses in-place UPDATE + raw token-gen, documented). `tenant.invalid_status` string identical across T4 (mint), T5 (reuse), T8 (admin-web map). `['admin-tenants']` query key identical in T7/T8.

**Open items flagged to user:** (a) BR-210 reminder-cancellation deferral — confirm acceptable; (b) likely 2-PR split at the T6 LOC checkpoint; (c) independent prod cleanup of the Slice-1 smoke tenant.

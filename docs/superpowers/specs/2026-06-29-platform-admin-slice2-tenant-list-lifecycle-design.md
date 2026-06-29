# Platform Admin — Slice 2: Tenant List + Lifecycle (design)

**Date:** 2026-06-29
**Status:** Approved for implementation
**Type:** Vertical slice of the multi-PR arc
**Arc spec:** `docs/superpowers/specs/2026-06-27-platform-admin-tenant-provisioning-design.md` (§ "Slice 2 — Tenant list + lifecycle")
**Builds on:** Slice 0 (PR #220/#221) infra+auth, Slice 1 (PR #223) create-tenant+invite.

## Problem

Slice 1 gave the platform-admin console a single capability: create a workshop
(tenant + primary location + super_admin invitation) and email the magic-link.
The console cannot yet **see** the workshops it created, cannot **suspend** a
workshop (e.g. non-payment, off-boarding), and has no recovery path when the
invitation email never arrives or the link expires — the exact failure mode the
operator hit and the reason Slice 1 deferred resend/regenerate (F2).

Slice 2 closes that loop: a tenant list with lifecycle controls
(suspend / reactivate / regenerate invitation), enforcement of the
already-existing-but-inert `TenantStatus` enum, and the cleanup of two debts
that this slice makes ripe (F6 shared invitation helper — regenerate is the 3rd
caller; F4 rate-limit on the tenant-provisioning routes).

## Goal

From the admin console an operator can:

1. See every workshop with its status and onboarding state.
2. Suspend a workshop — which **blocks its officina login** — and reactivate it.
3. Regenerate the owner's magic-link and obtain a copyable link to hand over
   (covering the broken-email case), with the email also re-sent.

Non-developer-usable, operator-driven, no automatic registration. Consistent
with the arc: same Fastify API, `/v1/admin/*` prefix, `platform-admins` pool.

---

## Decisions (locked in brainstorming 2026-06-29)

- **Suspend enforcement = DB guard** in `tenant-context.ts` (not Cognito disable).
- **Regenerate = in-place** on the existing pending invitation (new token, fresh
  expiry), **returns the plaintext link AND sends the email**.
- **Accept-while-suspended = blocked** (403).
- **Tenant list = all tenants + client-side status filter, no pagination.**

---

## 1. API surface

All routes: `preHandler: [requireAuth, requirePlatformAdminsPool]`, **no**
`tenantContext`/`requireOfficinaPool` (platform admins are cross-tenant), DB
access under `withContext({ role: 'admin' })`. Mirrors `admin-tenants-create.ts`.

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/v1/admin/tenants` | List all tenants |
| `POST` | `/v1/admin/tenants/:id/suspend` | `active → suspended` + audit |
| `POST` | `/v1/admin/tenants/:id/reactivate` | `suspended → active` + audit |
| `POST` | `/v1/admin/tenants/:id/regenerate-invitation` | Fresh owner magic-link |

### 1.1 `GET /v1/admin/tenants`

Returns all tenants (the dataset is a handful; no pagination — YAGNI). Each row:

```jsonc
{
  "id": "uuid",
  "businessName": "string",
  "vatNumber": "string",
  "email": "string | null",
  "status": "active | suspended | pending | cancelled",
  "createdAt": "ISO-8601",
  "owner": {
    "email": "string",
    "invitationStatus": "pending | accepted | expired"
  } // or null for legacy tenants without an invitation
}
```

**Owner derivation.** Find the tenant's `internal_user` + `role=super_admin`
Invitation (the one created at tenant creation). If multiple ever exist, take the
most recent by `createdAt`. Then:

- `acceptedAt != null` ⇒ `accepted`
- else `expiresAt < now` ⇒ `expired`
- else ⇒ `pending`

Tenants created before Slice 1 by `rebuild-tenants.mjs` (Officina Matula,
Officina Soriente) have **no** invitation row ⇒ `owner = null`. They are already
onboarded; the UI offers no regenerate for them.

Implementation note: fetch tenants, then fetch their super_admin invitations in
one `findMany` keyed by `tenantId` and stitch in memory (avoid N+1). Serializer
in `lib/dtos/`.

Response: `200 { "tenants": [ ...rows ] }`.

### 1.2 `POST /v1/admin/tenants/:id/suspend`

- `:id` validated as UUID (zod). Unknown id ⇒ `404 admin.tenant.not_found`.
- Load tenant under admin context. If `status != 'active'` ⇒
  `409 admin.tenant.invalid_status` (only active→suspended is legal here).
- `UPDATE tenants SET status='suspended'`.
- Audit row: `action='tenant_suspended'`, `actorType='system'`,
  `metadata={ actorCognitoSub }`, `ipAddress`.
- Response `200 { tenant: { id, status } }`.

No Cognito calls. The DB guard (§2) makes the suspension effective on the next
officine request.

### 1.3 `POST /v1/admin/tenants/:id/reactivate`

Symmetric: requires `status='suspended'` (else `409 admin.tenant.invalid_status`),
sets `status='active'`, audit `action='tenant_reactivated'`. Response
`200 { tenant: { id, status } }`.

### 1.4 `POST /v1/admin/tenants/:id/regenerate-invitation`

Recovery for "email never arrived" / "link expired".

Pre-conditions (all under admin context, in one tx where it mutates):

1. Tenant exists ⇒ else `404 admin.tenant.not_found`.
2. Tenant `status == 'active'` ⇒ else `409 admin.tenant.invalid_status`
   (a suspended tenant must not onboard; accept is blocked anyway, §4).
3. A super_admin `internal_user` invitation exists and is **unaccepted**
   (`acceptedAt == null`) ⇒ else `409 admin.tenant.invitation_not_pending`
   (already accepted, or legacy tenant with no invitation).

Action (in-place, keeps one invitation row per owner):

- `generateInvitationToken()` → `{ plaintext, hash }`.
- `UPDATE invitation SET tokenHash=<new>, expiresAt=now+INVITATION_TTL_MS`
  (acceptedAt stays null). The old `tokenHash` is thereby dead.
- Audit `action='tenant_invitation_regenerated'`.
- **Post-tx, best-effort:** `sendInvitationEmail(...)` (same params as create).
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

This is the **single place** in the system that returns a plaintext token. It is
returned only to an authenticated platform admin, on an explicit action, shown
once. Slice 1's create endpoint stays email-only; regenerate is the escape hatch.

---

## 2. Suspend enforcement — DB guard in `tenant-context.ts`

Today `tenant-context.ts` validates the user per request:

```ts
const userRow = await prisma.user.findFirst({
  where: { cognitoSub, tenantId, status: 'active', deletedAt: null },
});
if (!userRow) throw unauthorizedError('User inactive or not found');
```

Extend the **same query** (one round-trip, no extra query) with a joined tenant
filter:

```ts
where: {
  cognitoSub, tenantId, status: 'active', deletedAt: null,
  tenant: { is: { status: 'active' } },
}
```

Null ⇒ `401`. Effect: a suspended tenant's every officine API call fails within
seconds; the web app is non-functional. Flipping `status` back to `active`
restores access immediately. No Cognito user enumeration, no
disabled-by-suspension vs disabled-individually reconciliation. Existing Cognito
tokens remain technically valid but useless — acceptable, the app needs the API.

The error message stays generic (`User inactive or not found`) — do not leak
"tenant suspended" to the officine client (anti-enumeration, consistent with the
existing message). The platform-admin console is where suspension is visible.

This rule is the security core of the slice and gets an explicit BR (see §6).

---

## 3. F6 — extract `createInternalInvitation`

New `packages/api/src/lib/invitation-creation.ts`:

```ts
interface CreateInternalInvitationInput {
  tenantId: string;
  targetEmail: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  locationId: string | null;
}
async function createInternalInvitation(
  tx: PrismaTransactionClient,
  input: CreateInternalInvitationInput,
): Promise<{ invitationId: string; tokenPlaintext: string; expiresAt: Date }>
```

Owns the duplicated core: `generateInvitationToken()`,
`expiresAt = new Date(Date.now() + INVITATION_TTL_MS)`, the
`tx.invitation.create({ data: { invitationType: 'internal_user', ... } })`, and
the P2002 → `user.invitation.duplicate_pending` mapping.

**Email send stays in the callers.** `invitedByName` differs by caller (admin
JWT name vs DB user lookup) and the send is post-tx best-effort with
caller-specific `emailSent` handling. The helper returns `tokenPlaintext` so each
caller builds `${WEB_BASE_URL}/invitations/${token}` and calls
`sendInvitationEmail`.

Refactor is **behavior-preserving** for the two existing callers
(`admin-tenants-create.ts`, `users-invitations-create.ts`): their integration
tests must stay green unchanged. The new regenerate endpoint reuses the token
generation but updates in place (it is not a create), so it shares
`generateInvitationToken` + the TTL constant; if a clean seam emerges, a small
`regenerateInvitationToken(tx, invitationId)` helper may live alongside — decided
at implementation, not mandated here.

Watch `[[feedback_preserve_inline_guards_on_extract]]`: diff the `-` lines to
confirm no validation/guard is dropped in the extraction.

---

## 4. Accept-while-suspended guard

`POST /v1/invitations/:token/accept` (`invitations-public-accept.ts`) currently
resolves the invitation and runs the 4-phase Cognito+DB acceptance. Add: after
resolving the invitation, load its tenant and require `status == 'active'`; if
suspended ⇒ refuse `403` (reuse/define an error code in the `user.invitation.*`
family — grep `APPENDICE_G`). A reactivated, non-expired link works again.

This keeps semantics consistent: a suspended tenant can neither serve existing
users (§2) nor gain new ones.

---

## 5. F4 — rate-limit the tenant-provisioning routes

`@fastify/rate-limit` is registered `global:false`; routes opt-in via
`config.rateLimit`. Add a **loose** limit to the two *mutating provisioning*
routes — `POST /v1/admin/tenants` (Slice 1, currently none) and
`POST /v1/admin/tenants/:id/regenerate-invitation`:

```ts
config: {
  rateLimit: {
    max: 30,
    timeWindow: '1 hour',
    keyGenerator: (req) => `admin-tenant:${req.userId ?? req.ip}`,
  },
}
```

Generous enough never to impede 2 trusted operators, but caps a runaway
loop / leaked-token abuse. `suspend`/`reactivate`/`GET` are left unlimited
(idempotent / read). Integration tests use a unique key/IP per `describe` block
(`[[feedback_integration_test_rate_limit_isolation]]`).

---

## 6. Business rules

Grep `APPENDICE_F` for a free `BR-XXX` (avoid collision —
`[[feedback_br_number_collision_in_doc]]`). Code at least:

- **BR-SUSPEND (new):** a tenant with `status != 'active'` cannot authenticate
  any officine request (enforced in `tenant-context.ts`). Negative test required.
- The status-transition legality (active→suspended, suspended→active only) and
  accept-while-suspended may be folded into the same BR or a sibling — decided in
  the plan when the number is assigned. Cite the BR in code comments + tests.

---

## 7. Frontend (admin-web)

Stack already in place: React Router v6, react-query v5, react-hook-form + zod,
shadcn/ui, Sonner, `useApiFetch` (RFC 7807 `ApiError`), Italian copy.

### 7.1 New shadcn components

`table`, `badge`, `alert-dialog`, `dialog` via the shadcn CLI. Verify no literal
`@/` directory is created (`[[feedback_shadcn_cli_literal_alias_path]]`) and
fix/clean if so.

### 7.2 `pages/TenantList.tsx` at route `/officine`

- `useQuery(['admin-tenants'], () => apiFetch('/v1/admin/tenants'))`.
- Table columns: Officina (businessName), P.IVA, Email titolare (`owner.email`),
  Stato (status `Badge`: active=green, suspended=amber/red), Invito
  (`owner.invitationStatus` badge: pending/accepted/expired, or "—" when null),
  Creata (date), Azioni.
- Client-side status filter: Tutte / Attive / Sospese (simple segmented control
  or select; no server param).
- Loading / error / empty states (no pure-render tests — Tier 2).

### 7.3 Lifecycle actions

`useMutation` per action, each wrapped in an `alert-dialog` confirm:

- **Sospendi** — shown when `status==='active'` → `POST .../suspend`.
- **Riattiva** — shown when `status==='suspended'` → `POST .../reactivate`.
- **Rigenera link** — shown when `owner.invitationStatus ∈ {pending, expired}`
  and `status==='active'` → `POST .../regenerate-invitation`; on success open a
  `dialog` showing `magicLinkUrl` with a **Copia** button (+ `emailSent` note).

All mutations `invalidateQueries(['admin-tenants'])` on success; Sonner toast on
success/error; `ApiError` code→Italian message map mirroring `CreateTenant`.

### 7.4 Navigation

- Add an **Officine** entry in `PlatformConsole` header next to "Crea officina"
  (`navigate('/officine')`).
- Update `CreateTenant`'s confirmation note (currently "il re-invio del link sarà
  disponibile a breve (Slice 2)") to point the operator at the tenant list for
  regenerate.

---

## 8. Security & testing

### Tier 1 — mandatory, test-first (API/middleware/validators)

- **DB guard (security core):** suspended-tenant officine JWT → `401` on a normal
  tenant route; after reactivate → `200`. (Integration, CI-only Docker.)
- **Auth-plugin isolation still holds:** officine/clienti JWT on the new
  `/v1/admin/*` routes → `403`; platform-admins JWT → `200`.
- **Accept-while-suspended:** `403`; accept after reactivate (non-expired) →
  succeeds.
- **Status transitions:** suspend a non-active / reactivate a non-suspended →
  `409 admin.tenant.invalid_status`; unknown id → `404 admin.tenant.not_found`.
- **Regenerate:** refused when accepted / absent / suspended; on success old
  `tokenHash` no longer resolves and the new one does; `magicLinkUrl` returned;
  audit row written.
- **Audit:** `tenant_suspended` / `tenant_reactivated` /
  `tenant_invitation_regenerated` rows written (`actorType:'system'`, actor
  Cognito sub in metadata — matching Slice 1).
- **F6 refactor:** existing `admin-tenants-create` + `users-invitations-create`
  integration tests stay green unchanged (behavior-preserving).
- **Rate-limit:** create + regenerate enforce the 30/h key; isolation per
  `describe`.
- **API contract:** status codes + RFC 7807 envelope + error codes for every new
  route.

### Tier 2 — minimal (UI)

`TenantList` 2–3 tests: happy path (rows render from query), error state, and the
conditional-action gating (which action shows for which status / invitationStatus
+ the filter). No pure-render assertions.

### Pre-flight (in the plan, per `PLAN_TEMPLATE.md`)

- Grep `APPENDICE_G` for existing `admin.*` / `tenant.*` / `user.invitation.*`
  codes before minting `admin.tenant.not_found`, `admin.tenant.invalid_status`,
  `admin.tenant.invitation_not_pending`, accept-while-suspended
  (`[[feedback_preflight_must_grep_appendice_g_codes]]`).
- Grep `APPENDICE_F` for a free BR number (§6).
- Grep `schema.prisma` to confirm every Prisma op against the real model
  (`[[feedback_verify_plan_against_schema]]`): `Tenant.status`,
  `Invitation.acceptedAt/expiresAt/tokenHash`, the `tenant` relation on `User`
  for the joined guard.
- Confirm RLS admin context already permits the `tenants`/`invitations`
  UPDATE (Slice 1 established it does — same `withContext({role:'admin'})`).

### Docs to update

- `APPENDICE_A_API.md`: the 4 new routes.
- `APPENDICE_G_ERROR_CODES.md`: new `admin.tenant.*` codes.
- `APPENDICE_F_BUSINESS_LOGIC.md`: the new suspend BR.

---

## 9. Process & sizing

Large cross-layer slice (~8 tasks: F6 refactor, DB guard + accept guard, list
endpoint, suspend/reactivate, regenerate, rate-limit, TenantList page, lifecycle
UI). Therefore: **subagent-driven** implementation, per-task review only on the
riskiest tasks (DB guard, regenerate, F6 extraction), final **`/code-review
high`** on the whole branch, smoke **browser BLOCKER** (it is UI/login-facing and
touches the officine login path).

**PR size:** watch the 1500-LOC hard limit. If exceeded, split
**PR-A (backend §1–6)** then **PR-B (frontend §7)** — backend is independently
shippable (the list endpoint + lifecycle work via curl; the DB guard is the
risky bit and benefits from landing first). Decision taken at plan time, not
pre-committed.

## 10. Out of scope (roadmap Slice 3–4)

Edit tenant profile, per-tenant user management, the cross-tenant DB-role
decision, usage metrics, platform audit views, `cancelled`/`pending` status
transitions, list pagination/search, Cognito-level session kill on suspend.

## Open questions

None blocking. Exact error-code names and the BR number are resolved by the
plan's pre-flight greps, not design choices.

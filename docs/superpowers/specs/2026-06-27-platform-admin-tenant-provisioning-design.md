# Platform Admin — Tenant Provisioning Console (design)

**Date:** 2026-06-27
**Status:** Approved for Slice 0 + Slice 1
**Type:** Multi-PR arc (5 vertical slices)

## Problem

Workshops (tenants / officine) must NOT self-register. Self-service tenant
signup was deliberately disabled: `POST /auth/signup` with
`type=tenant_admin` returns `422 auth.signup.tenant_signup_not_supported`
(see `docs/APPENDICE_A_API.md` §auth, note 2026-05-04).

Today tenants are created by a hardcoded one-shot script
(`scripts/rebuild-tenants.mjs`): tenant + primary location via superuser SQL,
officine users via Cognito `AdminCreateUser`. This does not scale and is not
usable by a non-developer.

**Goal:** a separate, operator-driven **platform admin console** where internal
staff (Michele + ≥1 colleague) create a tenant and hand over login credentials.
The workshop calls us → we create the tenant in the console → we give them the
access → from that moment they can use the web app. No automatic registration.

## Scope decomposition (the full arc)

The end goal ("complete console") is a multi-PR arc. It is decomposed into
vertical slices, each with its own spec → plan → PR:

- **Slice 0 — Infra & Auth (this spec):** third Cognito pool
  `garageos-platform-admins`, new `packages/admin-web` app on a dedicated
  subdomain, API auth-plugin guarding `/v1/admin/*`. No functional features —
  just "I can log into the admin app and nothing else."
- **Slice 1 — Create tenant + invite (this spec):** creation form (tenant +
  primary location + super_admin `Invitation`), protected API endpoint, returns
  the magic-link to hand over. Replaces `rebuild-tenants.mjs`.
- **Slice 2 — Tenant list + lifecycle (roadmap):** list workshops with status,
  suspend/reactivate (blocks officina login), regenerate invitation link.
- **Slice 3 — Profile & users per tenant (roadmap):** edit tenant data,
  view/manage each tenant's users. **Decides the controlled cross-tenant access
  model** (dedicated DB role bypassing RLS vs. explicit queries) — the
  security-sensitive part.
- **Slice 4 — Metrics & audit (roadmap):** per-tenant usage + platform-level
  audit ("who created/suspended which tenant").

**This document specs Slice 0 + Slice 1 in depth.** Slices 2-4 are listed as
roadmap only.

---

## Slice 0 — Infra & Auth

### Cognito

New user pool **`garageos-platform-admins`** + app client, as a dedicated CDK
construct mirroring the two existing pools. Constraints:

- No self-signup, no Google IdP.
- Attributes: `email`, `given_name`, `family_name`. **No `custom:tenant_id`** —
  platform admins do not belong to a tenant. This is the whole point of a
  separate pool: an identity that is neither officina nor cliente.
- Password policy at least as strict as the officine pool.

### Platform admin bootstrap

Chicken-and-egg: there is no UI to create the first admins. Solved with a
one-shot operator CLI:

```
pnpm tsx scripts/admin/create-platform-admin.ts <email> <firstName> <lastName>
```

Same pattern as `rebuild-tenants.mjs`. Uses Cognito `AdminCreateUser` with a
**temporary password** (printed once) that the admin must change on first login
(`FORCE_CHANGE_PASSWORD`). Run twice to seed the two admins. Rare operation, no
UI required. (Decision: temporary password, not magic-link — faster for 2
internal people.)

### Admin web app

New package **`packages/admin-web`** — Vite + React + Tailwind + shadcn/ui,
identical stack to `packages/web`. Served on **`admin.garageos.aifollyadvisor.com`**
(officine app is on `app.…`) via CloudFront + S3, reusing the web app infra
pattern.

In Slice 0 the app does **only**: Cognito login against the new pool +
first-login forced password change + one empty "Console piattaforma" landing
page. Purpose: close the auth chain end-to-end before any feature lands.

### Backend auth-plugin

In the **same** Fastify API (decision: reuse, do not duplicate the API):

- A new auth-plugin verifies JWTs issued by the `garageos-platform-admins` pool
  (aws-jwt-verify, same pattern as the existing officine/clienti verifiers).
- It guards a route-prefix **`/v1/admin/*`**, accessible **only** to that pool.
- Slice 0 ships one route: `GET /v1/admin/me` returning the admin identity
  (sub, email, name) — validates the plugin end-to-end.

New env vars: `COGNITO_PLATFORM_ADMINS_POOL_ID`, `COGNITO_PLATFORM_ADMINS_CLIENT_ID`.
Per `[[feedback_lambda_reuses_api_env_schema_needs_all_vars]]`: any Lambda
reusing the API `parseEnv` schema must receive these too — wire them in every
CDK function that bundles the API.

---

## Slice 1 — Create tenant + invite

### Reuse: invitation acceptance is already generic

`POST /v1/invitations/:token/accept` (F-OFF-004, `invitations-public-accept.ts`)
is already generic over `role` and `locationId`. Its 4-phase flow
(read → Cognito AdminCreateUser → AdminSetUserPassword → DB User insert + consume
invitation + audit, with rollback at each Cognito phase) creates the officine
user. For the first `super_admin` we reuse it **verbatim** with
`role: super_admin`. No new acceptance code.

The admin console only needs to *create* the tenant + location + invitation and
show the link.

### Endpoint

`POST /v1/admin/tenants` — platform-admin only.

Body (minimum set the operator realistically has on a phone call):

| Field | Notes |
|---|---|
| `businessName` | required |
| `vatNumber` | required, `@unique` |
| `email` | tenant contact email, required |
| `ownerFirstName` | first super_admin |
| `ownerLastName` | first super_admin |
| `ownerEmail` | first super_admin login email |

### Behavior (one transaction, privileged/cross-tenant context)

1. Create `Tenant` (`status=active`, `billing_status=manual`, `plan=starter`).
2. Create primary `Location` `"Sede principale"` with **placeholder** address
   (NOT NULL columns; the workshop completes real data in the onboarding wizard
   F-OFF-003 — same compromise already used by `rebuild-tenants.mjs`).
3. Create `Invitation`: `invitationType=internal_user`, `role=super_admin`,
   `locationId=<primary>`, `targetEmail=ownerEmail`, `firstName`/`lastName`,
   `tokenHash` (SHA-256 of plaintext), `expiresAt`.
4. Audit log `tenant_created`.
5. Return the magic-link `/invitations/:token` (plaintext token, shown once).

### Errors

- Duplicate VAT → catch P2002 → `409 admin.tenant.vat_already_exists`.
- Per `[[feedback_preflight_must_grep_appendice_g_codes]]`: grep
  `APPENDICE_G` for an existing `admin.*` / `tenant.*` error family before
  minting new codes.

### Frontend (admin-web)

"Crea officina" form → confirmation page showing the magic-link with a
"Copia" button. (Tenant list is Slice 2.)

---

## Security & testing (Tier 1, mandatory)

- **Auth-plugin isolation (negative tests):** an `officine` or `clienti` JWT on
  `/v1/admin/*` → `403`; a `platform-admins` JWT on the normal tenant routes →
  `403`.
- **Cross-tenant write:** tenant creation needs a privileged context. The
  `garageos_app` runtime role is `NOBYPASSRLS`
  (`[[feedback_least_privilege_db_role]]`). The plan **must pre-flight grep the
  RLS policies** for `tenants` / `locations` / `invitations`: either an
  admin-permissive INSERT policy exists, or one is defined. Do NOT weaken
  existing tenant-scoped policies (`[[feedback_dont_loosen_schema_for_tests]]`).
- **Audit:** every tenant creation writes an audit row.
- **API contract:** status codes, RFC 7807 envelope, error codes.

## Infra notes

- New CDK construct for the Cognito pool (watch `resourceCountIs` assertions in
  infra tests — `[[feedback_infra_schedule_count_assertion_cascade]]`; pre-flight
  grep for each new resource type).
- New CloudFront distribution + S3 bucket + Route 53 record for
  `admin.garageos.aifollyadvisor.com`.
- WAF stays deferred per `[[project_waf_cloudfront_deferred]]` unless a trigger
  fires.

## Out of scope (roadmap Slice 2-4)

Tenant list, suspend/reactivate, regenerate link, edit profile, per-tenant user
management, usage metrics, platform audit views.

## Open questions

None blocking Slice 0 + 1. The cross-tenant RLS policy decision is scoped to the
Slice 1 plan's pre-flight (above), not an open design question.

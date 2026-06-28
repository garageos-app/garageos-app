# Platform Admin — Slice 1: Create tenant + email invite (design)

**Date:** 2026-06-28
**Status:** Approved (design) — ready for implementation plan
**Arc:** Platform Admin Console (Slice 1 of 5). Parent spec:
`docs/superpowers/specs/2026-06-27-platform-admin-tenant-provisioning-design.md`
**Slice type:** vertical slice, cross-layer (api + admin-web + docs), ~7 tasks →
formal spec + plan + subagent-driven + `/code-review high`. UI-facing → **browser
smoke is a BLOCKER** before merge.

## Goal

Replace the manual `scripts/rebuild-tenants.mjs` flow with a console action: a
**platform admin** fills a "Crea officina" form; the API creates the tenant, its
primary location, and a `super_admin` `Invitation`, then **emails** the onboarding
magic-link to the workshop owner via Resend. The owner accepts on the officine web
app (`app.…`) using the existing public acceptance endpoint — no new acceptance
code.

This builds directly on Slice 0 (merged, in prod): the `garageos-platform-admins`
Cognito pool, the `admin-web` app on `admin.garageos.aifollyadvisor.com`, and the
`/v1/admin/*` auth-plugin (`requirePlatformAdminsPool`, `GET /v1/admin/me`).

## Decisions locked in this brainstorming (deltas vs. the arc spec)

1. **Delivery is email-only via Resend, NO link shown in the console.** Resend is
   production-active (provider `resend`, domain `garageos.aifollyadvisor.com`
   verified on Resend EU, e2e-smoke PASS 2026-06-12 incl. the "user invitation"
   path). The confirmation page reports "invito inviato a `<ownerEmail>`" and does
   **not** display the plaintext token. (The arc spec's "show link with Copia
   button" is superseded by this decision.)
2. **Resend / regenerate of the link is DEFERRED to Slice 2** (together with the
   tenant list). Slice 1 has no resend path. Accepted risk: if the creation email
   fails to arrive, there is no recovery until Slice 2 ships. Mitigated by Resend
   being tested/working; the create email send is best-effort and its outcome is
   reported in the response (`emailSent` flag) so the operator knows.
3. **Owner-email collision is pre-checked and blocks creation** with a clear error
   (no "zombie" tenants whose invite can never be accepted).
4. **Zero database migration.** Confirmed below.

## Why zero migration

- **RLS allows the cross-tenant writes under `withContext({ role: 'admin' })`:**
  - `tenants_write` — `FOR ALL … WITH CHECK (is_admin_role() OR id = current_tenant_id())`
  - `locations_write` — `FOR ALL … WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id())`
  - `invitations_tenant_isolation` — `FOR ALL`, `USING (is_admin_role() OR tenant_id = current_tenant_id())`; with no `WITH CHECK`, Postgres uses the `USING` expression as the INSERT check, so `is_admin_role()` permits the insert. (Proven in prod: `users-invitations-create.ts` already inserts invitations under admin context.)
  - The `garageos_app` role (NOBYPASSRLS) holds `GRANT INSERT` on all three tables.
- **`audit_logs.action` is a free-form `string` column** (not an enum) → the new
  `tenant_created` action inserts with no schema change.
- **Error codes already registered** in `APPENDICE_G` → no new codes:
  - `tenant.vat_number_duplicate` (409)
  - `tenant.vat_number_invalid` (400)
  - `user.invitation.email_in_other_tenant` (409)
  - `auth.cognito_unavailable` (502)
- **Validator already exists:** `packages/database/src/validators/common.ts`
  `VatNumberSchema` (`/^[0-9]{11}$/`). Reuse it (format-only, 11 digits — consistent
  with the rest of the codebase; no checksum is added).

## API — `POST /v1/admin/tenants`

**Auth chain:** `requireAuth → requirePlatformAdminsPool`. No tenant context (platform
admins are cross-tenant; pool has no `custom:tenant_id`).

**Request body** (the minimum an operator has on a phone call):

| Field | Validation |
|---|---|
| `businessName` | required, trimmed, 1–200 |
| `vatNumber` | required, `VatNumberSchema` (11 digits), `@unique` |
| `email` | tenant contact email, required, ≤255, lowercased/trimmed |
| `ownerFirstName` | required, 1–100 |
| `ownerLastName` | required, 1–100 |
| `ownerEmail` | required, email, ≤255, lowercased/trimmed (first super_admin login) |

**Behavior:**

1. **Pre-check (outside tx)** — owner-email collision. Mirror
   `users-invitations-create.ts`: `getOfficineUserByEmail({ poolId: env.COGNITO_OFFICINE_POOL_ID, email: ownerEmail })`.
   - Cognito unavailable → `auth.cognito_unavailable` (502).
   - `exists === true` → `user.invitation.email_in_other_tenant` (409). Network call
     stays out of the Postgres tx (P2028 risk).
2. **Transaction** — `app.withContext({ role: 'admin' }, async (tx) => …)`:
   1. Create `Tenant` — rely on schema defaults (`status=active`,
      `billingStatus=manual`, `plan=starter`); set `businessName`, `vatNumber`,
      `email`. Duplicate VAT → P2002 caught → `tenant.vat_number_duplicate` (409).
   2. Create primary `Location` — `name="Sede principale"`, `isPrimary=true`,
      placeholder NOT-NULL address fields that satisfy CHECK constraints (province
      2 letters, postal code format — exact placeholders fixed in the plan, mirroring
      `rebuild-tenants.mjs`). The workshop completes real data in onboarding wizard
      F-OFF-003.
   3. Create `Invitation` — `invitationType=internal_user`, `role=super_admin`,
      `locationId=<primary>`, `targetEmail=ownerEmail`, `firstName/lastName`,
      `tokenHash` (SHA-256 of plaintext via `generateInvitationToken()`),
      `expiresAt = now + 7d` (`INVITATION_TTL_MS`). New tenant → no pre-existing
      pending invitation, but keep the BR-206 P2002 catch defensively.
   4. Audit row `tenant_created` (free-form action string; include created tenantId
      + admin sub in metadata).
   5. Return the created tenant + the plaintext token **to the handler scope only**
      (for the email send) — never in the HTTP response.
3. **Email (best-effort, outside tx)** — `sendInvitationEmail({ toAddress: ownerEmail,
   invitedFirstName: ownerFirstName, invitedByName: <platform admin name from JWT>,
   tenantName: businessName, role: 'super_admin', magicLinkUrl: `${WEB_BASE_URL}/invitations/${token}` })`.
   Failures are logged, do not roll back the tenant; the response carries `emailSent: false`.
4. **Response `201`:**
   ```json
   { "tenant": { "id": "...", "businessName": "...", "vatNumber": "...", "status": "active" },
     "invitation": { "ownerEmail": "...", "expiresAt": "...", "emailSent": true } }
   ```

**Out-of-tx ordering note:** the Cognito pre-check runs before the tx; the email send
runs after the tx commits. Only the three DB inserts + audit are inside the
transaction.

## Frontend — `admin-web`

- **"Crea officina"** page: shadcn form (`businessName`, `vatNumber`, `email`,
  `ownerFirstName`, `ownerLastName`, `ownerEmail`), client-side required/format
  validation mirroring the API, submit via the existing `api-client` (bearer token).
- **Confirmation** state on success: "Officina **{businessName}** creata. Invito
  inviato a **{ownerEmail}**. Il link di accesso scade tra 7 giorni." If
  `emailSent === false`, add a warning line ("Email non inviata — riprovare dallo
  Slice 2 / contattare il supporto") so the operator is not misled.
- Wire a nav entry from the existing "Console piattaforma" landing.
- **Tier-2 tests (2–3):** happy-path submit → confirmation; one error state (e.g. VAT
  duplicate → inline error); the `emailSent === false` warning branch. No
  pure-rendering tests.

## Security & testing (Tier 1, mandatory)

- **Auth-plugin isolation (negative):** officine or clienti JWT on
  `POST /v1/admin/tenants` → 403; platform-admins JWT on a tenant route → 403.
  (Extends the Slice 0 isolation tests.)
- **Cross-tenant write (integration, CI-only Docker):** under
  `withContext({ role: 'admin' })` the endpoint inserts tenant + primary location +
  invitation; assert all three rows + the audit row exist; assert NO RLS policy was
  weakened (the tenant-scoped negatives from earlier slices still hold).
- **Contract:** 201 envelope shape; `tenant.vat_number_invalid` (400) on bad VAT;
  `tenant.vat_number_duplicate` (409) on duplicate; `user.invitation.email_in_other_tenant`
  (409) on owner-email collision; RFC 7807 envelope on all errors.
- **Audit:** one `tenant_created` row per creation.
- **Email** is mocked in tests (assert called with the right args; assert a send
  failure still returns 201 with `emailSent: false`).

## Plan pre-flight checklist (resolve before/while writing the plan)

- [ ] Grep `schema.prisma` for exact `Tenant` / `Location` field names + NOT-NULL +
      CHECK constraints; choose placeholder Location values that pass them.
- [ ] Confirm `getOfficineUserByEmail` import path + `CognitoUnavailableError`.
- [ ] Confirm `sendInvitationEmail` signature + that `role: 'super_admin'` renders
      "Amministratore" in `invite-user-template`.
- [ ] Confirm `WEB_BASE_URL` env default points to the officine app (`app.…`).
- [ ] Grep `APPENDICE_G` to re-confirm the four reused codes (no new codes).
- [ ] Verify `resourceCountIs` infra assertions are untouched (no infra change in
      this slice — sanity check only).
- [ ] **Doc fixes (own task):** add `RESEND_API_KEY` to the documented secret field
      list (`infrastructure/README.md` F7 — currently 9 fields, missing it); update
      `APPENDICE_A` invitation note from "via SES" → "via Resend"; add the new
      `POST /v1/admin/tenants` to `APPENDICE_A`; update `APPENDICE_C` (operator no
      longer needs `rebuild-tenants.mjs` for new tenants).

## Out of scope (roadmap Slice 2+)

Resend/regenerate the invite link, tenant list, lifecycle (suspend/reactivate),
editing the real address, per-tenant user management, usage metrics, platform audit
views.

## Open questions

None blocking. All design decisions are resolved above.

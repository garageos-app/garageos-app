# PR2 Bundle — Invitation Token Hashing + Cognito AdminDisableUser

**Status**: Approved 2026-05-20
**Brainstorm session**: 2026-05-20 (resume of F-OFF-004 follow-ups)
**Author**: Michele + assistant
**Feature**: F-OFF-004 follow-ups bundle PR2 (Item 4 + Item 5)
**Master spec ref**: `docs/superpowers/specs/2026-05-19-f-off-004-multi-user-design.md` §Risk row "Token plaintext stored in invitations.token" + `feedback_disabled_user_login_loop_ux` memory
**Companion plan** (next): `docs/superpowers/plans/2026-05-20-pr2-token-hash-admin-disable.md`
**Predecessor PR**: #115 (F-OFF-004 follow-ups PR1: reactive auth + FOR UPDATE race + BR-206 wording)

> **Note — audit action rename during implementation**: occurrences of `invitation_token_rotated_by_operator` in this document refer to the audit action that shipped as `user_invitation_token_rotated`. The rename happened at implementation time for naming consistency with the existing `user_invitation_created` + `user_invitation_accepted` audit action family. All references below have been retroactively aligned to the shipped name.

---

## 1. Scope

### In-scope (PR2)

- **Item 4 — Invitation token hashing**:
  - Replace plaintext `invitations.token` column with `invitations.token_hash` (SHA-256 hex, 64 chars), mirroring the existing `email_verifications.token_hash` design.
  - Tombstone all in-flight `invitation_type='internal_user'` pending invitations as part of the migration (set `accepted_at = NOW()`), emit one `user_invitation_expired_by_migration` audit row each.
  - Adapt invitation-create + invitations-public-read + invitations-public-accept routes to hash at-rest and lookup-by-hash.
  - Adapt operator CLI `scripts/admin/get-invitation-link.ts` to rotate-on-extract: generate a fresh token, update `token_hash`, emit an audit row, print the new URL.

- **Item 5 — Cognito AdminDisableUser on inactivation**:
  - Add `disableOfficineUser` helper to `packages/api/src/lib/cognito.ts`, idempotent (swallow `UserNotFoundException`), wrap other errors in `CognitoUnavailableError`.
  - Wire into `users-admin-delete.ts` and `users-admin-update.ts` (status: active → inactive transition), best-effort try/catch, in addition to existing `signOutOfficineUser` calls.
  - Add `cognito-idp:AdminDisableUser` to the Lambda IAM grant in CDK.

### Out-of-scope (deferred)

- **Reactivation flow**: needs `enableOfficineUser` (AdminEnableUserCommand) symmetric to Item 5. Blocked on 3 open product questions in `project_user_reactivation_open_questions`: same-tenant resurrection mechanism, cross-tenant cohabitation policy, Cognito attributes per-tenant.
- **Frontend copy for login-after-disable**: Cognito's native `NotAuthorizedException` reuses the existing "Email o password non corretti" surface. No frontend change needed for PR2.
- **Admin "resend invitation" endpoint**: a future hardening could add `POST /v1/users/invitations/:id/resend` that rotates the token via authenticated API and re-sends the email. Operator CLI handles the SES sandbox workflow for v1; admin endpoint is deferred to post-pilot.
- **F-OFF-501 vehicle transfer, F-CLI-101 mobile add-vehicle, F-CLI-003 onboarding**: separate slices.

---

## 2. Architecture

### 2.1 Why hash invitation tokens

Pre-PR2 state: `invitations.token` stores plaintext (varchar(100)). The DB read implies full enumeration capability — a leaked DB dump exposes all in-flight invitation magic-links. The mirrored `email_verifications` table already stores only `token_hash`; PR2 brings invitations in line.

Security property post-PR2:
- DB compromise no longer exposes valid magic-link URLs.
- Operator CLI is the only path to extract a valid URL, which inherently rotates on each invocation and emits an audit row.
- In-flight tokens at migration time are tombstoned (acceptedAt set); their plaintexts (potentially still in inboxes/email logs) become inert.

### 2.2 Why expire-all-pending (not backfill-hash)

The migration could backfill `token_hash = sha256(token)` for existing pending rows, preserving in-flight magic-link URLs. We reject this in favor of tombstoning because:

1. Production is fresh F-OFF-004 (PR1 landed 2026-05-20); expected pending count is 0–small.
2. Backfill keeps the pre-existing plaintexts referenced in transit (email caches, operator logs) functionally valid until each invitation's `expires_at`. Tombstoning closes that window at migration time.
3. Backfill requires `pgcrypto` extension; tombstone needs no extra DB dependency.
4. Operator overhead of re-inviting 0–N users is bounded and one-time.

### 2.3 Why disable AND sign-out

`signOutOfficineUser` (already shipped in PR1) calls `AdminUserGlobalSignOutCommand`: invalidates all refresh tokens for the user, but the Cognito user remains enabled. A subsequent `AdminInitiateAuth` with correct credentials succeeds — Cognito issues a fresh JWT. The reactive lookup in `tenant-context` middleware (PR1) then rejects the request with a generic 401 (no info-leak), but the UX result is the loop documented in `feedback_disabled_user_login_loop_ux`:

```
disabled user → old token → 401 "Sessione Scaduta"
              → click Login → Cognito.AdminInitiateAuth succeeds
              → backend 401 (reactive) → "Sessione Scaduta" loop
```

`AdminDisableUserCommand` (Item 5) blocks `AdminInitiateAuth` at Cognito level: it returns `NotAuthorizedException: User is disabled`. Frontend handles this identically to a wrong password (existing surface), surfacing "Email o password non corretti". Anti-enum preserved at the auth layer; loop broken.

Order at the call site: `signOutOfficineUser` first (close active-token window), then `disableOfficineUser` (close re-login window). Both best-effort independent; neither failure cascades, and DB soft-delete remains the source of truth.

### 2.4 Why rotate-on-extract for operator CLI

Post-hash, the DB no longer stores plaintext, so the existing `get-invitation-link.ts` script (which read `invitation.token` and built the URL) can no longer function. Options considered:

- **A. Rotate-on-extract** (chosen): script generates new `{plaintext, hash}`, UPDATEs `token_hash`, emits `user_invitation_token_rotated` audit row, prints the new URL. Each invocation invalidates any prior URL for that invitation.
- B. Authenticated admin endpoint `POST /v1/users/invitations/:id/resend`: cleaner audit trail (actor = real super_admin) and reuses route logic, but adds endpoint surface + needs UI hook or curl-with-JWT operator workflow. Defer to post-pilot.
- C. Surface plaintext at create-time in response body to the super_admin: single-shot exposure to authenticated caller; risk of accidentally logging the URL in server-side error monitoring. Rejected.

Trade-off accepted: rotate-on-extract is idempotent in the sense that any operator run produces a fresh, working URL — exactly the workflow Michele uses during SES sandbox limbo (the operator delivers each URL out-of-band exactly once).

---

## 3. Files

### 3.1 New files

| Path | Responsibility | Est. LOC |
|------|----------------|----------|
| `packages/database/prisma/migrations/20260520_invitations_token_hash/migration.sql` | Migration 0016: tombstone pending + drop `token` + add `token_hash` unique | ~30 |
| `packages/api/src/lib/secure-tokens.ts` | Shared SHA-256 hash + token generation helpers (extracted from `email-verification.ts`) | ~30 |
| `packages/api/tests/unit/lib/secure-tokens.test.ts` | Unit tests for `hashToken` determinism + `generateInvitationToken` parity | ~40 |
| `packages/api/tests/unit/lib/cognito-disable.test.ts` | Unit test for `disableOfficineUser` swallow UserNotFoundException + error wrapping | ~80 |

### 3.2 Edited files

| Path | Change | LOC delta |
|------|--------|-----------|
| `packages/database/prisma/schema.prisma` | `Invitation.token` → `Invitation.tokenHash` (`token_hash` column, varchar(64), nullable @unique — partial unique enforced at DB) | +1 / -1 |
| `packages/api/src/lib/email-verification.ts` | Re-export `hashToken` + `generateVerificationToken` from `secure-tokens.ts` (back-compat shim — no call-site changes outside this PR) | +5 / -10 |
| `packages/api/src/lib/cognito.ts` | Add `disableOfficineUser` helper + import `AdminDisableUserCommand` | +30 |
| `packages/api/src/routes/v1/users-invitations-create.ts` | Replace `randomUUID + randomUUID` token gen with `generateInvitationToken`; store `tokenHash`; URL uses plaintext from helper; response strips plaintext + tokenHash | +6 / -6 |
| `packages/api/src/routes/v1/invitations-public-read.ts` | Lookup `where: { tokenHash: hashToken(parsed.data.token) }` | +2 / -1 |
| `packages/api/src/routes/v1/invitations-public-accept.ts` | Lookup `where: { tokenHash: hashToken(parsedParams.data.token) }` | +2 / -1 |
| `packages/api/src/routes/v1/users-admin-delete.ts` | Add `disableOfficineUser` sibling best-effort call after `signOutOfficineUser` | +15 |
| `packages/api/src/routes/v1/users-admin-update.ts` | Same — only on `result.statusBecameInactive` branch | +15 |
| `scripts/admin/get-invitation-link.ts` | Switch from reading `token` to rotate-on-extract: generate new token, UPDATE `token_hash`, emit audit row, print new URL | +35 / -5 |
| `packages/api/tests/integration/users-invitations.test.ts` | Add assertions that DB row has only `token_hash` (no plaintext column); accept-by-plaintext URL still works via hash lookup | +40 |
| `packages/api/tests/integration/users-admin-mutations.test.ts` | Add assertions that `AdminDisableUserCommand` fires on PATCH active→inactive AND on DELETE | +50 |
| `packages/database/tests/integration/migrations.test.ts` (or equivalent) | Verify migration tombstones pending + emits audit rows | +50 |
| `infrastructure/lib/constructs/lambda-api.ts` | Add `cognito-idp:AdminDisableUser` to existing Cognito IAM grant list | +1 |
| `docs/APPENDICE_F_BUSINESS_LOGIC.md` | Footnote on BR-206 / BR-220 referencing token hash storage | +5 |
| `docs/APPENDICE_G_ERROR_CODES.md` | No new codes — Cognito native error reuses existing wrong-credentials surface | 0 |
| `docs/superpowers/runbooks/F-OFF-004-smoke.md` (if exists) or new smoke section | Steps to verify post-deploy: re-login attempt after deactivation surfaces wrong-credentials (not loop); operator CLI rotates and prints URL | +40 |

**Estimated total**: ~480 LOC implementation + ~260 LOC tests = **~740 LOC gross**, well under the 1500 hard limit (and approaching the 500 target — within tolerance).

---

## 4. Component interfaces

### 4.1 `disableOfficineUser` helper

```ts
// packages/api/src/lib/cognito.ts (sibling of signOutOfficineUser)

import { AdminDisableUserCommand } from '@aws-sdk/client-cognito-identity-provider';

// Disables the Cognito user in the officine pool. Subsequent
// AdminInitiateAuth calls return NotAuthorizedException with the
// native "User is disabled" message — same surface as a wrong
// password from outside, preserving anti-enum at the auth layer.
//
// Used in tandem with signOutOfficineUser on soft-delete and on
// status: active→inactive transitions:
//   signOutOfficineUser  → invalidates active refresh tokens
//   disableOfficineUser  → blocks re-login attempts
//
// Idempotent — swallows UserNotFoundException so callers can use
// this in best-effort post-tx paths without prior existence checks.
export async function disableOfficineUser(args: {
  poolId: string;
  email: string;
}): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminDisableUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}
```

### 4.2 `generateInvitationToken` helper

```ts
// packages/api/src/lib/secure-tokens.ts

import { createHash, randomUUID } from 'node:crypto';

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Mirror the existing invitation token format (~62 chars):
// randomUUID() + randomUUID without dashes. Format kept stable
// to avoid surprising the magic-link URL pattern.
export function generateInvitationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID() + randomUUID().replace(/-/g, '');
  return { plaintext, hash: hashToken(plaintext) };
}

// Verify-email token: equivalent to invitation but with the existing
// shorter format. Kept here so all token generation lives in one file.
export function generateVerificationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID();
  return { plaintext, hash: hashToken(plaintext) };
}
```

`packages/api/src/lib/email-verification.ts` keeps `VERIFICATION_TOKEN_TTL_MS` and `buildVerificationUrl`, but re-exports `hashToken` + `generateVerificationToken` from `secure-tokens.ts`:

```ts
// packages/api/src/lib/email-verification.ts
export { hashToken, generateVerificationToken } from './secure-tokens.js';

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export function buildVerificationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}
```

This keeps all existing import paths working — no churn outside the new PR2 routes.

### 4.3 Migration 0016 (full SQL)

Design choice: `token_hash` is **nullable** + partial unique index `WHERE token_hash IS NOT NULL`. Tombstoned rows keep `NULL token_hash` (no placeholder needed); new rows always supply it via the application layer. This avoids any dependency on `pgcrypto` or hash-placeholder ceremony.

```sql
-- migration.sql

-- Step 1: tombstone all currently-pending internal_user invitations.
-- Their plaintext tokens (which were emailed) become invalid
-- immediately, closing residual exposure from email caches/logs.
-- Operator runbook (post-merge §1) lists affected users for re-invite.
UPDATE invitations
SET accepted_at = NOW()
WHERE invitation_type = 'internal_user'
  AND accepted_at IS NULL;

-- Step 2: emit one audit row per tombstoned invitation. Bounded by
-- the timestamp window written in Step 1 so we don't double-count
-- previously-accepted rows.
INSERT INTO audit_logs (
  tenant_id, actor_type, action, entity_type, entity_id, metadata, created_at
)
SELECT
  tenant_id,
  'system',
  'user_invitation_expired_by_migration',
  'invitation',
  id,
  jsonb_build_object('reason', 'token_hashing_migration_0016'),
  NOW()
FROM invitations
WHERE invitation_type = 'internal_user'
  AND accepted_at IS NOT NULL
  AND accepted_at > (NOW() - INTERVAL '5 seconds');

-- Step 3: drop plaintext column. The pre-existing unique index on
-- `token` is dropped implicitly by Postgres on column drop.
ALTER TABLE invitations DROP COLUMN token;

-- Step 4: add token_hash column (nullable — tombstoned rows have
-- NULL, new rows always supply via the application layer).
ALTER TABLE invitations
  ADD COLUMN token_hash VARCHAR(64);

-- Step 5: partial unique index on non-null token_hash. Postgres
-- treats NULL as distinct in unique indexes by default, but the
-- partial WHERE clause makes the intent explicit and bypasses any
-- engine-version variance.
CREATE UNIQUE INDEX idx_invitation_token_hash
  ON invitations(token_hash)
  WHERE token_hash IS NOT NULL;
```

Prisma schema field: `tokenHash String? @unique @map("token_hash") @db.VarChar(64)`. The application layer (`users-invitations-create.ts`) always supplies a non-null value, so Prisma's TypeScript types treat it as required at insert. Lookups remain straightforward — `where: { tokenHash: hashToken(...) }` returns `null` on tombstoned rows because their `token_hash` is `NULL` and SQL `NULL = '<hash>'` yields no match.

### 4.4 Route patches (sketch)

**`users-invitations-create.ts`** (existing lines 118–142 area):

```ts
// before:
//   const token = randomUUID() + randomUUID().replace(/-/g, '');
//   data: { ..., token }
//   ...
//   magicLinkUrl: `${WEB_BASE_URL}/invitations/${result.token}`

// after:
const { plaintext: tokenPlaintext, hash: tokenHash } = generateInvitationToken();
// ... later in the insert:
//   data: { ..., tokenHash }
// ... at email send:
//   magicLinkUrl: `${WEB_BASE_URL}/invitations/${tokenPlaintext}`
// ... response stripping unchanged — tokenHash is not in the public DTO.
```

**`invitations-public-read.ts` line 34** and **`invitations-public-accept.ts` line 66**:

```ts
// before:
//   where: { token: parsed.data.token }

// after:
//   where: { tokenHash: hashToken(parsed.data.token) }
```

Anti-enum behavior unchanged — 404 generic on any miss.

### 4.5 Operator CLI rotate-on-extract

`scripts/admin/get-invitation-link.ts`:

```ts
// pseudocode (replaces the main() body around line 47)

const invitation = await prisma.invitation.findFirst({
  where: {
    invitationType: 'internal_user',
    targetEmail: email.trim().toLowerCase(),
    acceptedAt: null,
    expiresAt: { gt: new Date() },
    ...(tenantId ? { tenantId } : {}),
  },
  select: { id: true, tenantId: true, expiresAt: true },
});
if (!invitation) { /* exit 1 */ }

const { plaintext, hash } = generateInvitationToken();
await prisma.$transaction(async (tx) => {
  await tx.invitation.update({
    where: { id: invitation.id },
    data: { tokenHash: hash },
  });
  await tx.auditLog.create({
    data: {
      tenantId: invitation.tenantId,
      actorType: 'system',
      action: 'user_invitation_token_rotated',
      entityType: 'invitation',
      entityId: invitation.id,
      metadata: { reason: 'ses_sandbox_workaround' },
    },
  });
});

console.log(`${baseUrl}/invitations/${plaintext}`);
```

Multi-match handling unchanged (`--tenant` required). Script imports `generateInvitationToken` from `@garageos/api` lib — verify package-export path in plan; if cross-package import is awkward, duplicate the ~10-line generator inline in the script (lower coupling cost than monorepo restructure).

### 4.6 IAM grant addition

`infrastructure/lib/constructs/lambda-api.ts` — extend the existing Cognito IAM action list (currently includes `AdminCreateUser`, `AdminSetUserPassword`, `AdminUpdateUserAttributes`, `AdminUserGlobalSignOut`, etc.):

```ts
// existing pattern (illustrative):
actions: [
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminSetUserPassword',
  'cognito-idp:AdminUpdateUserAttributes',
  'cognito-idp:AdminUserGlobalSignOut',
  'cognito-idp:AdminDeleteUser',
  'cognito-idp:AdminDisableUser',  // ← new
],
```

Plan task will grep the exact current location.

---

## 5. Error mapping

No new error codes. PR2 reuses existing surfaces:

| Surface | Behavior | Note |
|---------|----------|------|
| `GET /v1/invitations/:token` with rotated/expired/wrong token | 404 generic anti-enum | Same as PR1 |
| `POST /v1/invitations/:token/accept` with rotated/expired/wrong token | 404 generic anti-enum | Same as PR1 |
| Login attempt after `AdminDisableUser` | Cognito returns `NotAuthorizedException: User is disabled` → frontend shows existing "Email o password non corretti" | Native Cognito error; no new code |
| `disableOfficineUser` Cognito 5xx | DB write committed; log structured error; user retains ability to re-login until next disable retry or manual operator action | Best-effort, mirrors `signOutOfficineUser` |

---

## 6. Test plan

### 6.1 Unit

- `secure-tokens.test.ts`:
  - `hashToken` produces consistent SHA-256 hex output (~3 known input/output pairs).
  - `generateInvitationToken()` returns `{plaintext, hash}` where `hashToken(plaintext) === hash`.
  - Plaintext format: 60+ chars, alphanumeric-with-dashes.
- `cognito-disable.test.ts`:
  - `disableOfficineUser` happy path sends `AdminDisableUserCommand` with correct args.
  - `UserNotFoundException` is swallowed (no throw).
  - Other `CognitoIdentityProviderServiceException` wraps in `CognitoUnavailableError`.
- `users-invitations-create.test.ts` (existing) updates: assert stored data contains `tokenHash` (64-char hex), not `token`. Magic-link URL builds with the helper's plaintext.

### 6.2 Integration (real Postgres + Testcontainers)

- **Migration 0016 test**:
  - Seed N pending internal_user invitations + M accepted/expired invitations.
  - Run migration.
  - Assert all N tombstoned (`accepted_at IS NOT NULL` post-migration), `token` column absent, `token_hash` column present (nullable; tombstoned rows have NULL), partial unique index `idx_invitation_token_hash` present, audit_log has N new rows with `action='user_invitation_expired_by_migration'`.

- **`users-invitations.test.ts`** additions:
  - Create invitation → SELECT row + assert `token_hash` is 64-char hex; no `token` column accessible.
  - Accept via the plaintext URL (mock email retrieval, take plaintext from create response or test-only fixture) → succeeds.
  - Accept via a hash directly (i.e., the hash itself in the URL slot) → 404 (hash of hash ≠ stored hash, so lookup misses).

- **`users-admin-mutations.test.ts`** additions:
  - DELETE soft-delete user → assert both `AdminUserGlobalSignOutCommand` AND `AdminDisableUserCommand` sent to mocked Cognito (`aws-sdk-client-mock`), with the target user's email.
  - PATCH `status: 'inactive'` on an active user → same.
  - PATCH `role` change (no status change) → AdminDisable NOT fired (only signOut on PR1 path if applicable).

### 6.3 Operator CLI smoke (manual, post-merge)

- Run `pnpm tsx scripts/admin/get-invitation-link.ts <email>` against a freshly-created invitation.
- Verify: output URL works; running the script a second time yields a DIFFERENT URL; the first URL is now 404; `SELECT * FROM audit_logs WHERE action = 'user_invitation_token_rotated'` shows 2 rows.

### 6.4 Smoke runbook (operator post-merge, web app on production)

1. **Pre-flight**: `SELECT count(*) FROM invitations WHERE invitation_type='internal_user' AND accepted_at IS NULL` against prod. If N > 0, list affected emails, deactivate gracefully (notify users → re-invite post-deploy).
2. **Deploy migration 0016**: verify via `\d invitations` shows `token_hash` only (no `token`).
3. **Item 5 verification** (UX papercut fix):
   - Super_admin logs into web, navigates to `/settings/users`.
   - Deactivates an existing test mechanic (or creates+accepts an invitation first to have a test user).
   - Open incognito window, attempt login with mechanic's credentials.
   - **Pre-PR2**: would loop on "Sessione Scaduta". **Post-PR2**: Cognito returns `NotAuthorizedException` → web shows "Email o password non corretti" (same as wrong password). No loop.
4. **Item 4 verification** (operator CLI):
   - Super_admin creates a new invitation for a test email.
   - Operator runs `pnpm tsx scripts/admin/get-invitation-link.ts <test-email>` → URL printed.
   - Run script again → DIFFERENT URL printed. Try first URL → 404. Try second → 200 + AcceptInvitation page renders.
   - Complete accept flow → DB shows `token_hash` only (verify via `SELECT token_hash FROM invitations WHERE target_email = '<test-email>'`).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Migration tombstones a real in-flight invitation that the user was about to accept | Low (prod is fresh F-OFF-004) | Operator pre-flight count + re-invite affected users manually |
| Migration leaves tombstoned rows with `NULL token_hash` — any future code path that assumes `token_hash NOT NULL` would break | Low | Schema is `String?` (nullable); application code only ever lookups by hash, never by NULL. Documented in §4.3 |
| Operator CLI rotates a URL that Michele already sent via WhatsApp/Slack | Low (operator workflow is "rotate-once-deliver-once") | Audit row makes it visible post-hoc; CLI documents the side-effect in `--help` |
| Lambda IAM missing `cognito-idp:AdminDisableUser` permission | High (must remember CDK change) | Dedicated task in plan (Task 7); CDK synth test asserts the action in the grant list |
| `AdminDisableUser` succeeds but `signOutOfficineUser` fails (or vice versa) | Low | Both best-effort independent; DB soft-delete is source of truth; reactive tenant-context middleware closes any residual gap |
| Cognito user has been manually deleted out-of-band (operator console) | Low | Both helpers swallow `UserNotFoundException`; idempotent |
| Cross-package import (`@garageos/api` from `scripts/admin/`) breaks pnpm workspace | Medium | Alternative: inline ~10-line generator in the script. Decide in plan. |
| Backward-compat: existing email-verification.ts callers fail after re-export shim | Low | Re-export is identity; integration suite for email verification still passes |
| Token rotation timing race: operator runs CLI mid-accept-flow | Very low | Acceptable; the invitation is single-use and the race window is sub-second. If hit, user sees 404 and operator re-runs CLI. |

---

## 8. References

### Predecessor PR
- PR #115 (F-OFF-004 follow-ups PR1): reactive `tenant-context` lookup + FOR UPDATE race fix + BR-206 wording (`feedback_code_review_lock_graph_analysis`, `feedback_t7_test_cascade`)

### Master spec
- `docs/superpowers/specs/2026-05-19-f-off-004-multi-user-design.md` §Risk: "Token plaintext stored in invitations.token (vs hashed in email_verifications)" — explicit deferral target

### Memory anchors
- `feedback_disabled_user_login_loop_ux` — UX papercut motivating Item 5
- `project_user_reactivation_open_questions` — 3 unresolved questions blocking AdminEnableUser
- `project_resume_checkpoint` — session resume state
- `feedback_smoke_runbook_catches_ux_drift` — smoke is BLOCKER, runbook §3 mandatory

### Code patterns reused
- `lib/email-verification.ts` `hashToken` + `generateVerificationToken` (extracted to `secure-tokens.ts`)
- `lib/cognito.ts` `signOutOfficineUser` (sibling for `disableOfficineUser`)
- `users-admin-delete.ts:126-138` + `users-admin-update.ts:231-243` (sibling pattern for new helper)
- PR1 audit-log emission pattern with `actor_type='system'` (used for tombstone + rotation)

---

## 9. Open questions

None. Reactivation flow (3 product questions) is explicitly deferred to a future PR; this design does not commit on those questions.

---

## 10. Estimated decomposition (preview — finalized in plan)

~7 tasks subagent-driven (TDD red→green→commit per task):

1. **Migration 0016** + DB integration tests (tombstone + token_hash unique + extension check).
2. **`lib/secure-tokens.ts`** extract + `email-verification.ts` re-export shim + unit tests.
3. **Route updates**: `users-invitations-create.ts` + `invitations-public-read.ts` + `invitations-public-accept.ts` + integration test updates.
4. **Operator CLI** `get-invitation-link.ts` rotate-on-extract + manual smoke step.
5. **`lib/cognito.ts`** `disableOfficineUser` helper + unit tests.
6. **Wire `disableOfficineUser`** into `users-admin-delete.ts` + `users-admin-update.ts` + integration tests assert both Cognito calls fired.
7. **CDK lambda-api.ts** IAM grant for `cognito-idp:AdminDisableUser` + APPENDICE_F footnote + smoke runbook section.

Final task count + ordering finalized in companion plan.

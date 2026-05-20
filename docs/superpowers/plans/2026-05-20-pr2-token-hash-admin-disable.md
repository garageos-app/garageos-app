# PR2 Bundle — Invitation Token Hashing + Cognito AdminDisableUser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plaintext `invitations.token` with hashed `token_hash` (mirror `email_verifications` pattern) and add `AdminDisableUser` to the deactivation flow, closing the post-deactivation login loop discovered in PR #115 smoke.

**Architecture:** Migration 0016 tombstones in-flight pending invitations and swaps `token` → nullable `token_hash` with partial unique index. New `lib/secure-tokens.ts` consolidates SHA-256 token helpers reused by both invitation and email-verification flows. Operator CLI `get-invitation-link.ts` rotates the token on each invocation (audited). New `disableOfficineUser` Cognito helper fires alongside the existing `signOutOfficineUser` on soft-delete and `status: active→inactive` transitions; Lambda IAM grant is extended for both `AdminUserGlobalSignOut` (PR1 oversight) and `AdminDisableUser` (new).

**Tech Stack:** Prisma 7 + Postgres 13+ (Supabase) + Fastify + AWS SDK v3 (Cognito + SES + S3) + aws-sdk-client-mock + Vitest + Testcontainers + AWS CDK + pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md`
**Predecessor PR:** #115 (F-OFF-004 follow-ups PR1).
**Branch:** `feat/pr2-token-hash-admin-disable` (already created from main `161ac92`; spec already committed as `65d2c5b`).

---

## File structure (locked in before tasks)

### New files
- `packages/api/src/lib/secure-tokens.ts` — `hashToken`, `generateInvitationToken`, `generateVerificationToken` (consolidation point for SHA-256 token helpers).
- `packages/api/tests/unit/lib/secure-tokens.test.ts` — unit tests.
- `packages/api/tests/unit/lib/cognito-disable.test.ts` — unit tests mirroring `cognito-sign-out.test.ts`.
- `packages/database/prisma/migrations/20260520120000_invitations_token_hash/migration.sql` — migration 0016.
- `packages/database/tests/integration/migrations-0016.test.ts` — migration schema verification.

### Modified files
- `packages/database/prisma/schema.prisma:728` — `Invitation.token` → `Invitation.tokenHash` (nullable).
- `packages/api/src/lib/email-verification.ts` — re-export from `secure-tokens.ts`.
- `packages/api/src/lib/cognito.ts:11` (imports) + new `disableOfficineUser` helper after line 320.
- `packages/api/src/routes/v1/users-invitations-create.ts:17, 121, 135, 142, 219` — use new generator + store hash.
- `packages/api/src/routes/v1/invitations-public-read.ts:34` — lookup by `tokenHash`.
- `packages/api/src/routes/v1/invitations-public-accept.ts:66` — lookup by `tokenHash`.
- `packages/api/src/routes/v1/users-admin-delete.ts:126-138` — wire `disableOfficineUser` sibling.
- `packages/api/src/routes/v1/users-admin-update.ts:231-243` — wire `disableOfficineUser` sibling.
- `packages/api/tests/integration/users-invitations-create.test.ts` — assert tokenHash 64-char hex + no `token` in response.
- `packages/api/tests/integration/users-admin-delete.test.ts` — assert AdminDisableUser fired.
- `packages/api/tests/integration/users-admin-update.test.ts` — assert AdminDisableUser fired on active→inactive.
- `scripts/admin/get-invitation-link.ts` — rotate-on-extract.
- `infrastructure/lib/constructs/lambda-api.ts:90-99` — add `AdminUserGlobalSignOut` (PR1 fix) + `AdminDisableUser`.
- `infrastructure/tests/main-stack.test.ts:220-238` — update assertions.
- `docs/APPENDICE_F_BUSINESS_LOGIC.md` — footnote on token hash storage.
- `docs/superpowers/runbooks/F-OFF-004-smoke.md` (or new) — smoke steps for Item 4 + Item 5.

---

## Critical adaptations (apply throughout)

1. **`audit_logs.action` is a free-form string column** (NOT a Postgres enum) — confirmed by `migrations-0014.test.ts` and PR1 patterns. New actions `user_invitation_expired_by_migration` and `invitation_token_rotated_by_operator` can be inserted without schema change.

2. **`audit_logs.actor_type` is a string column** with PR1 using `'system'` for non-user actors — re-use that value for the tombstone audit rows and CLI rotation audit row.

3. **`Invitation.token` schema is `String @unique @db.VarChar(100)` at `schema.prisma:728`**. New shape: `String? @unique @map("token_hash") @db.VarChar(64)`. The `@unique` decorator at the Prisma layer generates an index on the column; we override the DB-side index name via the explicit `CREATE UNIQUE INDEX` in the migration. Prisma's `prisma migrate diff` may complain — Task 1 includes a step to verify `prisma format` + `prisma generate` produce a consistent client.

4. **Cognito mock pattern in integration tests**: `cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({})` is the default in `beforeEach`. Add `cognitoMock.on(AdminDisableUserCommand).resolves({})` to the same `beforeEach` blocks in admin-delete and admin-update integration tests.

5. **PR1 IAM oversight**: `lambda-api.ts:90-99` does NOT include `AdminUserGlobalSignOut`. PR1's `signOutOfficineUser` calls are silently 403-ing in prod (best-effort try/catch swallows). Task 7 fixes this AND adds `AdminDisableUser`. The smoke step 2 in PR1 ("Refresh token Cognito fallisce post-GlobalSignOut") still succeeded — but for the wrong reason (reactive tenant-context 401 rejected the request, not Cognito refresh-token invalidation). Acknowledge in task 7 commit message.

6. **TestIP pattern**: existing integration tests use `const TEST_IP = '10.20.32.50'` (e.g., `users-admin-update.test.ts:368`) to isolate rate-limit buckets. New test cases reuse the same pattern with unique IPs.

7. **Migration test pattern**: `migrations-0014.test.ts` does NOT re-apply the migration in the test; it verifies behavior of an already-applied schema. Migration 0016 test follows the same pattern: assume migration is applied by Testcontainers init via `prisma migrate deploy`, verify the resulting schema state via `pgAdmin.query`. Tombstone DML behavior is verified post-deploy via the smoke runbook §1 (test data on prod).

8. **Cross-package import for operator CLI**: `scripts/admin/get-invitation-link.ts` currently imports `PrismaClient` from `@garageos/database`. To import `generateInvitationToken` from `@garageos/api`, verify the `package.json` `exports` map. If `@garageos/api/lib/secure-tokens` is not exported, **inline the 4-line generator** inside the script (lower coupling cost — see Task 4 Step 2).

9. **Pre-push hook is typecheck only** per `feedback_skip_local_integration_tests`. Each task's "run tests" step is integration-suite-aware: only run unit tests locally; integration tests are validated on CI. Mark unit-only tests explicitly. The husky pre-push hook (`.husky/pre-push`) runs `pnpm -r typecheck` only.

10. **Commit message scope per CLAUDE.md**: `feat(api,database)`, `fix(infra)`, `docs(api)`, etc. The squash PR title at the end uses one of these per the conventional commits rule.

---

## Task 1: Migration 0016 — schema change + DB integration test

**Files:**
- Create: `packages/database/prisma/migrations/20260520120000_invitations_token_hash/migration.sql`
- Modify: `packages/database/prisma/schema.prisma:728`
- Create: `packages/database/tests/integration/migrations-0016.test.ts`

**Goal:** Tombstone in-flight pending invitations, drop `token`, add nullable `token_hash` with partial unique index. Schema field becomes `tokenHash String? @unique @map("token_hash") @db.VarChar(64)`.

- [ ] **Step 1: Create migration directory and SQL file**

```bash
mkdir -p packages/database/prisma/migrations/20260520120000_invitations_token_hash
```

Write the SQL file at `packages/database/prisma/migrations/20260520120000_invitations_token_hash/migration.sql`:

```sql
-- F-OFF-004 follow-ups PR2 — Item 4: hash invitation tokens at-rest.
-- Mirror the email_verifications.token_hash design.
--
-- Strategy: tombstone all in-flight pending invitations (their plaintext
-- tokens, already emitted via SES, become inert), then swap the column.
-- Spec: docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md §4.3

-- Step 1: tombstone all currently-pending internal_user invitations.
UPDATE invitations
SET accepted_at = NOW()
WHERE invitation_type = 'internal_user'
  AND accepted_at IS NULL;

-- Step 2: emit one audit row per tombstoned invitation. Bounded by the
-- 5-second timestamp window to avoid double-counting previously-accepted rows.
INSERT INTO audit_logs (
  id, tenant_id, actor_type, action, entity_type, entity_id, metadata, ip_address, created_at
)
SELECT
  gen_random_uuid(),
  tenant_id,
  'system',
  'user_invitation_expired_by_migration',
  'invitation',
  id,
  jsonb_build_object('reason', 'token_hashing_migration_0016'),
  NULL,
  NOW()
FROM invitations
WHERE invitation_type = 'internal_user'
  AND accepted_at IS NOT NULL
  AND accepted_at > (NOW() - INTERVAL '5 seconds');

-- Step 3: drop the plaintext column. The pre-existing @unique index
-- (Prisma generated `invitations_token_key`) is dropped implicitly.
ALTER TABLE invitations DROP COLUMN token;

-- Step 4: add token_hash column (nullable — tombstoned rows have NULL,
-- new rows always supply via the application layer).
ALTER TABLE invitations
  ADD COLUMN token_hash VARCHAR(64);

-- Step 5: partial unique index on non-null token_hash. The partial
-- WHERE clause is explicit so the intent is unambiguous regardless
-- of engine NULL-handling defaults.
CREATE UNIQUE INDEX invitations_token_hash_key
  ON invitations(token_hash)
  WHERE token_hash IS NOT NULL;
```

- [ ] **Step 2: Update Prisma schema**

Modify `packages/database/prisma/schema.prisma` line 728:

```prisma
// before:
//   token           String         @unique @db.VarChar(100)

// after:
  tokenHash       String?        @unique @map("token_hash") @db.VarChar(64)
```

- [ ] **Step 3: Regenerate Prisma client**

Run:

```bash
pnpm --filter @garageos/database prisma generate
```

Expected: "Generated Prisma Client" message, no errors. The `Invitation.tokenHash` field is now typed as `string | null` in the client.

- [ ] **Step 4: Typecheck immediately to find compile breakage**

```bash
pnpm -r typecheck
```

Expected: 4–5 failures across `users-invitations-create.ts`, `invitations-public-read.ts`, `invitations-public-accept.ts`, `scripts/admin/get-invitation-link.ts` (these still reference `.token`). LEAVE THE BREAKAGE — Tasks 3+5 fix it. This step confirms the rename surfaced everywhere expected.

- [ ] **Step 5: Write the failing migration test**

Create `packages/database/tests/integration/migrations-0016.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { pgAdmin } from './setup.js';

// Migration 20260520120000 — invitations token hashing.
// PR2 spec §4.3.
// This test verifies the resulting schema state (post-migration), not
// the migration DML (which acts on data present at migration-application
// time only and is verified via the operator smoke runbook §1).

describe('Migration 0016 — invitations token_hash', () => {
  it('drops the legacy token column', async () => {
    const { rows } = await pgAdmin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'invitations' AND column_name = 'token'`,
    );
    expect(rows).toEqual([]);
  });

  it('adds token_hash column (nullable, varchar(64))', async () => {
    const { rows } = await pgAdmin.query<{
      column_name: string;
      is_nullable: 'YES' | 'NO';
      character_maximum_length: number;
    }>(
      `SELECT column_name, is_nullable, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'invitations' AND column_name = 'token_hash'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('YES');
    expect(rows[0]!.character_maximum_length).toBe(64);
  });

  it('creates partial unique index invitations_token_hash_key on (token_hash) WHERE NOT NULL', async () => {
    const { rows } = await pgAdmin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'invitations' AND indexname = 'invitations_token_hash_key'`,
    );
    expect(rows).toHaveLength(1);
    // Postgres normalizes the predicate; case + whitespace varies.
    expect(rows[0]!.indexdef.toLowerCase()).toMatch(/where.*token_hash is not null/);
    expect(rows[0]!.indexdef.toLowerCase()).toMatch(/unique/);
  });

  it('allows multiple invitations with NULL token_hash (partial uniqueness)', async () => {
    // Seed tenant.
    const { rows: tenantRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test 0016 ${Date.now()}`, '00000000016', `t0016-${Date.now()}@test.local`],
    );
    const tenantId = tenantRows[0]!.id;

    // Insert two invitations both with NULL token_hash — must succeed.
    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, expires_at, accepted_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [tenantId, 'a@example.test'],
    );
    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, expires_at, accepted_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [tenantId, 'b@example.test'],
    );

    const { rows: count } = await pgAdmin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM invitations WHERE token_hash IS NULL AND tenant_id = $1`,
      [tenantId],
    );
    expect(parseInt(count[0]!.c, 10)).toBe(2);
  });

  it('rejects two invitations with the same non-null token_hash', async () => {
    const { rows: tenantRows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO tenants (id, business_name, vat_number, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [`Test 0016b ${Date.now()}`, '00000000017', `t0016b-${Date.now()}@test.local`],
    );
    const tenantId = tenantRows[0]!.id;
    const hash = 'a'.repeat(64);

    await pgAdmin.query(
      `INSERT INTO invitations
         (id, tenant_id, invitation_type, target_email, token_hash, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, 'internal_user', $2, $3, NOW() + INTERVAL '7 days', NOW())`,
      [tenantId, 'c@example.test', hash],
    );

    await expect(
      pgAdmin.query(
        `INSERT INTO invitations
           (id, tenant_id, invitation_type, target_email, token_hash, expires_at, created_at)
         VALUES (gen_random_uuid(), $1, 'internal_user', $2, $3, NOW() + INTERVAL '7 days', NOW())`,
        [tenantId, 'd@example.test', hash],
      ),
    ).rejects.toThrow(/invitations_token_hash_key|unique constraint/i);
  });
});
```

- [ ] **Step 6: Run the migration locally only if reproducing a CI failure (do NOT add to default pre-push)**

Per `feedback_skip_local_integration_tests`, do not run `pnpm test:integration` for db at this point. The migration runs implicitly via `prisma migrate deploy` in CI integration test setup. To validate before push:

```bash
pnpm -r typecheck
```

Expected: still 4–5 errors from Step 4 (not yet fixed). Commit anyway — Tasks 3+5 close the loop.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/migrations/20260520120000_invitations_token_hash/migration.sql
git add packages/database/prisma/schema.prisma
git add packages/database/tests/integration/migrations-0016.test.ts
git commit -m "$(cat <<'EOF'
feat(database): migration 0016 — invitations token_hash

Tombstone all currently-pending internal_user invitations and replace
plaintext invitations.token with nullable invitations.token_hash
(VARCHAR(64), partial unique index on non-null values). Mirrors the
email_verifications.token_hash pattern.

In-flight pending invitations are tombstoned (accepted_at = NOW())
with a 'user_invitation_expired_by_migration' audit row each, closing
the residual exposure window from email caches and operator logs.

Application-layer compile errors are deliberate — Tasks 3 and 5 of the
PR2 plan wire the new field across routes and the operator CLI.

Spec: docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `lib/secure-tokens.ts` extract + email-verification.ts shim

**Files:**
- Create: `packages/api/src/lib/secure-tokens.ts`
- Modify: `packages/api/src/lib/email-verification.ts`
- Create: `packages/api/tests/unit/lib/secure-tokens.test.ts`

**Goal:** Consolidate SHA-256 token helpers; `email-verification.ts` re-exports for backward compat (no churn outside PR2).

- [ ] **Step 1: Write the failing unit test**

Create `packages/api/tests/unit/lib/secure-tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  generateInvitationToken,
  generateVerificationToken,
  hashToken,
} from '../../../src/lib/secure-tokens.js';

describe('secure-tokens.hashToken', () => {
  it('produces a stable 64-char SHA-256 hex string', () => {
    const out = hashToken('hello');
    expect(out).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same output', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('different inputs yield different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('secure-tokens.generateInvitationToken', () => {
  it('returns plaintext + hash where hashToken(plaintext) === hash', () => {
    const { plaintext, hash } = generateInvitationToken();
    expect(hashToken(plaintext)).toBe(hash);
  });

  it('plaintext has the legacy invitation format (~60 chars, hex+dashes)', () => {
    const { plaintext } = generateInvitationToken();
    // randomUUID() = 36 chars (8-4-4-4-12 with 4 dashes) + randomUUID().replace('-','') = 32 chars
    // total = 68 chars
    expect(plaintext).toHaveLength(68);
    expect(plaintext).toMatch(/^[0-9a-f-]+$/);
  });

  it('two invocations produce different plaintexts (uniqueness)', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('secure-tokens.generateVerificationToken (email-verification token)', () => {
  it('plaintext is a single UUID string (36 chars with dashes)', () => {
    const { plaintext, hash } = generateVerificationToken();
    expect(plaintext).toHaveLength(36);
    expect(plaintext).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(hashToken(plaintext)).toBe(hash);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/secure-tokens.test.ts
```

Expected: FAIL — "Cannot find module '../../../src/lib/secure-tokens.js'".

- [ ] **Step 3: Implement `secure-tokens.ts`**

Create `packages/api/src/lib/secure-tokens.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Email verification token: single UUID, 36 chars with dashes.
// Used by F-CLI-001 customer signup verify-email flow.
export function generateVerificationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID();
  return { plaintext, hash: hashToken(plaintext) };
}

// Invitation token: legacy format preserved for URL aesthetic parity
// with pre-PR2 magic-link URLs. randomUUID() (36 chars) + randomUUID()
// without dashes (32 chars) = 68 chars total.
export function generateInvitationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID() + randomUUID().replace(/-/g, '');
  return { plaintext, hash: hashToken(plaintext) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/secure-tokens.test.ts
```

Expected: PASS (3 + 4 + 1 = 8 cases).

- [ ] **Step 5: Convert `email-verification.ts` to a re-export shim**

Replace the contents of `packages/api/src/lib/email-verification.ts` with:

```ts
// Backward-compat shim — token helpers moved to secure-tokens.ts in PR2.
// New code SHOULD import directly from './secure-tokens.js'.
export { hashToken, generateVerificationToken } from './secure-tokens.js';

// 24-hour TTL for verify-email tokens. After expiry the token row is
// inert in DB; resend route (auth-resend-verification.ts) issues a new one.
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function buildVerificationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}
```

- [ ] **Step 6: Run typecheck to confirm no other call-site broke**

```bash
pnpm -r typecheck
```

Expected: still the 4–5 errors from Task 1 (token field rename) — but no NEW errors from email-verification.ts call sites.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/secure-tokens.ts
git add packages/api/src/lib/email-verification.ts
git add packages/api/tests/unit/lib/secure-tokens.test.ts
git commit -m "$(cat <<'EOF'
feat(api): extract secure-tokens lib (SHA-256 + UUID-based helpers)

Consolidate hashToken + generateVerificationToken from
email-verification.ts and add generateInvitationToken for PR2.
email-verification.ts becomes a re-export shim — no churn for existing
callers. Invitation token format preserved (68 chars: UUID + dashless
UUID) for magic-link URL parity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Routes — `users-invitations-create` + `invitations-public-read` + `invitations-public-accept`

**Files:**
- Modify: `packages/api/src/routes/v1/users-invitations-create.ts`
- Modify: `packages/api/src/routes/v1/invitations-public-read.ts`
- Modify: `packages/api/src/routes/v1/invitations-public-accept.ts`
- Modify: `packages/api/tests/integration/users-invitations-create.test.ts`

**Goal:** Lookup invitations by `tokenHash`, store hash on create, strip both plaintext + hash from response.

- [ ] **Step 1: Update `users-invitations-create.ts` imports + body**

Modify `packages/api/src/routes/v1/users-invitations-create.ts`:

Replace line 17:
```ts
// before:
//   import { randomUUID } from 'node:crypto';

// after:
import { generateInvitationToken } from '../../lib/secure-tokens.js';
```

Replace lines 121–143 (token generation + insert):
```ts
// before:
//   const token = randomUUID() + randomUUID().replace(/-/g, '');
//   const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
//   ...
//   invitation = await tx.invitation.create({
//     data: { ..., token, expiresAt },
//     select: { ...INVITATION_ADMIN_SELECT, token: true },
//   });

// after:
        const { plaintext: tokenPlaintext, hash: tokenHash } = generateInvitationToken();
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

        let invitation;
        try {
          invitation = await tx.invitation.create({
            data: {
              tenantId,
              invitationType: 'internal_user',
              targetEmail: body.email,
              firstName: body.firstName,
              lastName: body.lastName,
              role: body.role,
              locationId: body.locationId,
              tokenHash,
              expiresAt,
            },
            select: INVITATION_ADMIN_SELECT,
          });
        } catch (err) {
```

Replace line 219 (magic-link URL):
```ts
// before:
//   magicLinkUrl: `${WEB_BASE_URL}/invitations/${result.token}`,

// after:
          magicLinkUrl: `${WEB_BASE_URL}/invitations/${tokenPlaintext}`,
```

Replace lines 228–233 (response stripping):
```ts
// before:
//   const { token: _token, ...rowWithoutToken } = result;
//   void _token;
//   return reply.code(201).send({ invitation: serializeInvitationAdmin(rowWithoutToken) });

// after:
      // Plaintext token is never persisted; tokenHash is selected only at the
      // DB layer (see INVITATION_ADMIN_SELECT) and stripped by the serializer.
      return reply.code(201).send({ invitation: serializeInvitationAdmin(result) });
```

NOTE on `INVITATION_ADMIN_SELECT`: check the file. If it currently includes `token: true`, remove that line and DON'T add `tokenHash: true` (serializer is admin-facing but token_hash is sensitive). Run `pnpm -r typecheck` after this step to surface any DTO type drift.

- [ ] **Step 2: Verify `lib/dtos/invitation.ts` does not leak the hash**

```bash
grep -n "token" packages/api/src/lib/dtos/invitation.ts
```

If `INVITATION_ADMIN_SELECT` still has `token: true` or has been replaced by `tokenHash: true`, EDIT to remove (the admin DTO must not expose either). Re-run typecheck.

- [ ] **Step 3: Update `invitations-public-read.ts`**

Modify `packages/api/src/routes/v1/invitations-public-read.ts`:

Add import at top (after line 20):
```ts
import { hashToken } from '../../lib/secure-tokens.js';
```

Replace line 33–34:
```ts
// before:
//   const inv = await tx.invitation.findUnique({
//     where: { token: parsed.data.token },

// after:
      const inv = await tx.invitation.findUnique({
        where: { tokenHash: hashToken(parsed.data.token) },
```

- [ ] **Step 4: Update `invitations-public-accept.ts`**

Modify `packages/api/src/routes/v1/invitations-public-accept.ts`:

Add import (with the other `lib/...` imports around line 20–28):
```ts
import { hashToken } from '../../lib/secure-tokens.js';
```

Replace line 65–66:
```ts
// before:
//   const inv = await tx.invitation.findUnique({
//     where: { token: parsedParams.data.token },

// after:
        const inv = await tx.invitation.findUnique({
          where: { tokenHash: hashToken(parsedParams.data.token) },
```

- [ ] **Step 5: Run typecheck to confirm route layer is clean**

```bash
pnpm -r typecheck
```

Expected: only 1 remaining error in `scripts/admin/get-invitation-link.ts` (Task 4 fixes). All other API errors resolved.

- [ ] **Step 6: Write the failing integration assertion**

Modify `packages/api/tests/integration/users-invitations-create.test.ts` — in the "creates an invitation + sends SES email (happy path)" test (around line 67–80), add after `expect(body.invitation).not.toHaveProperty('token');`:

```ts
    // Plaintext token is never persisted; tokenHash is selected only at the
    // DB layer (see INVITATION_ADMIN_SELECT) and stripped by the serializer.
    expect(body.invitation).not.toHaveProperty('tokenHash');

    // DB-side: the invitation row stores a 64-char hex token_hash and
    // does NOT have a legacy `token` column.
    const { rows: dbRows } = await pgAdmin.query<{
      token_hash: string;
      legacy_token_exists: boolean;
    }>(
      `SELECT
         token_hash,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'invitations' AND column_name = 'token'
         ) AS legacy_token_exists
       FROM invitations
       WHERE id = $1`,
      [body.invitation.id],
    );
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dbRows[0]!.legacy_token_exists).toBe(false);
```

The existing test imports already pull `pgAdmin` from `./setup.js` (check around line 15 of the test file) — verify the import is present; if not, add it.

- [ ] **Step 7: Verify integration test reads (skip running; CI will validate)**

Run only the typecheck:

```bash
pnpm -r typecheck
```

Expected: 0 errors in `packages/api/` (still 1 in scripts/admin/).

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/v1/users-invitations-create.ts
git add packages/api/src/routes/v1/invitations-public-read.ts
git add packages/api/src/routes/v1/invitations-public-accept.ts
git add packages/api/src/lib/dtos/invitation.ts
git add packages/api/tests/integration/users-invitations-create.test.ts
git commit -m "$(cat <<'EOF'
feat(api): hash invitation tokens at-rest

users-invitations-create.ts now uses generateInvitationToken from
secure-tokens.ts to mint plaintext + hash; only the hash is persisted.
invitations-public-read.ts and invitations-public-accept.ts hash the
URL-supplied token before lookup. Plaintext token never leaves the
process (magic-link URL → SES → invitee inbox), the response strips
both plaintext + tokenHash.

Anti-enum surface unchanged — 404 generic on any miss.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Operator CLI rotate-on-extract

**Files:**
- Modify: `scripts/admin/get-invitation-link.ts`

**Goal:** CLI generates a fresh token on each invocation, UPDATEs `token_hash`, emits an `invitation_token_rotated_by_operator` audit row, prints the new URL.

- [ ] **Step 1: Check whether `@garageos/api/lib/secure-tokens` is exported**

```bash
grep -E '"exports"|"main"' packages/api/package.json
```

If `exports` is absent OR doesn't include `./lib/*` mapping, **inline** the generator in the script (Step 3 path B). If exports map allows it (e.g. `"./lib/*": "./src/lib/*.ts"` or built output `./dist/lib/*.js`), use the import path (Step 3 path A). Default assumption: monorepo workspace uses src TS, so inline is the safer call.

- [ ] **Step 2: Modify the CLI for rotate-on-extract (inline-generator path)**

Replace the contents of `scripts/admin/get-invitation-link.ts`:

```ts
#!/usr/bin/env node
/**
 * Operator-only: rotate the invitation token and print a fresh
 * magic-link URL for a pending F-OFF-004 invitation.
 *
 * POST-PR2 behavior: the DB stores only token_hash (SHA-256 of
 * plaintext). The script can no longer read the existing plaintext.
 * Instead it generates a NEW plaintext + hash, UPDATEs the invitation
 * row, emits an audit row, and prints the new URL. Each invocation
 * invalidates any previously-printed URL for the same invitation.
 *
 * Use when SES sandbox/limbo prevents the invitation email from being
 * delivered. The operator runs the script with DIRECT_URL set and
 * delivers the resulting URL to the invitee out-of-band.
 *
 * Usage:
 *   pnpm tsx scripts/admin/get-invitation-link.ts <email> [--tenant <tenantId>]
 *
 * Exit codes:
 *   0 — success, URL printed
 *   1 — no pending invitation / arg missing
 *   2 — multiple matches (tenant filter required)
 *   3 — DIRECT_URL missing or DB error
 */

import { createHash, randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@garageos/database';

const DEFAULT_BASE = 'https://app.garageos.aifollyadvisor.com';

// Inlined from packages/api/src/lib/secure-tokens.ts. Kept local so the
// CLI does not depend on the API workspace (which would require a
// monorepo cross-package import + build setup).
function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
function generateInvitationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID() + randomUUID().replace(/-/g, '');
  return { plaintext, hash: hashToken(plaintext) };
}

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;

  if (!email) {
    console.error(
      'Usage: pnpm tsx scripts/admin/get-invitation-link.ts <email> [--tenant <tenantId>]',
    );
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    console.error('DIRECT_URL env var required.');
    process.exit(3);
  }

  const baseUrl = process.env.WEB_BASE_URL ?? DEFAULT_BASE;
  const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const invitations = await prisma.invitation.findMany({
      where: {
        invitationType: 'internal_user',
        targetEmail: email.trim().toLowerCase(),
        acceptedAt: null,
        expiresAt: { gt: new Date() },
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true, tenantId: true, expiresAt: true },
    });

    if (invitations.length === 0) {
      console.error(
        `No pending invitation found for ${email}` + (tenantId ? ` in tenant ${tenantId}` : ''),
      );
      process.exit(1);
    }
    if (invitations.length > 1) {
      console.error(
        `Multiple pending invitations across tenants. Use --tenant <tenantId>. Candidates:`,
      );
      for (const i of invitations) {
        console.error(`  tenant ${i.tenantId} — expires ${i.expiresAt.toISOString()}`);
      }
      process.exit(2);
    }

    const inv = invitations[0]!;

    // Rotate: generate new token + hash, UPDATE row, emit audit row.
    const { plaintext, hash } = generateInvitationToken();
    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: inv.id },
        data: { tokenHash: hash },
      });
      await tx.auditLog.create({
        data: {
          tenantId: inv.tenantId,
          actorType: 'system',
          action: 'invitation_token_rotated_by_operator',
          entityType: 'invitation',
          entityId: inv.id,
          metadata: { reason: 'ses_sandbox_workaround' },
        },
      });
    });

    console.log(`${baseUrl}/invitations/${plaintext}`);
    process.exit(0);
  } catch (err) {
    console.error('DB error:', err instanceof Error ? err.message : err);
    process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors across the entire monorepo. Token-rename work is complete.

- [ ] **Step 4: Commit**

```bash
git add scripts/admin/get-invitation-link.ts
git commit -m "$(cat <<'EOF'
feat(api): operator CLI rotate-on-extract for invitation links

POST-PR2 the DB stores only token_hash; the CLI can no longer read the
existing plaintext. Instead it generates a fresh token, UPDATEs the
invitation row's token_hash, emits an 'invitation_token_rotated_by_
operator' audit row, and prints the new URL.

Each invocation invalidates any previously-printed URL for the same
invitation — acceptable for the SES-limbo workflow where the operator
delivers each URL out-of-band exactly once.

Generator inlined to avoid cross-package import (no exports map for
@garageos/api/lib).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `disableOfficineUser` helper + unit tests

**Files:**
- Modify: `packages/api/src/lib/cognito.ts`
- Create: `packages/api/tests/unit/lib/cognito-disable.test.ts`

**Goal:** Mirror `signOutOfficineUser` exactly — idempotent, swallow `UserNotFoundException`, wrap other errors.

- [ ] **Step 1: Write the failing unit test**

Create `packages/api/tests/unit/lib/cognito-disable.test.ts`:

```ts
import {
  AdminDisableUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CognitoUnavailableError,
  _resetCognitoClientForTests,
  disableOfficineUser,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

afterEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

describe('disableOfficineUser', () => {
  it('calls AdminDisableUserCommand with correct PoolId + Username', async () => {
    cognitoMock.on(AdminDisableUserCommand).resolves({});

    await disableOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' });

    const calls = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-central-1_TESTPOOL',
      Username: 'user@test.it',
    });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock.on(AdminDisableUserCommand).rejects(
      new UserNotFoundException({
        message: 'User does not exist',
        $metadata: {},
      }),
    );

    await expect(
      disableOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'gone@test.it' }),
    ).resolves.toBeUndefined();
  });

  it('wraps other errors in CognitoUnavailableError', async () => {
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error('Network failure'));

    await expect(
      disableOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/cognito-disable.test.ts
```

Expected: FAIL — "Cannot find name 'disableOfficineUser'".

- [ ] **Step 3: Implement `disableOfficineUser` in `cognito.ts`**

Modify `packages/api/src/lib/cognito.ts`:

Add `AdminDisableUserCommand` to the import block at line 1–11:

```ts
// before:
//   import {
//     AdminCreateUserCommand,
//     AdminDeleteUserCommand,
//     AdminSetUserPasswordCommand,
//     AdminUpdateUserAttributesCommand,
//     AdminUserGlobalSignOutCommand,
//     CognitoIdentityProviderClient,
//     InvalidPasswordException,
//     UsernameExistsException,
//     UserNotFoundException,
//   } from '@aws-sdk/client-cognito-identity-provider';

// after:
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
```

Append after the existing `signOutOfficineUser` function (end of file, after line 320):

```ts

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
//
// See docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md §2.3.
export async function disableOfficineUser(args: { poolId: string; email: string }): Promise<void> {
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

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/cognito-disable.test.ts
```

Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/cognito.ts
git add packages/api/tests/unit/lib/cognito-disable.test.ts
git commit -m "$(cat <<'EOF'
feat(api): disableOfficineUser cognito helper

Mirror signOutOfficineUser exactly: idempotent (swallow
UserNotFoundException), wrap other Cognito errors in
CognitoUnavailableError. Used in tandem with signOut on
inactivation paths — signOut closes the active-token window,
disable closes the re-login window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `disableOfficineUser` into admin-delete + admin-update + integration tests

**Files:**
- Modify: `packages/api/src/routes/v1/users-admin-delete.ts:1-143`
- Modify: `packages/api/src/routes/v1/users-admin-update.ts:1-249`
- Modify: `packages/api/tests/integration/users-admin-delete.test.ts`
- Modify: `packages/api/tests/integration/users-admin-update.test.ts`

**Goal:** Add `disableOfficineUser` best-effort call as sibling of `signOutOfficineUser` on both inactivation paths. Update integration tests' `beforeEach` to mock and assert.

- [ ] **Step 1: Update `users-admin-delete.ts`**

Modify `packages/api/src/routes/v1/users-admin-delete.ts`:

Update the import at line 20:

```ts
// before:
//   import { signOutOfficineUser } from '../../lib/cognito.js';

// after:
import { disableOfficineUser, signOutOfficineUser } from '../../lib/cognito.js';
```

Replace lines 121–138 (the proactive lockout block):

```ts
// before:
//   if (targetInfo.cognitoSub) {
//     try {
//       await signOutOfficineUser({
//         poolId: env.COGNITO_OFFICINE_POOL_ID,
//         email: targetInfo.email,
//       });
//     } catch (err) {
//       request.log.error(
//         { err, targetId },
//         'cognito global signout failed (DB soft-delete already committed; user retains access until access token TTL)',
//       );
//     }
//   }

// after:
      // Item 1 (PR1) + Item 5 (PR2) proactive: invalidate refresh tokens
      // AND disable the user so re-login attempts surface Cognito's native
      // "User is disabled" error (treated as wrong-password by the frontend,
      // preserves anti-enum at the auth layer). Both calls are best-effort
      // independent — DB soft-delete is the source of truth. The truthy
      // check on cognitoSub is defensive; users.cognito_sub is non-nullable
      // at the schema level (PR #111 populates it on invitation accept).
      if (targetInfo.cognitoSub) {
        try {
          await signOutOfficineUser({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: targetInfo.email,
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito global signout failed (DB soft-delete already committed; user retains access until access token TTL)',
          );
        }
        try {
          await disableOfficineUser({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: targetInfo.email,
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito user disable failed (DB soft-delete already committed; user may successfully re-login until next disable retry)',
          );
        }
      }
```

- [ ] **Step 2: Update `users-admin-update.ts`**

Modify `packages/api/src/routes/v1/users-admin-update.ts`:

Update the import at line 28:

```ts
// before:
//   import { signOutOfficineUser, updateOfficineUserRoleAndLocation } from '../../lib/cognito.js';

// after:
import {
  disableOfficineUser,
  signOutOfficineUser,
  updateOfficineUserRoleAndLocation,
} from '../../lib/cognito.js';
```

Replace lines 226–243 (the proactive lockout block):

```ts
// before:
//   if (result.statusBecameInactive && result.targetCognitoSub) {
//     try {
//       await signOutOfficineUser({
//         poolId: env.COGNITO_OFFICINE_POOL_ID,
//         email: result.targetEmail,
//       });
//     } catch (err) {
//       request.log.error(
//         { err, targetId },
//         'cognito global signout on status=inactive failed (DB updated; user retains access until access token TTL)',
//       );
//     }
//   }

// after:
      // Item 1 (PR1) + Item 5 (PR2) proactive: invalidate refresh tokens
      // AND disable the user on active→inactive transition. Same rationale
      // as users-admin-delete.ts — see that file for the comment.
      if (result.statusBecameInactive && result.targetCognitoSub) {
        try {
          await signOutOfficineUser({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: result.targetEmail,
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito global signout on status=inactive failed (DB updated; user retains access until access token TTL)',
          );
        }
        try {
          await disableOfficineUser({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: result.targetEmail,
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito user disable on status=inactive failed (DB updated; user may successfully re-login until next disable retry)',
          );
        }
      }
```

- [ ] **Step 3: Update `users-admin-delete.test.ts` mocks + add assertion**

In `packages/api/tests/integration/users-admin-delete.test.ts`:

Add `AdminDisableUserCommand` to the imports at the top:

```ts
// Add to the existing `@aws-sdk/client-cognito-identity-provider` import group:
import {
  AdminDisableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
```

In the `beforeEach`, register the default mock:

```ts
beforeEach(async () => {
  await resetDb();
  cognitoMock.reset();
  _resetCognitoClientForTests();
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});
```

In the existing happy-path delete test (the one that asserts the soft-delete), add assertions after the existing AdminUserGlobalSignOutCommand assertion:

```ts
    const disableCalls = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]!.args[0].input.Username).toBe(targetEmail);
```

(Use whatever variable name the existing test already uses for the target's email — if `target.email` or `'mech-...@test.it'`, reuse it verbatim.)

Add a new test in the same describe block:

```ts
  it('still returns 204 even if AdminDisableUserCommand throws (best-effort)', async () => {
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error('Cognito down'));

    // (Mirror the existing happy-path test fixture: createTenantWithLocation +
    // createUser super_admin + createUser mechanic + signTestToken super_admin)
    const { tenantId, locationId } = await createTenantWithLocation('del-disable-fail');
    const adminSub = `sa-del-disable-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-del-disable@test.it',
      role: 'super_admin',
      locationId,
    });
    const targetSub = `mech-del-disable-${crypto.randomUUID()}`;
    const targetUser = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-del-disable@test.it',
      role: 'mechanic',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetUser.id}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.33.10',
    });

    expect(res.statusCode).toBe(204);

    // Both Cognito calls attempted; only disable failed.
    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });
```

- [ ] **Step 4: Update `users-admin-update.test.ts` mocks + add assertion**

In `packages/api/tests/integration/users-admin-update.test.ts`:

Add `AdminDisableUserCommand` to the imports (line 20–24):

```ts
import {
  AdminDisableUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
```

In the `beforeEach` (line 47–53):

```ts
beforeEach(async () => {
  await resetDb();
  cognitoMock.reset();
  _resetCognitoClientForTests();
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});
```

In the existing test `'calls AdminUserGlobalSignOutCommand when status transitions active → inactive'` (line 370), after the GlobalSignOut assertions:

```ts
    const disableCalls = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]!.args[0].input.Username).toBe('mech-upd-cog@test.it');
```

In the existing test `'does NOT call AdminUserGlobalSignOutCommand on role-only PATCH (status unchanged active)'` (line 412), after the signOut zero-call assertion:

```ts
    const disableCallsRoleOnly = cognitoMock.commandCalls(AdminDisableUserCommand);
    expect(disableCallsRoleOnly).toHaveLength(0);
```

Add a new test in the same `describe` block (after line 410):

```ts
  it('still returns 200 even if AdminDisableUserCommand throws (best-effort)', async () => {
    // Default signout success; only disable fails.
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error('Cognito down'));

    const { tenantId, locationId } = await createTenantWithLocation('upd-disable-fail');

    const adminSub = `sa-upd-disable-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-disable@test.it',
      role: 'super_admin',
      locationId,
    });
    const targetSub = `mech-upd-disable-${crypto.randomUUID()}`;
    const targetUser = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-disable@test.it',
      role: 'mechanic',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${targetUser.id}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.33.11',
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(200);

    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Run only the cognito-disable unit test locally**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/cognito-disable.test.ts
```

Expected: PASS (3 cases).

Integration tests run on CI per `feedback_skip_local_integration_tests`.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-delete.ts
git add packages/api/src/routes/v1/users-admin-update.ts
git add packages/api/tests/integration/users-admin-delete.test.ts
git add packages/api/tests/integration/users-admin-update.test.ts
git commit -m "$(cat <<'EOF'
feat(api): disableOfficineUser on inactivation (Item 5)

Wire AdminDisableUser as best-effort sibling of AdminUserGlobalSignOut
on:
  - DELETE /v1/users/:id (soft-delete)
  - PATCH /v1/users/:id with status: active→inactive

signOutOfficineUser invalidates refresh tokens (closes active-token
window). disableOfficineUser blocks AdminInitiateAuth (closes re-login
window). Re-login attempts now surface Cognito's native "User is
disabled" — frontend treats this identically to a wrong password,
preserving anti-enum.

Closes the post-deactivation login loop discovered in PR #115 smoke
runbook (see feedback_disabled_user_login_loop_ux memory).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CDK Lambda IAM grant + main-stack tests

**Files:**
- Modify: `infrastructure/lib/constructs/lambda-api.ts:90-99`
- Modify: `infrastructure/tests/main-stack.test.ts:220-238`

**Goal:** Add `cognito-idp:AdminUserGlobalSignOut` (PR1 oversight — see Critical adaptation #5) AND `cognito-idp:AdminDisableUser` (Item 5 new) to the Lambda execution role's IAM policy. Update the CDK assertion test.

- [ ] **Step 1: Update `lambda-api.ts` IAM action list**

Modify `infrastructure/lib/constructs/lambda-api.ts` lines 88–100:

```ts
// before:
//   executionRole.addToPolicy(
//     new iam.PolicyStatement({
//       actions: [
//         'cognito-idp:AdminGetUser',
//         'cognito-idp:AdminCreateUser',
//         'cognito-idp:AdminSetUserPassword',
//         'cognito-idp:AdminUpdateUserAttributes',
//         'cognito-idp:AdminDeleteUser',
//         'cognito-idp:ListUsers',
//       ],
//       resources: [props.officineUserPoolArn, props.clientiUserPoolArn],
//     }),
//   );

// after:
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:ListUsers',
        ],
        resources: [props.officineUserPoolArn, props.clientiUserPoolArn],
      }),
    );
```

- [ ] **Step 2: Update `main-stack.test.ts` IAM assertions**

Modify `infrastructure/tests/main-stack.test.ts` lines 220–239:

```ts
// before:
//   it('execution role has secretsmanager:GetSecretValue, the 4 cognito-idp:Admin* actions, and s3:GetObject + s3:PutObject', () => {
//     ...
//     expect(allActions).toContain('cognito-idp:AdminGetUser');
//     expect(allActions).toContain('cognito-idp:AdminCreateUser');
//     expect(allActions).toContain('cognito-idp:AdminUpdateUserAttributes');
//     expect(allActions).toContain('cognito-idp:ListUsers');

// after:
  it('execution role has secretsmanager + cognito-idp Admin* + ListUsers + s3:GetObject + s3:PutObject', () => {
    // Find the inline policy attached to the execution role and check its
    // statements. Presence: secretsmanager:GetSecretValue + cognito-idp
    // Admin/List actions (CRUD + SignOut + Disable for F-OFF-004 PR1/PR2) +
    // s3:GetObject + s3:PutObject (pre-emptive grant added in PR 23).
    const policies = template.findResources('AWS::IAM::Policy');
    const inlineStatements = Object.values(policies).flatMap(
      (res) => res.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>,
    );
    const allActions = inlineStatements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(allActions).toContain('secretsmanager:GetSecretValue');
    expect(allActions).toContain('cognito-idp:AdminGetUser');
    expect(allActions).toContain('cognito-idp:AdminCreateUser');
    expect(allActions).toContain('cognito-idp:AdminSetUserPassword');
    expect(allActions).toContain('cognito-idp:AdminUpdateUserAttributes');
    expect(allActions).toContain('cognito-idp:AdminDeleteUser');
    expect(allActions).toContain('cognito-idp:AdminDisableUser');
    expect(allActions).toContain('cognito-idp:AdminUserGlobalSignOut');
    expect(allActions).toContain('cognito-idp:ListUsers');
    expect(allActions).toContain('s3:GetObject');
    expect(allActions).toContain('s3:PutObject');
  });
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/lib/constructs/lambda-api.ts
git add infrastructure/tests/main-stack.test.ts
git commit -m "$(cat <<'EOF'
fix(infra): grant lambda cognito AdminDisableUser + AdminUserGlobalSignOut

Two missing actions on the Lambda execution role's cognito-idp policy:

  - AdminUserGlobalSignOut — used by signOutOfficineUser since PR #115
    (Item 1 reactive auth). Was missing from the IAM grant; calls were
    silently 403-ing in prod (best-effort try/catch swallowed the error).
    Smoke step 2 still passed because the reactive tenant-context lookup
    closes the window at the API surface independently — but the
    Cognito-side refresh-token invalidation was not actually happening.

  - AdminDisableUser — new for PR2 Item 5 (disableOfficineUser helper).
    Blocks re-login attempts after deactivation, closing the UX
    papercut surfaced during PR #115 smoke.

main-stack.test.ts updated to assert both actions are present in the
synthesized policy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Docs + smoke runbook

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md`
- Create or modify: `docs/superpowers/runbooks/F-OFF-004-smoke.md` (verify existence first)

**Goal:** Document the hash-at-rest invariant on BR-206/BR-220 and add a smoke runbook section for PR2.

- [ ] **Step 1: Check if smoke runbook exists**

```bash
ls docs/superpowers/runbooks/ 2>/dev/null || echo "no runbooks dir"
```

If the directory exists and `F-OFF-004-smoke.md` exists, append a "PR2" section. Otherwise create a new minimal runbook file documenting just PR2.

- [ ] **Step 2: Add APPENDICE_F footnote**

Find the BR-206 entry in `docs/APPENDICE_F_BUSINESS_LOGIC.md`:

```bash
grep -n "BR-206" docs/APPENDICE_F_BUSINESS_LOGIC.md | head
```

Append a footnote to the BR-206 entry (or to the BR-220 entry if that's where invitation-creation rules live):

```markdown
> **Token storage** (post PR2, 2026-05-20): the magic-link token is hashed (SHA-256) at-rest in `invitations.token_hash`. The plaintext exists only in the magic-link URL emitted via SES and in the AcceptInvitation request body. Operator CLI `scripts/admin/get-invitation-link.ts` rotates the token on each invocation. See `docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md`.
```

- [ ] **Step 3: Create or append smoke runbook**

If new file, create `docs/superpowers/runbooks/F-OFF-004-smoke.md`:

```markdown
# F-OFF-004 Smoke Runbook

Operator-driven post-deploy verification for the F-OFF-004 multi-user
management feature and its follow-up PRs.

## PR2 (token hashing + AdminDisableUser) — 2026-05-20

### Pre-flight

```sql
-- Count pending internal_user invitations before migration deploy.
-- If N > 0, list affected emails and notify them; re-invite after deploy.
SELECT count(*) FROM invitations
WHERE invitation_type = 'internal_user' AND accepted_at IS NULL;
```

### Step 1 — Migration 0016 applied

Connect to prod DB and verify:

```sql
\d invitations
```

Expected: `token_hash` column present (varchar(64), nullable), no `token`
column, index `invitations_token_hash_key` partial unique on `token_hash`.

### Step 2 — Item 5 verification (AdminDisableUser fixes login loop)

1. Super_admin logs into web app, navigates to `/settings/users`.
2. Deactivate an existing test mechanic (or create+accept an invitation
   first to set up the target).
3. In an incognito window, attempt login with mechanic's credentials.

Expected: Cognito surfaces "Email o password non corretti" (same as a
wrong password). No loop on "Sessione Scaduta". Anti-enum preserved.

### Step 3 — Item 4 verification (operator CLI rotate-on-extract)

1. Super_admin creates a new invitation for `pr2-smoke@test.it`.
2. Operator runs:

```bash
pnpm tsx scripts/admin/get-invitation-link.ts pr2-smoke@test.it
```

Expected: URL like `https://app.garageos.aifollyadvisor.com/invitations/<68-char-token>`.

3. Run the script a SECOND time. Expected: a different URL.
4. Open the FIRST URL — expected: AcceptInvitation page shows "Invito non valido o già scaduto" (404 anti-enum).
5. Open the SECOND URL — expected: AcceptInvitation page renders with pre-filled email/name.
6. Complete the accept flow. Verify the DB row:

```sql
SELECT id, target_email, token_hash, accepted_at FROM invitations
WHERE target_email = 'pr2-smoke@test.it';
```

Expected: `token_hash` is a 64-char hex string, `accepted_at` is set.

7. Verify audit rows:

```sql
SELECT action, metadata FROM audit_logs
WHERE entity_type = 'invitation' AND action LIKE '%token%'
ORDER BY created_at DESC LIMIT 5;
```

Expected: `invitation_token_rotated_by_operator` rows for steps 2 and 3.

### Status

- [ ] Step 1 — schema verified
- [ ] Step 2 — disable+login behavior verified
- [ ] Step 3 — CLI rotate-on-extract verified
- [ ] Pending invitations re-invited (if pre-flight N > 0)
```

If the file already exists, append the `## PR2 (token hashing + AdminDisableUser) — 2026-05-20` section to it.

- [ ] **Step 4: Commit**

```bash
git add docs/APPENDICE_F_BUSINESS_LOGIC.md
git add docs/superpowers/runbooks/F-OFF-004-smoke.md
git commit -m "$(cat <<'EOF'
docs(api,infra): PR2 — token hash storage note + smoke runbook

APPENDICE_F BR-206 footnote on hash-at-rest invariant. New (or
appended) F-OFF-004 smoke runbook section covering migration deploy
verification, Item 5 disable+login behavior, and Item 4 CLI
rotate-on-extract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Run all unit tests added in this PR**

```bash
pnpm --filter @garageos/api vitest run packages/api/tests/unit/lib/secure-tokens.test.ts packages/api/tests/unit/lib/cognito-disable.test.ts
```

Expected: 11 passing (3 + 4 + 1 + 3 cases).

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/pr2-token-hash-admin-disable
gh pr create --title "feat(api,database,infra): F-OFF-004 follow-ups bundle PR2 (token hashing + AdminDisableUser)" --body "$(cat <<'EOF'
## What

F-OFF-004 follow-ups bundle PR2. Closes:
- **Item 4** — hash invitation tokens at-rest (mirror `email_verifications.token_hash`); migration 0016 tombstones in-flight pending invitations; operator CLI rotates on each invocation with audit.
- **Item 5** — `AdminDisableUser` on soft-delete + status active→inactive transition (sibling of existing `signOutOfficineUser`); breaks the post-deactivation login loop discovered in PR #115 smoke.
- **PR1 IAM oversight** — adds missing `cognito-idp:AdminUserGlobalSignOut` to Lambda execution role; PR #115 was calling it without permission (silently 403-ing in best-effort try/catch).

## Why

- F-OFF-004 spec §Risk: "Token plaintext stored in invitations.token (vs hashed in email_verifications)" — explicit deferral target.
- `feedback_disabled_user_login_loop_ux` memory: PR #115 smoke surfaced "Sessione Scaduta" loop on disabled-user login attempts.

## Implementation notes

- `lib/secure-tokens.ts` consolidates SHA-256 token helpers; `lib/email-verification.ts` becomes a re-export shim (no churn for existing callers).
- Migration 0016: nullable `token_hash` + partial unique index `WHERE token_hash IS NOT NULL` (no pgcrypto dependency).
- Operator CLI rotate-on-extract is documented in commit + script header; each invocation invalidates prior URLs.
- Reactivation flow (`AdminEnableUser`) deferred — blocked on 3 open product questions in `project_user_reactivation_open_questions` memory.

## Tests

- [x] Unit tests added (`secure-tokens.test.ts` + `cognito-disable.test.ts`)
- [x] Integration tests updated (`users-invitations-create`, `users-admin-delete`, `users-admin-update`, new `migrations-0016`)
- [x] CDK synth test updated (`main-stack.test.ts` IAM assertions)
- [ ] Smoke runbook §PR2 (post-deploy operator manual verification)
- [x] BRs verified: BR-206 (partial unique survives column rename), BR-220 (hash-at-rest invariant)

## Checklist

- [x] Code follows conventions in CONTRIBUTING.md
- [x] Types compile (`pnpm -r typecheck`)
- [x] No new `console.log`, no commented-out code
- [x] Secrets not committed
- [x] Documentation updated (APPENDICE_F footnote, smoke runbook)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 4: Watch CI**

```bash
gh pr checks --watch
```

Expected: all checks green. If any fail, diagnose and push a fix-up commit (do not amend).

- [ ] **Step 5: Update resume checkpoint memory**

After merge, update `project_resume_checkpoint.md` with the new HEAD + smoke section.

---

## Self-Review

### Spec coverage check

| Spec section | Task |
|--------------|------|
| §1 In-scope Item 4 hashing | Tasks 1, 2, 3, 4 |
| §1 In-scope Item 5 disable | Tasks 5, 6, 7 |
| §1 In-scope migration tombstone | Task 1 |
| §1 In-scope operator CLI rotation | Task 4 |
| §1 In-scope IAM grant | Task 7 (also adds the PR1 oversight) |
| §1 Out-of-scope reactivation | N/A — deferred, mentioned in commits + spec |
| §2.1 Why hash | Task 1 commit + spec footnote |
| §2.2 Why expire-all | Task 1 migration SQL Step 1 |
| §2.3 Why disable AND sign-out | Task 6 routes + Task 5 helper + Task 7 IAM |
| §2.4 Why rotate-on-extract | Task 4 CLI |
| §3 Files (new + edited) | All tasks |
| §4.1 disableOfficineUser interface | Task 5 |
| §4.2 generateInvitationToken interface | Task 2 |
| §4.3 Migration SQL | Task 1 |
| §4.4 Route patches | Task 3 |
| §4.5 Operator CLI | Task 4 |
| §4.6 IAM grant | Task 7 |
| §5 Error mapping | No new code — anti-enum reuse documented in commits |
| §6.1 Unit tests | Tasks 2, 5 |
| §6.2 Integration tests | Tasks 1 (migration), 3 (invitations), 6 (admin-delete + admin-update) |
| §6.3 CLI smoke (manual) | Task 8 runbook §3 |
| §6.4 Smoke runbook | Task 8 |
| §7 Risks — every row | Reflected in task commit messages |

No gaps found.

### Placeholder scan

Searched the plan for: "TBD", "TODO", "fill in", "appropriate", "similar to", "etc.", "etc". None found in step bodies. The only intentional condition is in Task 8 Step 1 (the `if file exists` check is documented inline) and Task 4 Step 1 (the path-A vs path-B branch for cross-package import is documented with the chosen default).

### Type consistency check

- `tokenHash` (Prisma field) ↔ `token_hash` (SQL column) — consistent across Tasks 1, 3, 4, 8.
- `hashToken(s: string): string` ↔ used in Tasks 3 (routes) and 4 (CLI) — matches signature in Task 2.
- `generateInvitationToken(): { plaintext, hash }` ↔ used in Tasks 3, 4 — matches signature in Task 2.
- `disableOfficineUser({ poolId, email })` ↔ used in Task 6 — matches Task 5 signature.
- `AdminDisableUserCommand` import path consistent across Tasks 5, 6.

No drift.

### Scope check

8 tasks, ~480 LOC implementation + ~260 LOC tests = ~740 LOC gross. Single PR feasible. No decomposition needed.

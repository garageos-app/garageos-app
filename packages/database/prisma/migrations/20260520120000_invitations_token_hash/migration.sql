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

-- Step 2: emit one audit row per tombstoned invitation. NOW() is invariant
-- within a single transaction (Prisma wraps migrations in one), so every row
-- Step 1 just tombstoned has accepted_at = NOW() exactly. Equality predicate
-- removes the theoretical false-positive of auditing a pre-existing accept.
INSERT INTO audit_logs (
  id, tenant_id, actor_type, action, entity_type, entity_id, metadata, ip_address, created_at
)
SELECT
  gen_random_uuid(),
  tenant_id,
  'system'::"AuditActorType",
  'user_invitation_expired_by_migration',
  'invitation',
  id,
  jsonb_build_object('reason', 'token_hashing_migration_0016'),
  NULL,
  NOW()
FROM invitations
WHERE invitation_type = 'internal_user'
  AND accepted_at IS NOT NULL
  AND accepted_at = NOW();

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

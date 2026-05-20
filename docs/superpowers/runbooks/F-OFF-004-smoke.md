# F-OFF-004 Smoke Runbook

Operator-driven post-deploy verification for the F-OFF-004 multi-user
management feature and its follow-up PRs.

## PR2 (token hashing + AdminDisableUser) — 2026-05-20

### Pre-flight

⚠️ **CDK deploy gate**: this PR adds new IAM permissions (`cognito-idp:AdminUserGlobalSignOut` + `cognito-idp:AdminDisableUser`). After merge, wait for the `deploy-infrastructure` GitHub Actions workflow to complete (~5-7 min) before running Step 2. Until CDK has redeployed the Lambda execution role, the new Cognito calls will 403 silently in best-effort try/catch and the smoke step will appear to succeed for the wrong reason.

Also count pending internal_user invitations before migration deploy:

```sql
SELECT count(*) FROM invitations
WHERE invitation_type = 'internal_user' AND accepted_at IS NULL;
```

If N > 0, list affected emails and notify those users; re-invite after deploy. Migration 0016 tombstones all pending internal_user invitations.

### Step 1 — Migration 0016 applied

Connect to prod DB and verify:

```sql
\d invitations
```

Expected: `token_hash` column present (varchar(64), nullable), no `token` column, index `invitations_token_hash_key` partial unique on `token_hash` WHERE NOT NULL.

### Step 2 — Item 5 verification (AdminDisableUser fixes login loop)

(Run only after CDK deploy completed.)

1. Super_admin logs into web app, navigates to `/settings/users`.
2. Deactivate an existing test mechanic (or create+accept an invitation first to set up the target).
3. In an incognito window, attempt login with mechanic's credentials.

Expected: Cognito surfaces "Email o password non corretti" (same as a wrong password). No loop on "Sessione Scaduta". Anti-enum preserved at the API surface.

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

Expected: `user_invitation_token_rotated` rows for steps 2 and 3 with `metadata.actor = 'operator_cli'`.

### Status

- [ ] Pre-flight pending count < N or affected users notified
- [ ] Step 1 — schema verified
- [ ] Step 2 — disable+login behavior verified (after CDK deploy)
- [ ] Step 3 — CLI rotate-on-extract verified
- [ ] Pending invitations re-invited (if pre-flight N > 0)

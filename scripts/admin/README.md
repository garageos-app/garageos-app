# scripts/admin

Operator-only scripts for production troubleshooting and SES-sandbox workarounds.
These scripts require `DIRECT_URL` (Supabase direct connection string) and must
**never** be committed with real credentials.

Run from the repo root using `pnpm tsx scripts/admin/<script>.ts`.

---

## get-invitation-link.ts

Rotate the invitation token and print a fresh magic-link URL for a pending
F-OFF-004 internal-user invitation when SES sandbox/limbo prevented delivery.

### Post-PR2 behavior — rotate on extract

Post-PR2 the DB stores only `token_hash` (SHA-256 of plaintext), so the script
can no longer read the existing plaintext. Instead, each invocation:

1. Generates a **new** plaintext token + hash.
2. UPDATEs the invitation row with the new `token_hash`.
3. Emits an `audit_logs` row with action `user_invitation_token_rotated` and
   `metadata: { reason: 'ses_sandbox_workaround', actor: 'operator_cli' }`.
4. Prints the new URL to stdout.

**Each invocation invalidates any previously-printed URL** for the same
invitation. This is acceptable for the SES-limbo workflow where the operator
delivers each URL out-of-band exactly once: if a URL is lost, re-run the
script to mint a fresh one (the prior URL is now dead).

### Usage

```powershell
$env:DIRECT_URL = "<Supabase Direct connection string>"
pnpm tsx scripts/admin/get-invitation-link.ts mario@example.com
# or with explicit tenant:
pnpm tsx scripts/admin/get-invitation-link.ts mario@example.com --tenant abc-uuid
```

### Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | New URL printed to stdout (token rotated, audit row written)               |
| 1    | No pending invitation (or email arg missing)                               |
| 2    | Multiple tenants have a pending invitation for this email — pass --tenant  |
| 3    | DIRECT_URL missing or DB error                                             |

# scripts/admin

Operator-only scripts for production troubleshooting and SES-sandbox workarounds.
These scripts require `DIRECT_URL` (Supabase direct connection string) and must
**never** be committed with real credentials.

Run from the repo root using `pnpm tsx scripts/admin/<script>.ts`.

---

## get-invitation-link.ts

Fetch the magic-link URL for a pending F-OFF-004 internal-user invitation when SES
sandbox prevented delivery.

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
| 0    | URL printed to stdout                                                      |
| 1    | No pending invitation (or email arg missing)                               |
| 2    | Multiple tenants have a pending invitation for this email — pass --tenant  |
| 3    | DIRECT_URL missing or DB error                                             |

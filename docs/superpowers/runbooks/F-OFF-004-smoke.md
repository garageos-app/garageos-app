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

---

## §PR3 — Reactivation flow smoke (2026-05-21 slice)

**Setup**: web app prod, Super Admin loggato (es. `admin@demo-giuseppe.test`), almeno un mechanic attivo `mechanic-secondary@demo-giuseppe.test` + 1 location secondaria active in tenant Giuseppe.

1. `/settings/users` → identifica `mechanic-secondary@demo-giuseppe.test`.
2. Click row → EditUserDialog → click "Disattiva utente" → step conferma → "Conferma disattivazione". Verifica: user in sezione inactive nel list.
3. Click row inactive → EditUserDialog → vedi nuova section "Riattiva utente" (NON la notice "non ancora supportata" vecchia).
4. Click "Riattiva utente" → step conferma con preview email + ruolo IT + nome sede.
5. Click "Conferma riattivazione" → toast success → dialog close → list refresh.
6. Verifica: user di nuovo in sezione active, locationId originale, role originale.
7. Logout admin. Login con `mechanic-secondary@demo-giuseppe.test` + password pre-deactivation → access granted.
8. **Edge location stale**: come admin, ri-disattiva il mechanic. Vai a `/settings/locations` (se UI esiste) e disattiva la sua sede originale, OPPURE esegui manualmente:
   ```sql
   UPDATE locations SET status='inactive'::"LocationStatus", deleted_at=NOW() WHERE id='<L1-uuid>';
   ```
   Ri-apri EditUserDialog sul user inactive → click "Riattiva utente" → conferma. Vedi messaggio "Sede non valida" + dropdown "Seleziona nuova sede" → seleziona L2 → "Conferma riattivazione" → success.
9. **Edge already_active**: replay POST via curl:
   ```bash
   curl -X POST https://api.garageos.aifollyadvisor.com/v1/users/<active-user-id>/reactivate \
        -H "Authorization: Bearer $SUPER_ADMIN_JWT" \
        -H "Content-Type: application/json" \
        -d '{}'
   ```
   Expected: `422 user.already_active`.
10. **Soft-deleted re-invite 409**: come Super Admin, prova a invitare di nuovo `mechanic-secondary@demo-giuseppe.test` mentre è soft-deleted → POST `/v1/users/invitations` → `409 user.invitation.email_soft_deleted_in_tenant`. UI mostra "Riattivalo da Impostazioni → Utenti".
11. **Cross-tenant 409**: SOLO se esiste un secondo tenant nel seed pilot. Come Super Admin di tenant B, prova a invitare `mechanic-test@demo-giuseppe.test` → POST `/v1/users/invitations` → `409 user.invitation.email_in_other_tenant`. Se nessun tenant secondario è disponibile, **skip lo step** + nota che l'invariante è coperta da test integration `users-invitations-create.test.ts`.
12. **Cleanup**: ripristina seed state (mechanic-secondary attivo, L1 ripristinata se toccata, eventuali invitation row create eliminate via DB).

**Esito atteso**: 0 Critical, 0 Important, eventualmente Minor sulla copy IT del messaggio.

# User Reactivation Design (F-OFF-004 follow-up)

**Status**: Approved 2026-05-21
**Brainstorm session**: 2026-05-21
**Author**: Michele + assistant
**Feature**: F-OFF-004 reactivation slice (chiude le 3 open product questions)
**Master spec ref**: `docs/GarageOS-Specifiche.md` §3 F-OFF-004
**Closes memo**: [[project_user_reactivation_open_questions]]
**Companion plan** (will be created next): `docs/superpowers/plans/2026-05-21-user-reactivation.md`

---

## 1. Scope

### 1.1 In-scope (v1)

- Nuovo endpoint `POST /v1/users/:id/reactivate` (Super Admin only): inverte la soft-delete su una `User` row nel proprio tenant.
  - DB: `UPDATE users SET deletedAt=NULL, status='active'` + optional override `role`/`locationId`.
  - Cognito: `AdminEnableUser` best-effort + opzionale `AdminUpdateUserAttributes` se override role/location.
  - Audit log: action `user_reactivated` con metadata.
- Body opzionale `{role?, locationId?}` per override esplicito al reactivate-time.
- Validazione `locationId`: la sede preservata (o quella passata in body) deve essere `active` + `deletedAt=null`. Se stale → 422 `user.location_invalid`. BR-204 ricontrollato.
- Frontend `EditUserDialog.tsx`: sostituire l'attuale `inactive-notice` (righe 213-219) con nuovo componente `<ReactivateSection>` 2-step, simmetrico al pattern `Disattiva` esistente.
- Cross-tenant early-detection in `POST /v1/users/invitations`: chiamata Cognito `AdminGetUser` per email. Se utente esiste nel pool ma nessuna `User` row nel tenant chiamante → 409 `user.invitation.email_in_other_tenant`. Niente invitation row, niente SES.
- BR-211 (NEW) "Riattivazione utente" + BR-212 (NEW) "Cross-tenant single-pool" + BR-207 wording update in `APPENDICE_F`.
- 3 nuovi error code in `APPENDICE_G`: `user.already_active` (422), `user.invitation.email_in_other_tenant` (409), `user.invitation.email_soft_deleted_in_tenant` (409).
- Endpoint docs in `APPENDICE_A`.
- Smoke runbook §PR3 in `docs/superpowers/runbooks/F-OFF-004-smoke.md`.

### 1.2 Out-of-scope (deferred)

- **Cross-tenant cohabitation (scenario B)**: meccanico X attivo simultaneamente in Officina A e Officina B (o trasferimento A→B con A active). Tracciato come `F-OFF-XXX` futuro. Richiederebbe rearchitect Cognito (pool-per-tenant o list-attribute `custom:tenant_ids`).
- **Self-reactivation**: utente disattivato non può loggarsi (Cognito disabled). No `POST /users/me/reactivate`.
- **Invite-resurrect flow**: re-invitare same email post-deactivation per riattivare via accept-flow. Deferred (path operator-driven scelto).
- **Reactivation rate-limit**: skip — azione admin-side controllata da `requireSuperAdmin`, frequenza naturalmente bassa.
- **Audit log viewer UI**: tech debt LOW preesistente, non affrontato qui.

### 1.3 Documentation reconciliation

- BR-207 esistente dice "soft delete `status=inactive` + `deleted_at`" senza menzionare reversibilità. Aggiungere clausola "La rimozione è reversibile via BR-211 nello stesso tenant."
- BR-211 documenta esplicitamente la reactivation + vincolo same-tenant.
- BR-212 documenta esplicitamente la limitazione Cognito single-pool (email globally unique) e la conseguente impossibilità di cross-tenant cohabit in v1.

---

## 2. Architecture

### 2.1 Flow happy path

```
[Super Admin]                           [API]                       [Cognito]
    │ /settings/users → click row "X"     │                            │
    │ EditUserDialog opens (X.status=inactive)
    │ Click "Riattiva utente"             │                            │
    │   → step "Conferma riattivazione"   │                            │
    │   (preview: email, role, location;  │                            │
    │    Select sede se locationId stale) │                            │
    │ Click "Conferma"                    │                            │
    │ ─ POST /v1/users/:id/reactivate ─►  │                            │
    │   body: {} | {role?} | {locationId?}│                            │
    │                                     │ Phase 1: DB tx             │
    │                                     │   - lookup target          │
    │                                     │     INCLUDING deletedAt    │
    │                                     │     ≠ NULL                 │
    │                                     │   - guard already_active   │
    │                                     │   - compute newRole,       │
    │                                     │     newLocationId          │
    │                                     │   - BR-204 guard           │
    │                                     │   - location_invalid guard │
    │                                     │   - UPDATE users           │
    │                                     │     deletedAt=NULL         │
    │                                     │     status='active'        │
    │                                     │     [+role][+locationId]   │
    │                                     │   - audit row              │
    │                                     │ Phase 2: Cognito sync      │
    │                                     │   AdminEnableUser ────────►│
    │                                     │   (best-effort try/catch)  │
    │                                     │   On role/location override│
    │                                     │   AdminUpdateUserAttrs ───►│
    │ ◄─── 200 { user: serialized } ─────│                            │
    │ Toast "Utente riattivato"           │                            │
    │ /settings/users list refresh        │                            │
```

### 2.2 Componenti & responsabilità

| Componente | Ruolo |
|---|---|
| `routes/v1/users-admin-reactivate.ts` (NEW) | POST endpoint. Phase 1 DB tx con lookup `deletedAt: { not: null }`. Stesso pattern dei 3 admin routes esistenti (auth chain, `withContext({role:'admin'})`, audit row, actor UUID lookup). |
| `lib/cognito.ts` (EDIT) | Add `enableOfficineUser({poolId, email})` helper — mirror simmetrico di `disableOfficineUser` (PR #116). Wrap `AdminEnableUserCommand`. |
| `lib/cognito.ts` (EDIT) | Add `getOfficineUserByEmail({poolId, email})` helper. Wrap `AdminGetUserCommand`. Restituisce `{exists, sub?, attributes?}`. Throws su errori non-`UserNotFoundException`. |
| `routes/v1/users-invitations-create.ts` (EDIT) | Aggiunge step 1bis (Cognito early-check) tra collision check DB e generazione token. |
| `components/users/EditUserDialog.tsx` (EDIT) | Sostituisce righe 213-219 con `<ReactivateSection user={user}>`. |
| `components/users/ReactivateSection.tsx` (NEW) | 2-step flow component: primary button → confirm step con preview + Select location condizionale. Chiama `useReactivateUser`. |
| `queries/users-admin.ts` (EDIT) | Aggiunge `useReactivateUser` hook. Invalida `users` query on success. |

### 2.3 BR-211, BR-212 (NEW) + BR-207 reconciliation

- **BR-211 Riattivazione utente** (APPENDICE_F §10, dopo BR-210):
  - Super Admin può riattivare un utente soft-deleted (`status=inactive`, `deletedAt IS NOT NULL`) nel proprio tenant.
  - Effetto: `deletedAt=NULL`, `status=active`, Cognito user re-enabled.
  - Vincoli: BR-204 ricontrollato (mechanic → location active obbligatoria).
  - Override `{role?, locationId?}` permesso al reactivate time.
  - Audit: `action='user_reactivated'`.
  - Limitazione cross-tenant: BR-211 non risolve scenario cross-pool (vedi BR-212).
- **BR-207 wording update**: aggiungere clausola "La rimozione è reversibile via BR-211 nello stesso tenant."
- **BR-212 Cross-tenant email collision** (NEW): documenta che Cognito Officine è single-pool quindi email è alias globale. Cross-tenant invite triggera `user.invitation.email_in_other_tenant`. Resurrezione cross-pool è out-of-scope v1.

### 2.4 Sicurezza & invarianti

- **Auth chain**: `requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin` (stesso dei 3 admin routes).
- **RLS**: `withContext({role:'admin'})` necessario per UPDATE su `users` (USING clause require admin).
- **No BR-203 guard**: reactivate aggiunge un active super_admin/mechanic, mai sottrae.
- **No self-reactivation guard**: utente disattivato non può loggarsi (Cognito disabled).
- **Idempotenza**: re-fire POST /reactivate su utente già active → 422 `user.already_active`. Lookup `deletedAt: { not: null }` esclude già il caso, defensive double-check.
- **Cognito orphan recovery**: se `AdminEnableUser` fallisce con `UserNotFoundException` (cancellato out-of-band), DB già committed → log error + header `X-Cognito-Sync-Failed: true` su response. Operator runbook documenta cleanup.

---

## 3. Files

### 3.1 New files

| Path | Responsabilità | Est. LOC |
|---|---|---|
| `packages/api/src/routes/v1/users-admin-reactivate.ts` | `POST /v1/users/:id/reactivate` — 2-phase: DB tx + Cognito enable + optional attribute sync | ~180 |
| `packages/api/tests/integration/users-admin-reactivate.test.ts` | Integration: 10 cases (happy + idempotency + stale location + BR-204 + RLS + audit + override role + override location + cross-tenant 404 + parallel race) | ~280 |
| `packages/api/tests/unit/routes/users-admin-reactivate.test.ts` | Unit con fake-Prisma + Cognito mock | ~120 |
| `packages/web/src/components/users/ReactivateSection.tsx` | 2-step flow component con location-stale dropdown | ~180 |
| `packages/web/src/components/users/ReactivateSection.test.tsx` | JSDOM tests (8 cases) | ~200 |

### 3.2 Edited files

| Path | Cambio | Est. LOC delta |
|---|---|---|
| `packages/api/src/lib/cognito.ts` | + `enableOfficineUser` (~30) + `getOfficineUserByEmail` (~50) | +85 |
| `packages/api/src/routes/v1/users-invitations-create.ts` | Insert step 1bis: Cognito early-check + 502/409 branching | +40 / -2 |
| `packages/api/src/server.ts` | Register `usersAdminReactivateRoutes` | +2 |
| `packages/api/tests/integration/users-invitations.test.ts` | +2 cases: email in other tenant 409, Cognito unavailable 502 | +60 |
| `packages/api/tests/unit/routes/users-invitations-create.test.ts` | +4 cases per Cognito early-check | +80 |
| `packages/web/src/components/users/EditUserDialog.tsx` | Righe 213-219: sostituisce inline notice con `<ReactivateSection>` | +5 / -10 |
| `packages/web/src/components/users/EditUserDialog.test.tsx` | Rinomina test "hides ALL action sections" → "renders ReactivateSection for inactive user" | +20 / -25 |
| `packages/web/src/queries/users-admin.ts` | + `useReactivateUser(id)` hook | +35 |
| `packages/web/src/queries/users-admin.test.tsx` | + 2 cases per `useReactivateUser` | +60 |
| `docs/APPENDICE_F_BUSINESS_LOGIC.md` | + BR-211 + BR-212 + BR-207 wording update | +50 |
| `docs/APPENDICE_G_ERROR_CODES.md` | + `user.already_active` + `user.invitation.email_in_other_tenant` + `user.invitation.email_soft_deleted_in_tenant` | +22 |
| `docs/APPENDICE_A_API.md` | + `POST /v1/users/:id/reactivate` endpoint docs | +60 |
| `docs/superpowers/runbooks/F-OFF-004-smoke.md` | + §PR3 smoke section | +80 |

### 3.3 Migrations

**None.** Schema `User` ha già `deletedAt: DateTime?` e `status: UserStatus`. Reactivation è UPDATE su colonne esistenti.

### 3.4 Totale stimato

- **Gross LOC**: ~1505 (~750 code + ~755 test/docs).
- **Net code-only**: ~590 LOC.
- **Decisione**: PR singola entro 1500 hard limit. Se l'implementazione finale eccede 1800 gross, split in `feat-api` + `feat-web` come fatto post-#111.

---

## 4. Endpoint contracts

### 4.1 `POST /v1/users/:id/reactivate`

**Auth**: `requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin`.
**Rate limit**: nessuno.
**Path params**: `{ id: z.string().uuid() }`.

**Body** (Zod, tutti optional):
```ts
{
  role: z.enum(['super_admin', 'mechanic']).optional(),
  locationId: z.string().uuid().nullable().optional(),
}
```

Body vuoto `{}` valido (caso comune). `locationId: null` esplicito permesso solo se `newRole === 'super_admin'` (BR-204).

**Logic** (transaction, `withContext({role:'admin'})`):

1. **Lookup target** (include soft-deleted):
   ```ts
   tx.user.findFirst({
     where: { id: targetId, tenantId, deletedAt: { not: null } },
     select: { id, email, role, locationId, status, cognitoSub, deletedAt }
   })
   ```
   Not found → `404 user.not_found`.

2. **Idempotency guard** (defensive): `target.status === 'active' && target.deletedAt === null` → `422 user.already_active`. Lookup esclude già il caso ma teniamo per safety.

3. **Compute effective values**:
   ```ts
   const newRole = body.role ?? target.role;
   const newLocationId = body.locationId !== undefined ? body.locationId : target.locationId;
   ```

4. **BR-204 guard**: `newRole === 'mechanic' && !newLocationId` → `422 user.location_required_for_mechanic`.

5. **Location validity** (se `newLocationId` non-null):
   ```ts
   tx.location.findFirst({ where: { id: newLocationId, tenantId, status: 'active', deletedAt: null }})
   ```
   Not found → `422 user.location_invalid`.

6. **DB update**:
   ```ts
   tx.user.update({
     where: { id: targetId },
     data: {
       deletedAt: null,
       status: 'active',
       ...(body.role !== undefined ? { role: body.role } : {}),
       ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
     },
     select: USER_ADMIN_SELECT,
   })
   ```

7. **Audit row**:
   ```ts
   {
     action: 'user_reactivated',
     entityType: 'user',
     entityId: targetId,
     actorId: <actor DB UUID>,
     metadata: {
       targetEmail: target.email,
       previousStatus: target.status,
       previousDeletedAt: target.deletedAt.toISOString(),
       roleOverridden: body.role !== undefined,
       locationOverridden: body.locationId !== undefined,
       newRole, newLocationId,
     }
   }
   ```

8. **Cognito sync** (best-effort, outside transaction):
   - `AdminEnableUser`: try/catch. `UserNotFoundException` o altri errori → log + header `X-Cognito-Sync-Failed: true` su response.
   - `AdminUpdateUserAttributes`: solo se role o locationId override. Same try/catch pattern di `users-admin-update.ts:214-228`.

**Response 200**:
```json
{ "user": { /* USER_ADMIN_SELECT serializer */ } }
```

### 4.2 `POST /v1/users/invitations` — modifica

Due cambiamenti al flow esistente:

**Step 1 ridefinito** (riga ~91 in `users-invitations-create.ts`): rimuovere il filtro `deletedAt: null` e discriminare a posteriori. Lo stato `deletedAt != null` non è uno stato in cui l'invito può procedere — bisogna riattivare, non re-invitare.

```ts
// Step 1: DB lookup nel tenant corrente, INCLUDE soft-deleted.
const existingUser = await tx.user.findFirst({
  where: { tenantId, email: body.email },
  select: { id: true, deletedAt: true },
});
if (existingUser) {
  if (existingUser.deletedAt !== null) {
    throw businessError(
      'user.invitation.email_soft_deleted_in_tenant',
      409,
      'Questa email appartiene a un utente disattivato. Riattivalo da Impostazioni → Utenti.',
    );
  }
  throw businessError(
    'user.invitation.email_already_active',
    409,
    'Un account con questa email esiste già nel sistema. Effettua il login.',
  );
}
```

**Step 1bis (NEW)**: dopo step 1 e prima di generare token (step 3), aggiunge Cognito early-check. Raggiungibile solo se l'email NON esiste affatto nel tenant corrente — quindi un hit Cognito è inequivocabilmente cross-tenant.

```ts
let cognitoUser;
try {
  cognitoUser = await getOfficineUserByEmail({
    poolId: env.COGNITO_OFFICINE_POOL_ID,
    email: body.email,
  });
} catch (err) {
  request.log.error({ err }, 'cognito lookup failed at invitation create');
  throw businessError(
    'auth.cognito_unavailable',
    502,
    'Servizio di autenticazione temporaneamente non disponibile.',
  );
}
if (cognitoUser.exists) {
  throw businessError(
    'user.invitation.email_in_other_tenant',
    409,
    'Questa email risulta già registrata in un\'altra officina. Contatta il supporto.',
  );
}
```

### 4.3 Error mapping additions (APPENDICE_G)

| Code | HTTP | Severity | Message (IT) | Trigger |
|---|---|---|---|---|
| `user.already_active` | 422 | info | "Utente già attivo." | POST /reactivate su utente non soft-deleted (race / replay) |
| `user.invitation.email_in_other_tenant` | 409 | warning | "Questa email risulta già registrata in un'altra officina. Contatta il supporto." | Cognito GetUser hit al POST invitations + no User row in tenant chiamante (any deletedAt) |
| `user.invitation.email_soft_deleted_in_tenant` | 409 | info | "Questa email appartiene a un utente disattivato. Riattivalo da Impostazioni → Utenti." | DB User row exists in tenant con `deletedAt != null` — operator deve usare /reactivate, non /invitations |

Codici riusati: `user.not_found` (404), `user.location_invalid` (422), `user.location_required_for_mechanic` (422), `auth.cognito_unavailable` (502), `user.invitation.email_already_active` (409).

---

## 5. Test plan

### 5.1 Unit tests

**`users-admin-reactivate.test.ts`** (~12 cases, fake-Prisma + Cognito mock):
- Validator: body vuoto / role solo / locationId solo / both.
- BR-204: `role='mechanic'` + `locationId=null` esplicito → 422.
- BR-204: `role='mechanic'` body vuoto + target.locationId esistente → OK.
- Lookup miss (target.deletedAt = null) → 404.
- Lookup cross-tenant → 404.
- `AdminEnableUser` fail `UserNotFoundException` → 200 + log warning.
- `AdminUpdateUserAttributes` fail → 200 (best-effort).
- Audit row emessa con metadata corretta (roleOverridden/locationOverridden flags).

**`users-invitations-create.test.ts`** extensions (~5 cases):
- Cognito GetUser `{exists: true}` + step1 null → 409 `email_in_other_tenant`.
- Cognito GetUser `{exists: false}` → flow continua a step 3 (happy).
- Cognito GetUser throw → 502 `auth.cognito_unavailable`, no DB write.
- Step 1 DB hit same-tenant `deletedAt = null` → 409 `email_already_active`, Cognito non chiamato.
- Step 1 DB hit same-tenant `deletedAt != null` → 409 `email_soft_deleted_in_tenant`, Cognito non chiamato.

### 5.2 Integration tests (real Postgres + Testcontainers)

**`users-admin-reactivate.test.ts`** (~10 cases):
- Happy path: soft-delete user → reactivate body vuoto → status='active', deletedAt=null.
- Override role: soft-deleted mechanic → reactivate `{role:'super_admin', locationId:null}` → OK + audit metadata.
- Override locationId: reactivate `{locationId: 'other-active-uuid'}` → OK.
- Stale location: soft-delete user (locationId=L1) → soft-delete L1 → reactivate body vuoto → 422 `user.location_invalid`. Re-fire con `{locationId: L2}` → 200.
- BR-204: soft-deleted user con locationId=null (edge: super_admin demoted poi soft-deleted) → reactivate `{role:'mechanic'}` → 422.
- Active user (deletedAt null) → 404.
- Cross-tenant target → 404.
- Audit row asserts: action='user_reactivated', actorId DB UUID, metadata fields.
- Idempotency under parallel: 2 paralleli → 1 success + 1 404.
- Mech-test demo: lookup `mechanic-test@demo-giuseppe.test` if soft-deleted from prior runs.

**`users-invitations.test.ts`** extensions (~3 cases):
- Cognito stub `{exists:true}` + no DB user same tenant → 409 `email_in_other_tenant`, no invitation row, no SES send.
- Cognito stub throws → 502, no invitation row.
- Soft-deleted same-tenant user con stessa email → 409 `email_soft_deleted_in_tenant`, no invitation row, no Cognito call.

### 5.3 Web component tests (JSDOM)

**`ReactivateSection.test.tsx`** (~8 cases):
- Renders primary button + preview (email, role IT label, location name).
- Click primary → 2-step transition.
- Confirm step contains "Conferma riattivazione" + "Annulla" + preview.
- Location stale: render Select condizionale; confirm disabled until select.
- Click confirm → calls `useReactivateUser` mutation con payload corretto.
- Mutation success → toast + dialog close + `onSuccess` callback.
- Mutation error `user.location_invalid` → inline error + return to step 1.
- Mutation error `auth.cognito_unavailable` → toast + section open.

**`EditUserDialog.test.tsx`** edits:
- Esistente test riga ~324 "hides ALL action sections" rinominato + adattato: assert `data-testid="reactivate-section"` presente.

**`users-admin.test.tsx`** extensions:
- `useReactivateUser`: POST body shape; success invalidates `['users']`; error mapped.

### 5.4 Smoke runbook (operator post-merge) — `F-OFF-004-smoke.md` §PR3

1. **Setup**: web app prod, Super Admin loggato, almeno un mechanic attivo + 1 location secondaria active.
2. /settings/users → identifica un mechanic attivo target (es. `mechanic-secondary@demo-giuseppe.test`).
3. Click row → EditUserDialog → Disattiva utente → 2-step conferma. Verifica: user in sezione inactive.
4. Click row inactive → EditUserDialog → vedi nuova section "Riattiva utente" (NON la notice vecchia).
5. Click "Riattiva utente" → step conferma con preview email + ruolo + sede.
6. Click "Conferma riattivazione" → toast → dialog close → list refresh.
7. Verifica: user in sezione active, locationId originale, role originale.
8. Login con credenziali pre-deactivation → access granted (vecchia password OK).
9. **Edge location stale**: disattiva user (mechanic, locationId=L1) → soft-delete L1 (manual DB step if no UI) → riattiva → vedi dropdown Cambia sede → seleziona L2 → conferma → success.
10. **Edge already_active**: replay `POST /reactivate` su utente attivo via curl + JWT super_admin → 422 `user.already_active`.
11. **Cross-tenant 409**: come Officina B (tenant secondario) prova a invitare `mechanic-test@demo-giuseppe.test` → POST invitations → 409 `email_in_other_tenant`. UI mostra messaggio IT chiaro. *Precondizione: serve un secondo tenant attivo nel seed pilot. Se assente, lo step è marcato `[skip: serve secondo tenant — creare via signup form se importante]`.*
12. **Soft-deleted re-invite 409**: come Super Admin di Officina Giuseppe, riprovare invito su `mechanic-secondary@demo-giuseppe.test` MENTRE è soft-deleted → 409 `email_soft_deleted_in_tenant`. UI mostra hint "Riattivalo da Impostazioni → Utenti".
13. **Cleanup**: ripristina seed state.

### 5.5 Verification gates pre-merge

- `pnpm -r typecheck` (pre-push hook).
- CI: lint + format + commitlint + cdk-synth + test:unit + test:integration tutti verdi al 1° push (target streak ZERO-critical 17 → 18).
- Final code reviewer agent (entire branch).

---

## 6. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cognito `AdminEnableUser` fail dopo DB commit | Low | Medium | DB source of truth. Header `X-Cognito-Sync-Failed: true`. Operator runbook retry manuale. |
| Location stale alla reactivation | Medium | Low | 422 `user.location_invalid` early. Frontend Select condizionale. |
| Race parallel reactivate | Very Low | Low | Lookup esclude post-commit. Secondo POST → 404. |
| Cognito `AdminGetUser` rate-limit | Low | Low | Cognito 25 RPS default, ben sopra rate-limit invitations (10/hour). |
| Cross-tenant info disclosure via 409 | Low | Low | Messaggio generico, anti-enum preserved come `email_already_active`. |
| BR-211 docs drift | Very Low | Negligible | Doc edit nello stesso PR. |
| `EditUserDialog.test.tsx` regression | Low | Negligible | Test rinominato + adattato nello stesso commit Task 7. |
| Super_admin reactivate abuse | Very Low | Low | Audit log forensic. Skip rate-limit. |
| Cognito pool ID mismatch dev/prod | Very Low | Medium | Riusa `env.COGNITO_OFFICINE_POOL_ID`. |

---

## 7. References

- Master spec: `docs/GarageOS-Specifiche.md` §3 F-OFF-004
- Predecessor spec: `docs/superpowers/specs/2026-05-19-f-off-004-multi-user-design.md`
- BR rules: `APPENDICE_F` §10 (BR-200 ÷ BR-210, + nuovi BR-211, BR-212)
- Pattern reusati:
  - `routes/v1/users-admin-update.ts` per auth chain + audit + actor UUID lookup
  - `routes/v1/users-admin-delete.ts` per Cognito best-effort outside-tx pattern
  - `lib/cognito.ts` `disableOfficineUser` per simmetria `enableOfficineUser`
- Related memories:
  - [[project_user_reactivation_open_questions]] (questo memo viene chiuso post-merge)
  - [[feedback_subagent_driven_review_loop]]
  - [[feedback_smoke_runbook_catches_ux_drift]]
  - [[feedback_per_task_review_misses_production_cascade]]
  - [[feedback_schema_rename_cascade_extends_to_production_code]]
  - [[feedback_prisma_data_xor_defeats_excess_property]]
  - [[feedback_mid_execution_loc_checkpoint]]

---

## 8. Open questions

None. Tutte le 3 open product questions in [[project_user_reactivation_open_questions]] hanno risposta in §1, §4, §2.3:
1. **Same-tenant resurrection**: bottone esplicito "Riattiva" → §2.1 + §4.1.
2. **Cross-tenant cohabit**: forbidden + early-detection → §1.1 (in-scope) + §4.2.
3. **Cognito attributes per-tenant**: non rilevante (cross-tenant v1 vietato) → §1.2 (out-of-scope).

---

## 9. Decomposition preview (finalized nel plan)

7+1 task subagent-driven TDD:

1. `lib/cognito.ts` helpers (`enableOfficineUser` + `getOfficineUserByEmail`) + unit test. ~120 LOC.
2. `routes/v1/users-admin-reactivate.ts` + unit test. ~300 LOC.
3. Integration test `users-admin-reactivate.test.ts` (10 cases). ~280 LOC.
4. `users-invitations-create.ts` cross-tenant early-check + integration + unit extensions. ~140 LOC.
5. `queries/users-admin.ts` `useReactivateUser` hook + test. ~95 LOC.
6. `components/users/ReactivateSection.tsx` + test. ~380 LOC.
7. `EditUserDialog.tsx` integration + test adapt. ~35 LOC.
8. Docs bundle (APPENDICE_F + G + A + smoke runbook §PR3). ~205 LOC.
9. Final code reviewer agent (entire branch) — gate prima del push.

**Sequenziamento**: 1 → 2 → 3 ∥ 4 (Cognito helper pronto). 5 → 6 → 7 sequenziali. 8 ∥ dopo task 2.

**Stop-and-split threshold**: cumulative LOC ≥1800 gross post-task 6 → halt + propose split.

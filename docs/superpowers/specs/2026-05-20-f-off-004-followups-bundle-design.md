# F-OFF-004 follow-ups bundle — Design

**Status:** Draft
**Author:** Michele Matula (con Claude)
**Created:** 2026-05-20
**Bundle:** PR1 di 2 (PR2 = Item 4 token hashing, deferred)

## Sommario

Cleanup bundle post-F-OFF-004 (PR #111). Affronta 3 follow-up scoperti durante smoke runbook §6.4 e final review della slice multi-user management:

1. **Item 1 — `requireAuth` status check** (security regression HIGH)
2. **Item 2 — `SELECT FOR UPDATE` BR-203** (race correctness MEDIUM-HIGH)
3. **Item 3 — APPENDICE_F BR-206 wording reconciliation** (doc drift LOW)

Item 4 (invitation token hashing) deferred a un PR separato perché ha migration + decisione "expire all pending" + coordinamento operator.

## Motivazione per item

### Item 1 — `requireAuth` status check

**Problema:** dopo F-OFF-004, un super_admin può soft-deletare o disattivare un altro utente (`status='inactive'`, `deletedAt` popolato). Ma `packages/api/src/middleware/require-auth.ts` verifica soltanto JWT (firma + expiry + audience). Non fa lookup DB su `users.status` / `deletedAt`. Conseguenza: l'utente disattivato conserva accesso API per tutta la durata del suo access token Cognito (default ~1h).

L'operator UX (PR #113 hide deactivate button su inactive, PR #114 hide edit form su inactive) suggerisce "disattivato = fuori subito", ma in realtà c'è una finestra ~1h. **Security regression introdotta da F-OFF-004.**

**Soluzione:** belt-and-braces.
- **Reactive (middleware, source of truth):** lookup `users` per ogni richiesta officine. Se `status != 'active'` o `deletedAt != null` → 401.
- **Proactive (Cognito-side, UX):** invalida refresh token via `AdminUserGlobalSignOut` su soft-delete e su PATCH `status='inactive'`. Refresh tokens diventano invalidi immediatamente.

### Item 2 — `SELECT FOR UPDATE` BR-203

**Problema:** `users-admin-delete.ts:69-77` e `users-admin-update.ts:99-107` enforce BR-203 (almeno un super_admin attivo) con `tx.user.count(...)` dentro una tx Prisma. Sotto Read Committed (Postgres default), il count è uno snapshot al momento del SELECT — non locka le righe candidate. Due tx concorrenti che disattivano/demotano gli ultimi due super_admin possono entrambe vedere `remaining=1` e procedere, lasciando il tenant orfano.

**Soluzione:** `SELECT ... FOR UPDATE` esplicito sulle righe degli altri super_admin attivi prima del check. La seconda tx concorrente blocca finché la prima committa, poi vede stato aggiornato e fallisce con 409 `user.last_super_admin`.

### Item 3 — APPENDICE_F BR-206 wording

**Problema:** `docs/APPENDICE_F_BUSINESS_LOGIC.md` §11 BR-206 step 2 dice "Sistema crea `user` con `status=invited`, `cognito_sub=NULL`". F-OFF-004 implementato diversamente: l'invito crea SOLO una riga `invitations` (no `user` row, no `status=invited` enum value). La riga `users` viene creata su accept post-Cognito-signup con `status='active'` e `cognito_sub` popolato.

**Soluzione:** doc edit di allineamento al flow effettivo. No code change.

## Architettura

### Item 1 — Layered approach

```
JWT verify (requireAuth)
    │
    ▼
tenant-context (parse Cognito claims)
    │
    ▼
[NEW] users.findFirst({cognitoSub, tenantId, status:'active', deletedAt:null})
    │
    │── null  ──▶ throw 401 Unauthorized
    │
    ▼
route handler
```

**Posizione:** dentro `tenant-context.ts` (officine-only). Razionale: il middleware ha già `cognitoSub` + `tenantId` parsati dal JWT, e il check è officine-specifico (i customer della pool clienti non sono soft-deletable da F-OFF-004 — quel flow non li tocca).

**Query Prisma:**
```ts
const userRow = await prisma.user.findFirst({
  where: {
    cognitoSub: parsed.data.sub,
    tenantId: parsed.data['custom:tenant_id'],
    status: 'active',
    deletedAt: null,
  },
  select: { id: true },
});
if (!userRow) {
  throw unauthorizedError('User inactive or not found');
}
```

**Costo perf:** +1 query per richiesta officine. Index esistente su `users(cognito_sub)`. Su pilot (target <50 req/min) trascurabile. Future optimization (LRU cache cognitoSub→status, TTL 30s) deferred — non in questo bundle.

**Response shape:** 401 `Unauthorized` (stesso name pattern degli altri JWT failure). NO nuovo error code — evita info leak che distingue "JWT scaduto" da "utente disattivato". Detail log lato server.

**Cognito proactive (out-of-tx, best-effort):**
- `users-admin-delete.ts` post-tx: `cognitoClient.send(new AdminUserGlobalSignOutCommand({UserPoolId, Username: target.cognitoSub}))`. Se fallisce: log error, NO rollback DB. DB è source of truth.
- `users-admin-update.ts` post-tx: chiamata **separata** a `AdminUserGlobalSignOutCommand` (in aggiunta all'esistente `updateOfficineUserRoleAndLocation`), fired condizionalmente su transizione `target.status === 'active' && body.status === 'inactive'`. Stesso pattern try/catch best-effort. Se PATCH cambia anche role/location, le due chiamate sono indipendenti (entrambe possono fallire/succedere).

Skip se `target.cognitoSub == null` (utente mai accettato invito).

### Item 2 — `SELECT FOR UPDATE` query

Sostituisce in **entrambi** i path:

```ts
// PRIMA (race-prone):
const remaining = await tx.user.count({
  where: {
    tenantId, role: 'super_admin', status: 'active',
    deletedAt: null, id: { not: targetId },
  },
});
if (remaining === 0) throw ...

// DOPO (race-safe):
const locked = await tx.$queryRaw<Array<{ id: string }>>`
  SELECT id FROM users
  WHERE tenant_id = ${tenantId}::uuid
    AND role = 'super_admin'
    AND status = 'active'
    AND deleted_at IS NULL
  FOR UPDATE
`;
if (locked.length <= 1) throw ...
```

**Perché funziona:**
- `FOR UPDATE` acquisisce row-level lock su TUTTI gli active super_admin del tenant (target incluso).
- Locking del set disgiunto `id <> targetId` invece causerebbe due cross-delete concorrenti a lockare set disgiunti `{A}` e `{B}`, procedere entrambi alla `UPDATE`, e deadlockare sui lock incrociati a UPDATE time (Postgres aborta una tx con `40P01 deadlock detected`, l'API restituisce 500 invece di 409 — invariante preservata ma response sbagliata).
- Locking del set COMPLETO: la seconda tx blocca sulla SELECT, si sveglia post-commit, rilegge lo stato (il peer è ora `status='inactive'`), e il filtro restituisce `locked.length === 1` (solo il target stesso) → throw 409.

**Check `length <= 1`:** il "set lockato" include il target stesso. Se `length <= 1` significa che l'unica riga active è il target → la sua disattivazione lascerebbe il tenant senza super_admin.

**Caveat:** richiede che il check FOR UPDATE avvenga **dentro la stessa tx** che fa l'UPDATE finale. Già è così in entrambi i file (`prisma.$transaction(async (tx) => {...})`).

### Item 3 — Doc edit

`docs/APPENDICE_F_BUSINESS_LOGIC.md` linee 769-776, sezione "### BR-206 — Invito utenti":

**Da:**
```
1. Super Admin compila form: email, nome, cognome, ruolo, location
2. Sistema crea `user` con `status=invited`, `cognito_sub=NULL`
3. Sistema crea `invitation` con token valido 7 giorni
4. Email inviata con link di attivazione
5. Invitato clicca → imposta password in Cognito → `cognito_sub` popolato → `status=active`
6. Se link scade prima dell'attivazione: `invitation.expires_at < now()` → non più usabile, invito da rifare
```

**A:**
```
1. Super Admin compila form: email, nome, cognome, ruolo, location
2. Sistema crea riga `invitations` con token valido 7 giorni (NO user row al momento dell'invito)
3. Email inviata con magic-link a /accept-invitation?token=...
4. Invitato clicca → GET /v1/invitations/:token mostra dettagli → POST /v1/invitations/:token/accept con password
5. Backend chiama AdminCreateUser + AdminSetUserPassword in Cognito, crea riga `users` con status='active' e cognito_sub popolato, marca invitation.accepted_at
6. Se link scade prima dell'attivazione: invitation.expires_at < now() → 410 Gone, super_admin deve creare nuovo invito
```

Update anche `APPENDICE_G_ERROR_CODES.md` se cita `status=invited` (verificare in self-review).

## Test plan

### Item 1 reactive (tenant-context lookup)

**Unit (`tests/unit/middleware/tenant-context.test.ts`):**
- Stub `prisma.user.findFirst`:
  - returns `{id: ...}` → middleware passa
  - returns `null` → throws 401 con name `Unauthorized`
- Stub returns user con `status='inactive'`: impossibile (filtro nel where), ma test "lookup chiamato con corretto where" per regression.

**Integration (`tests/integration/middleware/auth-status.test.ts` nuovo):**
- Seed super_admin attivo → emette JWT valido → GET /v1/users → 200
- Soft-delete via API (DELETE /v1/users/:self via altro super_admin) → GET /v1/users con vecchio JWT → 401
- PATCH status=inactive via API → GET /v1/users con vecchio JWT → 401
- Clienti pool unaffected: customer JWT → GET /v1/me/vehicles → 200 (nessun cambio middleware su pool clienti)

### Item 1 proactive (Cognito GlobalSignOut)

**Unit (extend `users-admin-delete.test.ts` + `users-admin-update.test.ts`):**
- Mock `aws-sdk-client-mock` per `CognitoIdentityProviderClient`.
- DELETE /v1/users/:id → assert `AdminUserGlobalSignOutCommand` chiamato con corretto `Username`.
- PATCH status=inactive → stesso.
- PATCH status=active (riattivazione, non shippato in PR1 ma test difensivo per regression) → NO chiamata GlobalSignOut.
- Target con `cognitoSub: null` → SKIP chiamata (utente mai accettato invito).
- GlobalSignOut throws → log error, DB tx già committed, response 204/200 normale.

### Item 2 — `SELECT FOR UPDATE`

**Integration concurrent (`tests/integration/users-admin-br-203-race.test.ts` nuovo):**
- Seed tenant con esattamente 2 super_admin attivi A e B.
- `Promise.all([demoteA, demoteB])` con due Prisma client separati (forza connessioni distinte).
- Atteso: una tx 200, una tx 409 `user.last_super_admin`. Stato finale: ≥1 super_admin attivo.
- Variante: una DELETE + una PATCH demote simultanee.
- Variante: stessa cosa ma 3 super_admin → 2 demote contemporanee, tutte 200 (1 rimanente).

**Unit:** non testabile (race richiede tx reali Postgres). Skip unit per Item 2, copertura via integration.

### Item 3 — Doc

No test. Verifica manuale: grep `status=invited` su tutta `docs/` → solo BR-206 deve essere stato unico riferimento prima del fix, post-fix zero match.

## Error codes touched

| Code | Status | Comportamento | Riferimento |
|------|--------|---------------|-------------|
| `Unauthorized` (no detail leak) | 401 | Item 1 reactive: utente inactive o deletedAt → 401 generico | `tenant-context.ts` |
| `user.last_super_admin` | 409 | Item 2: ora race-safe sotto carico concorrente | F-OFF-004 BR-203 |

Nessun nuovo error code aggiunto a `APPENDICE_G_ERROR_CODES.md`.

## Migrazioni DB

**Zero.** Item 1 riusa schema esistente. Item 2 usa solo `SELECT ... FOR UPDATE` (no DDL). Item 3 è doc.

## Stima LOC

| Item | Code | Test | Doc | Tot |
|------|------|------|-----|-----|
| 1 reactive (tenant-context lookup) | ~20 | ~80 | — | ~100 |
| 1 proactive (Cognito GlobalSignOut × 2) | ~30 | ~50 | — | ~80 |
| 2 SELECT FOR UPDATE (2 endpoint + concurrent test) | ~30 | ~150 | — | ~180 |
| 3 BR-206 wording | — | — | ~40 | ~40 |
| **Totale PR1** | **~80** | **~280** | **~40** | **~400** |

Sotto soft-limit 1200, ampio margine.

## Smoke runbook §6.x — F-OFF-004 follow-ups (5 step)

| Step | Procedura | Esito atteso |
|------|-----------|--------------|
| 1 | Super_admin A disattiva mechanic B via UI. B prova GET /v1/users con JWT pre-disattivazione. | 401 entro 1s. |
| 2 | Stesso scenario step 1. B prova refresh token Cognito (via auth/refresh endpoint o SDK). | Refresh fallisce con Cognito error (token invalidato da GlobalSignOut). |
| 3 | Super_admin A PATCH status=inactive su mechanic B. B prova GET /v1/users. | 401. |
| 4 | Due browser, super_admin A e super_admin B (gli unici 2 attivi). Entrambi cliccano "Disattiva" sull'altro entro 200ms (DELETE /v1/users/:id concorrenti). | Uno 204 (chi vince la race), uno 409 `user.last_super_admin`. Stato finale: ≥1 super_admin attivo. Verifica via UI list + DB query. |
| 5 | Audit log post step 1 + step 4. | `user_soft_deleted` per step 1, un solo `user_soft_deleted` per step 4 (la tx vincente). Nessun audit row da Cognito side-effect (GlobalSignOut non emette audit). |

## Out of scope (questo PR)

- **Item 4 — Invitation token hashing.** Migration + expire-all-pending decision + operator coordination. PR separato.
- **Reactivation flow** (riattivare un utente soft-deleted). Aperti 2 scenari prodotto (same-tenant + cross-tenant cohabit), discussione di prodotto prima. UI già nasconde i deactivate button su inactive (PR #113/#114).
- **LRU cache per tenant-context lookup.** Future perf opt, non necessario sotto carico pilot.
- **Lower Cognito access token TTL.** Sarebbe complementare a Item 1 reactive (riduce finestra access token a 15min anche senza Cognito GlobalSignOut), ma è config infra (CDK) e impatta tutta la pool. Out of scope qui — Item 1 reactive risolve già al 100% via DB lookup.

## Open questions

Nessuna. Tutte le decisioni di design sono allineate con l'utente in brainstorming 2026-05-20.

## Riferimenti

- PR #111 (F-OFF-004 multi-user management) — origine dei 3 follow-up.
- PR #113, #114 — fix UX post-smoke su inactive.
- `feedback_smoke_runbook_catches_ux_drift` — memoria lesson learned.
- `project_user_reactivation_open_questions` — out-of-scope di questo bundle.
- `docs/APPENDICE_F_BUSINESS_LOGIC.md` BR-203, BR-206, BR-207.
- `docs/APPENDICE_G_ERROR_CODES.md` `user.last_super_admin`.

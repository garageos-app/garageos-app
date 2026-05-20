# F-OFF-004 follow-ups bundle (PR1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere 3 follow-up F-OFF-004: security gap su soft-delete (requireAuth status check + Cognito GlobalSignOut), race correctness su BR-203 (SELECT FOR UPDATE), drift doc su BR-206.

**Architecture:** Belt-and-braces per Item 1 — DB lookup in `tenant-context.ts` (source of truth, reactive) + `AdminUserGlobalSignOut` proactive su soft-delete e PATCH status=inactive. Item 2 — `SELECT ... FOR UPDATE` esplicito sulle righe super_admin attive prima del check `last_super_admin`. Item 3 — riallineamento testuale di BR-206 al flow effettivo.

**Tech Stack:** Fastify + TypeScript, Prisma 7, Postgres (Supabase), Cognito SDK (`@aws-sdk/client-cognito-identity-provider`), `aws-sdk-client-mock`, Vitest, Testcontainers.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-20-f-off-004-followups-bundle-design.md`.

**Branch attivo:** `chore/f-off-004-followups-bundle` (creato + spec committata `06cbd84`).

---

## File structure

### Files modificati

| File | Cosa cambia | Task |
|------|-------------|------|
| `docs/APPENDICE_F_BUSINESS_LOGIC.md` | BR-206 wording (linee 769-776) allineato al flow F-OFF-004 effettivo | 1 |
| `packages/api/src/routes/v1/users-admin-delete.ts` | Sostituisco `tx.user.count(...)` con `SELECT FOR UPDATE`. Aggiungo Cognito GlobalSignOut post-tx best-effort. | 2, 5 |
| `packages/api/src/routes/v1/users-admin-update.ts` | Sostituisco `tx.user.count(...)` con `SELECT FOR UPDATE`. Aggiungo Cognito GlobalSignOut post-tx best-effort su transizione `active → inactive`. | 3, 6 |
| `packages/api/src/lib/cognito.ts` | Nuova export `signOutOfficineUser({poolId, email})` idempotente (swallow UserNotFoundException). | 4 |
| `packages/api/src/middleware/tenant-context.ts` | Post parse claims: lookup `users{cognitoSub,tenantId,status:'active',deletedAt:null}` via `request.server.prisma`. Null → 401. | 7 |

### Files nuovi (test)

| File | Cosa contiene |
|------|---------------|
| `packages/api/tests/integration/users-admin-br-203-race.test.ts` | Concurrent race test per BR-203 (Item 2). |
| `packages/api/tests/integration/middleware-auth-status.test.ts` | E2E test che disattivazione → 401 al prossimo request (Item 1 reactive). |

### Files test estesi

| File | Cosa aggiungo |
|------|---------------|
| `packages/api/tests/unit/middleware/tenant-context.test.ts` | Aggiungo blocchi di test per il lookup status: passa con utente attivo, 401 se inactive/deletedAt. |
| `packages/api/tests/integration/users-admin-delete.test.ts` | Assert su `AdminUserGlobalSignOutCommand` chiamato con corretto Username. |
| `packages/api/tests/integration/users-admin-update.test.ts` | Stesso, conditional su status=inactive. |
| `packages/api/tests/unit/lib/cognito-sign-out.test.ts` | Nuovo file unit test per `signOutOfficineUser` helper. |

### Doc

`docs/APPENDICE_F_BUSINESS_LOGIC.md` linee 769-776.

---

## Task 1: APPENDICE_F BR-206 wording (Item 3)

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md:769-776`

- [ ] **Step 1: Update BR-206 wording**

Replace the existing BR-206 section (linee 769-776) with the corrected flow:

```markdown
### BR-206 — Invito utenti
Il Super Admin può invitare nuovi utenti via email. Il flusso effettivo (F-OFF-004):
1. Super Admin compila form: email, nome, cognome, ruolo, location
2. Sistema crea riga `invitations` con token valido 7 giorni — **NON** crea ancora una riga `users` (l'enum `users.status` non ha `'invited'`)
3. Email inviata con magic-link a `/accept-invitation?token=...`
4. Invitato clicca → GET `/v1/invitations/:token` mostra dettagli → POST `/v1/invitations/:token/accept` con password
5. Backend chiama `AdminCreateUser` + `AdminSetUserPassword` in Cognito, crea riga `users` con `status='active'` e `cognito_sub` popolato, marca `invitations.accepted_at`
6. Se link scade prima dell'attivazione: `invitation.expires_at < now()` → 410 Gone, super_admin deve creare un nuovo invito
```

- [ ] **Step 2: Verify no other doc cites the removed wording**

Run:

```bash
grep -rn "status=invited" docs/ packages/
```

Expected: zero matches. Se trovi match (probabilmente in vecchi plan archiviati), confermane irrilevanza (plan storici non vengono modificati).

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_F_BUSINESS_LOGIC.md
git commit -m "docs: align BR-206 wording with F-OFF-004 effective flow"
```

---

## Task 2: SELECT FOR UPDATE in users-admin-delete (Item 2 part a)

**Files:**
- Create: `packages/api/tests/integration/users-admin-br-203-race.test.ts`
- Modify: `packages/api/src/routes/v1/users-admin-delete.ts:66-85`

- [ ] **Step 1: Write the failing concurrent race test**

Create `packages/api/tests/integration/users-admin-br-203-race.test.ts`:

```typescript
// Integration concurrent race test for BR-203 (last super_admin guard).
//
// Verifica che con SELECT FOR UPDATE, due DELETE concorrenti che
// targettano i due ultimi super_admin attivi non possano entrambe
// procedere — una vince (204), l'altra fallisce (409 user.last_super_admin).
// Senza FOR UPDATE, entrambe vedono remaining=1 e procedono → tenant orfano.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

describe('BR-203 — concurrent DELETE race', () => {
  const TEST_IP_A = '10.20.40.1';
  const TEST_IP_B = '10.20.40.2';

  it('two concurrent DELETEs on the last two super_admins → one 204, one 409', async () => {
    const { tenantId } = await createTenantWithLocation('br203-race');

    // Two super_admin: A and B. Each tries to delete the OTHER.
    const subA = `sa-race-a-${crypto.randomUUID()}`;
    const subB = `sa-race-b-${crypto.randomUUID()}`;
    const { userId: idA } = await createUser({
      tenantId,
      cognitoSub: subA,
      email: 'race-a@test.it',
      role: 'super_admin',
    });
    const { userId: idB } = await createUser({
      tenantId,
      cognitoSub: subB,
      email: 'race-b@test.it',
      role: 'super_admin',
    });

    const tokenA = await signTestToken({
      pool: 'officine',
      sub: subA,
      tenantId,
      role: 'super_admin',
    });
    const tokenB = await signTestToken({
      pool: 'officine',
      sub: subB,
      tenantId,
      role: 'super_admin',
    });

    // A tries to DELETE B; B tries to DELETE A. Fire concurrently.
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idB}`,
        headers: { authorization: `Bearer ${tokenA}` },
        remoteAddress: TEST_IP_A,
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idA}`,
        headers: { authorization: `Bearer ${tokenB}` },
        remoteAddress: TEST_IP_B,
      }),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([204, 409]);

    // Identify the 409 response and assert correct error code.
    const failedRes = resA.statusCode === 409 ? resA : resB;
    expect(failedRes.json().code).toBe('user.last_super_admin');

    // DB invariant: at least 1 super_admin active remains.
    const remaining = await pgAdmin.user.count({
      where: {
        tenantId,
        role: 'super_admin',
        status: 'active',
        deletedAt: null,
      },
    });
    expect(remaining).toBeGreaterThanOrEqual(1);
  });

  it('three super_admin: two concurrent DELETEs both succeed (one super_admin left)', async () => {
    const { tenantId } = await createTenantWithLocation('br203-3super');

    const subA = `sa-3a-${crypto.randomUUID()}`;
    const subB = `sa-3b-${crypto.randomUUID()}`;
    const subC = `sa-3c-${crypto.randomUUID()}`;
    const { userId: idA } = await createUser({
      tenantId,
      cognitoSub: subA,
      email: '3a@test.it',
      role: 'super_admin',
    });
    const { userId: idB } = await createUser({
      tenantId,
      cognitoSub: subB,
      email: '3b@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId,
      cognitoSub: subC,
      email: '3c@test.it',
      role: 'super_admin',
    });

    // C is the actor for both calls — delete A, then delete B, concurrently.
    const tokenC = await signTestToken({
      pool: 'officine',
      sub: subC,
      tenantId,
      role: 'super_admin',
    });

    const [resDeleteA, resDeleteB] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idA}`,
        headers: { authorization: `Bearer ${tokenC}` },
        remoteAddress: '10.20.40.10',
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idB}`,
        headers: { authorization: `Bearer ${tokenC}` },
        remoteAddress: '10.20.40.11',
      }),
    ]);

    expect(resDeleteA.statusCode).toBe(204);
    expect(resDeleteB.statusCode).toBe(204);

    const remaining = await pgAdmin.user.count({
      where: {
        tenantId,
        role: 'super_admin',
        status: 'active',
        deletedAt: null,
      },
    });
    expect(remaining).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test (expect race-condition failure)**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-br-203-race
```

Expected: il primo test failisce con AssertionError `codes` = `[204, 204]` (race vincente prima della fix), oppure occasionalmente `[409, 409]` con timing diverso. Confermare che il test è race-sensitive.

- [ ] **Step 3: Implement SELECT FOR UPDATE in users-admin-delete.ts**

Modify `packages/api/src/routes/v1/users-admin-delete.ts`, sostituendo il blocco linee 66-85:

```typescript
        // BR-203: guard against leaving the tenant with zero active super_admins.
        // Fires only when target IS currently an active super_admin. See BR-203.
        //
        // SELECT FOR UPDATE locks the candidate rows; a second concurrent tx
        // executing the same SELECT blocks until this tx commits, then re-reads
        // the updated state. The target row itself is locked by the UPDATE
        // below (Prisma issues row-level lock on UPDATE). Together this makes
        // the count-then-update atomic.
        if (target.role === 'super_admin' && target.status === 'active') {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM users
            WHERE tenant_id = ${tenantId}::uuid
              AND role = 'super_admin'
              AND status = 'active'
              AND deleted_at IS NULL
              AND id <> ${targetId}::uuid
            FOR UPDATE
          `;
          if (locked.length === 0) {
            throw businessError(
              'user.last_super_admin',
              409,
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
            );
          }
        }
```

- [ ] **Step 4: Run race test → expect pass**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-br-203-race
```

Expected: entrambi i test passano consistentemente (gira il test 3× per essere certi).

```bash
for i in 1 2 3; do pnpm --filter @garageos/api test:integration -- users-admin-br-203-race; done
```

- [ ] **Step 5: Run existing users-admin-delete.test.ts to verify no regression**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-delete
```

Expected: tutti i 5 case esistenti continuano a passare (la modifica di Item 2 cambia solo il meccanismo del check, non la sua semantica).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-delete.ts packages/api/tests/integration/users-admin-br-203-race.test.ts
git commit -m "fix(api): race-safe BR-203 guard via SELECT FOR UPDATE in users-admin-delete"
```

---

## Task 3: SELECT FOR UPDATE in users-admin-update (Item 2 part b)

**Files:**
- Modify: `packages/api/src/routes/v1/users-admin-update.ts:89-115`
- Modify: `packages/api/tests/integration/users-admin-br-203-race.test.ts` (aggiungo block per PATCH demote race)

- [ ] **Step 1: Add PATCH demote concurrent test to the race file**

Aggiungi alla fine di `packages/api/tests/integration/users-admin-br-203-race.test.ts`:

```typescript
describe('BR-203 — concurrent PATCH demote race', () => {
  it('two concurrent PATCH demote on last two super_admin → one 200, one 409', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('br203-patch-race');

    const subA = `sa-patch-a-${crypto.randomUUID()}`;
    const subB = `sa-patch-b-${crypto.randomUUID()}`;
    const { userId: idA } = await createUser({
      tenantId,
      cognitoSub: subA,
      email: 'patch-a@test.it',
      role: 'super_admin',
    });
    const { userId: idB } = await createUser({
      tenantId,
      cognitoSub: subB,
      email: 'patch-b@test.it',
      role: 'super_admin',
    });

    const tokenA = await signTestToken({
      pool: 'officine',
      sub: subA,
      tenantId,
      role: 'super_admin',
    });
    const tokenB = await signTestToken({
      pool: 'officine',
      sub: subB,
      tenantId,
      role: 'super_admin',
    });

    // A demotes B to mechanic; B demotes A to mechanic, concurrently.
    // Mechanic requires location_id, so we provide one.
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/users/${idB}`,
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        payload: { role: 'mechanic', locationId },
        remoteAddress: '10.20.41.1',
      }),
      app.inject({
        method: 'PATCH',
        url: `/v1/users/${idA}`,
        headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
        payload: { role: 'mechanic', locationId },
        remoteAddress: '10.20.41.2',
      }),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([200, 409]);

    const failedRes = resA.statusCode === 409 ? resA : resB;
    expect(failedRes.json().code).toBe('user.last_super_admin');

    const remaining = await pgAdmin.user.count({
      where: {
        tenantId,
        role: 'super_admin',
        status: 'active',
        deletedAt: null,
      },
    });
    expect(remaining).toBe(1);
  });
});
```

- [ ] **Step 2: Run the new test (expect race-condition failure)**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-br-203-race
```

Expected: il nuovo describe block fallisce (race) — i due primi describe block (delete) continuano a passare.

- [ ] **Step 3: Implement SELECT FOR UPDATE in users-admin-update.ts**

Modify `packages/api/src/routes/v1/users-admin-update.ts`, sostituendo il blocco linee 89-115:

```typescript
        // BR-203: guard against leaving the tenant with zero active super_admins.
        // Fires only when target IS currently an active super_admin AND the
        // new state would no longer be an active super_admin (either role changed
        // away from super_admin, or status changed to inactive).
        //
        // SELECT FOR UPDATE locks candidate rows so a concurrent demote/disable
        // sees post-commit state and fails the guard. See BR-203 + Item 2 of
        // the F-OFF-004 follow-ups spec (2026-05-20).
        const isLosingAdmin =
          target.role === 'super_admin' &&
          target.status === 'active' &&
          (newRole !== 'super_admin' || newStatus !== 'active');

        if (isLosingAdmin) {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM users
            WHERE tenant_id = ${tenantId}::uuid
              AND role = 'super_admin'
              AND status = 'active'
              AND deleted_at IS NULL
              AND id <> ${targetId}::uuid
            FOR UPDATE
          `;
          if (locked.length === 0) {
            throw businessError(
              'user.last_super_admin',
              409,
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
            );
          }
        }
```

- [ ] **Step 4: Run race test → expect pass**

Run:

```bash
for i in 1 2 3; do pnpm --filter @garageos/api test:integration -- users-admin-br-203-race; done
```

Expected: tutti i 3 describe block passano consistentemente.

- [ ] **Step 5: Run existing users-admin-update.test.ts to verify no regression**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-update
```

Expected: tutti i case esistenti continuano a passare.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-update.ts packages/api/tests/integration/users-admin-br-203-race.test.ts
git commit -m "fix(api): race-safe BR-203 guard via SELECT FOR UPDATE in users-admin-update"
```

---

## Task 4: signOutOfficineUser helper in lib/cognito.ts (Item 1 helper)

**Files:**
- Modify: `packages/api/src/lib/cognito.ts` (aggiunge export)
- Create: `packages/api/tests/unit/lib/cognito-sign-out.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/api/tests/unit/lib/cognito-sign-out.test.ts`:

```typescript
import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CognitoUnavailableError, _resetCognitoClientForTests } from '../../../src/lib/cognito.js';
import { signOutOfficineUser } from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

afterEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

describe('signOutOfficineUser', () => {
  it('calls AdminUserGlobalSignOutCommand with correct PoolId + Username', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    await signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' });

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-central-1_TESTPOOL',
      Username: 'user@test.it',
    });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(
      new UserNotFoundException({
        message: 'User does not exist',
        $metadata: {},
      }),
    );

    // Must not throw.
    await expect(
      signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'gone@test.it' }),
    ).resolves.toBeUndefined();
  });

  it('wraps other errors in CognitoUnavailableError', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error('Network failure'));

    await expect(
      signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});
```

- [ ] **Step 2: Run test → expect FAIL on import**

Run:

```bash
pnpm --filter @garageos/api test:unit -- cognito-sign-out
```

Expected: FAIL con `SyntaxError` / `does not provide an export named 'signOutOfficineUser'`.

- [ ] **Step 3: Implement signOutOfficineUser in lib/cognito.ts**

Modify `packages/api/src/lib/cognito.ts`:

1. Aggiungi `AdminUserGlobalSignOutCommand` agli import (linea 1-10):

```typescript
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
```

2. Aggiungi la export alla fine del file (dopo `deleteCognitoUser`):

```typescript
// Invalidates ALL refresh tokens for the given user in the officine pool.
// Used as a "proactive lockout" companion to soft-delete and PATCH
// status=inactive (F-OFF-004 follow-ups Item 1). Access tokens already
// in circulation remain valid until their TTL, but the reactive lookup
// in tenant-context closes that residual window at the API surface.
//
// Idempotent — swallows UserNotFoundException so callers can use this
// safely on users who never accepted their invitation (cognito_sub
// would still be populated post-accept, so this case is rare; defensive
// anyway).
//
// See docs/superpowers/specs/2026-05-20-f-off-004-followups-bundle-design.md
// Item 1 proactive section.
export async function signOutOfficineUser(args: {
  poolId: string;
  email: string;
}): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminUserGlobalSignOutCommand({
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

- [ ] **Step 4: Run test → expect PASS**

Run:

```bash
pnpm --filter @garageos/api test:unit -- cognito-sign-out
```

Expected: 3 test passano.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/cognito.ts packages/api/tests/unit/lib/cognito-sign-out.test.ts
git commit -m "feat(api): add signOutOfficineUser helper for proactive Cognito lockout"
```

---

## Task 5: Wire signOutOfficineUser into users-admin-delete (Item 1 proactive delete)

**Files:**
- Modify: `packages/api/src/routes/v1/users-admin-delete.ts`
- Modify: `packages/api/tests/integration/users-admin-delete.test.ts` (aggiungo case)

- [ ] **Step 1: Add top-level Cognito mock setup + write failing tests**

Modifica gli import + setup di `packages/api/tests/integration/users-admin-delete.test.ts` per allinearsi al pattern di `users-admin-update.test.ts`:

Sostituisci le linee 16-22 (import block) con:

```typescript
import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
```

Aggiorna il `beforeEach` esistente (linee 34-36) per resettare Cognito:

```typescript
beforeEach(async () => {
  await resetDb();
  cognitoMock.reset();
  _resetCognitoClientForTests();
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
});
```

Aggiungi questo describe block alla fine del file:

```typescript
// ─── Item 1 proactive: Cognito GlobalSignOut on soft-delete ──────────────────

describe('DELETE /v1/users/:id — Cognito GlobalSignOut proactive lockout', () => {
  const TEST_IP = '10.20.31.50';

  it('calls AdminUserGlobalSignOutCommand on the target after soft-delete', async () => {
    const { tenantId } = await createTenantWithLocation('del-cog');

    const adminSub = `sa-cog-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-cog@test.it',
      role: 'super_admin',
    });

    const targetSub = `sa-target-cog-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-cog@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(204);

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Username).toBe('target-cog@test.it');
  });

  it('still returns 204 even if Cognito GlobalSignOut throws (best-effort)', async () => {
    // Override the default-success mock for this single test.
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error('Cognito down'));

    const { tenantId } = await createTenantWithLocation('del-cog-fail');

    const adminSub = `sa-cog-fail-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-cog-fail@test.it',
      role: 'super_admin',
    });

    const targetSub = `sa-target-cog-fail-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'target-cog-fail@test.it',
      role: 'super_admin',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });

    // Soft-delete in DB succeeded; Cognito signout failed best-effort.
    expect(res.statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-delete
```

Expected: i due nuovi case falliscono con `calls.length === 0` (chiamata mai effettuata).

- [ ] **Step 3: Wire signOutOfficineUser into the handler**

Modify `packages/api/src/routes/v1/users-admin-delete.ts`:

1. Aggiungi import (in cima al file, dopo gli altri import):

```typescript
import { env } from '../../config/env.js';
import { signOutOfficineUser } from '../../lib/cognito.js';
```

2. Modifica il blocco target lookup per recuperare anche `cognitoSub`. Cambia linee 57-61 da:

```typescript
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: null },
          select: { id: true, email: true, role: true, status: true },
        });
```

a:

```typescript
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: null },
          select: { id: true, email: true, role: true, status: true, cognitoSub: true },
        });
```

3. Refactora la handler per restituire `targetEmail` e `targetCognitoSub` dal withContext, poi chiamare signOutOfficineUser post-tx. Cambia il blocco da linea ~39 a linea ~110 in:

```typescript
      const targetInfo = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Look up the actor's DB UUID so the audit log actor_id column
        // (UUID) is correctly populated — cognitoSub is opaque, NOT a UUID.
        const actor = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        // Guard: cannot delete self via this admin endpoint.
        if (actor?.id === targetId) {
          throw businessError(
            'user.cannot_delete_self_via_admin',
            422,
            'Non puoi rimuovere te stesso da qui. Usa il profilo personale.',
          );
        }

        // Lookup target (same tenant, not already soft-deleted).
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: null },
          select: { id: true, email: true, role: true, status: true, cognitoSub: true },
        });
        if (!target) {
          throw businessError('user.not_found', 404, 'Utente non trovato.');
        }

        // BR-203: race-safe SELECT FOR UPDATE guard (see Item 2).
        if (target.role === 'super_admin' && target.status === 'active') {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM users
            WHERE tenant_id = ${tenantId}::uuid
              AND role = 'super_admin'
              AND status = 'active'
              AND deleted_at IS NULL
              AND id <> ${targetId}::uuid
            FOR UPDATE
          `;
          if (locked.length === 0) {
            throw businessError(
              'user.last_super_admin',
              409,
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
            );
          }
        }

        // Soft-delete: set status=inactive + deletedAt=now().
        await tx.user.update({
          where: { id: targetId },
          data: { status: 'inactive', deletedAt: new Date() },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actor?.id ?? null,
            action: 'user_soft_deleted',
            entityType: 'user',
            entityId: targetId,
            metadata: { targetEmail: target.email },
            ipAddress: request.ip,
          },
        });

        return { email: target.email, cognitoSub: target.cognitoSub };
      });

      // Item 1 proactive: invalidate all Cognito refresh tokens for the
      // target. Best-effort — DB soft-delete is the source of truth and
      // the reactive tenant-context lookup closes the residual window.
      // Skip if target never accepted invitation (no cognito_sub).
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
      }

      return reply.code(204).send();
```

- [ ] **Step 4: Run all users-admin-delete tests → expect pass**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-delete
```

Expected: tutti i case (esistenti + 2 nuovi) passano.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-delete.ts packages/api/tests/integration/users-admin-delete.test.ts
git commit -m "feat(api): proactive Cognito GlobalSignOut on user soft-delete"
```

---

## Task 6: Wire signOutOfficineUser into users-admin-update (Item 1 proactive update)

**Files:**
- Modify: `packages/api/src/routes/v1/users-admin-update.ts`
- Modify: `packages/api/tests/integration/users-admin-update.test.ts`

- [ ] **Step 1: Extend existing top-level cognitoMock + write failing tests**

`packages/api/tests/integration/users-admin-update.test.ts` ha già `cognitoMock` al top-level e `beforeEach` reset. Aggiungi `AdminUserGlobalSignOutCommand` all'import esistente da `@aws-sdk/client-cognito-identity-provider` (sulla linea 20-23):

```typescript
import {
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
```

Aggiorna il `beforeEach` esistente per stubbare anche signout di default:

```typescript
beforeEach(async () => {
  await resetDb();
  cognitoMock.reset();
  _resetCognitoClientForTests();
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
});
```

Aggiungi questo describe block alla fine del file:

```typescript
// ─── Item 1 proactive: Cognito GlobalSignOut on status active → inactive ─────

describe('PATCH /v1/users/:id — Cognito GlobalSignOut on status active → inactive', () => {
  const TEST_IP = '10.20.32.50';

  it('calls AdminUserGlobalSignOutCommand when status transitions active → inactive', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('upd-cog-inact');

    const adminSub = `sa-upd-cog-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-cog@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-cog-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-cog@test.it',
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
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { status: 'inactive' },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(200);

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Username).toBe('mech-upd-cog@test.it');
  });

  it('does NOT call AdminUserGlobalSignOutCommand on role-only PATCH (status unchanged active)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('upd-cog-rolesonly');

    const adminSub = `sa-upd-roles-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'admin-upd-roles@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-upd-roles-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-upd-roles@test.it',
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
      url: `/v1/users/${targetId}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { role: 'super_admin', locationId: null },
      remoteAddress: TEST_IP,
    });

    expect(res.statusCode).toBe(200);

    // Existing updateOfficineUserRoleAndLocation call uses
    // AdminUpdateUserAttributesCommand — assert specifically that
    // signout was NOT called for role-only change.
    const signoutCalls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(signoutCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-update
```

Expected: il primo nuovo case fallisce (signout non chiamato).

- [ ] **Step 3: Wire signOutOfficineUser into the handler**

Modify `packages/api/src/routes/v1/users-admin-update.ts`:

1. Aggiungi `signOutOfficineUser` all'import esistente da `'../../lib/cognito.js'` (l'import per `updateOfficineUserRoleAndLocation` esiste già — appendi alla stessa riga).

2. Aggiorna il return del withContext per esportare anche la transizione status e il targetEmail+cognitoSub. Cambia il blocco return da linee ~181 a ~187:

```typescript
        return {
          user: updated,
          targetEmail: target.email,
          targetCognitoSub: target.cognitoSub,
          roleChanged: body.role !== undefined && body.role !== target.role,
          locationChanged: body.locationId !== undefined && body.locationId !== target.locationId,
          statusBecameInactive:
            body.status !== undefined &&
            target.status === 'active' &&
            body.status === 'inactive',
        };
```

3. Estendi il target select per includere `cognitoSub`. Cambia il `findFirst` su `target` (intorno a linea ~62) per includere `cognitoSub: true` nel select.

4. Dopo l'existing Cognito sync block per role/location, aggiungi:

```typescript
      // Item 1 proactive: invalidate all Cognito refresh tokens on
      // active → inactive transition. Best-effort, independent from the
      // role/location sync above. See follow-ups spec 2026-05-20.
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
      }
```

- [ ] **Step 4: Run tests → expect pass**

Run:

```bash
pnpm --filter @garageos/api test:integration -- users-admin-update
```

Expected: tutti i case esistenti + i 2 nuovi passano.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-update.ts packages/api/tests/integration/users-admin-update.test.ts
git commit -m "feat(api): proactive Cognito GlobalSignOut on PATCH status active→inactive"
```

---

## Task 7: tenant-context status check (Item 1 reactive)

**Files:**
- Modify: `packages/api/src/middleware/tenant-context.ts`
- Modify: `packages/api/tests/unit/middleware/tenant-context.test.ts`
- Create: `packages/api/tests/integration/middleware-auth-status.test.ts`

- [ ] **Step 1: Write failing unit tests**

Aggiungi a `packages/api/tests/unit/middleware/tenant-context.test.ts` (estendi il file esistente). Modifica l'import line per includere `vi`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

Aggiungi sotto gli import + le costanti (prima di `type JwtStub`):

```typescript
// Module-level Prisma stub. Each test sets findFirst behavior; tenantContext
// reads request.server.prisma so we decorate the test app with this stub.
// Default mock in beforeEach returns an active user so the EXISTING tests
// (which don't care about status lookup) continue to pass.
const prismaStub = {
  user: { findFirst: vi.fn() },
};
```

Modifica `buildApp` per decorare `prisma`. Sostituisci la sua dichiarazione:

```typescript
async function buildApp(jwt: JwtStub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.decorate('prisma', prismaStub as unknown as never);
  app.get(
    '/_probe',
    {
      preHandler: [
        async (request) => {
          if (jwt !== undefined) {
            request.jwt = jwt as CognitoIdTokenPayload;
          }
        },
        tenantContext,
      ],
    },
    async (request) => ({
      tenantId: request.tenantId,
      userId: request.userId,
      userRole: request.userRole,
      locationId: request.locationId ?? null,
    }),
  );
  return app;
}
```

Modifica il `beforeEach` esistente per resettare lo stub e default a "user is active":

```typescript
  beforeEach(() => {
    app = undefined;
    prismaStub.user.findFirst.mockReset();
    // Default: user is active. Tests that need null override explicitly.
    prismaStub.user.findFirst.mockResolvedValue({ id: 'default-user-uuid' });
  });
```

Aggiungi i nuovi test alla fine del describe block esistente:

```typescript
  describe('user status lookup (F-OFF-004 follow-ups Item 1)', () => {
    it('returns 200 when user is active and not deleted', async () => {
      prismaStub.user.findFirst.mockResolvedValueOnce({ id: 'user-uuid' });
      app = await buildApp({
        sub: COGNITO_SUB,
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
      });

      const res = await app.inject({ method: 'GET', url: '/_probe' });
      expect(res.statusCode).toBe(200);
      expect(prismaStub.user.findFirst).toHaveBeenCalledWith({
        where: {
          cognitoSub: COGNITO_SUB,
          tenantId: TENANT_ID,
          status: 'active',
          deletedAt: null,
        },
        select: { id: true },
      });
    });

    it('returns 401 when user lookup returns null (inactive or deleted)', async () => {
      prismaStub.user.findFirst.mockResolvedValueOnce(null);
      app = await buildApp({
        sub: COGNITO_SUB,
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
      });

      const res = await app.inject({ method: 'GET', url: '/_probe' });
      expect(res.statusCode).toBe(401);
    });

    it('does not leak whether user is missing vs deleted in response body', async () => {
      prismaStub.user.findFirst.mockResolvedValueOnce(null);
      app = await buildApp({
        sub: COGNITO_SUB,
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'mechanic',
      });

      const res = await app.inject({ method: 'GET', url: '/_probe' });
      // RFC 7807 problem+json wrapped; code should be UNAUTHORIZED, no
      // status-specific detail in the body.
      const body = res.json();
      expect(body.code).toBe('UNAUTHORIZED');
    });
  });
```

- [ ] **Step 2: Run unit tests → expect FAIL**

Run:

```bash
pnpm --filter @garageos/api test:unit -- tenant-context
```

Expected: i 3 nuovi test falliscono (lookup non eseguito ancora).

- [ ] **Step 3: Implement status lookup in tenant-context.ts**

Modify `packages/api/src/middleware/tenant-context.ts`. Aggiungi dopo il blocco di parsing claims (post linea ~70, prima di `void reply`):

```typescript
  // F-OFF-004 follow-ups Item 1 (security regression closure):
  // Cognito access tokens remain valid until their TTL (~1h default)
  // even after a super_admin soft-deletes or sets status=inactive on the
  // user. Reactive DB lookup here makes the API surface the source of
  // truth — disabled/deleted users get 401 on the next request regardless
  // of access-token freshness.
  //
  // Companion proactive measure: users-admin-delete + users-admin-update
  // call AdminUserGlobalSignOut to invalidate refresh tokens.
  //
  // No new error code: response shape matches existing JWT failures
  // (401 Unauthorized) to avoid leaking the distinction between
  // "token expired" and "user disabled" to clients.
  const userRow = await request.server.prisma.user.findFirst({
    where: {
      cognitoSub: parsed.data.sub,
      tenantId: parsed.data['custom:tenant_id'],
      status: 'active',
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!userRow) {
    request.log.warn(
      { cognitoSub: parsed.data.sub, tenantId: parsed.data['custom:tenant_id'] },
      'tenant-context: user inactive or deleted — denying request',
    );
    throw unauthorizedError('User inactive or not found');
  }
```

- [ ] **Step 4: Run unit tests → expect PASS**

Run:

```bash
pnpm --filter @garageos/api test:unit -- tenant-context
```

Expected: tutti i test passano.

- [ ] **Step 5: Write integration test for end-to-end behavior**

Create `packages/api/tests/integration/middleware-auth-status.test.ts`:

```typescript
// Integration test for Item 1 reactive (tenant-context status lookup).
// Verifica end-to-end che dopo soft-delete o status=inactive l'utente
// disattivato riceve 401 al prossimo request anche con JWT valido.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

describe('tenant-context — user status reactive lookup', () => {
  const TEST_IP = '10.20.50.1';

  it('rejects authenticated requests after target is soft-deleted (status=inactive + deletedAt)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('mw-soft');

    // Two super_admin so we can delete one safely (no BR-203 issue).
    const otherSub = `sa-keep-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: otherSub,
      email: 'keep@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-target-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-target@test.it',
      role: 'mechanic',
      locationId,
    });

    const targetToken = await signTestToken({
      pool: 'officine',
      sub: targetSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    // Pre-soft-delete: request works.
    const okRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(okRes.statusCode).toBe(200);

    // Soft-delete via DB (bypass admin endpoint to keep the test focused).
    await pgAdmin.user.update({
      where: { id: targetId },
      data: { status: 'inactive', deletedAt: new Date() },
    });

    // Post-soft-delete: same valid JWT now fails with 401.
    const koRes = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(koRes.statusCode).toBe(401);
  });

  it('rejects authenticated requests after PATCH status=inactive (no deletedAt)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('mw-inact');

    const otherSub = `sa-other-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: otherSub,
      email: 'other@test.it',
      role: 'super_admin',
    });

    const targetSub = `mech-inact-${crypto.randomUUID()}`;
    const { userId: targetId } = await createUser({
      tenantId,
      cognitoSub: targetSub,
      email: 'mech-inact@test.it',
      role: 'mechanic',
      locationId,
    });

    const targetToken = await signTestToken({
      pool: 'officine',
      sub: targetSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    // Inactivate via direct DB update (sim PATCH status=inactive effect).
    await pgAdmin.user.update({
      where: { id: targetId },
      data: { status: 'inactive' }, // no deletedAt — just inactive
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${targetToken}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(401);
  });

  it('active users continue to authenticate normally (regression check)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('mw-ok');

    const sub = `sa-ok-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: 'ok@test.it',
      role: 'super_admin',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: TEST_IP,
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Run integration test → expect PASS**

Run:

```bash
pnpm --filter @garageos/api test:integration -- middleware-auth-status
```

Expected: tutti i 3 case passano.

- [ ] **Step 7: Run the full api integration suite to check no regressions**

Run:

```bash
pnpm --filter @garageos/api test:integration
```

Expected: tutti i test passano. Se ci sono failure per "user not found" / 401 in test che non seedavano user row, vanno fixati seedando un user row coerente col JWT. **Non procedere oltre finché non sono tutti verdi.**

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/middleware/tenant-context.ts packages/api/tests/unit/middleware/tenant-context.test.ts packages/api/tests/integration/middleware-auth-status.test.ts
git commit -m "feat(api): reactive user status lookup in tenant-context middleware

F-OFF-004 follow-ups Item 1: closes the access token window for
soft-deleted or status=inactive users by performing a DB lookup on every
authenticated officine request. Companion to Cognito GlobalSignOut
proactive measure on the admin-side endpoints."
```

---

## Task 8: Final typecheck + push

- [ ] **Step 1: Workspace-wide typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: 0 errori.

- [ ] **Step 2: Verify cumulative diff stays under 1200 LOC**

Run:

```bash
git diff main...HEAD --stat
```

Expected: total < 1200 lines. Se eccede, STOP and report — il bundle va potenzialmente split.

- [ ] **Step 3: Push branch**

Run:

```bash
git push -u origin chore/f-off-004-followups-bundle
```

- [ ] **Step 4: Open PR**

Run:

```bash
gh pr create --title "fix(api,docs): F-OFF-004 follow-ups bundle (security + race + doc)" --body "$(cat <<'EOF'
## What

Cleanup bundle PR1 di 2 post F-OFF-004 (PR #111). Affronta 3 follow-up:

1. **Item 1 — \`requireAuth\` status check** (security regression HIGH)
   - Reactive: \`tenant-context.ts\` lookup \`users\` table on every officine request; 401 se inactive/deletedAt.
   - Proactive: \`AdminUserGlobalSignOut\` su soft-delete + PATCH status active→inactive.
2. **Item 2 — \`SELECT FOR UPDATE\` BR-203** (race correctness MEDIUM-HIGH)
   - Sostituisce \`tx.user.count\` con \`SELECT ... FOR UPDATE\` in users-admin-delete + users-admin-update.
3. **Item 3 — APPENDICE_F BR-206 wording reconciliation** (doc drift LOW)
   - Allineamento alla flow F-OFF-004 effettivo (no user row pre-accept).

Item 4 (invitation token hashing) deferred a PR2 separato — ha migration + decisione expire-all-pending + coordinamento operator.

## Why

Smoke runbook F-OFF-004 §6.4 ha shippato 3 issue UX (PR #112-114). Final review interno + spec self-review hanno identificato 3 ulteriori gap di sicurezza/correttezza che non bloccavano lo smoke ma sono mitigation prioritarie.

- BR-203 (APPENDICE_F): \`packages/api/src/routes/v1/users-admin-update.ts\` + \`users-admin-delete.ts\`.
- F-OFF-004 spec: \`docs/superpowers/specs/2026-05-20-f-off-004-followups-bundle-design.md\`.

## Implementation notes

- Reactive lookup adds 1 query per officine request. Index su \`users(cognito_sub)\` esistente; accettabile su pilot/demo (target <50 req/min). LRU cache deferred (YAGNI).
- Cognito GlobalSignOut è best-effort (try/catch + log); DB rimane source of truth.
- \`SELECT FOR UPDATE\` locka solo gli ALTRI super_admin attivi; il target è già lockato da Prisma sull'UPDATE.
- BR-206 doc edit no code impact.

## Tests

- [ ] Unit \`tenant-context.test.ts\` (3 nuovi test)
- [ ] Unit \`cognito-sign-out.test.ts\` (3 test)
- [ ] Integration \`users-admin-br-203-race.test.ts\` (3 test concurrent)
- [ ] Integration \`middleware-auth-status.test.ts\` (3 test)
- [ ] Integration \`users-admin-delete.test.ts\` (2 nuovi case Cognito)
- [ ] Integration \`users-admin-update.test.ts\` (2 nuovi case Cognito)
- [ ] BR-203 race verificato (Item 2)
- [ ] Manual smoke: §6.x runbook 5 step (vedi spec)

## Checklist

- [ ] Code follows conventions in CONTRIBUTING.md
- [ ] Types compile (\`pnpm -r typecheck\`)
- [ ] No new \`console.log\`, no commented-out code
- [ ] Secrets not committed
- [ ] Spec linked above
EOF
)"
```

- [ ] **Step 5: Watch CI**

```bash
gh pr checks --watch
```

Expected: tutto verde. Se rosso, diagnose + fix follow-up commit (NO --amend).

---

## Self-review summary

- **Spec coverage:** Item 1 reactive (Task 7), Item 1 proactive delete (Task 5), Item 1 proactive update (Task 6), Item 1 helper (Task 4), Item 2 delete (Task 2), Item 2 update (Task 3), Item 3 doc (Task 1). Tutti gli item della spec coperti.
- **Placeholder scan:** zero TBD / TODO / "implement later" rilevati.
- **Type consistency:** `signOutOfficineUser({poolId, email})` definita in Task 4, usata identicamente in Task 5 + Task 6. Field name `statusBecameInactive` introdotto in Task 6.
- **Out-of-scope verified:** Item 4 token hashing esplicitamente deferred. Reactivation flow deferred. LRU cache deferred. Lower Cognito TTL deferred.

## Smoke runbook (post-merge, operator-driven)

Eseguire i 5 step nella sezione "Smoke runbook §6.x" della spec (`2026-05-20-f-off-004-followups-bundle-design.md`).

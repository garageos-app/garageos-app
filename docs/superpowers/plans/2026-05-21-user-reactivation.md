# User Reactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sbloccare il flow di reattivazione utenti F-OFF-004 nello stesso tenant via nuovo `POST /v1/users/:id/reactivate` (Super Admin only, simmetrico al DELETE), e chiudere la cross-tenant collision con early-detection a invite-time.

**Architecture:** Endpoint dedicato action-style (`POST /reactivate`) con lookup `deletedAt: { not: null }`, transactional UPDATE + audit, e Cognito `AdminEnableUser` best-effort post-tx (mirror del pattern delete). Cross-tenant early-detection via nuovo helper `getOfficineUserByEmail` chiamato in `users-invitations-create.ts` dopo discriminazione DB-side tra "email attiva same-tenant" vs "email soft-deleted same-tenant" vs "email in altro tenant". Frontend: nuovo componente `ReactivateSection` 2-step simmetrico al pattern Disattiva, montato in EditUserDialog quando `user.status === 'inactive'`.

**Tech Stack:** Fastify + TypeScript, Prisma 7, Postgres (Supabase) via Testcontainers, Cognito SDK (`@aws-sdk/client-cognito-identity-provider`), `aws-sdk-client-mock`, Vitest, Zod 4, React + Vite + Tailwind + shadcn/ui, React Query, JSDOM + Testing Library.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-21-user-reactivation-design.md`.

**Branch da creare:** `feat/user-reactivation` (da `main` HEAD `103a9b1`).

---

## File structure

### Files nuovi

| Path | Responsabilità | Task |
|---|---|---|
| `packages/api/src/routes/v1/users-admin-reactivate.ts` | POST endpoint dedicato | 2 |
| `packages/api/tests/unit/routes/users-admin-reactivate.test.ts` | Unit (fake-Prisma + Cognito mock) | 2 |
| `packages/api/tests/integration/users-admin-reactivate.test.ts` | Integration (Postgres reale) | 3 |
| `packages/web/src/components/users/ReactivateSection.tsx` | Componente 2-step + dropdown location stale | 6 |
| `packages/web/src/components/users/ReactivateSection.test.tsx` | JSDOM | 6 |

### Files modificati

| File | Cosa cambia | Task |
|---|---|---|
| `packages/api/src/lib/cognito.ts` | + `enableOfficineUser` + `getOfficineUserByEmail` | 1 |
| `packages/api/tests/unit/lib/cognito-enable.test.ts` (NEW) | Unit test per i 2 nuovi helpers | 1 |
| `packages/api/src/server.ts` | Register `usersAdminReactivateRoutes` | 2 |
| `packages/api/src/routes/v1/users-invitations-create.ts` | Step 1 ridefinito + step 1bis Cognito early-check | 4 |
| `packages/api/tests/unit/routes/users-invitations-create.test.ts` | +5 cases per nuovo path discriminato | 4 |
| `packages/api/tests/integration/users-invitations.test.ts` | +3 cases (email in other tenant, Cognito 502, soft-deleted re-invite) | 4 |
| `packages/web/src/queries/users-admin.ts` | + `useReactivateUser` hook | 5 |
| `packages/web/src/queries/users-admin.test.tsx` | +2 cases per `useReactivateUser` | 5 |
| `packages/web/src/components/users/EditUserDialog.tsx` | Sostituisce `inactive-notice` (linee 213-219) con `<ReactivateSection>` | 7 |
| `packages/web/src/components/users/EditUserDialog.test.tsx` | Adatta test "hides ALL action sections" → "renders ReactivateSection" | 7 |
| `docs/APPENDICE_F_BUSINESS_LOGIC.md` | + BR-211 + BR-212 + BR-207 wording update | 8 |
| `docs/APPENDICE_G_ERROR_CODES.md` | + 3 nuovi error codes | 8 |
| `docs/APPENDICE_A_API.md` | + endpoint `POST /v1/users/:id/reactivate` docs | 8 |
| `docs/superpowers/runbooks/F-OFF-004-smoke.md` | + §PR3 smoke section | 8 |

### Migrations

**Nessuna.** Schema `User` ha già `deletedAt: DateTime?` + `status: UserStatus`. Reactivation è UPDATE su colonne esistenti.

---

## Task 1: lib/cognito.ts — helpers `enableOfficineUser` + `getOfficineUserByEmail`

**Files:**
- Modify: `packages/api/src/lib/cognito.ts:1-15` (import) e fine file
- Create: `packages/api/tests/unit/lib/cognito-enable.test.ts`

- [ ] **Step 1: Write the failing test for `enableOfficineUser`**

Create `packages/api/tests/unit/lib/cognito-enable.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminEnableUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  CognitoUnavailableError,
  _resetCognitoClientForTests,
  enableOfficineUser,
  getOfficineUserByEmail,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('enableOfficineUser', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('sends AdminEnableUserCommand with poolId+email', async () => {
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    await enableOfficineUser({ poolId: 'pool-1', email: 'a@b.test' });
    const calls = cognitoMock.commandCalls(AdminEnableUserCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'a@b.test',
    });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock.on(AdminEnableUserCommand).rejects(
      new UserNotFoundException({ message: 'user not found', $metadata: {} }),
    );
    await expect(
      enableOfficineUser({ poolId: 'pool-1', email: 'gone@b.test' }),
    ).resolves.toBeUndefined();
  });

  it('wraps generic errors in CognitoUnavailableError', async () => {
    cognitoMock.on(AdminEnableUserCommand).rejects(new Error('boom'));
    await expect(
      enableOfficineUser({ poolId: 'pool-1', email: 'a@b.test' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

describe('getOfficineUserByEmail', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('returns {exists:true, sub, attributes} when AdminGetUser succeeds', async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: 'a@b.test',
      UserAttributes: [
        { Name: 'sub', Value: 'cognito-sub-uuid' },
        { Name: 'email', Value: 'a@b.test' },
        { Name: 'custom:tenant_id', Value: 'tenant-1' },
      ],
    });
    const result = await getOfficineUserByEmail({ poolId: 'pool-1', email: 'a@b.test' });
    expect(result.exists).toBe(true);
    expect(result.sub).toBe('cognito-sub-uuid');
    expect(result.attributes).toEqual({
      sub: 'cognito-sub-uuid',
      email: 'a@b.test',
      'custom:tenant_id': 'tenant-1',
    });
  });

  it('returns {exists:false} on UserNotFoundException', async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(
      new UserNotFoundException({ message: 'not found', $metadata: {} }),
    );
    const result = await getOfficineUserByEmail({ poolId: 'pool-1', email: 'gone@b.test' });
    expect(result.exists).toBe(false);
    expect(result.sub).toBeUndefined();
  });

  it('throws CognitoUnavailableError on generic errors', async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('boom'));
    await expect(
      getOfficineUserByEmail({ poolId: 'pool-1', email: 'a@b.test' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
pnpm --filter @garageos/api test tests/unit/lib/cognito-enable.test.ts
```

Expected: FAIL with "enableOfficineUser is not exported" or similar.

- [ ] **Step 3: Add `AdminEnableUserCommand` + `AdminGetUserCommand` imports**

Edit `packages/api/src/lib/cognito.ts:1-12`:

```typescript
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
```

- [ ] **Step 4: Implement `enableOfficineUser` at end of file**

Append to `packages/api/src/lib/cognito.ts` (after `disableOfficineUser`):

```typescript
// Re-enables a previously disabled Cognito user in the officine pool.
// Mirror of `disableOfficineUser` — used by the reactivation flow
// (POST /v1/users/:id/reactivate) to lift the AdminDisableUser side
// effect of the soft-delete.
//
// Idempotent: swallows UserNotFoundException so callers can use this
// in best-effort post-tx paths without prior existence checks.
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md §2.4.
export async function enableOfficineUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminEnableUserCommand({
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

// Looks up a Cognito user in the officine pool by email. Returns
// a discriminated `{exists, sub?, attributes?}` shape rather than
// throwing on not-found, because that case is a normal control-flow
// branch for the cross-tenant invitation early-check.
//
// Throws CognitoUnavailableError on any other Cognito error so the
// caller can map to 502 `auth.cognito_unavailable`.
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md §4.2.
export async function getOfficineUserByEmail(args: {
  poolId: string;
  email: string;
}): Promise<{ exists: false } | { exists: true; sub: string; attributes: Record<string, string> }> {
  const client = getCognitoClient();
  try {
    const resp = await client.send(
      new AdminGetUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
    const attributes: Record<string, string> = {};
    for (const a of resp.UserAttributes ?? []) {
      if (a.Name && a.Value !== undefined) attributes[a.Name] = a.Value;
    }
    const sub = attributes['sub'];
    if (!sub) {
      throw new CognitoUnavailableError('AdminGetUser response missing sub attribute');
    }
    return { exists: true, sub, attributes };
  } catch (err) {
    if (err instanceof UserNotFoundException) return { exists: false };
    if (err instanceof CognitoUnavailableError) throw err;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}
```

- [ ] **Step 5: Run tests to verify PASS**

```bash
pnpm --filter @garageos/api test tests/unit/lib/cognito-enable.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/cognito.ts packages/api/tests/unit/lib/cognito-enable.test.ts
git commit -m "feat(api): add enableOfficineUser + getOfficineUserByEmail Cognito helpers"
```

---

## Task 2: POST /v1/users/:id/reactivate route + unit test

**Files:**
- Create: `packages/api/src/routes/v1/users-admin-reactivate.ts`
- Create: `packages/api/tests/unit/routes/users-admin-reactivate.test.ts`
- Modify: `packages/api/src/server.ts:47` (register)

- [ ] **Step 1: Write the failing unit test**

Create `packages/api/tests/unit/routes/users-admin-reactivate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import { buildServer } from '../../../src/server.js';
import {
  _resetCognitoClientForTests,
} from '../../../src/lib/cognito.js';
import { makeFakePrisma, makeAuthOpts, fakeJwt } from '../helpers/fake-app.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR_ID = '33333333-3333-3333-3333-333333333333';
const LOCATION_ID = '44444444-4444-4444-4444-444444444444';

function buildTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    tenantId: TENANT_ID,
    email: 'mech@x.test',
    role: 'mechanic',
    locationId: LOCATION_ID,
    status: 'inactive',
    cognitoSub: 'sub-target',
    deletedAt: new Date('2026-05-15T00:00:00Z'),
  };
}

describe('POST /v1/users/:id/reactivate', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  });

  it('body vuoto: ripristina + AdminEnableUser + audit', async () => {
    const prisma = makeFakePrisma({
      user: {
        findFirst: vi
          .fn()
          // Phase 1: lookup target soft-deleted
          .mockResolvedValueOnce(buildTarget())
          // Actor UUID lookup
          .mockResolvedValueOnce({ id: ACTOR_ID }),
        update: vi.fn().mockResolvedValue({
          ...buildTarget(),
          status: 'active',
          deletedAt: null,
        }),
      },
      location: {
        findFirst: vi.fn().mockResolvedValue({ id: LOCATION_ID }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    });
    const app = await buildServer({
      database: { prisma },
      auth: makeAuthOpts(),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: null,
          status: 'active',
        }),
      }),
    );
    expect(cognitoMock.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user_reactivated',
          entityId: TARGET_ID,
          actorId: ACTOR_ID,
        }),
      }),
    );
  });

  it('target non soft-deleted → 404 user.not_found', async () => {
    const prisma = makeFakePrisma({
      user: { findFirst: vi.fn().mockResolvedValueOnce(null) },
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('user.not_found');
  });

  it('mechanic con locationId override null → 422 location_required_for_mechanic', async () => {
    const prisma = makeFakePrisma({
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(buildTarget({ role: 'mechanic' }))
          .mockResolvedValueOnce({ id: ACTOR_ID }),
      },
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: { locationId: null },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('user.location_required_for_mechanic');
  });

  it('locationId stale → 422 user.location_invalid', async () => {
    const prisma = makeFakePrisma({
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(buildTarget())
          .mockResolvedValueOnce({ id: ACTOR_ID }),
      },
      location: { findFirst: vi.fn().mockResolvedValueOnce(null) },
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('user.location_invalid');
  });

  it('role override + locationId override → audit metadata flags true', async () => {
    const prisma = makeFakePrisma({
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(buildTarget())
          .mockResolvedValueOnce({ id: ACTOR_ID }),
        update: vi.fn().mockResolvedValue({
          ...buildTarget(),
          role: 'super_admin',
          locationId: null,
          status: 'active',
          deletedAt: null,
        }),
      },
      location: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: { role: 'super_admin', locationId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            roleOverridden: true,
            locationOverridden: true,
          }),
        }),
      }),
    );
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });

  it('AdminEnableUser fails UserNotFoundException → 200 (best-effort)', async () => {
    cognitoMock.on(AdminEnableUserCommand).rejects(
      new UserNotFoundException({ message: 'not found', $metadata: {} }),
    );
    const prisma = makeFakePrisma({
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(buildTarget())
          .mockResolvedValueOnce({ id: ACTOR_ID }),
        update: vi.fn().mockResolvedValue({
          ...buildTarget(),
          status: 'active',
          deletedAt: null,
        }),
      },
      location: { findFirst: vi.fn().mockResolvedValue({ id: LOCATION_ID }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('non-super-admin → 403 auth.forbidden.not_super_admin', async () => {
    const prisma = makeFakePrisma({ user: { findFirst: vi.fn() } });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${TARGET_ID}/reactivate`,
      headers: { authorization: `Bearer ${fakeJwt({ role: 'mechanic' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
```

NB: il modulo `helpers/fake-app.ts` esiste già; vedi `packages/api/tests/unit/routes/users-admin-update.test.ts` per pattern fakeJwt/makeFakePrisma. Replica gli stessi import se non sono in scope.

- [ ] **Step 2: Run test to verify FAIL**

```bash
pnpm --filter @garageos/api test tests/unit/routes/users-admin-reactivate.test.ts
```

Expected: FAIL with "Cannot find module 'users-admin-reactivate'" o 404 su tutte le route.

- [ ] **Step 3: Implement the route**

Create `packages/api/src/routes/v1/users-admin-reactivate.ts`:

```typescript
// POST /v1/users/:id/reactivate — F-OFF-004 reactivation (slice 2026-05-21).
//
// Inverte la soft-delete (UPDATE users SET deletedAt=NULL, status='active'),
// con override opzionale di role/locationId, e Cognito AdminEnableUser
// best-effort post-tx. Mirror simmetrico del DELETE /v1/users/:id.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes.
//
// Business rules enforced:
//   BR-204 — mechanic location required
//   BR-211 — riattivazione utente (NEW, vedi APPENDICE_F)
//
// Error codes:
//   user.not_found                       — 404: target non soft-deleted o cross-tenant
//   user.already_active                  — 422: defensive guard (race / replay)
//   user.location_required_for_mechanic  — 422: BR-204
//   user.location_invalid                — 422: locationId stale o cross-tenant
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  enableOfficineUser,
  updateOfficineUserRoleAndLocation,
} from '../../lib/cognito.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../../lib/dtos/user-admin.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z.object({
  role: z.enum(['super_admin', 'mechanic']).optional(),
  locationId: z.string().uuid().nullable().optional(),
});

export const usersAdminReactivateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/users/:id/reactivate',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const tenantId = request.tenantId!;
      const actorCognitoSub = request.userId!;
      const targetId = parsedParams.data.id;
      const body = parsedBody.data;

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Phase 1: lookup target — INCLUDE soft-deleted (deletedAt: { not: null }).
        // Cross-tenant targets return null via RLS scoping inside withContext.
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: { not: null } },
          select: {
            id: true,
            email: true,
            role: true,
            locationId: true,
            status: true,
            cognitoSub: true,
            deletedAt: true,
          },
        });
        if (!target) {
          throw businessError('user.not_found', 404, 'Utente non trovato.');
        }

        // Defensive idempotency: lookup esclude già il caso, ma teniamo per safety.
        if (target.status === 'active' && target.deletedAt === null) {
          throw businessError('user.already_active', 422, 'Utente già attivo.');
        }

        const newRole = body.role ?? target.role;
        const newLocationId = body.locationId !== undefined ? body.locationId : target.locationId;

        // BR-204: mechanic requires a location.
        if (newRole === 'mechanic' && !newLocationId) {
          throw businessError(
            'user.location_required_for_mechanic',
            422,
            'Un meccanico deve essere assegnato a una sede.',
          );
        }

        // Location validity (se non-null).
        if (newLocationId !== null && newLocationId !== undefined) {
          const loc = await tx.location.findFirst({
            where: { id: newLocationId, tenantId, status: 'active', deletedAt: null },
            select: { id: true },
          });
          if (!loc) {
            throw businessError('user.location_invalid', 422, 'Sede non valida o inattiva.');
          }
        }

        // Persist — clear deletedAt + set status=active. Role/locationId only
        // when explicitly provided.
        const updated = await tx.user.update({
          where: { id: targetId },
          data: {
            deletedAt: null,
            status: 'active',
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          },
          select: USER_ADMIN_SELECT,
        });

        // Actor DB UUID for audit (cognitoSub is opaque, not a UUID).
        const actorUser = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actorUser?.id ?? null,
            action: 'user_reactivated',
            entityType: 'user',
            entityId: targetId,
            metadata: {
              targetEmail: target.email,
              previousStatus: target.status,
              previousDeletedAt: target.deletedAt!.toISOString(),
              roleOverridden: body.role !== undefined,
              locationOverridden: body.locationId !== undefined,
              newRole,
              newLocationId,
            },
            ipAddress: request.ip,
          },
        });

        return {
          user: updated,
          targetEmail: target.email,
          targetCognitoSub: target.cognitoSub,
          roleOverridden: body.role !== undefined,
          locationOverridden: body.locationId !== undefined,
        };
      });

      // Cognito sync — best-effort, outside transaction. DB is source of truth.
      let cognitoSyncFailed = false;
      try {
        await enableOfficineUser({
          poolId: env.COGNITO_OFFICINE_POOL_ID,
          email: result.targetEmail,
        });
      } catch (err) {
        cognitoSyncFailed = true;
        request.log.error(
          { err, targetId },
          'cognito AdminEnableUser failed during reactivate (DB committed; operator must enable manually)',
        );
      }

      if (result.roleOverridden || result.locationOverridden) {
        try {
          await updateOfficineUserRoleAndLocation({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: result.targetEmail,
            ...(result.roleOverridden && body.role !== undefined ? { role: body.role } : {}),
            ...(result.locationOverridden ? { locationId: body.locationId ?? null } : {}),
          });
        } catch (err) {
          cognitoSyncFailed = true;
          request.log.error(
            { err, targetId },
            'cognito attribute sync failed during reactivate (DB committed; takes effect on next JWT refresh)',
          );
        }
      }

      if (cognitoSyncFailed) {
        reply.header('x-cognito-sync-failed', 'true');
      }
      return reply.code(200).send({ user: serializeUserAdmin(result.user) });
    },
  );
};
```

- [ ] **Step 4: Register the route in server.ts**

Edit `packages/api/src/server.ts` after line 47:

```typescript
import { usersAdminUpdateRoutes } from './routes/v1/users-admin-update.js';
import { usersAdminDeleteRoutes } from './routes/v1/users-admin-delete.js';
import { usersAdminReactivateRoutes } from './routes/v1/users-admin-reactivate.js';
```

And after line 150:

```typescript
  await app.register(usersAdminUpdateRoutes);
  await app.register(usersAdminDeleteRoutes);
  await app.register(usersAdminReactivateRoutes);
```

- [ ] **Step 5: Run tests to verify PASS**

```bash
pnpm --filter @garageos/api test tests/unit/routes/users-admin-reactivate.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/v1/users-admin-reactivate.ts packages/api/tests/unit/routes/users-admin-reactivate.test.ts packages/api/src/server.ts
git commit -m "feat(api): POST /v1/users/:id/reactivate endpoint with Cognito enable"
```

---

## Task 3: Integration test users-admin-reactivate (real Postgres)

**Files:**
- Create: `packages/api/tests/integration/users-admin-reactivate.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/api/tests/integration/users-admin-reactivate.test.ts`. Usa pattern di `users-admin-mutations.test.ts` (stessa struttura `beforeAll`/`beforeEach` con Testcontainers + tenant seed):

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { FastifyInstance } from 'fastify';

import { buildIntegrationApp } from '../helpers/integration-app.js';
import { resetDatabase, seedTenantWithSuperAdmin, seedMechanic } from '../helpers/db-seed.js';
import { issueOfficineJwt } from '../helpers/cognito-jwt.js';
import { _resetCognitoClientForTests } from '../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const TEST_IP = '10.21.30.1'; // unique per file — see feedback_integration_test_rate_limit_isolation

describe('POST /v1/users/:id/reactivate (integration)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let superAdminSub: string;
  let superAdminId: string;

  beforeAll(async () => {
    app = await buildIntegrationApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    await resetDatabase();
    const seeded = await seedTenantWithSuperAdmin();
    tenantId = seeded.tenantId;
    superAdminSub = seeded.cognitoSub;
    superAdminId = seeded.userId;
  });

  async function softDeleteUser(userId: string) {
    await app.withContext({ role: 'admin' as const }, async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'inactive', deletedAt: new Date() },
      });
    });
  }

  it('happy path: soft-deleted mechanic → reactivate body vuoto → 200 + DB state ripristinato', async () => {
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.status).toBe('active');
    expect(body.user.deletedAt).toBeNull();
    expect(cognitoMock.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
  });

  it('audit row: action=user_reactivated con actorId DB UUID', async () => {
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    const audit = await app.withContext({ role: 'admin' as const }, (tx) =>
      tx.auditLog.findFirst({
        where: { entityId: mech.userId, action: 'user_reactivated' },
      }),
    );
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(superAdminId);
    expect(audit?.metadata).toMatchObject({
      targetEmail: mech.email,
      roleOverridden: false,
      locationOverridden: false,
    });
  });

  it('override role + locationId: audit metadata flags true + Cognito attrs synced', async () => {
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { role: 'super_admin', locationId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).user.role).toBe('super_admin');
    expect(JSON.parse(res.body).user.locationId).toBeNull();
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
    const audit = await app.withContext({ role: 'admin' as const }, (tx) =>
      tx.auditLog.findFirst({
        where: { entityId: mech.userId, action: 'user_reactivated' },
      }),
    );
    expect(audit?.metadata).toMatchObject({
      roleOverridden: true,
      locationOverridden: true,
      newRole: 'super_admin',
      newLocationId: null,
    });
  });

  it('locationId stale: sede soft-deleted → 422 + override valido → 200', async () => {
    const mech = await seedMechanic({ tenantId }); // location originale L1
    await softDeleteUser(mech.userId);
    // Soft-delete L1
    await app.withContext({ role: 'admin' as const }, async (tx) => {
      await tx.location.update({
        where: { id: mech.locationId },
        data: { status: 'inactive', deletedAt: new Date() },
      });
    });
    // Try reactivate body vuoto → 422
    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    expect(res1.statusCode).toBe(422);
    expect(JSON.parse(res1.body).code).toBe('user.location_invalid');
    // Seed L2 + retry con override
    const l2 = await app.withContext({ role: 'admin' as const }, (tx) =>
      tx.location.create({
        data: {
          tenantId,
          name: 'Sede L2',
          status: 'active',
          city: 'Roma',
          isPrimary: false,
        },
      }),
    );
    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { locationId: l2.id },
    });
    expect(res2.statusCode).toBe(200);
  });

  it('BR-204: soft-deleted user con locationId originale → override role=mechanic + locationId=null → 422', async () => {
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { locationId: null },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('user.location_required_for_mechanic');
  });

  it('utente attivo (deletedAt null) → 404 user.not_found', async () => {
    const mech = await seedMechanic({ tenantId });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('user.not_found');
  });

  it('cross-tenant target → 404', async () => {
    const other = await seedTenantWithSuperAdmin();
    const otherMech = await seedMechanic({ tenantId: other.tenantId });
    await softDeleteUser(otherMech.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${otherMech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('mechanic role → 403', async () => {
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${mech.userId}/reactivate`,
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: 'other-sub', tenantId, role: 'mechanic' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
```

NB: gli helper `seedTenantWithSuperAdmin`, `seedMechanic`, `buildIntegrationApp`, `issueOfficineJwt`, `resetDatabase` esistono già — vedi `packages/api/tests/integration/users-admin-mutations.test.ts` per esempi e import path corretti. Se `seedMechanic` non esiste con la signature qui, adattare al pattern esistente nel file gemello.

- [ ] **Step 2: Run integration test to verify FAIL/PASS**

```bash
pnpm --filter @garageos/api test:integration tests/integration/users-admin-reactivate.test.ts
```

Expected: PASS (8 tests). Se uno fail, è probabilmente per signature differente degli helper — riallinea con il file gemello.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/users-admin-reactivate.test.ts
git commit -m "test(api): integration coverage for POST /v1/users/:id/reactivate"
```

---

## Task 4: users-invitations-create cross-tenant early-check

**Files:**
- Modify: `packages/api/src/routes/v1/users-invitations-create.ts:91-101` (step 1) + insert step 1bis
- Modify: `packages/api/tests/unit/routes/users-invitations-create.test.ts`
- Modify: `packages/api/tests/integration/users-invitations.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Edit `packages/api/tests/unit/routes/users-invitations-create.test.ts` — aggiungere alla describe esistente:

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { _resetCognitoClientForTests } from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('POST /v1/users/invitations — cross-tenant early-check', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('Cognito exists + DB null → 409 user.invitation.email_in_other_tenant', async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: 'cross@x.test',
      UserAttributes: [
        { Name: 'sub', Value: 'cognito-sub' },
        { Name: 'email', Value: 'cross@x.test' },
      ],
    });
    const prisma = makeFakePrismaWithSuperAdminAndLocation();
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: validInvitePayload({ email: 'cross@x.test' }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('user.invitation.email_in_other_tenant');
  });

  it('Cognito NOT exists → flow continua → 201', async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(
      new (await import('@aws-sdk/client-cognito-identity-provider')).UserNotFoundException({
        message: 'not found',
        $metadata: {},
      }),
    );
    // ...mock invitation.create + auditLog.create as in existing happy-path test
    // expect 201
  });

  it('Cognito throws → 502 auth.cognito_unavailable, no DB write', async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('boom'));
    const prisma = makeFakePrismaWithSuperAdminAndLocation({
      invitationCreate: vi.fn(),
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: validInvitePayload(),
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('auth.cognito_unavailable');
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });

  it('DB hit same-tenant active (deletedAt=null) → 409 email_already_active, Cognito non chiamato', async () => {
    const prisma = makeFakePrismaWithSuperAdminAndLocation({
      userFindFirstOverride: vi.fn().mockResolvedValue({ id: 'existing-uuid', deletedAt: null }),
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: validInvitePayload(),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('user.invitation.email_already_active');
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });

  it('DB hit same-tenant soft-deleted (deletedAt != null) → 409 email_soft_deleted_in_tenant, Cognito non chiamato', async () => {
    const prisma = makeFakePrismaWithSuperAdminAndLocation({
      userFindFirstOverride: vi
        .fn()
        .mockResolvedValue({ id: 'existing-uuid', deletedAt: new Date() }),
    });
    const app = await buildServer({ database: { prisma }, auth: makeAuthOpts() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: { authorization: `Bearer ${fakeJwt({ role: 'super_admin' })}` },
      payload: validInvitePayload(),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('user.invitation.email_soft_deleted_in_tenant');
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });
});
```

NB: gli helper `makeFakePrismaWithSuperAdminAndLocation` + `validInvitePayload` esistono già nel file (vedi cima del file). Se signature differente, riadatta.

- [ ] **Step 2: Run tests to verify FAIL**

```bash
pnpm --filter @garageos/api test tests/unit/routes/users-invitations-create.test.ts
```

Expected: FAIL sui nuovi cases (cross-tenant code non esiste ancora).

- [ ] **Step 3: Modify route — step 1 ridefinito + step 1bis Cognito**

Edit `packages/api/src/routes/v1/users-invitations-create.ts`. Aggiungere import (riga ~24):

```typescript
import { sendInvitationEmail } from '../../lib/ses-client.js';
import { getOfficineUserByEmail } from '../../lib/cognito.js';
import { env } from '../../config/env.js';
import { generateInvitationToken } from '../../lib/secure-tokens.js';
```

Sostituire il blocco `// 1) Email collision check...` (linee ~88-101) con:

```typescript
        // 1) DB collision check nel tenant corrente — INCLUDE soft-deleted.
        //    Discriminiamo a posteriori: active → email_already_active;
        //    soft-deleted → email_soft_deleted_in_tenant (operator deve usare
        //    POST /v1/users/:id/reactivate, non /invitations).
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

        // 1bis) Cross-tenant early-check via Cognito.
        // Email assente in DB tenant corrente; hit Cognito = utente in altro tenant.
        // (Pool Officine è single-pool: email è alias globale.)
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
            "Questa email risulta già registrata in un'altra officina. Contatta il supporto.",
          );
        }
```

- [ ] **Step 4: Run unit tests to verify PASS**

```bash
pnpm --filter @garageos/api test tests/unit/routes/users-invitations-create.test.ts
```

Expected: PASS (tutti i test, vecchi + nuovi).

- [ ] **Step 5: Add integration test cases**

Edit `packages/api/tests/integration/users-invitations.test.ts` — aggiungere alla describe esistente:

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

const cognitoMockIntegration = mockClient(CognitoIdentityProviderClient);

describe('POST /v1/users/invitations — cross-tenant detection (integration)', () => {
  beforeEach(() => {
    cognitoMockIntegration.reset();
    _resetCognitoClientForTests();
  });

  it('Cognito hit + no DB user → 409 email_in_other_tenant, no invitation row', async () => {
    cognitoMockIntegration.on(AdminGetUserCommand).resolves({
      Username: 'cross@x.test',
      UserAttributes: [{ Name: 'sub', Value: 'cognito-cross-sub' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { email: 'cross@x.test', firstName: 'A', lastName: 'B', role: 'mechanic', locationId: primaryLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('user.invitation.email_in_other_tenant');
    const count = await app.withContext({ role: 'admin' as const }, (tx) =>
      tx.invitation.count({ where: { targetEmail: 'cross@x.test' } }),
    );
    expect(count).toBe(0);
  });

  it('Cognito throws → 502 auth.cognito_unavailable, no invitation row', async () => {
    cognitoMockIntegration.on(AdminGetUserCommand).rejects(new Error('boom'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { email: 'new@x.test', firstName: 'A', lastName: 'B', role: 'mechanic', locationId: primaryLocationId },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('auth.cognito_unavailable');
  });

  it('soft-deleted same-tenant user → 409 email_soft_deleted_in_tenant, no Cognito call', async () => {
    cognitoMockIntegration.on(AdminGetUserCommand).resolves({}); // shouldn't be reached
    const mech = await seedMechanic({ tenantId });
    await softDeleteUser(mech.userId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: {
        authorization: `Bearer ${issueOfficineJwt({ sub: superAdminSub, tenantId, role: 'super_admin' })}`,
        'x-forwarded-for': TEST_IP,
      },
      payload: { email: mech.email, firstName: 'A', lastName: 'B', role: 'mechanic', locationId: primaryLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('user.invitation.email_soft_deleted_in_tenant');
    expect(cognitoMockIntegration.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });
});
```

NB: `softDeleteUser` helper può vivere inline come in Task 3 oppure essere estratto a `tests/helpers/db-seed.ts` se già non c'è.

- [ ] **Step 6: Run integration tests to verify PASS**

```bash
pnpm --filter @garageos/api test:integration tests/integration/users-invitations.test.ts
```

Expected: PASS (vecchi + 3 nuovi).

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @garageos/api typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/v1/users-invitations-create.ts packages/api/tests/unit/routes/users-invitations-create.test.ts packages/api/tests/integration/users-invitations.test.ts
git commit -m "feat(api): cross-tenant early-check + soft-deleted re-invite guard on /v1/users/invitations"
```

---

## Task 5: useReactivateUser React Query hook

**Files:**
- Modify: `packages/web/src/queries/users-admin.ts`
- Modify: `packages/web/src/queries/users-admin.test.tsx`

- [ ] **Step 1: Write the failing test**

Edit `packages/web/src/queries/users-admin.test.tsx` — aggiungere alla describe esistente:

```typescript
describe('useReactivateUser', () => {
  it('POST /v1/users/:id/reactivate con body vuoto + invalida users query', async () => {
    const mockPost = vi.fn().mockResolvedValue({ user: { id: 'u1', status: 'active' } });
    vi.mocked(apiFetch).mockImplementation((path, opts) => mockPost(path, opts));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useReactivateUser('user-id-1'), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/v1/users/user-id-1/reactivate',
      expect.objectContaining({ method: 'POST', body: {} }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users'] });
  });

  it('POST con role + locationId override → payload corretto', async () => {
    const mockPost = vi.fn().mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(apiFetch).mockImplementation((path, opts) => mockPost(path, opts));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useReactivateUser('user-id-1'), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.mutateAsync({ role: 'super_admin', locationId: null });
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/v1/users/user-id-1/reactivate',
      expect.objectContaining({
        method: 'POST',
        body: { role: 'super_admin', locationId: null },
      }),
    );
  });
});
```

NB: usa il pattern dei mock già attivo nel file (vi.mock per `../lib/api-client`). Importa `useReactivateUser` dall'hook che stai per scrivere.

- [ ] **Step 2: Run test to verify FAIL**

```bash
pnpm --filter @garageos/web test src/queries/users-admin.test.tsx
```

Expected: FAIL "useReactivateUser is not exported".

- [ ] **Step 3: Implement the hook**

Edit `packages/web/src/queries/users-admin.ts` — aggiungere in fondo:

```typescript
export type ReactivateUserBody = {
  role?: 'super_admin' | 'mechanic';
  locationId?: string | null;
};

export function useReactivateUser(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReactivateUserBody) => {
      return apiFetch<{ user: AdminUser }>(`/v1/users/${userId}/reactivate`, {
        method: 'POST',
        body,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
```

NB: se `AdminUser` non è il tipo esistente esportato, usa il tipo presente nel file (es. `UserAdminWireDto` o equivalente). Riusa esattamente gli stessi import + pattern di `useUpdateUser` esistente nel file.

- [ ] **Step 4: Run tests to verify PASS**

```bash
pnpm --filter @garageos/web test src/queries/users-admin.test.tsx
```

Expected: PASS (vecchi + 2 nuovi).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/users-admin.ts packages/web/src/queries/users-admin.test.tsx
git commit -m "feat(web): useReactivateUser React Query hook"
```

---

## Task 6: ReactivateSection component

**Files:**
- Create: `packages/web/src/components/users/ReactivateSection.tsx`
- Create: `packages/web/src/components/users/ReactivateSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/users/ReactivateSection.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ReactivateSection } from './ReactivateSection.js';
import * as queries from '../../queries/users-admin.js';

const TENANT_LOCATIONS = [
  { id: 'loc-1', name: 'Sede Roma Centro', status: 'active' as const },
  { id: 'loc-2', name: 'Sede Roma Nord', status: 'active' as const },
];

const INACTIVE_USER = {
  id: 'u-1',
  email: 'mech@x.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic' as const,
  locationId: 'loc-1',
  locationName: 'Sede Roma Centro',
  locationStatus: 'active' as const,
  status: 'inactive' as const,
  deletedAt: '2026-05-01T00:00:00Z',
};

function renderWithQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ReactivateSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders primary button + preview email/role/location', () => {
    renderWithQueryClient(
      <ReactivateSection user={INACTIVE_USER} locations={TENANT_LOCATIONS} onSuccess={() => {}} />,
    );
    expect(screen.getByTestId('reactivate-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /riattiva utente/i })).toBeInTheDocument();
    expect(screen.getByText(/mech@x.test/)).toBeInTheDocument();
    expect(screen.getByText(/sede roma centro/i)).toBeInTheDocument();
  });

  it('click primary → mostra step conferma', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection user={INACTIVE_USER} locations={TENANT_LOCATIONS} onSuccess={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    expect(screen.getByRole('button', { name: /conferma riattivazione/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /annulla/i })).toBeInTheDocument();
  });

  it('location stale: locationStatus !== "active" → mostra Select per nuova sede', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection
        user={{ ...INACTIVE_USER, locationStatus: 'inactive' }}
        locations={TENANT_LOCATIONS}
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    expect(screen.getByText(/sede non valida/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /seleziona nuova sede/i })).toBeInTheDocument();
    // Confirm button disabled until select.
    expect(screen.getByRole('button', { name: /conferma riattivazione/i })).toBeDisabled();
  });

  it('click conferma → calls useReactivateUser con body vuoto (location originale OK)', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ user: { id: 'u-1' } });
    vi.spyOn(queries, 'useReactivateUser').mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      error: null,
    } as ReturnType<typeof queries.useReactivateUser>);

    const onSuccess = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection user={INACTIVE_USER} locations={TENANT_LOCATIONS} onSuccess={onSuccess} />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    await user.click(screen.getByRole('button', { name: /conferma riattivazione/i }));

    expect(mutateAsync).toHaveBeenCalledWith({});
    expect(onSuccess).toHaveBeenCalled();
  });

  it('mutation error user.location_invalid → mostra inline error + torna allo step 1', async () => {
    const mutateAsync = vi.fn().mockRejectedValue({
      code: 'user.location_invalid',
      message: 'Sede non valida o inattiva.',
    });
    vi.spyOn(queries, 'useReactivateUser').mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: { code: 'user.location_invalid', message: 'Sede non valida o inattiva.' },
    } as ReturnType<typeof queries.useReactivateUser>);

    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection user={INACTIVE_USER} locations={TENANT_LOCATIONS} onSuccess={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    await user.click(screen.getByRole('button', { name: /conferma riattivazione/i }));
    expect(await screen.findByText(/sede non valida/i)).toBeInTheDocument();
  });

  it('annulla riporta a step 1', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection user={INACTIVE_USER} locations={TENANT_LOCATIONS} onSuccess={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    await user.click(screen.getByRole('button', { name: /annulla/i }));
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
  });

  it('location stale + select location → confirm abilitato + payload include locationId', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ user: { id: 'u-1' } });
    vi.spyOn(queries, 'useReactivateUser').mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      error: null,
    } as ReturnType<typeof queries.useReactivateUser>);

    const user = userEvent.setup();
    renderWithQueryClient(
      <ReactivateSection
        user={{ ...INACTIVE_USER, locationStatus: 'inactive' }}
        locations={TENANT_LOCATIONS}
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /riattiva utente/i }));
    // Apri Radix Select via userEvent (vedi feedback_radix_tabs_user_event_not_fire_event).
    await user.click(screen.getByRole('combobox', { name: /seleziona nuova sede/i }));
    await user.click(screen.getByRole('option', { name: /sede roma nord/i }));
    await user.click(screen.getByRole('button', { name: /conferma riattivazione/i }));
    expect(mutateAsync).toHaveBeenCalledWith({ locationId: 'loc-2' });
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
pnpm --filter @garageos/web test src/components/users/ReactivateSection.test.tsx
```

Expected: FAIL (component non esiste).

- [ ] **Step 3: Implement the component**

Create `packages/web/src/components/users/ReactivateSection.tsx`:

```typescript
import { useState } from 'react';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useReactivateUser } from '../../queries/users-admin.js';

type LocationOption = {
  id: string;
  name: string;
  status: 'active' | 'inactive';
};

type Props = {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'super_admin' | 'mechanic';
    locationId: string | null;
    locationName: string | null;
    locationStatus: 'active' | 'inactive' | null;
    status: 'active' | 'inactive';
  };
  locations: LocationOption[];
  onSuccess: () => void;
};

const ROLE_LABEL: Record<'super_admin' | 'mechanic', string> = {
  super_admin: 'Amministratore',
  mechanic: 'Meccanico',
};

export function ReactivateSection({ user, locations, onSuccess }: Props) {
  const [step, setStep] = useState<'idle' | 'confirm'>('idle');
  const [overrideLocationId, setOverrideLocationId] = useState<string | null>(null);
  const reactivateMut = useReactivateUser(user.id);

  const locationStale = user.locationStatus !== null && user.locationStatus !== 'active';
  const needsLocationOverride = user.role === 'mechanic' && locationStale;
  const activeLocations = locations.filter((l) => l.status === 'active');

  const handleConfirm = async () => {
    const body: { role?: 'super_admin' | 'mechanic'; locationId?: string | null } = {};
    if (overrideLocationId) body.locationId = overrideLocationId;
    try {
      await reactivateMut.mutateAsync(body);
      onSuccess();
    } catch {
      // Error displayed via reactivateMut.isError below; stay on confirm step.
    }
  };

  const reset = () => {
    setStep('idle');
    setOverrideLocationId(null);
  };

  return (
    <section data-testid="reactivate-section">
      <h3 className="font-medium mb-2">Riattiva utente</h3>
      <div className="text-sm text-muted-foreground mb-3">
        <div>Email: {user.email}</div>
        <div>Ruolo: {ROLE_LABEL[user.role]}</div>
        <div>Sede: {user.locationName ?? '—'}</div>
      </div>

      {step === 'idle' ? (
        <Button onClick={() => setStep('confirm')}>Riattiva utente</Button>
      ) : (
        <div className="space-y-3">
          {needsLocationOverride && (
            <div>
              <p className="text-sm text-destructive mb-2">
                Sede non valida o inattiva. Seleziona una nuova sede:
              </p>
              <Select value={overrideLocationId ?? ''} onValueChange={setOverrideLocationId}>
                <SelectTrigger aria-label="Seleziona nuova sede">
                  <SelectValue placeholder="Scegli sede" />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {reactivateMut.isError && (
            <p className="text-sm text-destructive">
              {(reactivateMut.error as { message?: string })?.message ??
                'Errore durante la riattivazione.'}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleConfirm}
              disabled={
                reactivateMut.isPending || (needsLocationOverride && !overrideLocationId)
              }
            >
              {reactivateMut.isPending ? 'Riattivazione…' : 'Conferma riattivazione'}
            </Button>
            <Button variant="outline" onClick={reset} disabled={reactivateMut.isPending}>
              Annulla
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
```

NB: gli alias `ui/button` + `ui/select` riusano le componenti shadcn esistenti. Verifica path (`../ui/button` vs `@/components/ui/button`) — usa quello presente in altri component file della cartella `users/`.

- [ ] **Step 4: Run tests to verify PASS**

```bash
pnpm --filter @garageos/web test src/components/users/ReactivateSection.test.tsx
```

Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/users/ReactivateSection.tsx packages/web/src/components/users/ReactivateSection.test.tsx
git commit -m "feat(web): ReactivateSection component with 2-step flow + location stale dropdown"
```

---

## Task 7: EditUserDialog integration

**Files:**
- Modify: `packages/web/src/components/users/EditUserDialog.tsx:213-219`
- Modify: `packages/web/src/components/users/EditUserDialog.test.tsx:318-340`

- [ ] **Step 1: Update the existing test "hides ALL action sections" → "renders ReactivateSection"**

Edit `packages/web/src/components/users/EditUserDialog.test.tsx`. Locate il test `it('hides ALL action sections (role/location/deactivate) and shows only inactive notice when status="inactive"', ...)` (~riga 324) e sostituiscilo con:

```typescript
  it('renders ReactivateSection for inactive user, hides role/location/deactivate sections', () => {
    render(<EditUserDialog user={INACTIVE_USER} open={true} onOpenChange={() => {}} />, {
      wrapper: createWrapper(),
    });

    // Sections nascoste
    expect(screen.queryByRole('button', { name: /cambia ruolo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cambia sede/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^disattiva utente$/i })).not.toBeInTheDocument();

    // ReactivateSection presente
    expect(screen.getByTestId('reactivate-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
pnpm --filter @garageos/web test src/components/users/EditUserDialog.test.tsx
```

Expected: FAIL (notice ancora presente, ReactivateSection ancora non integrata).

- [ ] **Step 3: Wire `<ReactivateSection>` in EditUserDialog**

Edit `packages/web/src/components/users/EditUserDialog.tsx`. Import in cima:

```typescript
import { ReactivateSection } from './ReactivateSection.js';
```

Verifica che il componente abbia accesso a `locations` (lista sedi tenant) — se non lo ha già come prop, controlla come `EditUserDialog` ottiene la lista per la sezione "Cambia sede" (è probabile che usi un hook tipo `useLocations`). Riusa lo stesso pattern.

Sostituisci il blocco (~righe 213-219):

```tsx
          {user.status === 'inactive' ? (
            <section data-testid="inactive-notice">
              <h3 className="font-medium mb-2">Utente disattivato</h3>
              <p className="text-sm text-muted-foreground">
                Questo utente è disattivato e non può essere modificato. La riattivazione non è
                ancora supportata.
              </p>
            </section>
          ) : (
```

con:

```tsx
          {user.status === 'inactive' ? (
            <ReactivateSection
              user={user}
              locations={locations ?? []}
              onSuccess={() => onOpenChange(false)}
            />
          ) : (
```

NB: il nome `locations` qui assume che la prop o l'hook esistente si chiami così. Se nel file esiste un'altra naming convention (es. `tenantLocations`, `locationOptions`), allinea. Stessa cosa per il close handler — usa il pattern esistente di `EditUserDialog` per chiudere il dialog post-success.

- [ ] **Step 4: Run tests to verify PASS**

```bash
pnpm --filter @garageos/web test src/components/users/EditUserDialog.test.tsx
```

Expected: PASS (test rinominato + tutti gli altri vecchi).

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/users/EditUserDialog.tsx packages/web/src/components/users/EditUserDialog.test.tsx
git commit -m "feat(web): wire ReactivateSection into EditUserDialog for inactive users"
```

---

## Task 8: Docs bundle (APPENDICE_F + G + A + smoke runbook)

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (~righe 781-790, dopo BR-210)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/superpowers/runbooks/F-OFF-004-smoke.md`

- [ ] **Step 1: Update BR-207 wording**

Edit `docs/APPENDICE_F_BUSINESS_LOGIC.md` ~riga 780-782. Locate la sezione `### BR-207 — Rimozione utente` e aggiungi una clausola finale:

```markdown
### BR-207 — Rimozione utente
Super Admin può rimuovere un utente (soft delete, `status=inactive` + `deleted_at`).

**La rimozione è reversibile via BR-211 nello stesso tenant.**
```

- [ ] **Step 2: Add BR-211 + BR-212 dopo BR-210**

Edit `docs/APPENDICE_F_BUSINESS_LOGIC.md`. Dopo la sezione `### BR-210 — Suspension tenant`, aggiungi:

```markdown
### BR-211 — Riattivazione utente (F-OFF-004 follow-up)
Super Admin può riattivare un utente soft-deleted (`status=inactive`, `deleted_at IS NOT NULL`) nel proprio tenant via `POST /v1/users/:id/reactivate`.

**Effetto:**
- `deleted_at = NULL`, `status = 'active'`
- `AdminEnableUser` su Cognito (re-enable user)
- Optional override `{role?, locationId?}`
- Audit log `action='user_reactivated'`

**Vincoli:**
- BR-204 ricontrollato: mechanic richiede location active
- BR-203 non applicabile (reactivate aggiunge un super_admin, mai sottrae)

**Limitazione cross-tenant**: BR-211 risolve solo same-tenant. Per cross-tenant cohabitation vedi BR-212 (out-of-scope v1).

### BR-212 — Cross-tenant email collision (F-OFF-004 follow-up)
Cognito Officine è single-pool (`eu-central-1_9Rd7nGpH8`) quindi email è alias globalmente unico nel pool.

**Conseguenza:**
- Un meccanico X attivo in Officina A NON può essere invitato in Officina B mentre X è attivo (Cognito `UsernameExistsException`).
- Anche dopo soft-delete in A, X non può essere invitato in B finché il Cognito user esiste.
- `POST /v1/users/invitations` rileva il caso via Cognito `AdminGetUser` early-check e restituisce `409 user.invitation.email_in_other_tenant`.

**Out-of-scope v1**: cross-tenant cohabitation richiederebbe rearchitect Cognito (pool-per-tenant o `custom:tenant_ids` list-attribute). Tracciato come F-OFF-XXX futuro.
```

- [ ] **Step 3: Add error codes a APPENDICE_G**

Edit `docs/APPENDICE_G_ERROR_CODES.md`. Locate la sezione `user.*` (probabilmente sotto le sezioni admin) e aggiungi le 3 righe nuove rispettando il formato esistente del file. Pattern atteso (verifica formato reale nel file):

```markdown
| `user.already_active` | 422 | info | "Utente già attivo." | F-OFF-004 reactivation: POST /reactivate su utente non soft-deleted (race / replay). |
| `user.invitation.email_in_other_tenant` | 409 | warning | "Questa email risulta già registrata in un'altra officina. Contatta il supporto." | F-OFF-004 cross-tenant: Cognito GetUser hit al POST invitations + no User row in tenant chiamante. BR-212. |
| `user.invitation.email_soft_deleted_in_tenant` | 409 | info | "Questa email appartiene a un utente disattivato. Riattivalo da Impostazioni → Utenti." | F-OFF-004 reactivation hint: operator tries to re-invite same email in same tenant where the user is soft-deleted. |
```

- [ ] **Step 4: Add endpoint docs a APPENDICE_A**

Edit `docs/APPENDICE_A_API.md`. Locate la sezione F-OFF-004 (around `PATCH /v1/users/:id`) e aggiungi dopo:

```markdown
#### `POST /v1/users/:id/reactivate`

Riattiva un utente soft-deleted nel tenant del caller. Requires `requireSuperAdmin`.

**Request body** (Zod, all optional):
\`\`\`json
{
  "role": "super_admin" | "mechanic",
  "locationId": "uuid | null"
}
\`\`\`

Body vuoto `{}` valido: ripristina role/locationId originali (validati). `locationId: null` esplicito ammesso solo se nuovo `role === 'super_admin'` (BR-204).

**Response 200:**
\`\`\`json
{ "user": { /* USER_ADMIN serializer */ } }
\`\`\`

**Response header opzionale:** `X-Cognito-Sync-Failed: true` se Cognito `AdminEnableUser` o `AdminUpdateUserAttributes` post-tx ha fallito (DB già committed; operator deve eseguire enable manuale via console).

**Error codes:**
| HTTP | Code | Trigger |
|---|---|---|
| 403 | `auth.forbidden.not_super_admin` | Caller non super_admin |
| 404 | `user.not_found` | Target non esiste, è in altro tenant, o non è soft-deleted |
| 422 | `user.already_active` | Race/replay defensive |
| 422 | `user.location_required_for_mechanic` | BR-204 |
| 422 | `user.location_invalid` | Sede stale o cross-tenant |
```

E per `POST /v1/users/invitations`, aggiungi alla sezione "Error codes" della tabella esistente le 2 nuove righe:

```markdown
| 409 | `user.invitation.email_in_other_tenant` | Email registrata in altro tenant (Cognito hit). BR-212. |
| 409 | `user.invitation.email_soft_deleted_in_tenant` | Email appartiene a utente soft-deleted same-tenant. Operator deve usare /reactivate. |
| 502 | `auth.cognito_unavailable` | Cognito `AdminGetUser` lookup failed |
```

- [ ] **Step 5: Add smoke runbook §PR3**

Edit `docs/superpowers/runbooks/F-OFF-004-smoke.md`. Aggiungi una nuova section dopo l'ultima:

```markdown
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
   \`\`\`sql
   UPDATE locations SET status='inactive', deleted_at=now() WHERE id='<L1-uuid>';
   \`\`\`
   Ri-apri EditUserDialog sul user inactive → click "Riattiva utente" → conferma. Vedi messaggio "Sede non valida" + dropdown "Seleziona nuova sede" → seleziona L2 → "Conferma riattivazione" → success.
9. **Edge already_active**: replay POST via curl:
   \`\`\`bash
   curl -X POST https://api.garageos.aifollyadvisor.com/v1/users/<active-user-id>/reactivate \\
        -H "Authorization: Bearer $SUPER_ADMIN_JWT" \\
        -H "Content-Type: application/json" \\
        -d '{}'
   \`\`\`
   Expected: `422 user.already_active`.
10. **Soft-deleted re-invite 409**: come Super Admin, prova a invitare di nuovo `mechanic-secondary` mentre è soft-deleted → POST `/v1/users/invitations` → `409 user.invitation.email_soft_deleted_in_tenant`. UI mostra "Riattivalo da Impostazioni → Utenti".
11. **Cross-tenant 409**: SOLO se esiste un secondo tenant nel seed pilot. Come Super Admin di tenant B, prova a invitare `mechanic-test@demo-giuseppe.test` (registrato nel tenant Giuseppe) → POST `/v1/users/invitations` → `409 user.invitation.email_in_other_tenant`. Se nessun tenant secondario è disponibile, **skip lo step** + nota nel runbook che l'invariante è coperta da test integration `users-invitations.test.ts`.
12. **Cleanup**: ripristina seed state (mechanic-secondary attivo, L1 ripristinata se toccata, eventuali invitation row create eliminate via DB).

**Esito atteso**: 0 Critical, 0 Important, eventualmente Minor sulla copy IT del messaggio. Loggare risultato in `feedback_smoke_runbook_catches_ux_drift.md` e in `project_resume_checkpoint.md`.
```

- [ ] **Step 6: Verify no other doc cites the removed notice**

Run:

```bash
grep -rn "non è ancora supportata" docs/ packages/web/src/
```

Expected: zero matches (la stringa è stata rimossa da `EditUserDialog.tsx` in Task 7). Se trovi match, è probabilmente in un plan storico — accettabile, non modificare.

- [ ] **Step 7: Commit**

```bash
git add docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_G_ERROR_CODES.md docs/APPENDICE_A_API.md docs/superpowers/runbooks/F-OFF-004-smoke.md
git commit -m "docs(api): BR-211 reactivation + BR-212 cross-tenant + error codes + smoke runbook §PR3"
```

---

## Task 9: Final code reviewer (gate pre-push)

**Files:** none (read-only review).

- [ ] **Step 1: Run full local typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors across `@garageos/api`, `@garageos/database`, `@garageos/web`, `@garageos/shared`, `infrastructure`. Se errori, fix prima di proseguire.

- [ ] **Step 2: Quick check cumulative LOC**

```bash
git diff --stat main...HEAD
```

Expected: ≤1800 LOC gross. Se superiore, fermarsi e proporre split (vedi [[feedback_mid_execution_loc_checkpoint]]).

- [ ] **Step 3: Dispatch final code reviewer subagent**

In una nuova istanza, dispatch the code-quality reviewer agent with full branch context:

```
Reviewer prompt:
Branch `feat/user-reactivation` vs main. Implementa F-OFF-004 reactivation flow per spec `docs/superpowers/specs/2026-05-21-user-reactivation-design.md`.

Focus su 4 risk areas note dalla cronologia recente:
1. **Prisma data XOR defeat** ([[feedback_prisma_data_xor_defeats_excess_property]]) — verifica che `tx.user.update({data:{...}})` in `users-admin-reactivate.ts` non contenga campi extra o renamed silenti.
2. **Schema rename cascade** ([[feedback_schema_rename_cascade_extends_to_production_code]]) — no schema renames in questo slice, ma sanity check su tutti i Prisma `create/update` calls toccati.
3. **Cascade su production code** ([[feedback_per_task_review_misses_production_cascade]]) — il toccare `users-invitations-create.ts` step 1 ha effetti su `invitations-public-accept.ts` Phase 1 collision check? Quel route filtra ancora `deletedAt: null` correttamente per il suo use case (accept flow vuole bloccare anche resurrezione)?
4. **Cognito best-effort header pattern** — `X-Cognito-Sync-Failed: true` è un nuovo pattern. Verifica che non rompa client esistenti, che sia documentato in APPENDICE_A.

Restituisci issue list separated per Severity: Critical (block merge) / Important (fix before merge) / Minor (post-merge OK).
```

- [ ] **Step 4: Apply reviewer feedback**

Per ogni Critical e Important: fix + commit con messaggio dedicato. Per Minor: registra in `tech_debt` memo + skip.

- [ ] **Step 5: Final commit & push**

```bash
git push -u origin feat/user-reactivation
```

- [ ] **Step 6: Open PR via gh CLI**

```bash
gh pr create --title "feat(api,web,database): F-OFF-004 user reactivation slice (BR-211 + BR-212)" --body "$(cat <<'EOF'
## What
Sblocca il flow di reattivazione utenti F-OFF-004 nello stesso tenant via nuovo `POST /v1/users/:id/reactivate` (Super Admin only). Aggiunge cross-tenant early-detection a invite-time per evitare invio email inutili e UX confusa.

## Why
F-OFF-004 lasciava 3 product questions aperte (vedi `memory/project_user_reactivation_open_questions.md`). Stato attuale: dopo soft-delete l'email è morta — utente non riattivabile via API/UI, re-invito fallisce 409 a accept-time con messaggio generico. Spec: `docs/superpowers/specs/2026-05-21-user-reactivation-design.md`. Plan: `docs/superpowers/plans/2026-05-21-user-reactivation.md`.

## Implementation notes
- **BR-211 (NEW)** "Riattivazione utente" — POST endpoint dedicato (mirror simmetrico del DELETE), Cognito `AdminEnableUser` best-effort post-tx, header `X-Cognito-Sync-Failed: true` su Cognito error.
- **BR-212 (NEW)** "Cross-tenant single-pool" — documenta limitazione Cognito + tracciato F-OFF-XXX futuro per cohabitation.
- **Step 1 ridefinito** in `users-invitations-create.ts`: rimuove filtro `deletedAt:null`, discrimina active vs soft-deleted (nuovo error `user.invitation.email_soft_deleted_in_tenant`) prima del Cognito early-check.
- Frontend: nuovo componente `ReactivateSection` 2-step simmetrico a Disattiva. Dropdown condizionale per location stale.

## Tests
- [x] Unit tests added (api: ~12 new, web: ~7 new)
- [x] Integration tests added (api: 8 new in users-admin-reactivate, +3 in users-invitations)
- [x] Manual smoke test on local env (deferred to operator post-merge)
- [x] BR-211 + BR-212 verified via test + smoke runbook §PR3

## Checklist
- [x] Code follows conventions in CLAUDE.md
- [x] Types compile (`pnpm -r typecheck`)
- [x] Linter clean (`pnpm lint` via CI)
- [x] Tests pass (CI integration)
- [x] No new console.log, no commented-out code
- [x] Secrets not committed
- [x] Documentation updated (APPENDICE_F, G, A + smoke runbook)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Watch CI**

```bash
gh pr checks --watch
```

Expected: tutti green al 1° tentativo (target streak ZERO-critical 17 → 18).

---

## Self-review checkpoint

**1. Spec coverage**:
- §1.1 in-scope (reactivate endpoint, body override, location validation, frontend, cross-tenant, BR-211, BR-212, BR-207, error codes, runbook) — coperto da Task 2-8.
- §1.2 out-of-scope — non implementato per design.
- §2 architecture (flow, components, BR, security) — Task 1, 2, 8.
- §3 files — mappato 1:1 nelle task tables.
- §4 endpoint contracts — Task 2 + Task 4.
- §5 test plan — Task 2 (unit reactivate), Task 3 (integration reactivate), Task 4 (unit + integration invitations), Task 6 (web), Task 8 (smoke).
- §6 risks — affrontati nei test cases (Cognito fail, location stale, race, cross-tenant disclosure).
- §7 reviewer + decomposition — Task 9.

**2. Placeholder scan**: clean.

**3. Type consistency**:
- `enableOfficineUser({poolId, email})` — Task 1 def, Task 2 use ✓.
- `getOfficineUserByEmail({poolId, email}) → {exists, sub?, attributes?}` — Task 1 def, Task 4 use ✓.
- `useReactivateUser(userId).mutateAsync({role?, locationId?})` — Task 5 def, Task 6 use ✓.
- `ReactivateSection` props `{user, locations, onSuccess}` — Task 6 def, Task 7 use ✓.

**4. Worktree convention**: questo repo usa branch feature, non worktree. Plan creato direttamente su `feat/user-reactivation` (Task 9 push). Se executing-plans richiede worktree, il subagent-driven runner lo creerà.

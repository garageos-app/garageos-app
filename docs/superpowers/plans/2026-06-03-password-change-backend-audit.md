# Password Change/Reset Backend Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a `audit_logs` row (and apply a per-IP rate-limit) every time an officina user changes or resets their password, without moving the Cognito password flow off the client.

**Architecture:** Two best-effort "audit-notify" endpoints in one new route file. The web app keeps doing the real password change/reset client-side via Cognito, then fires a notify call afterward. `POST /v1/auth/password-changed` is authenticated (officine pool) and audits the actor from the JWT. `POST /v1/auth/password-reset-completed` is public (the user isn't logged in during forgot-password), takes `{ email }`, looks up active officina users by email and writes one row each, always returning a constant 204 (anti-enumeration).

**Tech Stack:** Fastify + TypeScript, Prisma (`auditLog`), `@fastify/rate-limit`, Zod v4, Vitest. Web: React + react-hook-form, `useApiFetch` (authenticated) / raw `fetch` (public).

**Reference spec:** `docs/superpowers/specs/2026-06-03-password-change-backend-audit-design.md`

**Process note (right-sizing):** additive, low-risk, 2 layers. Execute inline. Run `pnpm -r typecheck` always; run web jsdom tests locally (fast); do NOT run api integration tests locally (CI only — see CLAUDE.md §Testing). Use IP `10.20.46.x` for integration rate-limit isolation.

---

## File Structure

- **Create** `packages/api/src/routes/v1/auth-password-audit.ts` — both endpoints (`authPasswordAuditRoutes`).
- **Modify** `packages/api/src/server.ts` — register the new routes.
- **Create** `packages/api/tests/unit/routes/v1/auth-password-audit.test.ts` — unit tests (FakePrisma).
- **Create** `packages/api/tests/integration/auth-password-audit.test.ts` — integration tests (real Postgres, CI).
- **Modify** `packages/web/src/components/settings/PasswordForm.tsx` — fire change-notify on success.
- **Modify** `packages/web/src/components/settings/PasswordForm.test.tsx` — assert notify + best-effort.
- **Modify** `packages/web/src/queries/passwordReset.ts` — add `notifyPasswordResetCompleted(email)`.
- **Modify** `packages/web/src/pages/ResetPassword.tsx` — fire reset-notify on success.
- **Modify** `packages/web/src/pages/ResetPassword.test.tsx` — assert notify + best-effort.
- **Modify** `docs/APPENDICE_F_BUSINESS_LOGIC.md` (BR-280), `docs/APPENDICE_A_API.md`, `docs/APPENDICE_G_ERROR_CODES.md`.

---

## Task 1: API — `POST /v1/auth/password-changed` (authenticated)

**Files:**
- Create: `packages/api/src/routes/v1/auth-password-audit.ts`
- Modify: `packages/api/src/server.ts:29` (import) and `:184` (register, next to `authSignupRoutes`)
- Test: `packages/api/tests/unit/routes/v1/auth-password-audit.test.ts`

- [ ] **Step 1: Write the failing unit test (change endpoint)**

Create `packages/api/tests/unit/routes/v1/auth-password-audit.test.ts`:

```ts
// Unit tests for the password audit-notify endpoints.
// Pattern: inline FakePrisma + fake withContext + stub jwtVerifier,
// modeled on users-admin-reactivate.test.ts.

import sensible from '@fastify/sensible';
import rateLimitPlugin from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import { authPasswordAuditRoutes } from '../../../../src/routes/v1/auth-password-audit.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const ACTOR_DB_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  user: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(over: Partial<{ findManyRows: Array<{ id: string; tenantId: string }> }> = {}): FakePrisma {
  return {
    user: {
      // tenantContext live-lookup (status active + deletedAt null) AND the
      // handler actor lookup (cognitoSub + tenantId) both return {id}.
      findFirst: vi.fn(async () => ({ id: ACTOR_DB_ID })),
      findMany: vi.fn(async () => over.findManyRows ?? []),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: ACTOR_COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'super_admin',
      },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(rateLimitPlugin, { global: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(authPasswordAuditRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/auth/password-changed', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('204 + writes user_password_changed audit row for the actor', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      headers: { authorization: 'Bearer x' },
      remoteAddress: '10.20.46.1',
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      tenantId: TENANT_ID,
      actorType: 'user',
      actorId: ACTOR_DB_ID,
      action: 'user_password_changed',
      entityType: 'user',
      entityId: ACTOR_DB_ID,
    });
  });

  it('401 when no Authorization header', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/password-changed' });
    expect(res.statusCode).toBe(401);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- auth-password-audit`
Expected: FAIL — cannot find module `auth-password-audit.js` (route file not created yet).

- [ ] **Step 3: Create the route file with the change endpoint**

Create `packages/api/src/routes/v1/auth-password-audit.ts`:

```ts
// Password audit-notify endpoints (hardening, BR-280).
//
// The real password change/reset happens client-side via Cognito (the
// backend only ever sees the ID token, never the AccessToken that Cognito
// ChangePassword requires — see plugins/auth.ts customJwtCheck). These
// endpoints exist solely to record a forensic audit_logs row plus a thin
// per-IP rate-limit. See spec 2026-06-03-password-change-backend-audit-design.md.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// Shared rate-limit error builder — mirrors auth-signup.ts. Returns an Error
// whose dotted `name` flows through the global error handler to a
// Problem+JSON response with the matching `code`.
function rateLimitError(code: string, ttlMs: number): Error {
  const retryAfter = Math.ceil(ttlMs / 1000);
  const err = new Error(
    `Troppi tentativi. Riprova tra qualche minuto. Retry dopo ${retryAfter}s.`,
  ) as Error & { statusCode: number; retryAfter: number };
  err.name = code;
  err.statusCode = 429;
  err.retryAfter = retryAfter;
  return err;
}

const ResetBodySchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((s) => s.trim().toLowerCase()),
});

export const authPasswordAuditRoutes: FastifyPluginAsync = async (app) => {
  // ── Authenticated change-notify ──────────────────────────────────────────
  app.post(
    '/v1/auth/password-changed',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          errorResponseBuilder: (_req, ctx) =>
            rateLimitError('auth.password_change.rate_limited', ctx.ttl),
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const actorCognitoSub = request.userId!;
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Resolve the actor's DB UUID (request.userId is the opaque Cognito
        // sub). Same lookup pattern as users-admin-update.ts.
        const actor = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });
        if (!actor) {
          request.log.warn(
            { actorCognitoSub, tenantId },
            'password-changed: actor not found, skipping audit row',
          );
          return;
        }
        // BR-280: password change is a security event that must be audited.
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actor.id,
            action: 'user_password_changed',
            entityType: 'user',
            entityId: actor.id,
            metadata: {},
            ipAddress: request.ip,
          },
        });
      });
      return reply.code(204).send();
    },
  );
};
```

Add to `packages/api/src/server.ts` — import near line 29:

```ts
import { authPasswordAuditRoutes } from './routes/v1/auth-password-audit.js';
```

and register right after `authSignupRoutes` (line 184):

```ts
  await app.register(authPasswordAuditRoutes);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- auth-password-audit`
Expected: PASS (both change-endpoint cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
Expected: no errors.

```bash
git add packages/api/src/routes/v1/auth-password-audit.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/auth-password-audit.test.ts
git commit -m "feat(api): audit endpoint for authenticated password change"
```

---

## Task 2: API — `POST /v1/auth/password-reset-completed` (public)

**Files:**
- Modify: `packages/api/src/routes/v1/auth-password-audit.ts` (add second route)
- Test: `packages/api/tests/unit/routes/v1/auth-password-audit.test.ts` (add describe block)

- [ ] **Step 1: Write the failing unit tests (reset endpoint)**

Append to `packages/api/tests/unit/routes/v1/auth-password-audit.test.ts` (the `buildFakePrisma`/`buildApp` helpers already exist from Task 1):

```ts
describe('POST /v1/auth/password-reset-completed', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('204 + writes one user_password_reset row per matching active user', async () => {
    const prisma = buildFakePrisma({
      findManyRows: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', tenantId: TENANT_ID },
        { id: 'aaaaaaaa-0000-4000-8000-000000000002', tenantId: '99999999-9999-4999-8999-999999999999' },
      ],
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.2',
      payload: { email: 'Mario@Officina.IT' },
    });
    expect(res.statusCode).toBe(204);
    // email normalized to lowercase in the findMany where
    expect(prisma.user.findMany.mock.calls[0]![0].where.email).toBe('mario@officina.it');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const first = prisma.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(first).toMatchObject({ action: 'user_password_reset', actorType: 'user' });
  });

  it('204 + writes NO rows when no active user matches (anti-enumeration constant response)', async () => {
    const prisma = buildFakePrisma({ findManyRows: [] });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.3',
      payload: { email: 'ghost@nowhere.it' },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('422 on malformed email body', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.4',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
```

> Note: a Zod `safeParse` failure thrown as `parsed.error` is rendered by the
> shared error handler as a 400 `VALIDATION_ERROR` (see auth-signup unit test
> line 57). That is why the malformed-email case asserts 400, not 422.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/api test:unit -- auth-password-audit`
Expected: FAIL — route `/v1/auth/password-reset-completed` returns 404 (not registered yet).

- [ ] **Step 3: Add the reset endpoint to the route file**

In `packages/api/src/routes/v1/auth-password-audit.ts`, add inside `authPasswordAuditRoutes` (after the change route):

```ts
  // ── Public reset-completed-notify ────────────────────────────────────────
  // Unauthenticated: during forgot-password the user has no session. Always
  // returns a constant 204 (anti-enumeration). Writes audit rows only when an
  // active officine user matches the email. users.email is NOT unique, so we
  // iterate all matches and write one row per (user, tenant).
  app.post(
    '/v1/auth/password-reset-completed',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          errorResponseBuilder: (_req, ctx) =>
            rateLimitError('auth.password_reset.rate_limited', ctx.ttl),
        },
      },
    },
    async (request, reply) => {
      const parsed = ResetBodySchema.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const email = parsed.data.email;

      // role:'admin' bypasses the users RLS for this cross-tenant write with
      // no JWT — same rationale as auth-signup.ts.
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const users = await tx.user.findMany({
          where: { email, status: 'active', deletedAt: null },
          select: { id: true, tenantId: true },
        });
        for (const u of users) {
          // BR-280: password reset is a security event that must be audited.
          await tx.auditLog.create({
            data: {
              tenantId: u.tenantId,
              actorType: 'user',
              actorId: u.id,
              action: 'user_password_reset',
              entityType: 'user',
              entityId: u.id,
              metadata: {},
              ipAddress: request.ip,
            },
          });
        }
      });
      return reply.code(204).send();
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/api test:unit -- auth-password-audit`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
Expected: no errors.

```bash
git add packages/api/src/routes/v1/auth-password-audit.ts packages/api/tests/unit/routes/v1/auth-password-audit.test.ts
git commit -m "feat(api): public audit endpoint for password reset completion"
```

---

## Task 3: API integration tests (real Postgres — runs on CI)

**Files:**
- Create: `packages/api/tests/integration/auth-password-audit.test.ts`

> CLAUDE.md §Testing: do NOT run api integration locally (Docker freezes the machine). Write the file, typecheck, push; CI runs it. Use a dedicated IP block `10.20.46.x` for rate-limit isolation.

- [ ] **Step 1: Write the integration test file**

Create `packages/api/tests/integration/auth-password-audit.test.ts`:

```ts
// Integration tests for the password audit-notify endpoints.
// Helper pattern mirrors users-admin-update.test.ts:
//   buildTestServer / createTenantWithLocation / createUser / signTestToken /
//   pgAdmin / resetDb. Dedicated IP block 10.20.46.x for rate-limit isolation.

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

describe('POST /v1/auth/password-changed', () => {
  it('204 + writes user_password_changed for the authenticated actor', async () => {
    const { tenantId } = await createTenantWithLocation('pwa-changed');
    const sub = `sa-pwa-${crypto.randomUUID()}`;
    const { userId } = await createUser({ tenantId, cognitoSub: sub, role: 'super_admin' });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '10.20.46.10',
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_password_changed'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('401 without a token (no audit row)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-changed',
      remoteAddress: '10.20.46.11',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/password-reset-completed', () => {
  it('204 + writes user_password_reset for an existing active user', async () => {
    const { tenantId } = await createTenantWithLocation('pwa-reset');
    const { userId } = await createUser({
      tenantId,
      cognitoSub: `u-pwa-${crypto.randomUUID()}`,
      email: 'reset-me@officina.it',
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.12',
      payload: { email: 'reset-me@officina.it' },
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'user_password_reset'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('204 + NO row for an unknown email (anti-enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset-completed',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.20.46.13',
      payload: { email: 'ghost@nowhere.it' },
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pgAdmin.query(
      `SELECT 1 FROM audit_logs WHERE action = 'user_password_reset'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('429 once the per-IP rate-limit (5/15min) is exceeded', async () => {
    const ip = '10.20.46.14';
    const fire = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset-completed',
        headers: { 'content-type': 'application/json' },
        remoteAddress: ip,
        payload: { email: 'ghost@nowhere.it' },
      });
    for (let i = 0; i < 5; i++) {
      const ok = await fire();
      expect(ok.statusCode).toBe(204);
    }
    const limited = await fire();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('auth.password_reset.rate_limited');
  });
});
```

> If `createUser` does not accept an `email` override, check its signature in
> `packages/api/tests/integration/helpers.ts` and pass the email the way the
> sibling tests do (users-admin-update.test.ts:66-72 passes `email`).

- [ ] **Step 2: Typecheck**

Run: `pnpm -r typecheck`
Expected: no errors. (Do not run the integration suite locally.)

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/auth-password-audit.test.ts
git commit -m "test(api): integration tests for password audit endpoints"
```

---

## Task 4: Web — fire change-notify on success

**Files:**
- Modify: `packages/web/src/components/settings/PasswordForm.tsx`
- Test: `packages/web/src/components/settings/PasswordForm.test.tsx`

- [ ] **Step 1: Write/extend the failing test**

Add to the top of `packages/web/src/components/settings/PasswordForm.test.tsx` a mock for `useApiFetch`, and two new cases. Insert the mock alongside the existing `sonner` mock:

```ts
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));
```

In `beforeEach`, reset it: `apiFetchMock.mockReset(); apiFetchMock.mockResolvedValue(undefined);`

Add these cases inside `describe('PasswordForm', ...)`:

```ts
  it('success: fires POST /v1/auth/password-changed notify', async () => {
    mutate.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/v1/auth/password-changed', { method: 'POST' });
    });
  });

  it('success: still shows toast even if the notify call rejects (best-effort)', async () => {
    mutate.mockResolvedValue({ ok: true });
    apiFetchMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Password aggiornata.');
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @garageos/web test -- PasswordForm`
Expected: FAIL — `apiFetchMock` never called (notify not wired yet).

- [ ] **Step 3: Wire the notify in `PasswordForm.tsx`**

Add the import:

```ts
import { useApiFetch } from '@/lib/api-client';
```

Inside the component, get the fetcher:

```ts
  const apiFetch = useApiFetch();
```

In `onSubmit`, in the `if (result.ok)` branch, fire the notify before the toast (fire-and-forget; a failure must never affect the UX — token is fresh so a 401-triggered signOut is not a real concern here):

```ts
    if (result.ok) {
      // Best-effort backend audit (BR-280). Never blocks the success UX.
      void apiFetch('/v1/auth/password-changed', { method: 'POST' }).catch(() => {});
      toast.success('Password aggiornata.');
      form.reset();
      return;
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @garageos/web test -- PasswordForm`
Expected: PASS (all existing + 2 new cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`

```bash
git add packages/web/src/components/settings/PasswordForm.tsx packages/web/src/components/settings/PasswordForm.test.tsx
git commit -m "feat(web): notify backend audit on password change"
```

---

## Task 5: Web — fire reset-notify on success

**Files:**
- Modify: `packages/web/src/queries/passwordReset.ts`
- Modify: `packages/web/src/pages/ResetPassword.tsx`
- Test: `packages/web/src/pages/ResetPassword.test.tsx`

- [ ] **Step 1: Write the failing test**

In `packages/web/src/pages/ResetPassword.test.tsx`, spy on the new module function and assert it fires on success and that navigation still happens if it rejects. Mirror however the file already mocks `@/queries/passwordReset` (it mocks `useConfirmPasswordReset`). Add `notifyPasswordResetCompleted` to that mock as a `vi.fn()`, and add:

```ts
  it('success: fires notifyPasswordResetCompleted with the email', async () => {
    // confirm.mutate resolves { ok: true }; render at /reset-password?email=op@officina.it
    // (follow the existing render/setup helper in this file)
    // ...trigger submit with valid code + matching passwords...
    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith('op@officina.it');
    });
  });

  it('success: still navigates to /login even if the notify rejects', async () => {
    notifyMock.mockRejectedValue(new Error('boom'));
    // ...trigger submit...
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/login', expect.objectContaining({ replace: true }));
    });
  });
```

> Use the existing mocks/harness already present in `ResetPassword.test.tsx`
> (it already mocks the router `useNavigate` and the `passwordReset` queries).
> Add `notifyPasswordResetCompleted: notifyMock` to the existing
> `vi.mock('@/queries/passwordReset', ...)` factory, where
> `const notifyMock = vi.fn().mockResolvedValue(undefined)`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @garageos/web test -- ResetPassword`
Expected: FAIL — `notifyPasswordResetCompleted` is not exported / not called.

- [ ] **Step 3: Add the helper to `passwordReset.ts`**

Append to `packages/web/src/queries/passwordReset.ts`:

```ts
// Best-effort backend audit notify after a successful reset (BR-280). The
// user is NOT authenticated here, so this uses a raw fetch (apiFetch always
// requires a token). Failures are swallowed — auditing must never break the
// reset UX. Returns void.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export async function notifyPasswordResetCompleted(email: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/v1/auth/password-reset-completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch {
    // best-effort
  }
}
```

- [ ] **Step 4: Call it in `ResetPassword.tsx`**

Update the import:

```ts
import {
  notifyPasswordResetCompleted,
  useConfirmPasswordReset,
  useRequestPasswordReset,
  type ConfirmResetCode,
} from '@/queries/passwordReset';
```

In `onSubmit`, inside `if (result.ok)`, fire before navigate (fire-and-forget; the helper swallows internally):

```ts
    if (result.ok) {
      void notifyPasswordResetCompleted(email);
      navigate('/login', {
        replace: true,
        state: { flash: 'Password aggiornata. Accedi con la nuova password.' },
      });
      return;
    }
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @garageos/web test -- ResetPassword`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -r typecheck`

```bash
git add packages/web/src/queries/passwordReset.ts packages/web/src/pages/ResetPassword.tsx packages/web/src/pages/ResetPassword.test.tsx
git commit -m "feat(web): notify backend audit on password reset completion"
```

---

## Task 6: Documentation (BR-280, APPENDICE_A, APPENDICE_G)

**Files:**
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md` (BR-280 list)
- Modify: `docs/APPENDICE_A_API.md` (auth section)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (two new codes)

- [ ] **Step 1: Extend BR-280**

In `docs/APPENDICE_F_BUSINESS_LOGIC.md`, in the BR-280 bullet list ("Eventi sempre loggati in `audit_logs`"), add after the "Login/logout utente" line:

```markdown
- Cambio password / completamento reset password
```

- [ ] **Step 2: Document the endpoints in APPENDICE_A**

In `docs/APPENDICE_A_API.md`, in the `auth` section (near `POST /v1/auth/signup`), add:

```markdown
### POST /v1/auth/password-changed

Audit-notify per il cambio password (autenticato, officine pool). Il cambio
vero avviene client-side via Cognito; questo endpoint registra solo la riga
`audit_logs` (`user_password_changed`) per l'utente autenticato.

- **Auth:** Bearer ID token (officine).
- **Body:** nessuno.
- **200/204:** `204 No Content`.
- **429:** `auth.password_change.rate_limited` (5 richieste / 15 min per IP).

### POST /v1/auth/password-reset-completed

Audit-notify per il completamento del reset password (pubblico — l'utente non
è autenticato durante forgot-password). Registra una riga `audit_logs`
(`user_password_reset`) per ogni utente officine attivo che corrisponde
all'email.

- **Auth:** nessuna.
- **Body:** `{ "email": string }`.
- **Risposta:** sempre `204 No Content` (anti-enumeration; scrive righe solo se
  l'email corrisponde a un utente).
- **429:** `auth.password_reset.rate_limited` (5 richieste / 15 min per IP).
```

- [ ] **Step 3: Add the error codes in APPENDICE_G**

In `docs/APPENDICE_G_ERROR_CODES.md`, add to the relevant table/section:

```markdown
| `auth.password_change.rate_limited` | 429 | Troppi tentativi di cambio password da questo IP (5/15min). |
| `auth.password_reset.rate_limited`  | 429 | Troppi tentativi di reset password da questo IP (5/15min). |
```

> Match the exact column layout used by the surrounding rows in that file.

- [ ] **Step 4: Commit**

```bash
git add docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
git commit -m "docs: password change/reset audit endpoints + error codes"
```

---

## Final: push + PR

- [ ] **Step 1: Update graphify graph**

Run: `graphify update .`

- [ ] **Step 2: Push (pre-push hook runs `pnpm -r typecheck`)**

```bash
git push -u origin feat/password-change-backend-audit
```

- [ ] **Step 3: Open PR** with the CLAUDE.md template (What/Why/Implementation/Tests/Checklist), citing the spec and BR-280. Watch CI: `gh pr checks --watch`.

- [ ] **Step 4: Final Opus review** of the diff before merge (single review — right-sized slice).

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- §3.1 change endpoint → Task 1. §3.2 reset endpoint → Task 2. §4.1 web change notify → Task 4. §4.2 web reset notify → Task 5. §7 docs (BR-280, APPENDICE_A/G) → Task 6. §9 testing → unit in Tasks 1-2, integration in Task 3, web in Tasks 4-5. ✅ all covered.

**Placeholder scan:** No TBD/TODO/"handle errors" — every code step shows full code. The two cross-referenced web test harnesses (Tasks 4-5) point at the exact existing mock structure to extend, with the code to add. ✅

**Type consistency:** `authPasswordAuditRoutes` (file + server.ts + both test files), `notifyPasswordResetCompleted(email: string): Promise<void>` (passwordReset.ts + ResetPassword.tsx + test), action strings `user_password_changed` / `user_password_reset`, error codes `auth.password_change.rate_limited` / `auth.password_reset.rate_limited` — consistent across all tasks. ✅

**Known assumption to verify during execution:** `createUser` integration helper accepts an `email` override (Task 3 note) — confirmed used at users-admin-update.test.ts:66-72.

# F-CLI-005 PR1 — Notification preferences API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET` + `PATCH /v1/me/notification-preferences` so a customer can read and update their own email notification preferences.

**Architecture:** New route file mirroring `me-profile.ts` (GET under RLS `role:'user'`, PATCH under `role:'admin'`). A new pure projection function in `lib/notification-preferences.ts` merges stored prefs with BR-226 defaults for the 4 editable `email.*` keys. PATCH deep-merges supplied keys into the stored JSON (non-destructive), preserving non-editable keys (`transfer_invitation`, `dispute_response`, `push.*`).

**Tech Stack:** Fastify, Zod, Prisma, Vitest. No migration, no new dependency.

**Spec:** `docs/superpowers/specs/2026-06-08-f-cli-005-pr1-notification-preferences-api-design.md`

---

## File structure

- Modify: `packages/api/src/lib/notification-preferences.ts` — add `EditableEmailKey`, `EDITABLE_EMAIL_KEYS`, `projectNotificationPreferences()`.
- Create: `packages/api/src/routes/v1/me-notification-preferences.ts` — GET + PATCH handlers.
- Modify: `packages/api/src/server.ts` — import + register the new route plugin.
- Create: `packages/api/tests/unit/lib/notification-preferences.test.ts` — projection unit tests.
- Create: `packages/api/tests/unit/routes/v1/me-notification-preferences.test.ts` — route unit tests (FakePrisma).
- Create: `packages/api/tests/integration/me-notification-preferences.test.ts` — end-to-end RLS + merge tests.
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` — two new error codes (table + flat list).

---

## Task 1: Projection helper (`projectNotificationPreferences`)

**Files:**
- Modify: `packages/api/src/lib/notification-preferences.ts`
- Test: `packages/api/tests/unit/lib/notification-preferences.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/notification-preferences.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { projectNotificationPreferences } from '../../../src/lib/notification-preferences.js';

describe('projectNotificationPreferences', () => {
  it('returns all 4 defaults for an empty object', () => {
    expect(projectNotificationPreferences({})).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
  });

  it('returns defaults for null / non-object / malformed json', () => {
    const expected = {
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    };
    expect(projectNotificationPreferences(null)).toEqual(expected);
    expect(projectNotificationPreferences('nope')).toEqual(expected);
    expect(projectNotificationPreferences([1, 2])).toEqual(expected);
    expect(projectNotificationPreferences({ email: 'bad' })).toEqual(expected);
  });

  it('reflects a partial override and fills the rest from defaults', () => {
    expect(
      projectNotificationPreferences({
        email: { intervention_updates: false, marketing: true },
      }),
    ).toEqual({
      email: {
        intervention_updates: false,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: true,
      },
    });
  });

  it('ignores non-boolean values and non-editable keys', () => {
    expect(
      projectNotificationPreferences({
        email: {
          deadline_reminder: 'yes',
          transfer_invitation: false,
          dispute_response: false,
        },
        push: { intervention_updates: false },
      }),
    ).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit notification-preferences`
Expected: FAIL — `projectNotificationPreferences is not a function` / no export.

- [ ] **Step 3: Implement the projection**

Append to `packages/api/src/lib/notification-preferences.ts`:

```ts
import type { Prisma } from '@garageos/database';

// The subset of email channels a customer may edit via F-CLI-005.
// Excludes transfer_invitation (BR-260: always sent, not disablable),
// dispute_response (no consumer yet), and push.* (no delivery yet —
// F-CLI-302). These remain in storage but outside the editable surface.
export const EDITABLE_EMAIL_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
  'marketing',
] as const;

export type EditableEmailKey = (typeof EDITABLE_EMAIL_KEYS)[number];

export interface ProjectedNotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
}

// Effective preferences for the editable keys: stored value when it is a
// boolean, otherwise the BR-226 default. Mirrors the defensive fallback in
// lib/notifications/preferences.ts (missing/malformed/partial -> default).
export function projectNotificationPreferences(
  stored: Prisma.JsonValue,
): ProjectedNotificationPreferences {
  const email =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).email
      : undefined;
  const emailObj =
    email && typeof email === 'object' && !Array.isArray(email)
      ? (email as Record<string, unknown>)
      : {};

  const out = {} as Record<EditableEmailKey, boolean>;
  for (const key of EDITABLE_EMAIL_KEYS) {
    const value = emailObj[key];
    out[key] = typeof value === 'boolean' ? value : DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }
  return { email: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit notification-preferences`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/notification-preferences.ts packages/api/tests/unit/lib/notification-preferences.test.ts
git commit -F - <<'EOF'
feat(api): add projectNotificationPreferences helper (F-CLI-005)

Effective-value projection for the 4 editable email keys, defensive
fallback to BR-226 defaults. Excludes BR-260 locked + not-yet keys.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Route handlers + server registration

**Files:**
- Create: `packages/api/src/routes/v1/me-notification-preferences.ts`
- Modify: `packages/api/src/server.ts` (import near line 41, register near line 207)

- [ ] **Step 1: Write the route file**

Create `packages/api/src/routes/v1/me-notification-preferences.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  EDITABLE_EMAIL_KEYS,
  projectNotificationPreferences,
  type EditableEmailKey,
} from '../../lib/notification-preferences.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET + PATCH /v1/me/notification-preferences — F-CLI-005 (customer
// notification preferences). Mirrors me-profile.ts: GET under role:'user'
// (customers_read RLS is USING(true), app-layer where:{id} scopes to self);
// PATCH under role:'admin' (customers UPDATE policy has no self clause).
//
// Editable surface = 4 email keys (see EDITABLE_EMAIL_KEYS). PATCH deep-merges
// onto the stored JSON, preserving non-editable keys.
// See BR-226 (default shape) + BR-260 (transfer_invitation always-sent, not editable).

const editableEmailSchema = z
  .object(
    Object.fromEntries(EDITABLE_EMAIL_KEYS.map((k) => [k, z.boolean()])) as Record<
      EditableEmailKey,
      z.ZodBoolean
    >,
  )
  .partial()
  .strict();

const patchBodySchema = z.object({ email: editableEmailSchema }).partial().strict();

const meNotificationPreferencesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/notification-preferences',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: { notificationPreferences: true },
        });
        return projectNotificationPreferences(row.notificationPreferences);
      });
    },
  );

  app.patch(
    '/v1/me/notification-preferences',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'me.notification-preferences.update.unknown_field',
            422,
            'Campo non modificabile.',
          );
        }
        throw parsed.error;
      }

      const email = parsed.data.email ?? {};
      if (Object.keys(email).length === 0) {
        throw businessError(
          'me.notification-preferences.update.empty_body',
          422,
          'Specifica almeno una preferenza da aggiornare.',
        );
      }

      const customerId = request.customerId!;
      // role:'admin' — see header comment (customers UPDATE RLS has no self clause).
      return app.withContext({ role: 'admin' }, async (tx) => {
        const current = await tx.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: { notificationPreferences: true },
        });
        const stored =
          current.notificationPreferences &&
          typeof current.notificationPreferences === 'object' &&
          !Array.isArray(current.notificationPreferences)
            ? (current.notificationPreferences as Record<string, unknown>)
            : {};
        const storedEmail =
          stored.email && typeof stored.email === 'object' && !Array.isArray(stored.email)
            ? (stored.email as Record<string, unknown>)
            : {};

        const mergedEmail = { ...storedEmail, ...email };
        const merged = { ...stored, email: mergedEmail };

        const row = await tx.customer.update({
          where: { id: customerId },
          data: { notificationPreferences: merged },
          select: { notificationPreferences: true },
        });
        return projectNotificationPreferences(row.notificationPreferences);
      });
    },
  );
};

export default meNotificationPreferencesRoutes;
```

- [ ] **Step 2: Register in server.ts**

In `packages/api/src/server.ts`, add the import next to the other `me-*` imports (~line 41):

```ts
import meNotificationPreferencesRoutes from './routes/v1/me-notification-preferences.js';
```

And register it next to `meProfileRoutes` (~line 207):

```ts
  await app.register(meNotificationPreferencesRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/me-notification-preferences.ts packages/api/src/server.ts
git commit -F - <<'EOF'
feat(api): GET/PATCH /me/notification-preferences (F-CLI-005)

Customer self-service read/update of editable email preferences.
PATCH deep-merges, preserving non-editable keys. Mirrors me-profile
RLS pattern (GET role:user, PATCH role:admin).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Route unit tests (FakePrisma)

**Files:**
- Create: `packages/api/tests/unit/routes/v1/me-notification-preferences.test.ts`

Required because this is a route-handler change — typecheck does not catch broken FakePrisma mocks (see memory: handler-change-breaks-unit-mock).

- [ ] **Step 1: Write the unit test**

Create `packages/api/tests/unit/routes/v1/me-notification-preferences.test.ts`:

```ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meNotificationPreferencesRoutes from '../../../../src/routes/v1/me-notification-preferences.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';

interface FakePrisma {
  customer: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma['customer']> = {}): FakePrisma {
  return {
    customer: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ notificationPreferences: {} }),
      update: vi.fn().mockResolvedValue({ notificationPreferences: {} }),
      ...overrides,
    },
  };
}

interface AppDeps {
  verifier?: JwtVerifier;
  prisma?: FakePrisma;
  withContext?: ReturnType<typeof vi.fn>;
}

async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? buildFakePrisma();
  const withContext = deps.withContext ?? vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = deps.verifier ?? {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(meNotificationPreferencesRoutes);
  return app;
}

describe('GET /v1/me/notification-preferences', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('projects effective defaults from an empty stored object under role: user', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ notificationPreferences: {} });
    const withContext = vi.fn(async (_ctx, fn) => fn(buildFakePrisma({ findUniqueOrThrow })));
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
      },
    });
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, role: 'user' }),
      expect.any(Function),
    );
    expect(findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID } }),
    );
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/notification-preferences' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /v1/me/notification-preferences', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('deep-merges supplied keys under role: admin, preserving non-editable keys', async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      notificationPreferences: {
        email: { intervention_updates: true, transfer_invitation: true },
        push: { deadline_reminder: true },
      },
    });
    const update = vi.fn().mockResolvedValue({
      notificationPreferences: {
        email: { intervention_updates: true, transfer_invitation: true, marketing: true },
        push: { deadline_reminder: true },
      },
    });
    const withContext = vi.fn(async (_ctx, fn) =>
      fn(buildFakePrisma({ findUniqueOrThrow, update })),
    );
    app = await buildApp({ withContext });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { marketing: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(withContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.any(Function),
    );
    const updateArg = update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: CUSTOMER_ID });
    expect(updateArg.data.notificationPreferences).toEqual({
      email: { intervention_updates: true, transfer_invitation: true, marketing: true },
      push: { deadline_reminder: true },
    });
  });

  it('rejects an empty body with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects {email:{}} with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: {} },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-editable key (transfer_invitation) with 422', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { transfer_invitation: true } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-boolean value with 400 (ZodError, not a business error)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { email: { marketing: 'yes' } },
    });
    // invalid_type is NOT unrecognized_keys, so it falls through to
    // `throw parsed.error` -> error-handler maps ZodError to 400.
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the unit tests**

Run: `pnpm --filter @garageos/api test:unit me-notification-preferences`
Expected: PASS (7 tests across GET + PATCH).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/unit/routes/v1/me-notification-preferences.test.ts
git commit -F - <<'EOF'
test(api): unit tests for /me/notification-preferences (F-CLI-005)

GET projection + PATCH deep-merge under role:admin + 422 paths
(empty body, locked key, non-boolean).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Integration tests (RLS + merge end-to-end)

**Files:**
- Create: `packages/api/tests/integration/me-notification-preferences.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/api/tests/integration/me-notification-preferences.test.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createCustomer, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-005 PR1 — GET/PATCH /v1/me/notification-preferences.
const TEST_IP = '10.20.40.9';
const DEFAULTS = {
  intervention_updates: true,
  deadline_reminder: true,
  ownership_transfer: true,
  marketing: false,
};

describe('Customer notification preferences (F-CLI-005)', () => {
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

  async function authCustomer(notificationPreferences?: object) {
    const customerSub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({
      cognitoSub: customerSub,
      firstName: 'Mario',
      lastName: 'Rossi',
      ...(notificationPreferences ? { notificationPreferences } : {}),
    });
    const token = await signTestToken({ pool: 'clienti', sub: customerSub, customerId });
    return { customerId, token };
  }

  function get(token: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/me/notification-preferences',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
  }
  function patch(token: string, payload: unknown) {
    return app.inject({
      method: 'PATCH',
      url: '/v1/me/notification-preferences',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
      payload,
    });
  }

  it('GET returns the 4 effective defaults for an empty stored object', async () => {
    const { token } = await authCustomer({});
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { email: unknown }).email).toEqual(DEFAULTS);
  });

  it('GET reflects a partial stored override', async () => {
    const { token } = await authCustomer({ email: { intervention_updates: false } });
    const res = await get(token);
    expect((res.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      intervention_updates: false,
    });
  });

  it('PATCH updates two keys and GET reflects both', async () => {
    const { token } = await authCustomer({});
    const patchRes = await patch(token, { email: { deadline_reminder: false, marketing: true } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      deadline_reminder: false,
      marketing: true,
    });
  });

  it('PATCH merges onto existing stored prefs (does not clobber)', async () => {
    // Seed with intervention_updates already off; PATCH only marketing.
    // If PATCH replaced instead of merged, intervention_updates would revert
    // to the default (true). Asserting it stays false proves the merge.
    const { token } = await authCustomer({
      email: { intervention_updates: false, transfer_invitation: true },
    });
    const patchRes = await patch(token, { email: { marketing: true } });
    expect(patchRes.statusCode).toBe(200);
    const getRes = await get(token);
    expect((getRes.json() as { email: unknown }).email).toEqual({
      ...DEFAULTS,
      intervention_updates: false,
      marketing: true,
    });
  });

  it('PATCH with empty body returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, {})).statusCode).toBe(422);
  });

  it('PATCH with {email:{}} returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: {} })).statusCode).toBe(422);
  });

  it('PATCH with a non-editable key (transfer_invitation) returns 422 (BR-260)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: { transfer_invitation: true } })).statusCode).toBe(422);
  });

  it('PATCH with a push.* key returns 422', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { push: { intervention_updates: false } })).statusCode).toBe(422);
  });

  it('PATCH with a non-boolean value returns 400 (ZodError)', async () => {
    const { token } = await authCustomer({});
    expect((await patch(token, { email: { marketing: 'yes' } })).statusCode).toBe(400);
  });
});
```

> Note: the non-destructive merge is exercised through the public API (PATCH then
> GET). A raw DB assertion on `transfer_invitation` is intentionally avoided to keep
> the test coupled to behavior, not storage internals. The unit test in Task 3 already
> asserts the exact merged object passed to `customer.update`.

- [ ] **Step 2: (CI runs this)** Do NOT run `test:integration` locally — it spins up Docker/Testcontainers and can freeze the machine (see CLAUDE.md). Validation happens on CI.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/me-notification-preferences.test.ts
git commit -F - <<'EOF'
test(api): integration tests for /me/notification-preferences (F-CLI-005)

GET effective projection (empty + partial), PATCH merge end-to-end,
non-destructive merge, and 422 paths incl. BR-260 locked key + push.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Error codes documentation (APPENDICE_G)

**Files:**
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (table ~§204-205, flat list ~§1005)

- [ ] **Step 1: Add the two table rows**

In the error-code table, immediately after the `me.profile.update.unknown_field`
row (~line 205), insert (keeping `empty_body` before `unknown_field`):

```markdown
| `me.notification-preferences.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/me/notification-preferences con body vuoto o senza preferenze edibili | F-CLI-005 |
| `me.notification-preferences.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/me/notification-preferences con chiave fuori schema (transfer_invitation, push, dispute_response) o valore non booleano | F-CLI-005, BR-260 |
```

- [ ] **Step 2: Add to the flat list**

In the flat code list, after `me.profile.update.unknown_field` (find with
`grep -n "me.profile.update.unknown_field" docs/APPENDICE_G_ERROR_CODES.md`),
insert alphabetically — `me.notification-preferences.*` sorts BEFORE `me.profile.*`,
so place the two new codes immediately before the `me.profile.update.empty_body`
entry instead:

```text
me.notification-preferences.update.empty_body
me.notification-preferences.update.unknown_field
```

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_G_ERROR_CODES.md
git commit -F - <<'EOF'
docs: add F-CLI-005 notification-preferences error codes

me.notification-preferences.update.empty_body + .unknown_field (422).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Final verification + push + PR

- [ ] **Step 1: Workspace typecheck (push gate)**

Run: `pnpm -r typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Targeted unit run (route handler changed)**

Run: `pnpm --filter @garageos/api test:unit me-notification-preferences notification-preferences`
Expected: PASS (projection + route unit tests).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/me-notification-preferences-api
```

- [ ] **Step 4: Open the PR** (title `feat(api): notification preferences endpoints (F-CLI-005)`), filling the CLAUDE.md PR template: What / Why (F-CLI-005, BR-226, BR-260) / Implementation notes (editable-key decision, deep-merge, RLS role split) / Tests checklist / no migration-deploy-dep.

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on failure.

---

## Out of scope (this PR)

- Mobile UI (PR2).
- `push.*` toggles (F-CLI-302), `dispute_response` toggle (with its consumer).
- Migration / deploy (none needed).

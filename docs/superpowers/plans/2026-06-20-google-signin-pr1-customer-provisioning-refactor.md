# Google Sign-In — PR 1: Extract shared customer-provisioning helper

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the Phase-1 find-or-create-or-promote logic from `POST /v1/auth/signup` into a shared, idempotent `provisionCustomer()` helper that returns an *outcome* instead of throwing — so the future Cognito Google-federation trigger (PR 2) can reuse the exact same advisory-locked, BR-tested code path.

**Architecture:** New pure-ish module `packages/api/src/lib/customer-provisioning.ts` owns the advisory lock + find/promote/create + audit-log write, returning `{ customer, outcome }` where `outcome ∈ {created, promoted, already_active}`. The signup route keeps its endpoint-specific concerns (409 mapping, verify-email token, Cognito user creation, SES send) and delegates the DB row provisioning to the helper. **Behaviour of the signup endpoint is unchanged** — this is a behaviour-preserving refactor that adds a new direct test surface.

**Tech Stack:** Fastify + Prisma 7 (`@prisma/adapter-pg`) + Postgres advisory locks; Vitest integration tests against Testcontainers.

## Global Constraints

- **Git workflow:** branch `feat/google-signin-provisioning-refactor` off updated `main`; never commit to `main`; squash-merge the PR. Conventional Commits, scope `api`.
- **Local gate is typecheck only:** `pnpm -r typecheck` (husky pre-push). Integration tests run on **CI**, not locally (Testcontainers freezes Windows). A targeted `pnpm --filter @garageos/api test:unit` is allowed for the route change.
- **No new dependencies.**
- **TypeScript strict; no `any`.** Comments in English; user-facing strings stay Italian and unchanged.
- **RLS is non-negotiable:** the helper runs inside the caller's `app.withContext({ role: 'admin' }, ...)` tx; do not add `withContext({})` or weaken policies.
- **BRs touched:** BR-220 (race serialisation), BR-221 (promote shadow), BR-224 (active predicate), BR-226 (default notification preferences). Cite them in code comments.

---

### Task 1: Create `provisionCustomer()` helper + direct integration tests

**Files:**
- Create: `packages/api/src/lib/customer-provisioning.ts`
- Test: `packages/api/tests/integration/customer-provisioning.test.ts`

**Interfaces:**
- Consumes: `customerSelfSelect`, `CustomerSelfRow` from `packages/api/src/lib/customer-shared.ts`; `DEFAULT_NOTIFICATION_PREFERENCES` from `packages/api/src/lib/notification-preferences.ts`; `Prisma`, `PrismaClient`, `withContext` from `@garageos/database`.
- Produces (relied on by Task 2 and PR 2):
  - `type ProvisionOutcome = 'created' | 'promoted' | 'already_active'`
  - `interface ProvisionCustomerInput { email: string; firstName: string; lastName: string; phone?: string }`
  - `interface ProvisionCustomerOptions { ip?: string; auditMetadata?: Record<string, unknown> }`
  - `interface ProvisionCustomerResult { customer: CustomerSelfRow; outcome: ProvisionOutcome }`
  - `function provisionCustomer(tx: PrismaClient, input: ProvisionCustomerInput, opts?: ProvisionCustomerOptions): Promise<ProvisionCustomerResult>`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/api/tests/integration/customer-provisioning.test.ts`:

```ts
// packages/api/tests/integration/customer-provisioning.test.ts
//
// Direct integration tests for provisionCustomer() — the shared find-or-
// create-or-promote helper extracted from POST /v1/auth/signup so the Cognito
// Google-federation trigger (PR 2) can reuse it. Run against Testcontainers.
//
// BR-220 (create), BR-221 (promote shadow), BR-224 (active predicate),
// BR-226 (default notification preferences). The 'already_active' outcome is
// the new behaviour the trigger depends on (account merge) — the signup route
// still maps it to 409.

import { withContext } from '@garageos/database';
import { beforeEach, describe, expect, it } from 'vitest';

import { provisionCustomer } from '../../src/lib/customer-provisioning.js';
import { resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('provisionCustomer — created', () => {
  it('creates a Customer + audit log for a brand-new email (BR-220, BR-226)', async () => {
    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'new@example.it', firstName: 'Mario', lastName: 'Rossi', phone: '+393331234567' },
        { ip: '10.0.0.1' },
      ),
    );

    expect(result.outcome).toBe('created');
    expect(result.customer.email).toBe('new@example.it');
    expect(result.customer.status).toBe('active');

    const { rows } = await pgAdmin.query<{
      app_installed: boolean;
      notification_preferences: { email: { marketing: boolean } };
    }>(`SELECT app_installed, notification_preferences FROM customers WHERE email = $1`, [
      'new@example.it',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app_installed).toBe(true);
    expect(rows[0]!.notification_preferences.email.marketing).toBe(false);

    const { rows: audit } = await pgAdmin.query<{ metadata: { promoted: boolean } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'customer_signup' AND entity_id = $1`,
      [result.customer.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata.promoted).toBe(false);
  });
});

describe('provisionCustomer — promoted', () => {
  it('promotes a shadow row in place, no duplicate (BR-221, BR-226)', async () => {
    const { rows: seed } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, $1, 'Old', 'Name', NULL,
         'active'::"CustomerStatus", false, '{}', NOW(), NOW())
       RETURNING id`,
      ['shadow@example.it'],
    );
    const shadowId = seed[0]!.id;

    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'shadow@example.it', firstName: 'Mario', lastName: 'Rossi' },
        { ip: '10.0.0.2' },
      ),
    );

    expect(result.outcome).toBe('promoted');
    expect(result.customer.id).toBe(shadowId);

    const { rows } = await pgAdmin.query<{
      id: string;
      last_name: string;
      app_installed: boolean;
      notification_preferences: { email: { marketing: boolean } };
    }>(
      `SELECT id, last_name, app_installed, notification_preferences
         FROM customers WHERE email = $1`,
      ['shadow@example.it'],
    );
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0]!.id).toBe(shadowId);
    expect(rows[0]!.last_name).toBe('Rossi'); // overwritten by promote
    expect(rows[0]!.app_installed).toBe(true);
    expect(rows[0]!.notification_preferences.email.marketing).toBe(false);
  });
});

describe('provisionCustomer — already_active', () => {
  it('returns already_active without writing or auditing when the row is active', async () => {
    const { rows: seed } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, cognito_sub, email, first_name, last_name, phone, status,
          app_installed, notification_preferences, created_at, updated_at)
       VALUES (gen_random_uuid(), 'cog-existing', $1, 'Keep', 'Me', NULL,
         'active'::"CustomerStatus", true, '{}', NOW(), NOW())
       RETURNING id`,
      ['active@example.it'],
    );
    const existingId = seed[0]!.id;

    const result = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(
        tx,
        { email: 'active@example.it', firstName: 'Changed', lastName: 'Name' },
        { ip: '10.0.0.3' },
      ),
    );

    expect(result.outcome).toBe('already_active');
    expect(result.customer.id).toBe(existingId);

    // No mutation of the existing row.
    const { rows } = await pgAdmin.query<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM customers WHERE id = $1`,
      [existingId],
    );
    expect(rows[0]!.first_name).toBe('Keep');
    expect(rows[0]!.last_name).toBe('Me');

    // No audit row written for the merge case.
    const { rows: audit } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE entity_id = $1`,
      [existingId],
    );
    expect(Number(audit[0]!.count)).toBe(0);
  });

  it('is idempotent: a second call on a now-active row adds no duplicate row or audit', async () => {
    const input = { email: 'idem@example.it', firstName: 'Mario', lastName: 'Rossi' };

    const first = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(tx, input, { ip: '10.0.0.4' }),
    );
    expect(first.outcome).toBe('created');

    // Mark active the way signup/the trigger would (cognito_sub set).
    await pgAdmin.query(`UPDATE customers SET cognito_sub = 'cog-idem' WHERE email = $1`, [
      'idem@example.it',
    ]);

    const second = await withContext({ role: 'admin' }, (tx) =>
      provisionCustomer(tx, input, { ip: '10.0.0.4' }),
    );
    expect(second.outcome).toBe('already_active');

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers WHERE email = $1`,
      ['idem@example.it'],
    );
    expect(Number(rows[0]!.count)).toBe(1);

    const { rows: audit } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs
         WHERE action = 'customer_signup' AND entity_id = $1`,
      [first.customer.id],
    );
    expect(Number(audit[0]!.count)).toBe(1); // only the create wrote audit
  });
});
```

- [ ] **Step 2: Confirm the test fails to compile/run (no implementation yet)**

The import `provisionCustomer` from `../../src/lib/customer-provisioning.js` does not resolve yet. Verify with typecheck (integration tests themselves run on CI):

Run: `pnpm --filter @garageos/api typecheck`
Expected: FAIL — `Cannot find module '../../src/lib/customer-provisioning.js'` (or "has no exported member 'provisionCustomer'").

- [ ] **Step 3: Implement `provisionCustomer()`**

Create `packages/api/src/lib/customer-provisioning.ts`:

```ts
import { Prisma, type PrismaClient } from '@garageos/database';

import { customerSelfSelect, type CustomerSelfRow } from './customer-shared.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notification-preferences.js';

// Outcome of an idempotent customer-provisioning attempt.
//   'created'        — no row existed; a fresh Customer was inserted (BR-220).
//   'promoted'       — a shadow row (cognito_sub IS NULL AND app_installed=false)
//                      was claimed (BR-221).
//   'already_active' — a row already exists AND is active (cognito_sub set OR
//                      app_installed=true). No write is performed; the caller
//                      decides what it means: the password signup endpoint
//                      rejects with 409, the Cognito Google-federation trigger
//                      (PR 2) treats it as the account-merge case.
export type ProvisionOutcome = 'created' | 'promoted' | 'already_active';

export interface ProvisionCustomerInput {
  // Caller normalises (trimmed + lowercased) before calling.
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface ProvisionCustomerOptions {
  // Stored in audit_logs.metadata.ip and audit_logs.ip_address. Signup passes
  // request.ip; the federation trigger may omit it.
  ip?: string;
  // Extra key/values merged into audit_logs.metadata (e.g. { provider: 'google' }).
  auditMetadata?: Record<string, unknown>;
}

export interface ProvisionCustomerResult {
  customer: CustomerSelfRow;
  outcome: ProvisionOutcome;
}

// Idempotent find-or-create-or-promote for a Customer row, keyed on email.
//
// Extracted verbatim from the Phase-1 DB transaction of POST /v1/auth/signup so
// the same advisory-locked, BR-tested logic backs both the password signup
// endpoint and the Cognito Google-federation trigger. See
// docs/superpowers/specs/2026-06-20-mobile-google-signin-design.md.
//
// MUST run inside a transaction context opened by the caller via
// app.withContext({ role: 'admin' }, async (tx) => ...). role:'admin' is
// required so the customers _write RLS policy allows the PROMOTE/CREATE for a
// brand-new customer (no customer_tenant_relations row yet). The advisory lock
// is xact-scoped, so it only serialises while that transaction is open.
//
// See APPENDICE_F BR-220/221/224/226.
export async function provisionCustomer(
  tx: PrismaClient,
  input: ProvisionCustomerInput,
  opts: ProvisionCustomerOptions = {},
): Promise<ProvisionCustomerResult> {
  // BR-220 race serialisation: xact-scoped advisory lock keyed on
  // `signup:<email>`. The SAME key is used by every caller so a password
  // signup and a Google federation for the same email serialise against each
  // other. `::text` cast works around Prisma 7 + @prisma/adapter-pg being
  // unable to deserialise a `void` column
  // (feedback_pg_void_return_prisma_adapter).
  await tx.$queryRawUnsafe<unknown[]>(
    `SELECT pg_advisory_xact_lock(hashtext($1))::text`,
    `signup:${input.email}`,
  );

  const existing = await tx.customer.findUnique({
    where: { email: input.email },
    select: { ...customerSelfSelect, cognitoSub: true, appInstalled: true },
  });

  // BR-224: a row is a promotable shadow iff cognito_sub IS NULL AND
  // app_installed = false. Anything else that already exists is "active".
  if (existing && (existing.cognitoSub !== null || existing.appInstalled === true)) {
    return {
      customer: {
        id: existing.id,
        email: existing.email,
        firstName: existing.firstName,
        lastName: existing.lastName,
        phone: existing.phone,
        status: existing.status,
        createdAt: existing.createdAt,
      },
      outcome: 'already_active',
    };
  }

  if (existing) {
    // PROMOTE — shadow customer becomes claimed (BR-221).
    const row = await tx.customer.update({
      where: { id: existing.id },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.phone ? { phone: input.phone } : {}),
        appInstalled: true,
        // BR-226: apply defaults on promote too — shadow rows carry `{}`.
        notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
      },
      select: customerSelfSelect,
    });
    await writeSignupAudit(tx, row.id, true, opts);
    return { customer: row, outcome: 'promoted' };
  }

  // CREATE — brand-new customer (BR-220).
  let row: CustomerSelfRow;
  try {
    row = await tx.customer.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.phone ? { phone: input.phone } : {}),
        status: 'active',
        appInstalled: true,
        notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
      },
      select: customerSelfSelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost a create race (parallel tx committed first, or a hashtext
      // collision let an unrelated email through the lock). Re-fetch and
      // report the now-existing row as already_active — externally identical
      // to the pre-refactor 409 path in the signup route.
      const raced = await tx.customer.findUnique({
        where: { email: input.email },
        select: customerSelfSelect,
      });
      if (raced) {
        return { customer: raced, outcome: 'already_active' };
      }
    }
    throw err;
  }
  await writeSignupAudit(tx, row.id, false, opts);
  return { customer: row, outcome: 'created' };
}

async function writeSignupAudit(
  tx: PrismaClient,
  customerId: string,
  promoted: boolean,
  opts: ProvisionCustomerOptions,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: null,
      actorType: 'customer',
      actorId: customerId,
      action: 'customer_signup',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        promoted,
        ...(opts.ip ? { ip: opts.ip } : {}),
        ...(opts.auditMetadata ?? {}),
      },
      ipAddress: opts.ip ?? null,
    },
  });
}
```

- [ ] **Step 4: Typecheck passes**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (no errors). The new test file and module compile.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/customer-provisioning.ts packages/api/tests/integration/customer-provisioning.test.ts
git commit -m "feat(api): extract idempotent provisionCustomer helper"
```

---

### Task 2: Refactor `POST /v1/auth/signup` to use `provisionCustomer()`

**Files:**
- Modify: `packages/api/src/routes/v1/auth-signup.ts` (imports + the Phase-1 `app.withContext` block, lines ~4-20 and ~118-249)

**Interfaces:**
- Consumes: `provisionCustomer`, `ProvisionCustomerResult` from `../../lib/customer-provisioning.js` (Task 1).
- Produces: no new exports; the endpoint's external contract (status codes, body, audit rows, Cognito calls) is unchanged.

- [ ] **Step 1: Update imports**

In `packages/api/src/routes/v1/auth-signup.ts`, remove the now-unused imports and add the helper. Replace the import block at the top:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  CognitoEmailAlreadyExistsError,
  CognitoInvalidPasswordError,
  createCustomerCognitoUser,
  deleteCognitoUser,
  setCustomerCognitoPassword,
} from '../../lib/cognito.js';
import { provisionCustomer } from '../../lib/customer-provisioning.js';
import { projectCustomerSelf } from '../../lib/customer-shared.js';
import {
  generateVerificationToken,
  buildVerificationUrl,
  VERIFICATION_TOKEN_TTL_MS,
} from '../../lib/email-verification.js';
import { sendVerificationEmail } from '../../lib/ses-client.js';
```

(Removed: `import { Prisma } from '@garageos/database'`, `customerSelfSelect` from customer-shared, and `DEFAULT_NOTIFICATION_PREFERENCES` — all now encapsulated in the helper.)

- [ ] **Step 2: Replace the Phase-1 transaction block**

Replace the entire `const { customer, promoted, verifyToken } = await app.withContext(...)` block (the old lines ~132-249, from `const { customer, promoted, verifyToken } = await app.withContext(` through its closing `);`) with:

```ts
      // ─── Phase 1 — DB transaction ───────────────────────────────────────────
      // role:'admin' bypasses the customers _write RLS policy (needed for a
      // brand-new customer with no customer_tenant_relations row yet) — same
      // rationale as before; the privacy boundary is application-level (Zod-
      // validated body, single email-keyed row). The provisioning mechanics
      // (advisory lock, find/promote/create, audit log) live in
      // provisionCustomer so the Google-federation trigger reuses them.
      const { customer, promoted, verifyToken } = await app.withContext(
        { role: 'admin' as const },
        async (tx) => {
          const result = await provisionCustomer(
            tx,
            {
              email: body.email,
              firstName: body.firstName,
              lastName: body.lastName,
              ...(body.phone ? { phone: body.phone } : {}),
            },
            { ip: request.ip },
          );

          // For the password signup endpoint an already-active row means the
          // email is taken → 409. (The Google-federation trigger instead
          // treats 'already_active' as the account-merge case — see
          // provisionCustomer.) NOTE: race-loss audit emission stays deferred
          // (see project_tech_debt.md).
          if (result.outcome === 'already_active') {
            throw businessError(
              'auth.signup.email_already_active',
              409,
              'Un account con questa email è già registrato. Effettua il login.',
            );
          }

          // Signup-specific: generate the verify-email token + persist its
          // hash. Plaintext is held in a closure variable to be sent via SES
          // post-commit. Single-use, 24h TTL, hash-only storage.
          const { plaintext: verifyToken, hash: verifyTokenHash } = generateVerificationToken();
          await tx.emailVerification.create({
            data: {
              customerId: result.customer.id,
              tokenHash: verifyTokenHash,
              expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
            },
          });

          return {
            customer: result.customer,
            promoted: result.outcome === 'promoted',
            verifyToken,
          };
        },
      );
```

Leave Phase 2, Phase 3, Phase 4 and the final `return reply.code(201).send({ customer: projectCustomerSelf(customer) });` exactly as they are. `void promoted;` stays.

- [ ] **Step 3: Typecheck passes**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS. No unused-import errors (Prisma / customerSelfSelect / DEFAULT_NOTIFICATION_PREFERENCES removed).

- [ ] **Step 4: Run the signup unit suite locally (route mocks)**

Per CLAUDE.md, route changes warrant a targeted unit run (typecheck does not catch broken FakePrisma mocks).

Run: `pnpm --filter @garageos/api test:unit -- auth-signup`
Expected: PASS — all existing `auth-signup` unit tests still green (rate-limit, validation, 409 mapping, etc.).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/auth-signup.ts
git commit -m "refactor(api): signup uses shared provisionCustomer helper"
```

---

### Task 3: Open the PR and verify CI

**Files:** none (git/CI only)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/google-signin-provisioning-refactor
```

The husky pre-push hook runs `pnpm -r typecheck` (~30s). Expected: pass.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "refactor(api): extract shared provisionCustomer helper for Google sign-in" --body "<see body below>"
```

PR body must follow the template in `CLAUDE.md` (What / Why / Implementation notes / Tests / Checklist). Key points to include:
- **What:** extract Phase-1 signup DB logic into idempotent `provisionCustomer()` returning `{ customer, outcome }`; signup route delegates to it. Behaviour-preserving refactor; foundation for PR 2 (Cognito Google-federation trigger).
- **Why:** PR 1 of the Google sign-in arc — see `docs/superpowers/specs/2026-06-20-mobile-google-signin-design.md`. BR-220/221/224/226.
- **Tests:** new direct integration tests (`customer-provisioning.test.ts`) covering created / promoted / already_active / idempotency; existing `auth-signup` integration + unit suites act as regression for the refactor.

- [ ] **Step 3: Watch CI until fully green**

Run: `gh pr checks --watch`
Expected: every check green — including the integration job that runs `customer-provisioning.test.ts` and the existing `auth-signup.test.ts` against Testcontainers. If integration fails, fix and push a follow-up commit (do not merge over red CI).

- [ ] **Step 4: Final whole-branch review**

Per CLAUDE.md right-sizing (this PR is a single-layer refactor, 2 tasks): run `/code-review high` on the branch. Apply Critical/Important findings; list Minor in the PR description.

- [ ] **Step 5: Squash-merge (self-merge authorised) once green + review clean**

```bash
gh pr merge <n> --squash --delete-branch
git checkout main && git pull origin main && git branch -D feat/google-signin-provisioning-refactor
```

---

## Self-Review

**Spec coverage (PR 1 slice only):** The spec's "Refactor abilitante" section (extract 3-phase provisioning into a shared function reused by signup + trigger) is implemented by Tasks 1-2. The `already_active`-without-throw return shape is the explicit enabler for the spec's merge case (handled in PR 2). PR 2 (triggers + CDK) and PR 3 (mobile) are out of scope for this plan by design and will be planned against the merged code.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `provisionCustomer` signature, `ProvisionCustomerResult`, and `ProvisionOutcome` are used identically in Task 1 (definition + tests) and Task 2 (route consumer). The route destructures `{ customer, promoted, verifyToken }` where `promoted = result.outcome === 'promoted'`, matching the downstream `void promoted;` and `projectCustomerSelf(customer)` (customer is `CustomerSelfRow`, the helper's return type).

**Behaviour-preservation check:** audit metadata `{ promoted, ip: request.ip }` and `ipAddress: request.ip` are byte-identical to the pre-refactor route (signup always passes `opts.ip = request.ip`). The P2002 path now resolves to `already_active → 409` instead of throwing 409 directly — same HTTP result, no audit row in either case. The 409 "already active" test, both race tests, the promote test, and the create test remain valid.

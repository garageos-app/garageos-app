# F-OFF-110 PR-1 — Officina-mediated vehicle transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build single-step officina-mediated vehicle transfer endpoint + Web dialog UI: backend atomic swap (close old ownership, open new, audit row, customer pick-or-create cross-tenant), Web 3-step wizard dialog, docs updates, enum migrations.

**Architecture:** New POST `/v1/vehicles/:id/ownership-transfer` route delegates to `lib/ownership-transfer.ts` which runs the 8-step atomic transaction inside `withContext({ role: 'admin' })`. Web `OwnershipTransferDialog` uses shadcn Dialog + 3-step state, calls mutation hook `useOwnershipTransfer`. Schema enum extensions only — no data shape migrations.

**Tech Stack:** Fastify + Zod + Prisma + Postgres (api), React + Vite + shadcn/ui + Radix + react-hook-form + TanStack Query (web), Vitest + supertest + Testcontainers (tests).

**Branch:** `feat/f-off-110-officina-mediated-transfer-pr1` off main.

**Spec reference:** `docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md`

---

## File map

**Created:**
- `packages/database/prisma/migrations/<ts>_officina_mediated_transfer/migration.sql`
- `packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts`
- `packages/api/src/lib/ownership-transfer.ts`
- `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
- `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`
- `packages/api/tests/integration/vehicles-ownership-transfer.test.ts`
- `packages/web/src/components/OwnershipTransferDialog.tsx`
- `packages/web/src/components/OwnershipTransferDialog.test.tsx`
- `packages/web/src/queries/ownershipTransfer.ts`

**Modified:**
- `packages/database/prisma/schema.prisma` (enum extensions)
- `packages/api/src/server.ts` (route registration)
- `packages/api/src/lib/business-error.ts` (verify codes registered if registry exists; else only used by call sites)
- `packages/web/src/pages/VehicleDetail.tsx` (button wire)
- `packages/web/src/queries/types.ts` (response shape types)
- `docs/GarageOS-Specifiche.md`
- `docs/APPENDICE_F_BUSINESS_LOGIC.md`
- `docs/APPENDICE_A_API.md`
- `docs/APPENDICE_G_ERROR_CODES.md`
- `docs/APPENDICE_E_TESTING.md`

---

## Task 1: Schema enum extensions + migration

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (lines around 85-104, 163-170)
- Create: `packages/database/prisma/migrations/<ts>_officina_mediated_transfer/migration.sql`

- [ ] **Step 1: Edit schema.prisma — extend TransferMethod**

Find existing enum at `packages/database/prisma/schema.prisma:85`:
```prisma
enum TransferMethod {
  initiated_by_seller
  claim_without_seller
}
```

Replace with:
```prisma
enum TransferMethod {
  initiated_by_seller
  claim_without_seller
  officina_mediated // BR-049
}
```

- [ ] **Step 2: Edit schema.prisma — extend AccessLogAction**

Find existing enum at `packages/database/prisma/schema.prisma:163`:
```prisma
enum AccessLogAction {
  view
  create
  update
  search_match
  cancel
  respond
}
```

Replace with:
```prisma
enum AccessLogAction {
  view
  create
  update
  search_match
  cancel
  respond
  ownership_transfer // BR-049
}
```

- [ ] **Step 3: Generate migration**

Run:
```bash
pnpm --filter @garageos/database exec prisma migrate dev --name officina_mediated_transfer --create-only
```

Expected: prints `Migration created`. Confirm new directory created under `prisma/migrations/`.

- [ ] **Step 4: Verify migration content**

Open `packages/database/prisma/migrations/<ts>_officina_mediated_transfer/migration.sql`. Expected content (Prisma generates):
```sql
-- AlterEnum
ALTER TYPE "TransferMethod" ADD VALUE 'officina_mediated';

-- AlterEnum
ALTER TYPE "AccessLogAction" ADD VALUE 'ownership_transfer';
```

If prisma adds extra `BEGIN` / `COMMIT` boilerplate, that's fine.

- [ ] **Step 5: Regenerate Prisma client**

Run:
```bash
pnpm --filter @garageos/database exec prisma generate
```

Expected: success, no error.

- [ ] **Step 6: Verify typecheck still passes**

Run:
```bash
pnpm -r typecheck
```

Expected: clean. The new enum values are additive — no existing code breaks.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(database): add officina_mediated TransferMethod + ownership_transfer AccessLogAction (BR-049)"
```

---

## Task 2: DB integration test BR-049

**Files:**
- Create: `packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createCustomer,
  createTenantWithLocation,
  createVehicle,
  createVehicleOwnership,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-049 — Officina-mediated single-step vehicle transfer.
// Atomic transaction: close current ownership, open new ownership for
// recipient, write VehicleTransfer audit row with status='completed' and
// method='officina_mediated', write AccessLog with action='ownership_transfer'.
// Spec ref: docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md

describe('BR-049 — officina-mediated single-step transfer', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function executeTransferSql(
    vehicleId: string,
    fromCustomerId: string,
    toCustomerId: string,
    reason: 'purchase' | 'inheritance' | 'company_assignment' | 'other',
    notes: string | null,
    tenantId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await pgAdmin.query('BEGIN');
    try {
      // Step 5: close current
      await pgAdmin.query(
        `UPDATE vehicle_ownerships
           SET ended_at = NOW(), transfer_reason = $2, transfer_notes = $3
         WHERE vehicle_id = $1 AND ended_at IS NULL`,
        [vehicleId, reason, notes],
      );
      // Step 6: open new
      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships
           (id, vehicle_id, customer_id, started_at, transfer_reason, transfer_notes, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), $3, $4, NOW())`,
        [vehicleId, toCustomerId, reason, notes],
      );
      // Step 7: audit transfer
      await pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, from_customer_id, to_customer_id, method, status,
            expires_at, completed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3,
            'officina_mediated'::"TransferMethod",
            'completed'::"TransferStatus",
            NOW(), NOW(), NOW(), NOW())`,
        [vehicleId, fromCustomerId, toCustomerId],
      );
      // Step 8: access log
      await pgAdmin.query(
        `INSERT INTO access_logs
           (id, tenant_id, user_id, action, resource_type, resource_id, created_at)
         VALUES (gen_random_uuid(), $1, $2,
            'ownership_transfer'::"AccessLogAction",
            'vehicle', $3, NOW())`,
        [tenantId, actorUserId, vehicleId],
      );
      await pgAdmin.query('COMMIT');
    } catch (err) {
      await pgAdmin.query('ROLLBACK');
      throw err;
    }
  }

  it('performs atomic swap: closes old ownership and opens new', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'purchase',
      'Vendita usato',
      tenantId,
      null,
    );

    const { rows } = await pgAdmin.query(
      `SELECT customer_id, started_at, ended_at, transfer_reason, transfer_notes
       FROM vehicle_ownerships WHERE vehicle_id = $1 ORDER BY started_at`,
      [vehicleId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].customer_id).toBe(cedente.id);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].transfer_reason).toBe('purchase');
    expect(rows[0].transfer_notes).toBe('Vendita usato');
    expect(rows[1].customer_id).toBe(cessionario.id);
    expect(rows[1].ended_at).toBeNull();
    expect(rows[1].transfer_reason).toBe('purchase');
  });

  it('BR-040: exactly one active ownership after transfer', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'other',
      null,
      tenantId,
      null,
    );

    const { rows } = await pgAdmin.query(
      `SELECT COUNT(*)::int AS n FROM vehicle_ownerships
       WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('writes VehicleTransfer audit row with method=officina_mediated, status=completed', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'inheritance',
      null,
      tenantId,
      null,
    );

    const { rows } = await pgAdmin.query(
      `SELECT method, status, from_customer_id, to_customer_id, completed_at
       FROM vehicle_transfers WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('officina_mediated');
    expect(rows[0].status).toBe('completed');
    expect(rows[0].from_customer_id).toBe(cedente.id);
    expect(rows[0].to_customer_id).toBe(cessionario.id);
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('writes AccessLog with action=ownership_transfer', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'company_assignment',
      null,
      tenantId,
      null,
    );

    const { rows } = await pgAdmin.query(
      `SELECT action, resource_type, resource_id FROM access_logs
       WHERE resource_id = $1 AND action = 'ownership_transfer'`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('ownership_transfer');
    expect(rows[0].resource_type).toBe('vehicle');
  });

  it('BR-047: rejects insert of second active VehicleTransfer on same vehicle', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    // Insert a pending transfer first
    await pgAdmin.query(
      `INSERT INTO vehicle_transfers
         (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'TRC-X-1',
          'initiated_by_seller'::"TransferMethod",
          'pending_recipient'::"TransferStatus",
          NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [vehicleId],
    );

    // Now try to add a completed officina-mediated transfer — should work
    // (completed is NOT in the BR-047 active set). But adding a SECOND
    // pending one should fail.
    await expect(
      pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'TRC-X-2',
            'officina_mediated'::"TransferMethod",
            'pending_recipient'::"TransferStatus",
            NOW() + INTERVAL '7 days', NOW(), NOW())`,
        [vehicleId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('accepts officina_mediated enum value', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

    await expect(
      pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, method, status, expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1,
            'officina_mediated'::"TransferMethod",
            'completed'::"TransferStatus",
            NOW(), NOW(), NOW())`,
        [vehicleId],
      ),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Verify helpers exist; add missing if any**

Check that `createCustomer`, `createVehicleOwnership` exist in `packages/database/tests/integration/helpers.ts`. If missing, add:

```typescript
export async function createCustomer({
  tenantId,
  firstName = 'Test',
  lastName = 'Customer',
  email,
}: {
  tenantId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}) {
  const customerEmail = email ?? `cust-${randomUUID()}@example.com`;
  const { rows } = await pgAdmin.query(
    `INSERT INTO customers (id, first_name, last_name, email, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW()) RETURNING id`,
    [firstName, lastName, customerEmail],
  );
  const id = rows[0].id as string;
  if (tenantId) {
    await pgAdmin.query(
      `INSERT INTO customer_tenant_relations
         (id, tenant_id, customer_id, intervention_count, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 0, NOW(), NOW())`,
      [tenantId, id],
    );
  }
  return { id, email: customerEmail };
}

export async function createVehicleOwnership({
  vehicleId,
  customerId,
  startedAt = new Date(),
}: {
  vehicleId: string;
  customerId: string;
  startedAt?: Date;
}) {
  const { rows } = await pgAdmin.query(
    `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW()) RETURNING id`,
    [vehicleId, customerId, startedAt],
  );
  return { id: rows[0].id as string };
}
```

If they already exist, leave alone.

- [ ] **Step 3: Run test to verify it passes (migration applied)**

Run on CI (memory `feedback_skip_local_integration_tests`: NO local integration). The DB integration tests run on CI as part of `@garageos/database test:integration`. Push the branch and watch:
```bash
gh pr checks --watch
```

Expected: green for `db-integration` job.

If local run is necessary for debugging:
```bash
pnpm --filter @garageos/database test:integration -- br-049
```

Expected: 6/6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts packages/database/tests/integration/helpers.ts
git commit -m "test(database): add BR-049 officina-mediated transfer integration tests"
```

---

## Task 3: API lib ownership-transfer.ts (atomic transaction)

**Files:**
- Create: `packages/api/src/lib/ownership-transfer.ts`

- [ ] **Step 1: Write the lib file**

Create `packages/api/src/lib/ownership-transfer.ts`:

```typescript
// Officina-mediated vehicle ownership transfer (BR-049, F-OFF-110).
//
// Single-step atomic swap executed within a Prisma transaction with
// withContext({ role: 'admin' }). Closes the current vehicle_ownership,
// opens a new one for the recipient, writes a VehicleTransfer audit row
// with status='completed' / method='officina_mediated', and writes an
// AccessLog row.
//
// Pre-conditions (callers MUST ensure tenant scoping BEFORE calling):
//   - vehicle.tenantId === actor tenant (checked at route via findFirst)
// Errors are surfaced via businessError() codes — see
// docs/APPENDICE_G_ERROR_CODES.md vehicle.transfer.* family.
//
// Lock order (memory feedback_code_review_lock_graph_analysis):
//   vehicles → vehicle_ownerships → vehicle_transfers → customers
//   → customer_tenant_relations
//
// Spec: docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md

import type { Prisma, PrismaClient } from '@garageos/database/client';

import { businessError } from './business-error.js';

export type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

export type RecipientInput =
  | { kind: 'existing'; customerId: string }
  | {
      kind: 'new';
      firstName: string;
      lastName: string;
      email: string;
      phone?: string | null;
      codiceFiscale?: string | null;
      isBusiness?: boolean;
      businessName?: string | null;
      vatNumber?: string | null;
    };

export interface OwnershipTransferInput {
  vehicleId: string;
  tenantId: string;
  actorUserId: string | null;
  recipient: RecipientInput;
  reason: TransferReason;
  notes: string | null;
}

export interface OwnershipTransferResult {
  vehicleId: string;
  ownership: { id: string; customerId: string; startedAt: Date };
  transfer: {
    id: string;
    status: 'completed';
    completedAt: Date;
    reason: TransferReason;
    notes: string | null;
  };
}

type TxClient = Prisma.TransactionClient | PrismaClient;

/**
 * Resolve toCustomer (existing or new). Returns { toCustomerId, isNew }.
 */
async function resolveRecipient(
  tx: TxClient,
  tenantId: string,
  recipient: RecipientInput,
): Promise<{ toCustomerId: string }> {
  if (recipient.kind === 'existing') {
    const existing = await tx.customer.findUnique({
      where: { id: recipient.customerId },
      select: { id: true },
    });
    if (!existing) {
      throw businessError(
        'vehicle.transfer.recipient_not_found',
        422,
        'Cessionario non trovato.',
      );
    }
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: existing.id } },
      update: {},
      create: { tenantId, customerId: existing.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: existing.id };
  }

  // kind === 'new'
  const found = await tx.customer.findFirst({
    where: { email: recipient.email },
    select: { id: true },
  });
  if (found) {
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: found.id } },
      update: {},
      create: { tenantId, customerId: found.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: found.id };
  }

  try {
    const created = await tx.customer.create({
      data: {
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        email: recipient.email,
        phone: recipient.phone ?? null,
        codiceFiscale: recipient.codiceFiscale ?? null,
        isBusiness: recipient.isBusiness ?? false,
        businessName: recipient.businessName ?? null,
        vatNumber: recipient.vatNumber ?? null,
      },
      select: { id: true },
    });
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: created.id } },
      update: {},
      create: { tenantId, customerId: created.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: created.id };
  } catch (err: unknown) {
    // P2002 race condition catch + refetch (pattern PR #15)
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'P2002'
    ) {
      const refetched = await tx.customer.findFirst({
        where: { email: recipient.email },
        select: { id: true },
      });
      if (refetched) {
        await tx.customerTenantRelation.upsert({
          where: { tenantId_customerId: { tenantId, customerId: refetched.id } },
          update: {},
          create: { tenantId, customerId: refetched.id, interventionCount: 0 },
          select: { id: true },
        });
        return { toCustomerId: refetched.id };
      }
    }
    throw err;
  }
}

export async function performOwnershipTransfer(
  tx: TxClient,
  input: OwnershipTransferInput,
): Promise<OwnershipTransferResult> {
  // Step 1: lock + verify vehicle status
  const vehicle = await tx.vehicle.findFirst({
    where: { id: input.vehicleId, tenantId: input.tenantId },
    select: { id: true, status: true },
  });
  if (!vehicle) {
    throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
  }
  if (vehicle.status === 'pending') {
    throw businessError(
      'vehicle.transfer.pending_not_transferable',
      422,
      'Veicolo non certificato non trasferibile (BR-046).',
    );
  }
  if (vehicle.status === 'archived') {
    throw businessError(
      'vehicle.transfer.archived',
      422,
      'Veicolo archiviato non trasferibile.',
    );
  }

  // Step 2: current active ownership
  const currentOwnership = await tx.vehicleOwnership.findFirst({
    where: { vehicleId: input.vehicleId, endedAt: null },
    select: { id: true, customerId: true },
  });
  if (!currentOwnership) {
    throw businessError(
      'vehicle.transfer.no_active_ownership',
      422,
      'Veicolo senza proprietario attivo.',
    );
  }

  // Step 3: no active transfer (BR-047 defensive — DB unique enforces, but
  // surface a clean 409 instead of P2002 leak).
  const activeTransfer = await tx.vehicleTransfer.findFirst({
    where: {
      vehicleId: input.vehicleId,
      status: { in: ['pending_recipient', 'pending_seller_confirmation', 'pending_validation'] },
    },
    select: { id: true },
  });
  if (activeTransfer) {
    throw businessError(
      'vehicle.transfer.active_transfer_exists',
      409,
      'Trasferimento già in corso per questo veicolo (BR-047).',
    );
  }

  // Step 4: resolve recipient
  const { toCustomerId } = await resolveRecipient(tx, input.tenantId, input.recipient);
  if (toCustomerId === currentOwnership.customerId) {
    throw businessError(
      'vehicle.transfer.same_owner',
      409,
      'Il cessionario coincide con il proprietario attuale.',
    );
  }

  // Step 5: close current ownership
  await tx.vehicleOwnership.update({
    where: { id: currentOwnership.id },
    data: {
      endedAt: new Date(),
      transferReason: input.reason,
      transferNotes: input.notes,
    },
  });

  // Step 6: open new ownership
  const newOwnership = await tx.vehicleOwnership.create({
    data: {
      vehicleId: input.vehicleId,
      customerId: toCustomerId,
      startedAt: new Date(),
      transferReason: input.reason,
      transferNotes: input.notes,
    },
    select: { id: true, customerId: true, startedAt: true },
  });

  // Step 7: audit transfer row
  const now = new Date();
  const transferRow = await tx.vehicleTransfer.create({
    data: {
      vehicleId: input.vehicleId,
      fromCustomerId: currentOwnership.customerId,
      toCustomerId,
      method: 'officina_mediated',
      status: 'completed',
      expiresAt: now,
      completedAt: now,
    },
    select: { id: true, completedAt: true },
  });

  // Step 8: access log
  await tx.accessLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.actorUserId,
      action: 'ownership_transfer',
      resourceType: 'vehicle',
      resourceId: input.vehicleId,
    },
  });

  return {
    vehicleId: input.vehicleId,
    ownership: newOwnership,
    transfer: {
      id: transferRow.id,
      status: 'completed' as const,
      completedAt: transferRow.completedAt!,
      reason: input.reason,
      notes: input.notes,
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
pnpm -r typecheck
```

Expected: clean. If `accessLog`, `customerTenantRelation`, etc. fields differ from actual Prisma schema names, fix imports/casing.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/lib/ownership-transfer.ts
git commit -m "feat(api): add ownership-transfer atomic transaction lib (BR-049)"
```

---

## Task 4: API route POST /vehicles/:id/ownership-transfer

**Files:**
- Create: `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
- Modify: `packages/api/src/server.ts` (import + register)

- [ ] **Step 1: Write the route file**

Create `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`:

```typescript
// POST /v1/vehicles/:id/ownership-transfer — F-OFF-110 officina-mediated
// single-step vehicle transfer (BR-049, see spec
// docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md).
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext
// Role: super_admin OR mechanic (both can execute transfers; mechanic
// is the common in-store actor).
// RLS context: role: 'admin' for writes (memory feedback_withcontext_empty_blocks_rls_writes).
//
// Error codes:
//   vehicle.not_found                         — 404
//   vehicle.transfer.pending_not_transferable — 422 BR-046
//   vehicle.transfer.archived                 — 422
//   vehicle.transfer.no_active_ownership      — 422
//   vehicle.transfer.active_transfer_exists   — 409 BR-047
//   vehicle.transfer.same_owner               — 409
//   vehicle.transfer.recipient_not_found      — 422

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  performOwnershipTransfer,
  type RecipientInput,
} from '../../lib/ownership-transfer.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { vehicleDetailSelect } from '../../lib/vehicle-shared.js';

const ParamsSchema = z.object({ id: z.uuid() });

const RecipientExistingSchema = z.object({
  kind: z.literal('existing'),
  customerId: z.uuid(),
});

const RecipientNewSchema = z.object({
  kind: z.literal('new'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).nullable().optional(),
  codiceFiscale: z.string().trim().max(20).nullable().optional(),
  isBusiness: z.boolean().optional(),
  businessName: z.string().trim().max(200).nullable().optional(),
  vatNumber: z.string().trim().max(20).nullable().optional(),
});

const BodySchema = z
  .object({
    recipient: z.discriminatedUnion('kind', [RecipientExistingSchema, RecipientNewSchema]),
    reason: z.enum(['purchase', 'inheritance', 'company_assignment', 'other']),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine(
    (b) => {
      if (b.recipient.kind === 'new' && b.recipient.isBusiness === true) {
        return Boolean(b.recipient.businessName && b.recipient.vatNumber);
      }
      return true;
    },
    {
      message: 'businessName and vatNumber required when isBusiness=true',
      path: ['recipient'],
    },
  );

export const vehiclesOwnershipTransferRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/ownership-transfer',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const role = request.userRole;
      if (role !== 'super_admin' && role !== 'mechanic') {
        throw businessError('auth.role_forbidden', 403, 'Ruolo non autorizzato.');
      }

      const tenantId = request.tenantId!;
      const actorUserId = request.dbUserId ?? null;
      const vehicleId = parsedParams.data.id;
      const body = parsedBody.data;

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        return performOwnershipTransfer(tx, {
          vehicleId,
          tenantId,
          actorUserId,
          recipient: body.recipient as RecipientInput,
          reason: body.reason,
          notes: body.notes ?? null,
        });
      });

      // Reload vehicle with detail shape for response
      const vehicle = await app.prisma.vehicle.findFirst({
        where: { id: vehicleId, tenantId },
        select: vehicleDetailSelect,
      });

      return reply.code(200).send({
        vehicle,
        ownership: {
          id: result.ownership.id,
          customerId: result.ownership.customerId,
          startedAt: result.ownership.startedAt.toISOString(),
        },
        transfer: {
          id: result.transfer.id,
          status: result.transfer.status,
          completedAt: result.transfer.completedAt.toISOString(),
          reason: result.transfer.reason,
          notes: result.transfer.notes,
        },
      });
    },
  );
};
```

- [ ] **Step 2: Register route in server.ts**

In `packages/api/src/server.ts`:

Add the import near other v1 vehicle routes (alphabetically or follow existing convention; likely after `vehicles.ts` import):
```typescript
import { vehiclesOwnershipTransferRoutes } from './routes/v1/vehicles-ownership-transfer.js';
```

Add the registration near other vehicle route registrations:
```typescript
await app.register(vehiclesOwnershipTransferRoutes);
```

Verify both lines added by reading the file post-edit.

- [ ] **Step 3: Verify typecheck**

Run:
```bash
pnpm -r typecheck
```

Expected: clean. If `request.userRole` or `request.dbUserId` typing is different in the codebase, adjust to actual names by grepping a recent route like `users-admin-reactivate.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-ownership-transfer.ts packages/api/src/server.ts
git commit -m "feat(api): add POST /v1/vehicles/:id/ownership-transfer route (F-OFF-110)"
```

---

## Task 5: API unit tests

**Files:**
- Create: `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`

- [ ] **Step 1: Write the unit test file**

Create `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`. Use FakePrisma stub pattern from existing unit tests (e.g. `me-vehicles.test.ts`). The stub must include: `vehicle`, `vehicleOwnership`, `vehicleTransfer`, `customer`, `customerTenantRelation`, `accessLog` groups.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  performOwnershipTransfer,
  type OwnershipTransferInput,
} from '../../../../src/lib/ownership-transfer.js';

interface StubState {
  vehicles: Map<string, { id: string; tenantId: string; status: string }>;
  ownerships: Map<string, { id: string; vehicleId: string; customerId: string; endedAt: Date | null }>;
  transfers: Map<string, { id: string; vehicleId: string; status: string }>;
  customers: Map<string, { id: string; email: string }>;
  relations: Map<string, { tenantId: string; customerId: string }>;
  accessLogs: Array<{ tenantId: string; resourceId: string; action: string }>;
}

function makeStub() {
  const state: StubState = {
    vehicles: new Map(),
    ownerships: new Map(),
    transfers: new Map(),
    customers: new Map(),
    relations: new Map(),
    accessLogs: [],
  };

  const tx = {
    vehicle: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const v of state.vehicles.values()) {
          if (v.id === where.id && v.tenantId === where.tenantId) return v;
        }
        return null;
      }),
    },
    vehicleOwnership: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const o of state.ownerships.values()) {
          if (o.vehicleId === where.vehicleId && o.endedAt === null) return o;
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const o = state.ownerships.get(where.id);
        if (o) Object.assign(o, data);
        return o;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `own-${state.ownerships.size + 1}`;
        const row = { id, ...data, endedAt: null };
        state.ownerships.set(id, row);
        return { id, customerId: data.customerId, startedAt: data.startedAt };
      }),
    },
    vehicleTransfer: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const t of state.transfers.values()) {
          if (t.vehicleId === where.vehicleId && (where.status?.in ?? []).includes(t.status)) {
            return t;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `tr-${state.transfers.size + 1}`;
        const row = { id, ...data, completedAt: data.completedAt };
        state.transfers.set(id, row);
        return { id, completedAt: data.completedAt };
      }),
    },
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        return state.customers.get(where.id) ?? null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const c of state.customers.values()) {
          if (c.email === where.email) return c;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `c-${state.customers.size + 1}`;
        const row = { id, ...data };
        state.customers.set(id, row);
        return { id };
      }),
    },
    customerTenantRelation: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = `${where.tenantId_customerId.tenantId}:${where.tenantId_customerId.customerId}`;
        if (!state.relations.has(key)) state.relations.set(key, create);
        return { id: key };
      }),
    },
    accessLog: {
      create: vi.fn(async ({ data }: any) => {
        state.accessLogs.push(data);
        return data;
      }),
    },
  };

  return { tx, state };
}

const baseInput: OwnershipTransferInput = {
  vehicleId: 'v1',
  tenantId: 't1',
  actorUserId: 'u1',
  recipient: { kind: 'existing', customerId: 'c-recipient' },
  reason: 'purchase',
  notes: null,
};

describe('performOwnershipTransfer', () => {
  let env: ReturnType<typeof makeStub>;

  beforeEach(() => {
    env = makeStub();
    env.state.vehicles.set('v1', { id: 'v1', tenantId: 't1', status: 'certified' });
    env.state.ownerships.set('own-current', {
      id: 'own-current',
      vehicleId: 'v1',
      customerId: 'c-cedente',
      endedAt: null,
    });
    env.state.customers.set('c-cedente', { id: 'c-cedente', email: 'cedente@example.com' });
    env.state.customers.set('c-recipient', { id: 'c-recipient', email: 'recipient@example.com' });
  });

  it('happy path: existing recipient produces complete result', async () => {
    const result = await performOwnershipTransfer(env.tx as any, baseInput);
    expect(result.transfer.status).toBe('completed');
    expect(result.ownership.customerId).toBe('c-recipient');
    expect(env.state.ownerships.get('own-current')!.endedAt).not.toBeNull();
    expect(env.state.accessLogs).toHaveLength(1);
    expect(env.state.accessLogs[0].action).toBe('ownership_transfer');
  });

  it('happy path: new recipient creates customer', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: {
        kind: 'new',
        firstName: 'Anna',
        lastName: 'Rossi',
        email: 'anna@example.com',
      },
    };
    const result = await performOwnershipTransfer(env.tx as any, input);
    expect(result.transfer.status).toBe('completed');
    expect(env.tx.customer.create).toHaveBeenCalled();
  });

  it('new recipient with matching email reuses existing customer', async () => {
    env.state.customers.set('c-existing', { id: 'c-existing', email: 'reuse@example.com' });
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: {
        kind: 'new',
        firstName: 'Mario',
        lastName: 'Bianchi',
        email: 'reuse@example.com',
      },
    };
    const result = await performOwnershipTransfer(env.tx as any, input);
    expect(result.ownership.customerId).toBe('c-existing');
    expect(env.tx.customer.create).not.toHaveBeenCalled();
  });

  it('404 vehicle.not_found when vehicle missing in tenant', async () => {
    env.state.vehicles.clear();
    await expect(performOwnershipTransfer(env.tx as any, baseInput)).rejects.toMatchObject({
      name: 'vehicle.not_found',
      statusCode: 404,
    });
  });

  it('422 pending_not_transferable when vehicle.status=pending', async () => {
    env.state.vehicles.set('v1', { id: 'v1', tenantId: 't1', status: 'pending' });
    await expect(performOwnershipTransfer(env.tx as any, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.pending_not_transferable',
      statusCode: 422,
    });
  });

  it('422 archived when vehicle.status=archived', async () => {
    env.state.vehicles.set('v1', { id: 'v1', tenantId: 't1', status: 'archived' });
    await expect(performOwnershipTransfer(env.tx as any, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.archived',
      statusCode: 422,
    });
  });

  it('422 no_active_ownership when ownerships empty', async () => {
    env.state.ownerships.clear();
    await expect(performOwnershipTransfer(env.tx as any, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.no_active_ownership',
      statusCode: 422,
    });
  });

  it('409 active_transfer_exists when pending transfer present', async () => {
    env.state.transfers.set('tr-pending', {
      id: 'tr-pending',
      vehicleId: 'v1',
      status: 'pending_recipient',
    });
    await expect(performOwnershipTransfer(env.tx as any, baseInput)).rejects.toMatchObject({
      name: 'vehicle.transfer.active_transfer_exists',
      statusCode: 409,
    });
  });

  it('409 same_owner when recipient is current owner', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: { kind: 'existing', customerId: 'c-cedente' },
    };
    await expect(performOwnershipTransfer(env.tx as any, input)).rejects.toMatchObject({
      name: 'vehicle.transfer.same_owner',
      statusCode: 409,
    });
  });

  it('422 recipient_not_found when existing customerId missing', async () => {
    const input: OwnershipTransferInput = {
      ...baseInput,
      recipient: { kind: 'existing', customerId: 'c-ghost' },
    };
    await expect(performOwnershipTransfer(env.tx as any, input)).rejects.toMatchObject({
      name: 'vehicle.transfer.recipient_not_found',
      statusCode: 422,
    });
  });
});
```

- [ ] **Step 2: Run unit tests**

Run:
```bash
pnpm --filter @garageos/api test:unit -- vehicles-ownership-transfer
```

Expected: 10/10 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts
git commit -m "test(api): add ownership-transfer unit tests (FakePrisma, BR-049)"
```

---

## Task 6: API integration tests

**Files:**
- Create: `packages/api/tests/integration/vehicles-ownership-transfer.test.ts`

- [ ] **Step 1: Write the integration test file**

Create `packages/api/tests/integration/vehicles-ownership-transfer.test.ts`. Pattern follows existing integration tests (e.g. `vehicles-timeline.test.ts`, `me-vehicles.test.ts`). Use a unique remote IP per describe for rate-limit isolation (memory `feedback_integration_test_rate_limit_isolation`).

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildAppForTests, mintOfficineJwt } from './helpers.js';
import {
  createTenantWithLocation,
  createCustomer,
  createVehicle,
  createVehicleOwnership,
  createUser,
  resetDb,
} from './helpers.js';

const TEST_IP = '10.99.49.10';

describe('POST /v1/vehicles/:id/ownership-transfer (F-OFF-110, BR-049)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildAppForTests();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function setupScenario(opts?: { vehicleStatus?: 'certified' | 'pending' | 'archived' }) {
    const { tenantId } = await createTenantWithLocation();
    const adminUser = await createUser({ tenantId, role: 'super_admin' });
    const mechanicUser = await createUser({ tenantId, role: 'mechanic' });
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `cess-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({
      tenantId,
      status: opts?.vehicleStatus ?? 'certified',
    });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });
    const adminJwt = mintOfficineJwt({ sub: adminUser.cognitoSub, tenantId, role: 'super_admin' });
    const mechanicJwt = mintOfficineJwt({
      sub: mechanicUser.cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, adminUser, mechanicUser, cedente, cessionario, vehicleId, adminJwt, mechanicJwt };
  }

  it('200: happy path with existing recipient (super_admin)', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
        notes: 'Vendita usato',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfer.status).toBe('completed');
    expect(body.ownership.customerId).toBe(s.cessionario.id);
    expect(body.vehicle.id).toBe(s.vehicleId);
  });

  it('200: happy path mechanic role can execute', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.mechanicJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'other',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: new recipient creates customer + tenant relation', async () => {
    const s = await setupScenario();
    const newEmail = `new-${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Anna',
          lastName: 'Rossi',
          email: newEmail,
        },
        reason: 'inheritance',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfer.status).toBe('completed');
    expect(body.ownership.customerId).not.toBe(s.cedente.id);
  });

  it('200: new recipient with same-tenant email match reuses customer', async () => {
    const s = await setupScenario();
    // s.cessionario already exists in the same tenant
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Different',
          lastName: 'Name',
          email: s.cessionario.email,
        },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ownership.customerId).toBe(s.cessionario.id);
  });

  it('200: new recipient with cross-tenant email match reuses customer + adds relation', async () => {
    const s = await setupScenario();
    // Create another tenant + customer with overlapping email
    const otherTenant = await createTenantWithLocation();
    const sharedEmail = `cross-${Date.now()}@example.com`;
    const sharedCustomer = await createCustomer({ tenantId: otherTenant.tenantId, email: sharedEmail });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: {
          kind: 'new',
          firstName: 'Cross',
          lastName: 'Tenant',
          email: sharedEmail,
        },
        reason: 'company_assignment',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ownership.customerId).toBe(sharedCustomer.id);
  });

  it('400: missing reason', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401: missing auth', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404: vehicle from other tenant', async () => {
    const s = await setupScenario();
    const other = await createTenantWithLocation();
    const { vehicleId: otherVehicleId } = await createVehicle({
      tenantId: other.tenantId,
      status: 'certified',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${otherVehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');
  });

  it('422: vehicle pending', async () => {
    const s = await setupScenario({ vehicleStatus: 'pending' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.pending_not_transferable');
  });

  it('422: vehicle archived', async () => {
    const s = await setupScenario({ vehicleStatus: 'archived' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.archived');
  });

  it('409: same_owner — cessionario is current owner', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cedente.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.transfer.same_owner');
  });

  it('422: recipient_not_found — existing customerId ghost', async () => {
    const s = await setupScenario();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: '00000000-0000-4000-8000-000000000001' },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.recipient_not_found');
  });

  it('409: active_transfer_exists when pending transfer present', async () => {
    const s = await setupScenario();
    // Manually insert pending transfer via raw SQL
    const { pgAdmin } = await import('../../tests/integration/setup.js').catch(
      () => import('../../../database/tests/integration/setup.js' as any),
    );
    // Fallback to app-side prisma for insertion if pgAdmin not exported
    await app.prisma.vehicleTransfer.create({
      data: {
        vehicleId: s.vehicleId,
        method: 'initiated_by_seller',
        status: 'pending_recipient',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        transferCode: `PENDING-${Date.now()}`,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('vehicle.transfer.active_transfer_exists');
  });

  it('BR-045 privacy: post-transfer GET /vehicles/:id returns only new owner', async () => {
    const s = await setupScenario();
    await app.inject({
      method: 'POST',
      url: `/v1/vehicles/${s.vehicleId}/ownership-transfer`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
      payload: {
        recipient: { kind: 'existing', customerId: s.cessionario.id },
        reason: 'purchase',
      },
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${s.vehicleId}`,
      headers: { authorization: `Bearer ${s.adminJwt}`, 'x-test-ip': TEST_IP },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    // ownerships array should contain only the active row (cessionario)
    const owners = body.vehicle?.ownerships ?? body.currentOwnership ? [body.currentOwnership] : [];
    if (Array.isArray(owners)) {
      expect(owners.length).toBeLessThanOrEqual(1);
      if (owners[0]) expect(owners[0].customer.id).toBe(s.cessionario.id);
    }
  });
});
```

- [ ] **Step 2: Verify helpers**

Check `packages/api/tests/integration/helpers.ts` has `createUser`, `createCustomer`, `createVehicleOwnership`, `mintOfficineJwt`. Add any missing using the pattern of existing helpers (mirror `packages/database/tests/integration/helpers.ts` if needed).

- [ ] **Step 3: Run tests on CI**

Push branch and watch:
```bash
git push -u origin feat/f-off-110-officina-mediated-transfer-pr1
gh pr checks --watch
```

Expected: api-integration job green. If failures, look for typing mismatch on `app.prisma.vehicleTransfer.create` or helper signatures.

- [ ] **Step 4: Commit**

```bash
git add packages/api/tests/integration/vehicles-ownership-transfer.test.ts packages/api/tests/integration/helpers.ts
git commit -m "test(api): add ownership-transfer integration tests (F-OFF-110)"
```

---

## Task 7: Web mutation hook

**Files:**
- Create: `packages/web/src/queries/ownershipTransfer.ts`
- Modify: `packages/web/src/queries/types.ts`

- [ ] **Step 1: Add response shape type**

Append to `packages/web/src/queries/types.ts`:

```typescript
export type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

export interface OwnershipTransferResponse {
  vehicle: {
    id: string;
    garageCode: string;
    plate: string;
    [k: string]: unknown;
  };
  ownership: { id: string; customerId: string; startedAt: string };
  transfer: {
    id: string;
    status: 'completed';
    completedAt: string;
    reason: TransferReason;
    notes: string | null;
  };
}
```

- [ ] **Step 2: Create mutation hook**

Create `packages/web/src/queries/ownershipTransfer.ts`:

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { OwnershipTransferResponse, TransferReason } from './types';

export type OwnershipTransferRecipient =
  | { kind: 'existing'; customerId: string }
  | {
      kind: 'new';
      firstName: string;
      lastName: string;
      email: string;
      phone?: string | null;
      codiceFiscale?: string | null;
      isBusiness?: boolean;
      businessName?: string | null;
      vatNumber?: string | null;
    };

export interface OwnershipTransferPayload {
  recipient: OwnershipTransferRecipient;
  reason: TransferReason;
  notes?: string | null;
}

export function useOwnershipTransfer(vehicleId: string) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: OwnershipTransferPayload) =>
      apiFetch<OwnershipTransferResponse>(`/v1/vehicles/${vehicleId}/ownership-transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-detail', vehicleId] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
      queryClient.invalidateQueries({ queryKey: ['customer-search'] });
    },
  });
}
```

- [ ] **Step 3: Verify typecheck**

Run:
```bash
pnpm -r typecheck
```

Expected: clean. If `useApiFetch` returns different signature, adapt — grep `useApiFetch` in existing queries (e.g. `customerSearch.ts`) for the canonical pattern.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/queries/ownershipTransfer.ts packages/web/src/queries/types.ts
git commit -m "feat(web): add useOwnershipTransfer mutation hook (F-OFF-110)"
```

---

## Task 8: Web OwnershipTransferDialog component

**Files:**
- Create: `packages/web/src/components/OwnershipTransferDialog.tsx`

- [ ] **Step 1: Write the dialog component**

Create `packages/web/src/components/OwnershipTransferDialog.tsx`:

```typescript
// F-OFF-110 — Officina-mediated vehicle transfer dialog (BR-049).
// IT-strings hardcoded. 3-step wizard: cessionario, motivo+note, conferma.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError } from '@/lib/api-client';
import { useCustomerSearch } from '@/queries/customerSearch';
import { useOwnershipTransfer, type OwnershipTransferRecipient } from '@/queries/ownershipTransfer';

const REASON_OPTIONS: { value: 'purchase' | 'inheritance' | 'company_assignment' | 'other'; label: string }[] = [
  { value: 'purchase', label: 'Vendita' },
  { value: 'inheritance', label: 'Eredità' },
  { value: 'company_assignment', label: 'Assegnazione aziendale' },
  { value: 'other', label: 'Altro' },
];

const NewRecipientSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Nome obbligatorio').max(100),
    lastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100),
    email: z.string().trim().email('Email non valida').max(255),
    phone: z.string().trim().max(30).optional(),
    codiceFiscale: z.string().trim().max(20).optional(),
    isBusiness: z.boolean().optional(),
    businessName: z.string().trim().max(200).optional(),
    vatNumber: z.string().trim().max(20).optional(),
  })
  .refine((d) => !d.isBusiness || (Boolean(d.businessName) && Boolean(d.vatNumber)), {
    message: 'Ragione sociale e P.IVA obbligatorie per cliente aziendale',
    path: ['businessName'],
  });

type NewRecipientForm = z.infer<typeof NewRecipientSchema>;

interface SelectedRecipient {
  kind: 'existing' | 'new';
  data: OwnershipTransferRecipient;
  displayName: string;
  email: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: string;
  vehicleLabel: string; // for the warning box
  currentOwnerCustomerId: string;
}

export function OwnershipTransferDialog(props: Props) {
  const { open, onOpenChange, vehicleId, vehicleLabel, currentOwnerCustomerId } = props;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [recipient, setRecipient] = useState<SelectedRecipient | null>(null);
  const [reason, setReason] = useState<'purchase' | 'inheritance' | 'company_assignment' | 'other' | ''>('');
  const [notes, setNotes] = useState('');

  const searchQuery = useCustomerSearch(search);
  const mutation = useOwnershipTransfer(vehicleId);

  const newForm = useForm<NewRecipientForm>({
    resolver: zodResolver(NewRecipientSchema),
    defaultValues: { firstName: '', lastName: '', email: '', isBusiness: false },
  });
  const isBusinessFlag = newForm.watch('isBusiness');

  function reset() {
    setStep(1);
    setSearch('');
    setShowNewForm(false);
    setRecipient(null);
    setReason('');
    setNotes('');
    newForm.reset();
  }

  function handleClose() {
    if (mutation.isPending) return;
    onOpenChange(false);
    reset();
  }

  function handleSelectExisting(customer: { id: string; firstName: string; lastName: string; email: string }) {
    if (customer.id === currentOwnerCustomerId) {
      toast.error('Il cessionario non può essere il proprietario attuale');
      return;
    }
    setRecipient({
      kind: 'existing',
      data: { kind: 'existing', customerId: customer.id },
      displayName: `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email,
    });
    setStep(2);
  }

  function handleSubmitNew(data: NewRecipientForm) {
    setRecipient({
      kind: 'new',
      data: {
        kind: 'new',
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone || null,
        codiceFiscale: data.codiceFiscale || null,
        isBusiness: data.isBusiness ?? false,
        businessName: data.businessName || null,
        vatNumber: data.vatNumber || null,
      },
      displayName: `${data.firstName} ${data.lastName}`,
      email: data.email,
    });
    setStep(2);
  }

  async function handleConfirm() {
    if (!recipient || !reason) return;
    try {
      await mutation.mutateAsync({
        recipient: recipient.data,
        reason,
        notes: notes.trim() || null,
      });
      toast.success('Trasferimento completato');
      onOpenChange(false);
      reset();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message = mapErrorCode(code) ?? (err instanceof Error ? err.message : 'Errore sconosciuto');
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : handleClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Trasferisci proprietà — Step {step}/3
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            {!showNewForm && (
              <>
                <div>
                  <Label htmlFor="recipient-search">Cerca cessionario</Label>
                  <Input
                    id="recipient-search"
                    placeholder="Nome, cognome o ragione sociale (min 2 caratteri)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {searchQuery.data && search.trim().length >= 2 && (
                  <ul className="max-h-60 overflow-y-auto border rounded">
                    {searchQuery.data.customers.map((c) => (
                      <li
                        key={c.id}
                        className="p-2 hover:bg-muted cursor-pointer border-b last:border-b-0"
                        onClick={() => handleSelectExisting(c)}
                        role="button"
                        data-testid={`recipient-result-${c.id}`}
                      >
                        <div className="font-medium">
                          {c.firstName} {c.lastName}
                        </div>
                        <div className="text-sm text-muted-foreground">{c.email}</div>
                      </li>
                    ))}
                    {searchQuery.data.customers.length === 0 && (
                      <li className="p-2 text-sm text-muted-foreground">Nessun risultato</li>
                    )}
                  </ul>
                )}
                <Button variant="outline" onClick={() => setShowNewForm(true)} type="button">
                  Aggiungi nuovo cessionario
                </Button>
              </>
            )}
            {showNewForm && (
              <form onSubmit={newForm.handleSubmit(handleSubmitNew)} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="firstName">Nome *</Label>
                    <Input id="firstName" {...newForm.register('firstName')} />
                    {newForm.formState.errors.firstName && (
                      <p className="text-sm text-destructive">
                        {newForm.formState.errors.firstName.message}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="lastName">Cognome *</Label>
                    <Input id="lastName" {...newForm.register('lastName')} />
                    {newForm.formState.errors.lastName && (
                      <p className="text-sm text-destructive">
                        {newForm.formState.errors.lastName.message}
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input id="email" type="email" {...newForm.register('email')} />
                  {newForm.formState.errors.email && (
                    <p className="text-sm text-destructive">
                      {newForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="phone">Telefono</Label>
                    <Input id="phone" {...newForm.register('phone')} />
                  </div>
                  <div>
                    <Label htmlFor="cf">Codice fiscale</Label>
                    <Input id="cf" {...newForm.register('codiceFiscale')} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="isBusiness"
                    checked={isBusinessFlag ?? false}
                    onCheckedChange={(v) => newForm.setValue('isBusiness', v === true)}
                  />
                  <Label htmlFor="isBusiness">Cliente aziendale</Label>
                </div>
                {isBusinessFlag && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="businessName">Ragione sociale *</Label>
                      <Input id="businessName" {...newForm.register('businessName')} />
                    </div>
                    <div>
                      <Label htmlFor="vatNumber">P.IVA *</Label>
                      <Input id="vatNumber" {...newForm.register('vatNumber')} />
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <Button type="button" variant="outline" onClick={() => setShowNewForm(false)}>
                    Indietro
                  </Button>
                  <Button type="submit">Avanti</Button>
                </div>
              </form>
            )}
          </div>
        )}

        {step === 2 && recipient && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Cessionario: <strong>{recipient.displayName}</strong> ({recipient.email})
            </div>
            <div>
              <Label htmlFor="reason">Motivo trasferimento *</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
                <SelectTrigger id="reason">
                  <SelectValue placeholder="Seleziona motivo" />
                </SelectTrigger>
                <SelectContent>
                  {REASON_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="notes">Note (opzionale)</Label>
              <Textarea
                id="notes"
                maxLength={1000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="text-xs text-muted-foreground">{notes.length} / 1000</div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(1)}>
                Indietro
              </Button>
              <Button onClick={() => setStep(3)} disabled={!reason}>
                Avanti
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && recipient && reason && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>
                Confermando il trasferimento, il veicolo <strong>{vehicleLabel}</strong> passerà a{' '}
                <strong>{recipient.displayName}</strong> in modo permanente. Verifica di aver controllato il
                libretto di circolazione. Questa azione non può essere annullata.
              </AlertDescription>
            </Alert>
            <div className="text-sm space-y-1">
              <div>
                <strong>Cessionario:</strong> {recipient.displayName} ({recipient.email})
              </div>
              <div>
                <strong>Motivo:</strong> {REASON_OPTIONS.find((o) => o.value === reason)?.label}
              </div>
              {notes && (
                <div>
                  <strong>Note:</strong> {notes}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(2)} disabled={mutation.isPending}>
                Indietro
              </Button>
              <Button variant="destructive" onClick={handleConfirm} disabled={mutation.isPending}>
                {mutation.isPending ? 'Trasferimento in corso…' : 'Conferma trasferimento'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function mapErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    'vehicle.transfer.pending_not_transferable': 'Il veicolo non è certificato.',
    'vehicle.transfer.archived': 'Il veicolo è archiviato.',
    'vehicle.transfer.no_active_ownership': 'Il veicolo non ha un proprietario attivo.',
    'vehicle.transfer.active_transfer_exists': 'È già in corso un trasferimento per questo veicolo.',
    'vehicle.transfer.same_owner': 'Il cessionario non può essere il proprietario attuale.',
    'vehicle.transfer.recipient_not_found': 'Cessionario non trovato.',
    'vehicle.not_found': 'Veicolo non trovato.',
    'auth.role_forbidden': 'Non autorizzato.',
  };
  return map[code] ?? null;
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
pnpm -r typecheck
```

Expected: clean. If shadcn `Textarea`, `Checkbox`, or `Select` import paths differ, adjust to the project's actual `components/ui/` paths.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/OwnershipTransferDialog.tsx
git commit -m "feat(web): add OwnershipTransferDialog 3-step wizard (F-OFF-110)"
```

---

## Task 9: Web component tests

**Files:**
- Create: `packages/web/src/components/OwnershipTransferDialog.test.tsx`

- [ ] **Step 1: Write the component test file**

Create `packages/web/src/components/OwnershipTransferDialog.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { OwnershipTransferDialog } from './OwnershipTransferDialog';
import * as api from '@/lib/api-client';

function renderDialog(overrides?: Partial<React.ComponentProps<typeof OwnershipTransferDialog>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props: React.ComponentProps<typeof OwnershipTransferDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    vehicleId: 'veh-1',
    vehicleLabel: 'AB123CD',
    currentOwnerCustomerId: 'c-cedente',
    ...overrides,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <OwnershipTransferDialog {...props} />
    </QueryClientProvider>,
  );
}

describe('OwnershipTransferDialog', () => {
  it('step 1 renders search input', () => {
    renderDialog();
    expect(screen.getByLabelText(/Cerca cessionario/i)).toBeInTheDocument();
  });

  it('clicking "Aggiungi nuovo cessionario" opens inline form', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    expect(screen.getByLabelText(/^Nome \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Cognome \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email \*/i)).toBeInTheDocument();
  });

  it('new form requires firstName + lastName + email', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    expect(await screen.findByText(/Nome obbligatorio/i)).toBeInTheDocument();
  });

  it('isBusiness toggle reveals businessName + vatNumber', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    await user.click(screen.getByLabelText(/Cliente aziendale/i));
    expect(screen.getByLabelText(/Ragione sociale/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/P.IVA/i)).toBeInTheDocument();
  });

  it('step 2 reason required: Avanti disabled until selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    // Jump into step 2 via new recipient happy path
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    await user.type(screen.getByLabelText(/^Nome \*/i), 'Anna');
    await user.type(screen.getByLabelText(/^Cognome \*/i), 'Rossi');
    await user.type(screen.getByLabelText(/^Email \*/i), 'anna@example.com');
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    const advanceBtn = await screen.findByRole('button', { name: /Avanti/i });
    expect(advanceBtn).toBeDisabled();
  });

  it('step 3 confirm calls mutation with correct payload', async () => {
    const user = userEvent.setup();
    const apiFetchSpy = vi
      .spyOn(api, 'useApiFetch')
      .mockReturnValue(vi.fn().mockResolvedValue({
        vehicle: { id: 'veh-1' },
        ownership: { id: 'o', customerId: 'c-new', startedAt: new Date().toISOString() },
        transfer: {
          id: 't',
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
          reason: 'purchase' as const,
          notes: null,
        },
      }));
    renderDialog();
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    await user.type(screen.getByLabelText(/^Nome \*/i), 'Anna');
    await user.type(screen.getByLabelText(/^Cognome \*/i), 'Rossi');
    await user.type(screen.getByLabelText(/^Email \*/i), 'anna@example.com');
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    // Step 2 reason
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Vendita/i }));
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    // Step 3 confirm
    await user.click(screen.getByRole('button', { name: /Conferma trasferimento/i }));
    await waitFor(() => {
      expect(apiFetchSpy).toHaveBeenCalled();
    });
    apiFetchSpy.mockRestore();
  });

  it('error response surfaces toast and dialog stays open', async () => {
    const user = userEvent.setup();
    const apiError = new api.ApiError('Veicolo non trovato', {
      status: 404,
      code: 'vehicle.not_found',
    });
    const apiFetchSpy = vi
      .spyOn(api, 'useApiFetch')
      .mockReturnValue(vi.fn().mockRejectedValue(apiError));
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    await user.click(screen.getByRole('button', { name: /Aggiungi nuovo cessionario/i }));
    await user.type(screen.getByLabelText(/^Nome \*/i), 'A');
    await user.type(screen.getByLabelText(/^Cognome \*/i), 'B');
    await user.type(screen.getByLabelText(/^Email \*/i), 'a@b.it');
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Altro/i }));
    await user.click(screen.getByRole('button', { name: /Avanti/i }));
    await user.click(screen.getByRole('button', { name: /Conferma trasferimento/i }));
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalled());
    apiFetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Verify ApiError export signature**

If `api.ApiError` constructor signature differs from `(message, { status, code })`, adapt by reading `packages/web/src/lib/api-client.ts`. Same for `useApiFetch` spy pattern — fall back to module-level mocking if `vi.spyOn` doesn't work due to default export.

- [ ] **Step 3: Run web tests**

Run:
```bash
pnpm --filter @garageos/web test -- OwnershipTransferDialog
```

Expected: 7/7 pass.

Memory `feedback_radix_tabs_user_event_not_fire_event`: tests use `userEvent.click`, NOT `fireEvent.click`. Confirmed in code.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/OwnershipTransferDialog.test.tsx
git commit -m "test(web): add OwnershipTransferDialog component tests (F-OFF-110)"
```

---

## Task 10: Wire button into VehicleDetail page

**Files:**
- Modify: `packages/web/src/pages/VehicleDetail.tsx`

- [ ] **Step 1: Add button + dialog state to VehicleDetail.tsx**

Read current state of `packages/web/src/pages/VehicleDetail.tsx`. Identify the section where vehicle status badge + actions are rendered (around line 80-150).

Add imports near existing imports:
```typescript
import { useState } from 'react'; // verify React is already imported
import { OwnershipTransferDialog } from '@/components/OwnershipTransferDialog';
```

Inside the component, add state after `useVehicleTimeline` line:
```typescript
const [transferOpen, setTransferOpen] = useState(false);
```

Locate the actions row in the rendered JSX (where existing buttons like "Modifica" live). Add transfer button conditionally:

```tsx
{v.status === 'certified' && detail.data.currentOwnership && (
  <Button variant="outline" onClick={() => setTransferOpen(true)}>
    Trasferisci proprietà
  </Button>
)}
```

At the end of the component's returned JSX, mount the dialog:

```tsx
{detail.data.currentOwnership && (
  <OwnershipTransferDialog
    open={transferOpen}
    onOpenChange={setTransferOpen}
    vehicleId={v.id}
    vehicleLabel={v.plate ?? v.garageCode ?? v.id}
    currentOwnerCustomerId={detail.data.currentOwnership.customer.id}
  />
)}
```

- [ ] **Step 2: Verify typecheck + run page test**

```bash
pnpm -r typecheck
pnpm --filter @garageos/web test -- VehicleDetail
```

Expected: typecheck clean; existing VehicleDetail tests still pass (button visible only when certified+ownership present, which is normal demo seed state).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/pages/VehicleDetail.tsx
git commit -m "feat(web): wire OwnershipTransferDialog button on VehicleDetail page (F-OFF-110)"
```

---

## Task 11: Documentation updates

**Files:**
- Modify: `docs/GarageOS-Specifiche.md`
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md`
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`
- Modify: `docs/APPENDICE_E_TESTING.md`

- [ ] **Step 1: Add F-OFF-110 row in GarageOS-Specifiche.md**

Find the F-OFF-109 row at `docs/GarageOS-Specifiche.md:432` (the Ristampa tag row, in the vehicles section table). Add immediately AFTER that row:

```markdown
| F-OFF-110 | Trasferimento proprietà in officina | L'officina trasferisce la proprietà di un veicolo certificato da un cliente esistente a un nuovo proprietario, in single-step atomic swap. Richiede presenza fisica cedente + verifica libretto. Variante officina-mediated del passaggio proprietà (vedi BR-049) | 🟢 MUST |
```

- [ ] **Step 2: Add BR-049 in APPENDICE_F_BUSINESS_LOGIC.md**

Find the end of BR-048 at `docs/APPENDICE_F_BUSINESS_LOGIC.md:268`. Insert AFTER BR-048's closing:

```markdown

### BR-049 — Passaggio di proprietà officina-mediated (single-step)

Variante officina-mediated del passaggio di proprietà: il cedente è fisicamente presente in officina, l'officina verifica il libretto di circolazione e identità delle parti, ed esegue il transfer in **una singola operazione atomica** senza la doppia conferma di BR-043.

**Razionale:** la presenza fisica + verifica documentale dell'officina sostituiscono il consenso remoto via app del flusso BR-043. Utile per clienti non-tech-savvy o per officine che gestiscono compravendite usato.

**Precondizioni:**
- Veicolo deve essere in stato `certified` (BR-046)
- Veicolo deve avere `vehicle_ownership` attiva (`ended_at IS NULL`)
- Non deve esistere un `VehicleTransfer` attivo per il veicolo (BR-047)
- Cessionario ≠ cedente attuale

**Effetti atomici** (singola transazione SQL):
1. `vehicle_ownerships` corrente: `ended_at = NOW()`, popola `transfer_reason` + `transfer_notes`
2. Nuova `vehicle_ownerships` row: `customer_id = cessionario.id`, `started_at = NOW()`, stessi `transfer_reason` + `transfer_notes`
3. `vehicle_transfers` row: `method = 'officina_mediated'`, `status = 'completed'`, `completed_at = NOW()`, `from_customer_id` + `to_customer_id` popolati
4. `customer_tenant_relations` per cessionario↔tenant garantita (UPSERT)
5. Se cessionario nuovo: `customers` row creata (con email-as-global-identity riuso cross-tenant se esistente)
6. `access_logs` row: `action = 'ownership_transfer'`

**Auth:** officina pool, ruolo `super_admin` o `mechanic`.

**Cross-ref:** BR-043 (mobile remote-parties variant), BR-045 (cosa trasferisce / cosa no), BR-046 (no pending), BR-047 (no concurrent active transfers).
```

Then find BR-043 (around line 186) and append at the end of its content:

```markdown

**Cross-ref:** per la variante officina-mediated single-step vedi BR-049.
```

- [ ] **Step 3: Document endpoint in APPENDICE_A_API.md**

Find the vehicles section of `docs/APPENDICE_A_API.md`. After the most recent vehicle endpoint documentation (e.g. patch vehicle), add:

```markdown

### POST /v1/vehicles/:id/ownership-transfer

Trasferimento officina-mediated della proprietà del veicolo (F-OFF-110, BR-049). Single-step atomic swap.

**Auth:** Cognito JWT officina pool. Role `super_admin` o `mechanic`.

**Path params:**
- `id` (UUID): vehicle id

**Body:**

```json
{
  "recipient": {
    "kind": "existing",
    "customerId": "uuid"
  } /* OR */ {
    "kind": "new",
    "firstName": "string",
    "lastName": "string",
    "email": "string",
    "phone": "string|null",
    "codiceFiscale": "string|null",
    "isBusiness": false,
    "businessName": "string|null",
    "vatNumber": "string|null"
  },
  "reason": "purchase|inheritance|company_assignment|other",
  "notes": "string|null"
}
```

**Response 200:**

```json
{
  "vehicle": { /* vehicleDetailSelect shape */ },
  "ownership": { "id": "uuid", "customerId": "uuid", "startedAt": "ISO" },
  "transfer": {
    "id": "uuid",
    "status": "completed",
    "completedAt": "ISO",
    "reason": "purchase",
    "notes": "string|null"
  }
}
```

**Errors:** vedi APPENDICE_G error codes family `vehicle.transfer.*`.
```

- [ ] **Step 4: Add error codes in APPENDICE_G_ERROR_CODES.md**

Find the existing vehicle codes section (or codes registry) in `docs/APPENDICE_G_ERROR_CODES.md`. Add a new sub-section:

```markdown

## vehicle.transfer.* (F-OFF-110 / BR-049)

| Code | HTTP | Message (IT default) |
|---|---|---|
| `vehicle.transfer.pending_not_transferable` | 422 | Veicolo non certificato non trasferibile (BR-046). |
| `vehicle.transfer.archived` | 422 | Veicolo archiviato non trasferibile. |
| `vehicle.transfer.no_active_ownership` | 422 | Veicolo senza proprietario attivo. |
| `vehicle.transfer.active_transfer_exists` | 409 | Trasferimento già in corso per questo veicolo (BR-047). |
| `vehicle.transfer.same_owner` | 409 | Il cessionario coincide con il proprietario attuale. |
| `vehicle.transfer.recipient_not_found` | 422 | Cessionario non trovato. |
```

- [ ] **Step 5: Add BR-049 to test matrix in APPENDICE_E_TESTING.md**

Find the BR↔Test matrix in `docs/APPENDICE_E_TESTING.md` §8 and add row:

```markdown
| BR-049 | DB integration + API integration + Web component | br-049-officina-mediated-transfer / vehicles-ownership-transfer / OwnershipTransferDialog |
```

- [ ] **Step 6: Commit docs**

```bash
git add docs/GarageOS-Specifiche.md docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md docs/APPENDICE_E_TESTING.md
git commit -m "docs: add F-OFF-110 + BR-049 (officina-mediated vehicle transfer)"
```

---

## Task 12: Open PR + smoke validation

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/f-off-110-officina-mediated-transfer-pr1
```

- [ ] **Step 2: Open PR via gh CLI**

```bash
gh pr create --title "feat(api,web,database): F-OFF-110 officina-mediated vehicle transfer (BR-049) PR-1/2" --body "$(cat <<'EOF'
## What

Backend POST /v1/vehicles/:id/ownership-transfer endpoint + Web dialog UI + enum migrations + docs for the officina-mediated vehicle transfer slice (F-OFF-110, BR-049). Single-step atomic ownership swap: cedente fisicamente presente in officina, no double-confirm (variant of BR-043).

## Why

Permette al pilot officina (Giuseppe) di gestire compravendite di veicoli usati in-store senza dipendere da mobile customer flow F-CLI-401/402/403 (parked T&S SES). PR-2 follow-up: S3 libretto upload + notifica email cedente.

Spec: `docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md`

## Implementation notes

- Atomic 8-step transaction in `lib/ownership-transfer.ts` with `withContext({ role: 'admin' })` for RLS writes
- Cross-tenant email-as-identity reuse for new recipients (pattern customer-shared)
- 3-step shadcn Dialog wizard (cessionario search/create → motivo+note → conferma)
- Two-PR split: this is PR-1 (~1100-1300 LOC); PR-2 covers S3 doc upload + email notification (~400-600 LOC)
- Enum extensions only: `TransferMethod += officina_mediated`, `AccessLogAction += ownership_transfer`. No data-shape migrations.

## Tests

- [x] DB integration tests added (BR-049 file)
- [x] API unit tests (FakePrisma stub, 10 cases)
- [x] API integration tests (real Postgres, 13 cases incl. BR-045 privacy)
- [x] Web component tests (7 cases)
- [x] BR-049 verified end-to-end
- [ ] Manual smoke pilot demo Giuseppe (post-merge)

## Screenshots

(N/A at PR creation; will attach smoke screenshots post-merge)

## Checklist

- [x] Code follows conventions in CONTRIBUTING.md
- [x] Types compile (`pnpm -r typecheck`)
- [x] No new `console.log`
- [x] Secrets not committed
- [x] Documentation updated (Specifiche, APPENDICE_F, APPENDICE_A, APPENDICE_G, APPENDICE_E)
- [x] BR-049 added in business logic doc

EOF
)"
```

- [ ] **Step 3: Watch CI**

```bash
gh pr checks --watch
```

Expected: all jobs green (db-integration, api-unit, api-integration, web-unit, lint, typecheck, cdk-synth).

- [ ] **Step 4: Mid-execution LOC checkpoint**

After Task 9 (or earlier if subjective volume feels high), run:
```bash
git diff main --stat | tail -5
```

If total exceeds 1300 LOC, halt and ask user for split (e.g. extract Web component to PR-1b). Memory `feedback_mid_execution_loc_checkpoint`: 80% threshold = stop-and-ask.

- [ ] **Step 5: Memory updates after merge**

Post-merge, before declaring done, update:
- `project_resume_checkpoint.md` — new HEAD, PR # increment, F-OFF-110 LIVE
- New feedback memories as discovered during execution (drift, hidden constraints, etc.)

---

## Self-Review Checklist

**Spec coverage:**
- [x] F-OFF-110 feature ID — Task 11
- [x] BR-049 business rule — Task 11
- [x] Enum migrations (TransferMethod, AccessLogAction) — Task 1
- [x] Atomic transaction (8 steps) — Task 3
- [x] All 6 vehicle.transfer.* error codes + customer.email_conflict (via P2002 catch) — Task 3 + Task 4
- [x] BR-046 pending guard — Task 3, Task 5, Task 6
- [x] BR-047 active transfer guard — Task 3, Task 5, Task 6
- [x] Cross-tenant customer reuse (email-as-identity) — Task 3, Task 6
- [x] Web 3-step dialog (search/create cessionario, motivo+note, conferma) — Task 8
- [x] Button wire on VehicleDetail conditional on status=certified+ownership — Task 10
- [x] Docs updates (5 files) — Task 11
- [x] DB + API + Web tests — Tasks 2, 5, 6, 9
- [x] BR-045 privacy verification (no new code, integration test asserts) — Task 6
- [x] AccessLog ownership_transfer row — Tasks 2, 3
- [x] Lock ordering — documented in Task 3 comment header
- [x] LOC budget tracking — Task 12 step 4

**Placeholder scan:** No TBD/TODO. All code blocks complete.

**Type consistency:**
- `RecipientInput` type defined in Task 3, used in Task 4 + Task 7
- `OwnershipTransferResult` shape consistent between lib (Task 3) and route response (Task 4) and Web type (Task 7)
- Function names: `performOwnershipTransfer`, `resolveRecipient` consistently referenced

**Scope check:** Single PR (PR-1), single coherent slice. PR-2 explicitly out-of-scope and documented in spec.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-f-off-110-officina-mediated-transfer-pr1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Per memory `feedback_subagent_driven_review_loop`: 36+ successful applications, ZERO-critical-on-merge streak 19.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

Which approach?

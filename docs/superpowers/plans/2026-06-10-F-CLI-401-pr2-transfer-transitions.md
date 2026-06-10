# F-CLI-401 PR2 — Transfer transitions + atomic swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `accept`, `confirm`, `reject` transitions to the customer-side vehicle-transfer flow, with an atomic ownership swap on confirm (BR-043 double confirmation).

**Architecture:** Three new handlers in the existing `routes/v1/me-transfers.ts` (all `role:'user'`, app-layer authorization). The confirm swap lives in a dedicated `lib/transfer-swap.ts` helper using compare-and-swap on the transfer status plus the `uq_ownership_vehicle_active` index for race safety. `performOwnershipTransfer` (officina) is left untouched. No migration / dependency / CDK / deploy.

**Tech Stack:** Fastify + Zod + Prisma (Postgres), Vitest (unit with FakePrisma + integration with real Postgres via Testcontainers).

**Spec:** `docs/superpowers/specs/2026-06-10-F-CLI-401-pr2-transfer-transitions-design.md`

---

## File structure

- **Create** `packages/api/src/lib/transfer-swap.ts` — `confirmTransferSwap(tx, input)` atomic swap helper.
- **Create** `packages/api/tests/unit/lib/transfer-swap.test.ts` — helper unit tests.
- **Modify** `packages/api/src/routes/v1/me-transfers.ts` — +3 handlers (accept/confirm/reject).
- **Modify** `packages/api/tests/unit/routes/v1/me-transfers.test.ts` — extend FakePrisma + handler unit tests.
- **Modify** `packages/api/tests/integration/helpers.ts` — `createTransfer`, `getActiveOwnerCustomerId`, `getTransferById`.
- **Create** `packages/api/tests/integration/me-transfers-transitions.test.ts` — full-flow integration tests (incl. F-CLI-405).
- **Modify** `docs/APPENDICE_G_ERROR_CODES.md` — +4 error-code leaves.
- **Modify** `docs/APPENDICE_A_API.md` — mark the 3 endpoints implemented.

### Error codes used (all under blessed `transfer.*` prefixes)

| Code | HTTP | Status | New? |
|---|---|---|---|
| `transfer.not_found` | 404 | — | reuse |
| `transfer.acceptance.already_completed` | 409 | — | reuse |
| `transfer.acceptance.not_pending_recipient` | 422 | — | reuse |
| `transfer.acceptance.expired` | 410 | — | reuse |
| `transfer.acceptance.self_not_allowed` | 403 | — | **NEW** |
| `transfer.confirmation.not_from_customer` | 403 | — | reuse |
| `transfer.confirmation.not_pending_seller` | 422 | — | reuse |
| `transfer.confirmation.expired` | 410 | — | **NEW** |
| `transfer.confirmation.ownership_conflict` | 409 | — | **NEW** |
| `transfer.rejection.not_permitted` | 403 | — | reuse |
| `transfer.rejection.not_pending` | 409 | — | **NEW** |

All `detail` strings are ASCII-only (no apostrophes/accents), matching PR1's style ("gia", "puo").

---

## Task 1: `confirmTransferSwap` helper

**Files:**
- Create: `packages/api/src/lib/transfer-swap.ts`
- Test: `packages/api/tests/unit/lib/transfer-swap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/transfer-swap.test.ts`:

```ts
import { Prisma } from '@garageos/database';
import { describe, expect, it, vi } from 'vitest';

import { confirmTransferSwap } from '../../../../src/lib/transfer-swap.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const INPUT = {
  transferId: 'tr-1',
  vehicleId: 'veh-1',
  fromCustomerId: 'seller-1',
  toCustomerId: 'buyer-1',
  now: NOW,
};

// Minimal fake transaction client: only the methods confirmTransferSwap touches.
function fakeTx(overrides: {
  transferUpdateCount?: number;
  ownershipUpdateCount?: number;
  ownershipCreate?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    vehicleTransfer: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.transferUpdateCount ?? 1 }),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.ownershipUpdateCount ?? 1 }),
      create: overrides.ownershipCreate ?? vi.fn().mockResolvedValue({ id: 'own-new' }),
    },
  };
}

describe('confirmTransferSwap', () => {
  it('CAS-flips the transfer, closes the old ownership, opens the new one', async () => {
    const tx = fakeTx();
    await confirmTransferSwap(tx as never, INPUT);

    expect(tx.vehicleTransfer.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'tr-1', status: 'pending_seller_confirmation' },
      data: { status: 'completed', completedAt: NOW },
    });
    expect(tx.vehicleOwnership.updateMany.mock.calls[0]![0]).toEqual({
      where: { vehicleId: 'veh-1', customerId: 'seller-1', endedAt: null },
      data: { endedAt: NOW, transferReason: 'purchase', transferNotes: null },
    });
    expect(tx.vehicleOwnership.create.mock.calls[0]![0]).toEqual({
      data: { vehicleId: 'veh-1', customerId: 'buyer-1', startedAt: NOW },
    });
  });

  it('throws not_pending_seller (422) when the CAS loses the race', async () => {
    const tx = fakeTx({ transferUpdateCount: 0 });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.not_pending_seller',
      statusCode: 422,
    });
    expect(tx.vehicleOwnership.updateMany).not.toHaveBeenCalled();
  });

  it('throws ownership_conflict (409) when no active ownership is closed', async () => {
    const tx = fakeTx({ ownershipUpdateCount: 0 });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.ownership_conflict',
      statusCode: 409,
    });
    expect(tx.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('maps a uq_ownership_vehicle_active P2002 to ownership_conflict (409)', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('race', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['uq_ownership_vehicle_active'] },
      }),
    );
    const tx = fakeTx({ ownershipCreate: create });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.ownership_conflict',
      statusCode: 409,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-swap.test.ts`
Expected: FAIL — cannot resolve `../../../../src/lib/transfer-swap.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/lib/transfer-swap.ts`:

```ts
import { Prisma } from '@garageos/database';
import type { PrismaClient } from '@garageos/database';

import { businessError } from './business-error.js';

// Atomic ownership swap for the customer-confirmed transfer (BR-043 step 4).
//
// Compare-and-swap on the transfer status guards against a concurrent
// confirm; the partial-unique index uq_ownership_vehicle_active (BR-040)
// guards the new ownership row. No AccessLog is written: the customer flow
// has no tenant/user actor (mirrors the claim path in me-vehicles.ts). The
// whole call runs inside the withContext transaction, so any throw after the
// status flip rolls the flip back.
//
// Lock order (memory feedback_code_review_lock_graph_analysis):
//   vehicle_transfers -> vehicle_ownerships
//
// performOwnershipTransfer (lib/ownership-transfer.ts, F-OFF-110) is the
// officina-mediated single-step variant and is intentionally NOT reused:
// it scopes by tenant, resolves/creates the recipient, CREATES the transfer
// row and writes an AccessLog — none of which fit the customer flow.

type TxClient = Prisma.TransactionClient | PrismaClient;

export interface ConfirmSwapInput {
  transferId: string;
  vehicleId: string;
  fromCustomerId: string;
  toCustomerId: string;
  now: Date;
}

export async function confirmTransferSwap(tx: TxClient, input: ConfirmSwapInput): Promise<void> {
  const { transferId, vehicleId, fromCustomerId, toCustomerId, now } = input;

  // Step 1: CAS the transfer to completed. Leaving pending_seller_confirmation
  // also drops the row out of the uq_transfer_vehicle_active predicate,
  // freeing the BR-047 active-transfer slot.
  const cas = await tx.vehicleTransfer.updateMany({
    where: { id: transferId, status: 'pending_seller_confirmation' },
    data: { status: 'completed', completedAt: now },
  });
  if (cas.count === 0) {
    // A concurrent confirm won the race and already advanced the status.
    throw businessError(
      'transfer.confirmation.not_pending_seller',
      422,
      'Trasferimento non in attesa di conferma del cedente.',
    );
  }

  // Step 2: close the seller's current active ownership.
  const closed = await tx.vehicleOwnership.updateMany({
    where: { vehicleId, customerId: fromCustomerId, endedAt: null },
    data: { endedAt: now, transferReason: 'purchase', transferNotes: null },
  });
  if (closed.count === 0) {
    // Near-unreachable: the pending transfer held the BR-047 slot, blocking
    // any competing claim/officina transfer. Defensive guard.
    throw businessError(
      'transfer.confirmation.ownership_conflict',
      409,
      'Stato proprieta del veicolo cambiato: riprova.',
    );
  }

  // Step 3: open the new ownership for the recipient.
  try {
    await tx.vehicleOwnership.create({
      data: { vehicleId, customerId: toCustomerId, startedAt: now },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw businessError(
        'transfer.confirmation.ownership_conflict',
        409,
        'Stato proprieta del veicolo cambiato: riprova.',
      );
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-swap.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/transfer-swap.ts packages/api/tests/unit/lib/transfer-swap.test.ts
git commit -m "feat(api): add confirmTransferSwap helper for customer transfer"
```

---

## Task 2: Error-code docs (APPENDICE_G + APPENDICE_A)

**Files:**
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Add the 4 new leaves to the APPENDICE_G table**

In `docs/APPENDICE_G_ERROR_CODES.md`, find the transfer block in the main table (it contains the line `| \`transfer.confirmation.not_pending_seller\` | 422 | ...`). Add these 4 rows so the acceptance/confirmation/rejection groups stay contiguous:

```markdown
| `transfer.acceptance.self_not_allowed` | 403 | warning | Non puoi accettare un trasferimento avviato da te | accept del proprio transfer | F-CLI-401, BR-043 |
| `transfer.confirmation.expired` | 410 | info | Trasferimento scaduto | expires_at passato dopo accettazione | F-CLI-403, BR-043 |
| `transfer.confirmation.ownership_conflict` | 409 | warning | Stato proprieta veicolo cambiato | concorrenza sullo swap | F-CLI-403 |
| `transfer.rejection.not_pending` | 409 | info | Trasferimento gia in stato terminale | reject di un transfer non attivo | F-CLI-403, BR-048 |
```

- [ ] **Step 2: Add the 4 codes to the alphabetical index**

Find the alphabetical index block (the flat list containing `transfer.acceptance.already_completed` … `transfer.rejection.not_permitted`). Insert the 4 new codes keeping the block alphabetically sorted:

```
transfer.acceptance.self_not_allowed
transfer.confirmation.expired
transfer.confirmation.ownership_conflict
transfer.rejection.not_pending
```

Resulting order within the affected region must be:
`transfer.acceptance.not_pending_recipient`, `transfer.acceptance.self_not_allowed`, `transfer.claim_without_seller.*`, `transfer.confirmation.expired`, `transfer.confirmation.not_from_customer`, `transfer.confirmation.not_pending_seller`, `transfer.confirmation.ownership_conflict`, `transfer.creation.*`, `transfer.not_found`, `transfer.rejection.not_pending`, `transfer.rejection.not_permitted`.

- [ ] **Step 3: Update APPENDICE_A to mark the endpoints implemented**

In `docs/APPENDICE_A_API.md`, find the endpoint table rows for `/me/transfers/:code/accept`, `/me/transfers/:id/confirm`, `/me/transfers/:id/reject` (currently tagged `(PR2+)`). Change the trailing `(PR2+)` annotation in those three rows to `(PR2)` and append a short note line after the §2.3 PR1 note:

```markdown
> **Nota implementazione PR2 (2026-06):** implementati `POST /me/transfers/:code/accept` (cessionario accetta, stato -> `pending_seller_confirmation`, `expiresAt` resettato a +7gg dall'accettazione, BR-043), `POST /me/transfers/:id/confirm` (cedente conferma -> swap atomico della proprieta, stato `completed`) e `POST /me/transfers/:id/reject` (entrambe le parti, finche non `completed`). accept/confirm non hanno body; reject accetta `{ reason?: string }` (max 500). Solo `physical_code`; notifiche ed email differite.
```

- [ ] **Step 4: Commit**

```bash
git add docs/APPENDICE_G_ERROR_CODES.md docs/APPENDICE_A_API.md
git commit -m "docs(api): register transfer transition error codes and endpoints"
```

---

## Task 3: `accept` handler

**Files:**
- Modify: `packages/api/src/routes/v1/me-transfers.ts`
- Test: `packages/api/tests/unit/routes/v1/me-transfers.test.ts`

- [ ] **Step 1: Extend the FakePrisma in the unit test file**

In `packages/api/tests/unit/routes/v1/me-transfers.test.ts`, replace the `FakePrisma` interface and `buildFakePrisma` function with these extended versions (adds `updateMany` on transfers, and the `vehicleOwnership` model the confirm swap needs — used by Tasks 3–5):

```ts
interface FakePrisma {
  vehicle: { findFirst: ReturnType<typeof vi.fn> };
  vehicleTransfer: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(ownedCertifiedVehicle()),
      ...(overrides.vehicle ?? {}),
    },
    vehicleTransfer: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(createdRow()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      ...(overrides.vehicleTransfer ?? {}),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'own-new' }),
      ...(overrides.vehicleOwnership ?? {}),
    },
  };
}
```

Also add a `pendingRow` helper next to `createdRow()` (a row in a given state with a future expiry and a recipient slot), used by the transition tests:

```ts
function pendingRow(over: Partial<ReturnType<typeof createdRow>> & { fromCustomerId?: string; toCustomerId?: string | null } = {}) {
  return {
    ...createdRow(),
    fromCustomerId: CUSTOMER_ID,
    toCustomerId: null,
    vehicleId: VEHICLE_ID,
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing accept tests**

Append to `packages/api/tests/unit/routes/v1/me-transfers.test.ts`:

```ts
describe('POST /v1/me/transfers/:code/accept', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function accept(code: string) {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${code}/accept`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
  }

  it('accepts a pending_recipient transfer initiated by another customer', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(pendingRow({ fromCustomerId: 'seller-x', status: 'pending_recipient' }))
      .mockResolvedValueOnce({ ...createdRow(), status: 'pending_seller_confirmation' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany },
    });
    app = await buildApp(prisma);
    const res = await accept('TR-9K4M-7P2X');
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('pending_seller_confirmation');
    const arg = updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'tr-1', status: 'pending_recipient' });
    expect(arg.data.toCustomerId).toBe(CUSTOMER_ID);
    expect(arg.data.status).toBe('pending_seller_confirmation');
    const daysOut = (arg.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('returns 404 when the code is unknown', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-0000-0000')).statusCode).toBe(404);
  });

  it('returns 403 when the caller initiated the transfer (self-accept)', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(pendingRow({ fromCustomerId: CUSTOMER_ID })),
        findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(403);
  });

  it('returns 409 when the transfer is already completed', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(pendingRow({ fromCustomerId: 'seller-x', status: 'completed' })),
        findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(409);
  });

  it('returns 422 when the transfer is not pending_recipient', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(pendingRow({ fromCustomerId: 'seller-x', status: 'pending_seller_confirmation' })),
        findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(422);
  });

  it('returns 410 when the transfer has expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(
          pendingRow({ fromCustomerId: 'seller-x', status: 'pending_recipient', expiresAt: new Date(Date.now() - 1000) }),
        ),
        findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(410);
  });

  it('returns 422 when the CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(pendingRow({ fromCustomerId: 'seller-x', status: 'pending_recipient' })),
        findMany: vi.fn(), create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    app = await buildApp(prisma);
    expect((await accept('TR-9K4M-7P2X')).statusCode).toBe(422);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts -t accept`
Expected: FAIL (route 404s — handler not registered yet).

- [ ] **Step 4: Implement the accept handler**

In `packages/api/src/routes/v1/me-transfers.ts`, add the import (top, with the other lib imports — needed in Task 4, harmless here):

```ts
import { confirmTransferSwap } from '../../lib/transfer-swap.js';
```

Add a code-param schema next to `idParamSchema`:

```ts
const codeParamSchema = z.object({ code: z.string().min(1) });
```

Add this handler inside `meTransfersRoutes`, after the `GET /v1/me/transfers/:id` handler:

```ts
  // POST /v1/me/transfers/:code/accept — F-CLI-402/403. The recipient
  // accepts by entering the physical code. Sets toCustomerId = caller and
  // advances to pending_seller_confirmation; ownership does NOT move yet
  // (BR-043 step 2). Resets expiresAt so the seller's confirmation window
  // (BR-043: 7gg dall'accettazione) starts now. No request body.
  app.post(
    '/v1/me/transfers/:code/accept',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { code } = codeParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { transferCode: code },
          select: { id: true, fromCustomerId: true, status: true, expiresAt: true },
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        if (row.fromCustomerId === customerId) {
          throw businessError(
            'transfer.acceptance.self_not_allowed',
            403,
            'Non puoi accettare un trasferimento avviato da te.',
          );
        }
        if (row.status === 'completed') {
          throw businessError(
            'transfer.acceptance.already_completed',
            409,
            'Trasferimento gia completato.',
          );
        }
        if (row.status !== 'pending_recipient') {
          throw businessError(
            'transfer.acceptance.not_pending_recipient',
            422,
            'Trasferimento non accettabile in questo stato.',
          );
        }
        if (row.expiresAt.getTime() < Date.now()) {
          throw businessError('transfer.acceptance.expired', 410, 'Trasferimento scaduto.');
        }

        const newExpiry = new Date(Date.now() + TRANSFER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
        const cas = await tx.vehicleTransfer.updateMany({
          where: { id: row.id, status: 'pending_recipient' },
          data: {
            toCustomerId: customerId,
            status: 'pending_seller_confirmation',
            expiresAt: newExpiry,
          },
        });
        if (cas.count === 0) {
          // Lost the race to another acceptor / a reject.
          throw businessError(
            'transfer.acceptance.not_pending_recipient',
            422,
            'Trasferimento non accettabile in questo stato.',
          );
        }

        const updated = await tx.vehicleTransfer.findFirst({
          where: { id: row.id },
          select: TRANSFER_SELECT,
        });
        // TODO(F-CLI-notifications): notify the seller that the recipient
        // accepted (ownership_transfer push/email), post-commit.
        return { transfer: serializeTransfer(updated!) };
      });
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: PASS (PR1 tests + 7 new accept tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/me-transfers.ts packages/api/tests/unit/routes/v1/me-transfers.test.ts
git commit -m "feat(api): POST /me/transfers/:code/accept transition"
```

---

## Task 4: `confirm` handler

**Files:**
- Modify: `packages/api/src/routes/v1/me-transfers.ts`
- Test: `packages/api/tests/unit/routes/v1/me-transfers.test.ts`

- [ ] **Step 1: Write the failing confirm tests**

Append to `packages/api/tests/unit/routes/v1/me-transfers.test.ts`:

```ts
describe('POST /v1/me/transfers/:id/confirm', () => {
  const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function confirm() {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/confirm`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: {},
    });
  }

  // Row at pending_seller_confirmation owned by the caller, recipient set.
  function awaitingConfirm(over: Record<string, unknown> = {}) {
    return {
      id: 'tr-1',
      vehicleId: VEHICLE_ID,
      fromCustomerId: CUSTOMER_ID,
      toCustomerId: 'buyer-1',
      status: 'pending_seller_confirmation',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      ...over,
    };
  }

  it('confirms and swaps ownership', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(awaitingConfirm())
      .mockResolvedValueOnce({ ...createdRow(), status: 'completed', completedAt: new Date() });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    app = await buildApp(prisma);
    const res = await confirm();
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('completed');
    expect(prisma.vehicleOwnership.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleOwnership.create).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the transfer does not exist', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(404);
  });

  it('returns 403 when the caller is not the seller', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ fromCustomerId: 'seller-x' })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(403);
  });

  it('returns 422 when the transfer is not pending_seller_confirmation', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ status: 'pending_recipient' })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(422);
  });

  it('returns 410 when the transfer has expired', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(awaitingConfirm({ expiresAt: new Date(Date.now() - 1000) })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(410);
  });

  it('returns 422 when the swap CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(awaitingConfirm()), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });
    app = await buildApp(prisma);
    expect((await confirm()).statusCode).toBe(422);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts -t confirm`
Expected: FAIL (route 404 — handler not registered).

- [ ] **Step 3: Implement the confirm handler**

In `packages/api/src/routes/v1/me-transfers.ts`, add after the `accept` handler:

```ts
  // POST /v1/me/transfers/:id/confirm — F-CLI-403. The seller confirms after
  // the recipient accepted; this is where ownership actually moves (BR-043
  // step 4) via the atomic confirmTransferSwap. No request body.
  app.post(
    '/v1/me/transfers/:id/confirm',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { id },
          select: {
            id: true,
            vehicleId: true,
            fromCustomerId: true,
            toCustomerId: true,
            status: true,
            expiresAt: true,
          },
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        if (row.fromCustomerId !== customerId) {
          throw businessError(
            'transfer.confirmation.not_from_customer',
            403,
            'Non sei il cedente di questo trasferimento.',
          );
        }
        if (row.status !== 'pending_seller_confirmation' || !row.toCustomerId) {
          throw businessError(
            'transfer.confirmation.not_pending_seller',
            422,
            'Trasferimento non in attesa di conferma del cedente.',
          );
        }
        if (row.expiresAt.getTime() < Date.now()) {
          throw businessError('transfer.confirmation.expired', 410, 'Trasferimento scaduto.');
        }

        await confirmTransferSwap(tx, {
          transferId: row.id,
          vehicleId: row.vehicleId,
          fromCustomerId: customerId,
          toCustomerId: row.toCustomerId,
          now: new Date(),
        });

        const updated = await tx.vehicleTransfer.findFirst({
          where: { id: row.id },
          select: TRANSFER_SELECT,
        });
        // TODO(F-CLI-notifications): notify the recipient that ownership
        // transferred (ownership_transfer push/email), post-commit.
        return { transfer: serializeTransfer(updated!) };
      });
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: PASS (all prior + 6 new confirm tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-transfers.ts packages/api/tests/unit/routes/v1/me-transfers.test.ts
git commit -m "feat(api): POST /me/transfers/:id/confirm with atomic swap"
```

---

## Task 5: `reject` handler

**Files:**
- Modify: `packages/api/src/routes/v1/me-transfers.ts`
- Test: `packages/api/tests/unit/routes/v1/me-transfers.test.ts`

- [ ] **Step 1: Write the failing reject tests**

Append to `packages/api/tests/unit/routes/v1/me-transfers.test.ts`:

```ts
describe('POST /v1/me/transfers/:id/reject', () => {
  const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function reject(payload: unknown = {}) {
    return app!.inject({
      method: 'POST',
      url: `/v1/me/transfers/${TRANSFER_ID}/reject`,
      headers: { authorization: 'Bearer valid.jwt' },
      payload: payload as never,
    });
  }

  function rejectable(over: Record<string, unknown> = {}) {
    return {
      id: 'tr-1',
      fromCustomerId: CUSTOMER_ID,
      toCustomerId: null,
      status: 'pending_recipient',
      ...over,
    };
  }

  it('lets the seller reject and stores the reason', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(rejectable())
      .mockResolvedValueOnce({ ...createdRow(), status: 'rejected', rejectedReason: 'cambiato idea' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany },
    });
    app = await buildApp(prisma);
    const res = await reject({ reason: 'cambiato idea' });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('rejected');
    expect(updateMany.mock.calls[0]![0].data.rejectedReason).toBe('cambiato idea');
  });

  it('lets the recipient reject (no reason)', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(rejectable({ fromCustomerId: 'seller-x', toCustomerId: CUSTOMER_ID, status: 'pending_seller_confirmation' }))
      .mockResolvedValueOnce({ ...createdRow(), status: 'rejected' });
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(200);
  });

  it('returns 404 when the transfer does not exist', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(404);
  });

  it('returns 403 when the caller is neither party', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(rejectable({ fromCustomerId: 'seller-x', toCustomerId: 'buyer-y' })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(403);
  });

  it('returns 409 when the transfer is already terminal', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(rejectable({ status: 'completed' })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(409);
  });

  it('returns 409 when the CAS loses the race', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(rejectable()), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });
    app = await buildApp(prisma);
    expect((await reject()).statusCode).toBe(409);
  });

  it('rejects an unknown body field with 400', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(rejectable()), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    });
    app = await buildApp(prisma);
    expect((await reject({ foo: 'bar' })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts -t reject`
Expected: FAIL (route 404 — handler not registered).

- [ ] **Step 3: Implement the reject handler**

In `packages/api/src/routes/v1/me-transfers.ts`, add a body schema next to `codeParamSchema`:

```ts
const rejectBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
```

Add this handler after the `confirm` handler:

```ts
  // POST /v1/me/transfers/:id/reject — F-CLI-403 / BR-048. Either party may
  // reject while the transfer is still active (seller cancels, or recipient
  // declines). Optional free-text reason. No ownership change.
  app.post(
    '/v1/me/transfers/:id/reject',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const { reason } = rejectBodySchema.parse(request.body ?? {});
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { id },
          select: { id: true, fromCustomerId: true, toCustomerId: true, status: true },
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        if (row.fromCustomerId !== customerId && row.toCustomerId !== customerId) {
          throw businessError(
            'transfer.rejection.not_permitted',
            403,
            'Non puoi rifiutare questo trasferimento.',
          );
        }
        if (!(ACTIVE_TRANSFER_STATUSES as readonly string[]).includes(row.status)) {
          throw businessError(
            'transfer.rejection.not_pending',
            409,
            'Trasferimento gia in stato terminale.',
          );
        }

        const cas = await tx.vehicleTransfer.updateMany({
          where: { id: row.id, status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
          data: { status: 'rejected', rejectedReason: reason ?? null },
        });
        if (cas.count === 0) {
          throw businessError(
            'transfer.rejection.not_pending',
            409,
            'Trasferimento gia in stato terminale.',
          );
        }

        const updated = await tx.vehicleTransfer.findFirst({
          where: { id: row.id },
          select: TRANSFER_SELECT,
        });
        return { transfer: serializeTransfer(updated!) };
      });
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: PASS (all prior + 7 new reject tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-transfers.ts packages/api/tests/unit/routes/v1/me-transfers.test.ts
git commit -m "feat(api): POST /me/transfers/:id/reject transition"
```

---

## Task 6: Integration tests (full flow + F-CLI-405 + concurrency)

**Files:**
- Modify: `packages/api/tests/integration/helpers.ts`
- Create: `packages/api/tests/integration/me-transfers-transitions.test.ts`

- [ ] **Step 1: Add integration helpers**

In `packages/api/tests/integration/helpers.ts`, add these three exported helpers (place after `createOwnership`). They use the existing `pgAdmin` client and `randomUUID` already imported at the top of the file:

```ts
// Direct insert of a vehicle_transfers row (bypasses RLS). Enum columns
// require explicit casts (see createVehicle). Defaults to a seller-initiated
// physical-code transfer with a 7-day future expiry.
export async function createTransfer(params: {
  vehicleId: string;
  fromCustomerId: string;
  toCustomerId?: string | null;
  status: 'pending_recipient' | 'pending_seller_confirmation' | 'pending_validation' | 'completed' | 'rejected' | 'expired';
  method?: 'initiated_by_seller' | 'claim_without_seller' | 'officina_mediated';
  transferCode?: string | null;
  expiresAt?: Date;
}): Promise<{ transferId: string; transferCode: string | null }> {
  const {
    vehicleId,
    fromCustomerId,
    toCustomerId = null,
    status,
    method = 'initiated_by_seller',
    transferCode = `TR-TST-${randomUUID().slice(0, 5).toUpperCase()}`,
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO vehicle_transfers
       (id, vehicle_id, from_customer_id, to_customer_id, transfer_code,
        method, status, expires_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4,
        $5::"TransferMethod", $6::"TransferStatus", $7, NOW(), NOW())
     RETURNING id`,
    [vehicleId, fromCustomerId, toCustomerId, transferCode, method, status, expiresAt],
  );
  return { transferId: rows[0]!.id, transferCode };
}

// Customer id of the single active (ended_at IS NULL) ownership, or null.
export async function getActiveOwnerCustomerId(vehicleId: string): Promise<string | null> {
  const { rows } = await pgAdmin.query<{ customer_id: string }>(
    `SELECT customer_id FROM vehicle_ownerships WHERE vehicle_id = $1 AND ended_at IS NULL`,
    [vehicleId],
  );
  return rows[0]?.customer_id ?? null;
}

export async function getTransferById(
  transferId: string,
): Promise<{ status: string; toCustomerId: string | null; completedAt: Date | null } | null> {
  const { rows } = await pgAdmin.query<{ status: string; to_customer_id: string | null; completed_at: Date | null }>(
    `SELECT status, to_customer_id, completed_at FROM vehicle_transfers WHERE id = $1`,
    [transferId],
  );
  const r = rows[0];
  return r ? { status: r.status, toCustomerId: r.to_customer_id, completedAt: r.completed_at } : null;
}
```

- [ ] **Step 2: Write the integration test file**

Create `packages/api/tests/integration/me-transfers-transitions.test.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createPrivateIntervention,
  createTenantWithLocation,
  createTransfer,
  createVehicle,
  getActiveOwnerCustomerId,
  getTransferById,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-401 PR2 — accept / confirm / reject transitions + atomic swap.
describe('Customer transfer transitions (F-CLI-401 PR2)', () => {
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

  async function makeCustomer() {
    const sub = `c-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, token };
  }

  async function certifiedVehicleOwnedBy(customerId: string) {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    return { vehicleId };
  }

  function post(token: string, url: string, payload?: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: (payload ?? {}) as never,
    });
  }

  it('runs the full happy path: accept -> confirm -> ownership moves', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);

    const created = await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' });
    expect(created.statusCode).toBe(201);
    const { id: transferId, transferCode } = created.json();

    const accepted = await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().transfer.status).toBe('pending_seller_confirmation');
    // Ownership has NOT moved yet.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);

    const confirmed = await post(seller.token, `/v1/me/transfers/${transferId}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().transfer.status).toBe('completed');

    // Ownership has moved to the buyer; the transfer row is completed.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);
    const dbRow = await getTransferById(transferId);
    expect(dbRow?.status).toBe('completed');
    expect(dbRow?.completedAt).not.toBeNull();

    // The buyer now sees the vehicle in their list.
    const buyerList = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(buyerList.json().data.map((v: { id: string }) => v.id)).toContain(vehicleId);
  });

  it('blocks the seller from accepting their own transfer (403)', async () => {
    const seller = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const created = await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' });
    const { transferCode } = created.json();
    expect((await post(seller.token, `/v1/me/transfers/${transferCode}/accept`)).statusCode).toBe(403);
  });

  it('rejects acceptance of an expired transfer (410)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferCode } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`)).statusCode).toBe(410);
  });

  it('rejects confirmation after expiry (410)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await post(seller.token, `/v1/me/transfers/${transferId}/confirm`)).statusCode).toBe(410);
    // Ownership untouched.
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);
  });

  it('lets the recipient reject after accepting', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
    });
    const res = await post(buyer.token, `/v1/me/transfers/${transferId}/reject`, { reason: 'non piu interessato' });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.status).toBe('rejected');
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(seller.customerId);
  });

  it('lets the seller cancel a pending transfer (BR-048)', async () => {
    const seller = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const created = await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' });
    const { id: transferId } = created.json();
    expect((await post(seller.token, `/v1/me/transfers/${transferId}/reject`)).statusCode).toBe(200);
    // A new transfer can now be initiated (the active slot is free).
    expect((await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' })).statusCode).toBe(201);
  });

  it('hides the seller private interventions from the new owner (F-CLI-405)', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    await createPrivateIntervention({
      customerId: seller.customerId,
      vehicleId,
      interventionDate: '2026-01-15',
      description: 'Segreto del cedente',
    });

    const created = await post(seller.token, '/v1/me/transfers', { vehicleId, method: 'physical_code' });
    const { id: transferId, transferCode } = created.json();
    await post(buyer.token, `/v1/me/transfers/${transferCode}/accept`);
    await post(seller.token, `/v1/me/transfers/${transferId}/confirm`);
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);

    // New owner lists private interventions for the vehicle: none of the
    // seller's are visible (private_interventions RLS is customer-scoped).
    const buyerView = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/private-interventions`,
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(buyerView.statusCode).toBe(200);
    expect(buyerView.json().data).toHaveLength(0);
  });

  it('completes exactly one swap under concurrent double-confirm', async () => {
    const seller = await makeCustomer();
    const buyer = await makeCustomer();
    const { vehicleId } = await certifiedVehicleOwnedBy(seller.customerId);
    const { transferId } = await createTransfer({
      vehicleId,
      fromCustomerId: seller.customerId,
      toCustomerId: buyer.customerId,
      status: 'pending_seller_confirmation',
    });

    const [a, b] = await Promise.all([
      post(seller.token, `/v1/me/transfers/${transferId}/confirm`),
      post(seller.token, `/v1/me/transfers/${transferId}/confirm`),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    // Exactly one 200; the loser gets a clean 4xx (422 lost-CAS).
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);
    expect(await getActiveOwnerCustomerId(vehicleId)).toBe(buyer.customerId);
  });
});
```

- [ ] **Step 3: Run the integration tests (only if reproducing CI; Docker-heavy)**

Per CLAUDE.md, integration tests run on CI by default. To run locally only when needed:
Run: `pnpm --filter @garageos/api exec vitest run -c vitest.integration.config.ts me-transfers-transitions`
Expected: PASS (8 tests). If skipping locally, rely on CI.

- [ ] **Step 4: Commit**

```bash
git add packages/api/tests/integration/helpers.ts packages/api/tests/integration/me-transfers-transitions.test.ts
git commit -m "test(api): integration tests for transfer transitions and swap"
```

---

## Task 7: Final checks, push, PR

- [ ] **Step 1: Typecheck (mandatory local gate)**

Run: `pnpm -r typecheck`
Expected: clean across all workspaces.

- [ ] **Step 2: Targeted unit run (route handler changed — typecheck does not catch broken FakePrisma)**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts tests/unit/lib/transfer-swap.test.ts`
Expected: PASS.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/cli-401-pr2-transfer-transitions
gh pr create --title "feat(api): customer transfer transitions accept/confirm/reject (F-CLI-401 PR2)" --body "<fill from PR template: What/Why/Tests/Checklist; cite F-CLI-402/403/405, BR-043/045/047/048>"
```

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on any failure.

---

## Self-review notes (author)

- **Spec coverage:** accept (§5 accept table) → Task 3; confirm + swap (§3, §5 confirm) → Tasks 1+4; reject (§5 reject) → Task 5; expiresAt reset (§4) → Task 3 (asserted in unit + integration); F-CLI-405 (§6) → Task 6; error codes (§5) → Task 2; deferred notifications (§7) → `TODO` markers in Tasks 3–4.
- **Type consistency:** `confirmTransferSwap(tx, ConfirmSwapInput)` defined in Task 1, imported/called identically in Task 4. `ACTIVE_TRANSFER_STATUSES`, `idParamSchema`, `TRANSFER_SELECT`, `serializeTransfer`, `businessError` are all pre-existing in `me-transfers.ts` / its imports.
- **No placeholders** except the PR body in Task 7 Step 3 (intentional — filled at PR time from the template).
- **Empty-body POSTs:** accept/confirm send no semantic body; integration + unit calls pass `payload: {}` (valid JSON) to avoid Fastify's empty-JSON-body 400 (the #104 lesson). PR4's mobile client must POST a JSON body (`{}`) for accept/confirm.
```

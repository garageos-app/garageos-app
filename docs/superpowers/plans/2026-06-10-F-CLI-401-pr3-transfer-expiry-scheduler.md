# F-CLI-401 PR3 — Transfer Expiry Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere un job periodico giornaliero che porta a `status='expired'` i `VehicleTransfer` rimasti in `pending_recipient`/`pending_seller_confirmation` oltre `expiresAt`, lasciando il veicolo al cedente (BR-043), più l'hardening del confirm-CAS dal final review di PR2.

**Architecture:** Trigger ricorrente CDK (`CfnSchedule` singleton giornaliero, mirror di `WarmingSchedule`) → payload top-level `{source:'transfer-expiry'}` → nuovo guard `withTransferExpiryGuard` (mirror di `withWarmingGuard`) → handler `processTransferExpiry` che esegue un singolo `updateMany` set-based sotto `role:'admin'`. Lo sweep tocca solo `vehicle_transfers` (lock graph a un nodo); l'ownership resta al cedente.

**Tech Stack:** Fastify + TypeScript + Prisma + Vitest (api); AWS CDK + aws-scheduler (infra). Nessuna migration, nessuna nuova dipendenza, nessun nuovo error code.

---

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `packages/api/src/lib/transfer-swap.ts` | modificato | Hardening confirm-CAS: `expiresAt:{gt:now}` + re-read→410 |
| `packages/api/tests/unit/lib/transfer-swap.test.ts` | modificato | Aggiorna assert CAS + nuovi casi expired/race |
| `packages/api/src/lib/transfers/expire-transfers.ts` | nuovo | `processTransferExpiry` (sweep set-based) |
| `packages/api/tests/unit/lib/transfers/expire-transfers.test.ts` | nuovo | Unit FakePrisma dello sweep |
| `packages/api/src/lambda-transfer-expiry.ts` | nuovo | `withTransferExpiryGuard` + tipo handler |
| `packages/api/tests/unit/lambda-transfer-expiry.test.ts` | nuovo | Unit del routing del guard |
| `packages/api/src/index.ts` | modificato | Inserimento guard nella catena Lambda |
| `infrastructure/lib/constructs/scheduler.ts` | modificato | + `TransferExpirySchedule` CfnSchedule |
| `packages/api/tests/integration/transfer-expiry.test.ts` | nuovo | Integration Postgres reale dello sweep |

**Nota di esecuzione:** i test api girano con **Vitest** (non Jest). `pnpm --filter @garageos/api test:unit` per gli unit; gli integration (`test:integration`) girano **solo su CI** (Docker, vedi CLAUDE.md — non eseguirli localmente). `pnpm -r typecheck` è il gate pre-push.

---

## Task 1: Hardening confirm-CAS (expiresAt guard + re-read→410)

**Files:**
- Modify: `packages/api/src/lib/transfer-swap.ts:36-54`
- Test: `packages/api/tests/unit/lib/transfer-swap.test.ts`

Lo step-1 CAS di `confirmTransferSwap` oggi guarda solo `status:'pending_seller_confirmation'`. Aggiungiamo `expiresAt:{gt:now}` per chiudere la finestra read→swap, e sul fallimento (`count===0`) distinguiamo scadenza (410) da race concorrente (422) con un re-read.

- [ ] **Step 1: Aggiorna i test esistenti del CAS + aggiungi i nuovi casi**

Il `fakeTx` esistente non espone `findFirst`; serve per il ramo di re-read. Sostituisci l'helper e i casi interessati così (il resto del file resta invariato):

```ts
// Minimal fake transaction client: only the methods confirmTransferSwap touches.
function fakeTx(
  overrides: {
    transferUpdateCount?: number;
    ownershipUpdateCount?: number;
    ownershipCreate?: ReturnType<typeof vi.fn>;
    // Row returned by the re-read on a failed CAS. Default: a still-pending,
    // not-yet-expired row → the failure is a concurrent-confirm race (422).
    transferFindFirst?: { status: string; expiresAt: Date } | null;
  } = {},
) {
  return {
    vehicleTransfer: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.transferUpdateCount ?? 1 }),
      findFirst: vi.fn().mockResolvedValue(
        overrides.transferFindFirst === undefined
          ? { status: 'pending_seller_confirmation', expiresAt: new Date(NOW.getTime() + 60_000) }
          : overrides.transferFindFirst,
      ),
    },
    vehicleOwnership: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.ownershipUpdateCount ?? 1 }),
      create: overrides.ownershipCreate ?? vi.fn().mockResolvedValue({ id: 'own-new' }),
    },
  };
}
```

Aggiorna l'assert del CAS happy-path (il `where` ora include `expiresAt`):

```ts
  it('CAS-flips the transfer, closes the old ownership, opens the new one', async () => {
    const tx = fakeTx();
    await confirmTransferSwap(tx as never, INPUT);

    expect(tx.vehicleTransfer.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'tr-1', status: 'pending_seller_confirmation', expiresAt: { gt: NOW } },
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
```

Il caso race esistente resta valido (default findFirst = still-pending → 422). Aggiungi due casi nuovi:

```ts
  it('throws confirmation.expired (410) when the CAS fails because the row is expired by status', async () => {
    const tx = fakeTx({ transferUpdateCount: 0, transferFindFirst: { status: 'expired', expiresAt: new Date(NOW.getTime() + 60_000) } });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.expired',
      statusCode: 410,
    });
    expect(tx.vehicleOwnership.updateMany).not.toHaveBeenCalled();
  });

  it('throws confirmation.expired (410) when the CAS fails because expiresAt has passed', async () => {
    const tx = fakeTx({ transferUpdateCount: 0, transferFindFirst: { status: 'pending_seller_confirmation', expiresAt: new Date(NOW.getTime() - 1) } });
    await expect(confirmTransferSwap(tx as never, INPUT)).rejects.toMatchObject({
      name: 'transfer.confirmation.expired',
      statusCode: 410,
    });
  });
```

- [ ] **Step 2: Esegui i test per vederli fallire**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-swap.test.ts`
Expected: FAIL — il CAS non include `expiresAt`, il re-read non esiste (i due nuovi casi ottengono 422 invece di 410; l'happy-path fallisce sull'assert `where`).

- [ ] **Step 3: Implementa l'hardening in `confirmTransferSwap`**

Sostituisci lo step-1 CAS (`transfer-swap.ts:42-54`) con:

```ts
  // Step 1: CAS the transfer to completed. Leaving pending_seller_confirmation
  // also drops the row out of the uq_transfer_vehicle_active predicate,
  // freeing the BR-047 active-transfer slot. The expiresAt:{gt:now} guard
  // closes the sub-ms window between the route's read-guard (me-transfers.ts:308)
  // and this swap: a row that expired in between (or was flipped to 'expired'
  // by the PR3 sweep) fails the CAS. See F-CLI-401 PR3 spec.
  const cas = await tx.vehicleTransfer.updateMany({
    where: { id: transferId, status: 'pending_seller_confirmation', expiresAt: { gt: now } },
    data: { status: 'completed', completedAt: now },
  });
  if (cas.count === 0) {
    // Distinguish expiry-in-between (410) from a concurrent-confirm race (422)
    // via a light re-read on the (rare) failure branch.
    const current = await tx.vehicleTransfer.findFirst({
      where: { id: transferId },
      select: { status: true, expiresAt: true },
    });
    if (current && (current.status === 'expired' || current.expiresAt.getTime() <= now.getTime())) {
      throw businessError('transfer.confirmation.expired', 410, 'Trasferimento scaduto.');
    }
    // The caller already verified the row exists, so count === 0 here means a
    // concurrent confirm won the race and already advanced the status.
    throw businessError(
      'transfer.confirmation.not_pending_seller',
      422,
      'Trasferimento non in attesa di conferma del cedente.',
    );
  }
```

- [ ] **Step 4: Esegui i test per vederli passare**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-swap.test.ts`
Expected: PASS (tutti i casi, vecchi e nuovi).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/transfer-swap.ts packages/api/tests/unit/lib/transfer-swap.test.ts
git commit -m "fix(api): harden transfer confirm CAS against expiry race"
```

---

## Task 2: Sweep handler `processTransferExpiry`

**Files:**
- Create: `packages/api/src/lib/transfers/expire-transfers.ts`
- Test: `packages/api/tests/unit/lib/transfers/expire-transfers.test.ts`

Handler che esegue un singolo `updateMany` set-based sotto `role:'admin'`.

- [ ] **Step 1: Scrivi il test fallente**

```ts
import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@garageos/database';

import type { AppLike } from '../../../../src/lib/transfers/expire-transfers.js';
import { processTransferExpiry } from '../../../../src/lib/transfers/expire-transfers.js';

interface FakePrisma {
  vehicleTransfer: { updateMany: ReturnType<typeof vi.fn> };
}

function asPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

function makeFakeApp(fake: FakePrisma): AppLike & { _ctx: unknown } {
  const captured: { ctx?: unknown } = {};
  return {
    _ctx: captured,
    withContext: vi
      .fn()
      .mockImplementation(
        async (ctx: unknown, fn: (tx: PrismaClient) => Promise<unknown>) => {
          captured.ctx = ctx;
          return fn(asPrisma(fake));
        },
      ),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as AppLike['log'],
  } as AppLike & { _ctx: unknown };
}

describe('processTransferExpiry', () => {
  it('sweeps pending_recipient/pending_seller_confirmation past expiresAt to expired under role admin', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    };
    const app = makeFakeApp(fake);

    const result = await processTransferExpiry({ app });

    expect(result).toEqual({ sweptCount: 3 });
    // Runs cross-tenant under role admin (no JWT).
    expect((app._ctx as { ctx: unknown }).ctx).toEqual({ role: 'admin' });

    const arg = fake.vehicleTransfer.updateMany.mock.calls[0]![0];
    expect(arg.where.status).toEqual({ in: ['pending_recipient', 'pending_seller_confirmation'] });
    expect(arg.where.expiresAt).toHaveProperty('lt');
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
    // pending_validation (F-CLI-404 / BR-044) is intentionally excluded.
    expect(arg.where.status.in).not.toContain('pending_validation');
    expect(arg.data).toEqual({ status: 'expired' });
  });

  it('returns sweptCount 0 when nothing is expired (idempotent re-run)', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const result = await processTransferExpiry({ app: makeFakeApp(fake) });
    expect(result).toEqual({ sweptCount: 0 });
  });

  it('logs the swept count', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const app = makeFakeApp(fake);
    await processTransferExpiry({ app });
    expect(app.log.info).toHaveBeenCalledWith({ transferExpiry: { sweptCount: 2 } });
  });

  it('propagates a database error (so EventBridge retries)', async () => {
    const boom = new Error('db down');
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockRejectedValue(boom) },
    };
    await expect(processTransferExpiry({ app: makeFakeApp(fake) })).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Esegui il test per vederlo fallire**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfers/expire-transfers.test.ts`
Expected: FAIL — il modulo non esiste ancora.

- [ ] **Step 3: Implementa l'handler**

Crea `packages/api/src/lib/transfers/expire-transfers.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';

import type { PrismaClient } from '@garageos/database';

// Minimal structural subset of FastifyInstance consumed by the sweep — kept
// local (not imported from the deadlines scheduler) so the transfers module
// has no dependency on the deadlines module. Mirrors the AppLike rationale in
// lib/deadlines/scheduler-invocation.ts.
export interface AppLike {
  withContext: <T>(
    ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
  log: FastifyBaseLogger;
}

export interface TransferExpiryResult {
  sweptCount: number;
}

// processTransferExpiry — the daily housekeeping sweep (F-CLI-401 PR3).
//
// Flips every VehicleTransfer still in pending_recipient or
// pending_seller_confirmation past its expiresAt to status='expired'
// (BR-043 timeout: the vehicle stays with the seller). pending_validation
// (F-CLI-404 / BR-044) is intentionally excluded — its timeout means the
// opposite (no response => approved).
//
// The sweep touches ONLY vehicle_transfers: leaving pending_* drops the row
// out of the uq_transfer_vehicle_active predicate, freeing the BR-047 slot.
// vehicle_ownerships is untouched (the vehicle stays with the seller).
//
// Cross-tenant under role:'admin' (the EventBridge invocation carries no JWT;
// an empty ctx would silently deny the RLS write — see
// feedback_withcontext_empty_blocks_rls_writes). Idempotent: the status IN
// (pending_*) predicate makes a re-run a no-op (count 0). Never swallows a DB
// error — it propagates so the Lambda returns non-2xx and EventBridge retries.
export async function processTransferExpiry(input: {
  app: AppLike;
}): Promise<TransferExpiryResult> {
  const { app } = input;
  return app.withContext({ role: 'admin' }, async (tx) => {
    const now = new Date();
    const result = await tx.vehicleTransfer.updateMany({
      where: {
        status: { in: ['pending_recipient', 'pending_seller_confirmation'] },
        expiresAt: { lt: now },
      },
      data: { status: 'expired' },
    });
    app.log.info({ transferExpiry: { sweptCount: result.count } });
    // TODO(F-CLI-notifications): notify both parties that the transfer expired
    // (ownership_transfer push/email) once the notifications arc lands.
    return { sweptCount: result.count };
  });
}
```

- [ ] **Step 4: Esegui il test per vederlo passare**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfers/expire-transfers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/transfers/expire-transfers.ts packages/api/tests/unit/lib/transfers/expire-transfers.test.ts
git commit -m "feat(api): add transfer expiry sweep handler"
```

---

## Task 3: Routing guard `withTransferExpiryGuard`

**Files:**
- Create: `packages/api/src/lambda-transfer-expiry.ts`
- Test: `packages/api/tests/unit/lambda-transfer-expiry.test.ts`

Higher-order guard che short-circuita gli eventi `{source:'transfer-expiry'}` prima dell'adapter Fastify, mirror esatto di `withWarmingGuard`.

- [ ] **Step 1: Scrivi il test fallente**

```ts
import { describe, expect, it, vi } from 'vitest';

import { withTransferExpiryGuard } from '../../src/lambda-transfer-expiry.js';

describe('withTransferExpiryGuard', () => {
  it('routes {source:"transfer-expiry"} to the handler and not to inner', async () => {
    const handler = vi.fn().mockResolvedValue({ sweptCount: 5 });
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withTransferExpiryGuard(inner, handler);

    const result = await wrapped({ source: 'transfer-expiry' }, {}, undefined);

    expect(result).toEqual({ sweptCount: 5 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes APIGW requests through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = withTransferExpiryGuard(inner, handler);

    const event = { requestContext: { http: { method: 'GET' } }, rawPath: '/health' };
    await wrapped(event, {}, undefined);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes warming and deadline-scheduler events through to inner', async () => {
    const handler = vi.fn();
    const inner = vi.fn().mockResolvedValue('inner');
    const wrapped = withTransferExpiryGuard(inner, handler);

    await wrapped({ source: 'warming' }, {}, undefined);
    await wrapped({ source: 'aws.scheduler', detail: { deadlineNotificationId: 'd', reminderType: 't_minus_30' } }, {}, undefined);

    expect(handler).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Esegui il test per vederlo fallire**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lambda-transfer-expiry.test.ts`
Expected: FAIL — il modulo non esiste.

- [ ] **Step 3: Implementa il guard**

Crea `packages/api/src/lambda-transfer-expiry.ts`:

```ts
import type { LambdaHandler } from './lambda-warming.js';
import type { TransferExpiryResult } from './lib/transfers/expire-transfers.js';

export type TransferExpiryHandler = () => Promise<TransferExpiryResult>;

// Short-circuit EventBridge Scheduler invocations carrying the daily
// transfer-expiry payload before they reach the @fastify/aws-lambda adapter
// (which assumes APIGW v2 event shape and would crash on a non-APIGW event).
// Pattern mirrors withWarmingGuard: the schedule's `input` JSON IS the event,
// so we match a top-level `source: 'transfer-expiry'`. That value is disjoint
// from 'warming' (withWarmingGuard) and 'aws.scheduler' (withSchedulerGuard),
// so the three guards never collide.
//
// Wrapping order in the Lambda entry (outermost to innermost):
//   withWarmingGuard(withTransferExpiryGuard(withSchedulerGuard(...)(adapter), handler), warmup)
export function withTransferExpiryGuard(
  inner: LambdaHandler,
  handler: TransferExpiryHandler,
): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'transfer-expiry'
    ) {
      return handler();
    }
    return inner(event, context, callback);
  };
}
```

- [ ] **Step 4: Esegui il test per vederlo passare**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lambda-transfer-expiry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lambda-transfer-expiry.ts packages/api/tests/unit/lambda-transfer-expiry.test.ts
git commit -m "feat(api): add transfer-expiry lambda routing guard"
```

---

## Task 4: Wire the guard into the Lambda entry

**Files:**
- Modify: `packages/api/src/index.ts:1-8,34-51`

Nessun unit test diretto su `index.ts` (boot module); la verifica è il `typecheck` + il wiring corretto.

- [ ] **Step 1: Aggiungi gli import**

In testa a `packages/api/src/index.ts`, dopo gli import esistenti dei guard, aggiungi:

```ts
import { withTransferExpiryGuard } from './lambda-transfer-expiry.js';
import { processTransferExpiry } from './lib/transfers/expire-transfers.js';
```

- [ ] **Step 2: Aggiungi l'handler e inserisci il guard nella catena**

Dopo la definizione di `schedulerHandler` (intorno a `index.ts:38`), aggiungi:

```ts
const transferExpiryHandler = (): ReturnType<typeof processTransferExpiry> =>
  processTransferExpiry({
    app: { withContext: app.withContext.bind(app), log: app.log },
  });
```

Poi sostituisci la composizione `innerHandler` (`index.ts:48-51`) con:

```ts
const innerHandler = withWarmingGuard(
  withTransferExpiryGuard(
    withSchedulerGuard(schedulerHandler)(awsLambdaFastify(app)),
    transferExpiryHandler,
  ),
  warmup,
);
```

- [ ] **Step 3: Verifica il typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (nessun errore di tipo; `transferExpiryHandler` ritorna `Promise<TransferExpiryResult>`, compatibile con `TransferExpiryHandler`).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): wire transfer-expiry guard into lambda entry"
```

---

## Task 5: CDK recurring schedule `TransferExpirySchedule`

**Files:**
- Modify: `infrastructure/lib/constructs/scheduler.ts`

Nuova `CfnSchedule` singleton giornaliera, mirror di `WarmingSchedule`. Riusa `SchedulerRole` (già concede `lambda:InvokeFunction`) e il flag `warmingEnabled` (gate ambiente). Nome costante interno — nessuna nuova prop, nessuna modifica a `main-stack.ts`/`config`.

- [ ] **Step 1: Aggiungi il campo pubblico al construct**

In `infrastructure/lib/constructs/scheduler.ts`, nella class `SchedulerConstruct`, accanto a `public readonly warmingSchedule`, aggiungi:

```ts
  public readonly transferExpirySchedule: scheduler.CfnSchedule;
```

- [ ] **Step 2: Crea la CfnSchedule dopo `this.warmingSchedule`**

Subito dopo il blocco `this.warmingSchedule = new scheduler.CfnSchedule(...)` (fine costruttore), aggiungi:

```ts
    // Daily housekeeping sweep that flips expired pending transfers to
    // 'expired' (F-CLI-401 PR3, BR-043). Recurring singleton mirroring
    // WarmingSchedule — NOT the per-row one-shot pattern used for deadline
    // reminders. Lives in the 'default' group; the garageos-deadlines group
    // stays reserved for runtime-created deadline schedules. Gated by the same
    // warmingEnabled env flag (the single "schedules active in this env"
    // switch). UTC (not Europe/Rome) — it is timezone-indifferent night work
    // and UTC avoids DST edge cases. Retries are safe because the sweep is
    // idempotent (the status IN (pending_*) predicate no-ops on re-run).
    this.transferExpirySchedule = new scheduler.CfnSchedule(this, 'TransferExpirySchedule', {
      name: 'garageos-transfer-expiry',
      groupName: 'default',
      description: 'Daily sweep: expire pending vehicle transfers past their 7-day window (BR-043)',
      state: props.warmingEnabled ? 'ENABLED' : 'DISABLED',
      scheduleExpression: 'cron(0 3 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: JSON.stringify({ source: 'transfer-expiry' }),
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
      },
    });
```

- [ ] **Step 3: Verifica il typecheck infra**

Run: `pnpm --filter @garageos/infrastructure typecheck`
Expected: PASS.

> NON eseguire `pnpm --filter @garageos/infrastructure test:unit` localmente (bundla il Lambda 3× via esbuild e congela Windows — vedi CLAUDE.md). Il `cdk-synth` su CI è il gate che valida la nuova CfnSchedule.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/lib/constructs/scheduler.ts
git commit -m "feat(infra): add daily transfer-expiry CfnSchedule"
```

---

## Task 6: Integration test (sweep end-to-end su Postgres reale)

**Files:**
- Create: `packages/api/tests/integration/transfer-expiry.test.ts`

Verifica lo sweep contro Postgres reale: flip degli stati corretti, esclusione di `pending_validation`, slot BR-047 liberato, ownership invariata. Usa gli helper esistenti `createTransfer` / `getTransferById` (`tests/integration/helpers.ts`).

> Pre-flight per l'implementer: apri `tests/integration/me-transfers-transitions.test.ts` e `tests/integration/helpers.ts` per la forma esatta del setup (bootstrap tenant/customer/vehicle, firma di `createCustomer`/`createVehicle`/`createTransfer`/`getTransferById`, helper di context). Il blocco sotto mostra la struttura; allinea i nomi degli helper a quelli realmente esportati.

- [ ] **Step 1: Scrivi il test di integrazione**

```ts
import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '@garageos/database';

import { processTransferExpiry } from '../../src/lib/transfers/expire-transfers.js';
import {
  createCustomer,
  createVehicle,
  createTransfer,
  getTransferById,
  // ...altri helper di bootstrap/context come usati in me-transfers-transitions.test.ts
} from './helpers.js';
import { app, withAdmin } from './setup.js'; // allinea agli export reali di setup.ts

// Minimal AppLike backed by the integration app's withContext, so the sweep
// runs against the real Postgres pool under role:'admin'.
function realApp(): { withContext: typeof app.withContext; log: typeof app.log } {
  return { withContext: app.withContext.bind(app), log: app.log };
}

describe('processTransferExpiry (integration)', () => {
  it('flips expired pending transfers, frees the BR-047 slot, leaves ownership untouched', async () => {
    // Bootstrap: seller customer + certified vehicle owned by the seller.
    const seller = await createCustomer({ /* ...as in transitions suite... */ });
    const buyer = await createCustomer({ /* ... */ });
    const { vehicleId } = await createVehicle({ /* owned by seller, status: 'certified' */ });

    const past = new Date(Date.now() - 60_000);

    // 1) pending_recipient, expired
    const a = await createTransfer({
      vehicleId,
      fromCustomerId: seller.id,
      status: 'pending_recipient',
      expiresAt: past,
    });
    // (close it via the sweep before seeding b/c BR-047 allows one active row)

    const result1 = await processTransferExpiry({ app: realApp() });
    expect(result1.sweptCount).toBeGreaterThanOrEqual(1);
    expect((await getTransferById(a.transferId))?.status).toBe('expired');

    // After expiry the uq_transfer_vehicle_active slot is free: a fresh active
    // transfer on the same vehicle can be created.
    const b = await createTransfer({
      vehicleId,
      fromCustomerId: seller.id,
      toCustomerId: buyer.id,
      status: 'pending_seller_confirmation',
      expiresAt: past,
    });

    const result2 = await processTransferExpiry({ app: realApp() });
    expect((await getTransferById(b.transferId))?.status).toBe('expired');

    // Ownership never moved: the seller is still the active owner.
    const owner = await app.withContext({ role: 'admin' }, (tx: PrismaClient) =>
      tx.vehicleOwnership.findFirst({ where: { vehicleId, endedAt: null }, select: { customerId: true } }),
    );
    expect(owner?.customerId).toBe(seller.id);
  });

  it('does NOT touch pending_validation (F-CLI-404 / BR-044)', async () => {
    const seller = await createCustomer({ /* ... */ });
    const { vehicleId } = await createVehicle({ /* owned by seller, certified */ });
    const v = await createTransfer({
      vehicleId,
      fromCustomerId: seller.id,
      status: 'pending_validation',
      expiresAt: new Date(Date.now() - 60_000),
    });

    await processTransferExpiry({ app: realApp() });

    expect((await getTransferById(v.transferId))?.status).toBe('pending_validation');
  });

  it('does NOT touch a not-yet-expired pending transfer', async () => {
    const seller = await createCustomer({ /* ... */ });
    const { vehicleId } = await createVehicle({ /* owned by seller, certified */ });
    const future = await createTransfer({
      vehicleId,
      fromCustomerId: seller.id,
      status: 'pending_recipient',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await processTransferExpiry({ app: realApp() });

    expect((await getTransferById(future.transferId))?.status).toBe('pending_recipient');
  });
});
```

- [ ] **Step 2: Verifica il typecheck (gli integration NON girano localmente)**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

> Gli integration test richiedono Docker/Testcontainers e girano **solo su CI** (CLAUDE.md). Non eseguirli localmente. Su CI verranno eseguiti dal job `test:integration`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/transfer-expiry.test.ts
git commit -m "test(api): integration coverage for transfer expiry sweep"
```

---

## Final verification (prima della PR)

- [ ] `pnpm -r typecheck` pulito su tutti i workspace (gate pre-push husky).
- [ ] `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-swap.test.ts tests/unit/lib/transfers/expire-transfers.test.ts tests/unit/lambda-transfer-expiry.test.ts` — tutti verdi.
- [ ] `graphify update .` per aggiornare il knowledge graph (AST-only, no API cost).
- [ ] Push branch `feat/transfer-expiry-scheduler` e apri PR; watch CI con `gh pr checks --watch`.
- [ ] PR description: cita F-CLI-401/403, BR-043, BR-047; nota deploy pending operatore (`cdk deploy` per attivare la CfnSchedule); checklist tests.

## Note operatore (post-merge, non bloccanti)

- La `CfnSchedule` `garageos-transfer-expiry` richiede `cdk deploy` per attivarsi in prod. Guard + handler sono inerti finché lo schedule non consegna eventi → merge sicuro senza deploy immediato.
- Notifiche di scadenza differite (arco notifiche).

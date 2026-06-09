# F-CLI-401 PR1 — API avvio + lettura passaggio di proprietà — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Esporre la superficie cliente per *avviare* un passaggio di proprietà via codice fisico (`POST /v1/me/transfers`) e *leggerlo* (`GET /v1/me/transfers`, `GET /v1/me/transfers/:id`), senza spostare ancora la proprietà.

**Architecture:** Una sola route plugin Fastify (`me-transfers.ts`) sulla catena cliente (`requireAuth` + `requireClientiPool` + `clientiContext`, poi `withContext({ customerId, role: 'user' })`). La RLS di `vehicle_transfers` è `USING(true)`, quindi la frontiera di sicurezza è **interamente app-layer**: ogni query filtra esplicitamente su `fromCustomerId = customerId`. Due helper puri isolati: `lib/transfer-code.ts` (genera/valida il codice) e `lib/dtos/transfer.ts` (serializer + select). Nessuna migration: lo schema `vehicle_transfers` è già completo.

**Tech Stack:** Fastify, Zod v4, Prisma, Vitest (unit con FakePrisma + integration con Testcontainers), `node:crypto`.

**Spec di riferimento:** `docs/superpowers/specs/2026-06-09-F-CLI-401-pr1-transfer-initiate-api-design.md`

---

## File Structure

| File | Responsabilità | Azione |
|---|---|---|
| `packages/api/src/lib/transfer-code.ts` | Generazione `TR-XXXX-XXXX` (alfabeto no-ambigui) + `TRANSFER_CODE_RE` | Create |
| `packages/api/src/lib/dtos/transfer.ts` | `TRANSFER_SELECT` + `serializeTransfer(row)` puro camelCase | Create |
| `packages/api/src/routes/v1/me-transfers.ts` | I 3 endpoint | Create |
| `packages/api/src/server.ts` | Registra `meTransfersRoutes` | Modify |
| `packages/api/tests/unit/lib/transfer-code.test.ts` | Unit helper codice | Create |
| `packages/api/tests/unit/lib/dtos/transfer.test.ts` | Unit serializer | Create |
| `packages/api/tests/unit/routes/v1/me-transfers.test.ts` | Unit route (FakePrisma) | Create |
| `packages/api/tests/integration/me-transfers.test.ts` | Integration (Testcontainers) | Create |
| `docs/APPENDICE_G_ERROR_CODES.md` | 5 codici nuovi | Modify |
| `docs/APPENDICE_A_API.md` | §2.3/§3.10 path + method + codici | Modify |

**Convenzioni:** header commit Conventional Commits, scope `api`, ≤72 caratteri, imperativo. Niente `console.log`, niente `any` non giustificato. Pre-push esegue `pnpm -r typecheck` (l'unico gate locale); unit e integration girano su CI. Per validare un task di route in locale puoi lanciare `pnpm --filter @garageos/api test:unit`.

---

## Task 1: Helper generazione/validazione codice (`lib/transfer-code.ts`)

**Files:**
- Create: `packages/api/src/lib/transfer-code.ts`
- Test: `packages/api/tests/unit/lib/transfer-code.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/lib/transfer-code.test.ts
import { describe, expect, it } from 'vitest';

import { generateTransferCode, TRANSFER_CODE_RE } from '../../../src/lib/transfer-code.js';

describe('transfer-code', () => {
  it('generates codes matching TR-XXXX-XXXX with the no-ambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateTransferCode();
      expect(code).toMatch(TRANSFER_CODE_RE);
      // No ambiguous characters: 0 1 I O Q S U
      expect(code.slice(3)).not.toMatch(/[01IOQSU]/);
    }
  });

  it('produces varied codes (not a constant)', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateTransferCode()));
    expect(set.size).toBeGreaterThan(1);
  });

  it('TRANSFER_CODE_RE rejects malformed codes', () => {
    expect('tr-9k4m-7p2x').not.toMatch(TRANSFER_CODE_RE); // lowercase
    expect('TR-9K4M7P2X').not.toMatch(TRANSFER_CODE_RE); // missing dash
    expect('TR-9K4-7P2X').not.toMatch(TRANSFER_CODE_RE); // wrong length
    expect('TR-9K4O-7P2X').not.toMatch(TRANSFER_CODE_RE); // contains O
    expect('GO-234-ABCD').not.toMatch(TRANSFER_CODE_RE); // garage code shape
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-code.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/transfer-code.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/lib/transfer-code.ts
import { randomInt } from 'node:crypto';

// Physical transfer code shared with the recipient out-of-band (F-CLI-401,
// physical_code method). Alphabet excludes ambiguous glyphs (0 1 I O Q S U),
// mirroring the BR-020 garage-code alphabet. Format: TR-XXXX-XXXX.
const ALPHABET = '23456789ABCDEFGHJKLMNPRTVWXYZ';

export const TRANSFER_CODE_RE = /^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/;

function group(): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateTransferCode(): string {
  return `TR-${group()}-${group()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/transfer-code.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/transfer-code.ts packages/api/tests/unit/lib/transfer-code.test.ts
git commit -m "feat(api): add transfer code generator and validator"
```

---

## Task 2: DTO serializer (`lib/dtos/transfer.ts`)

**Files:**
- Create: `packages/api/src/lib/dtos/transfer.ts`
- Test: `packages/api/tests/unit/lib/dtos/transfer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/lib/dtos/transfer.test.ts
import { describe, expect, it } from 'vitest';

import { serializeTransfer } from '../../../../src/lib/dtos/transfer.js';

const baseRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  vehicleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  method: 'initiated_by_seller' as const,
  status: 'pending_recipient' as const,
  transferCode: 'TR-9K4M-7P2X',
  expiresAt: new Date('2026-06-16T14:32:05.000Z'),
  completedAt: null,
  rejectedReason: null,
  createdAt: new Date('2026-06-09T14:32:05.000Z'),
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
};

describe('serializeTransfer', () => {
  it('maps initiated_by_seller to physical_code and serializes dates as ISO', () => {
    expect(serializeTransfer(baseRow)).toEqual({
      id: baseRow.id,
      vehicleId: baseRow.vehicleId,
      vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      method: 'physical_code',
      status: 'pending_recipient',
      transferCode: 'TR-9K4M-7P2X',
      expiresAt: '2026-06-16T14:32:05.000Z',
      createdAt: '2026-06-09T14:32:05.000Z',
    });
  });

  it('omits completedAt/rejectedReason when null', () => {
    const dto = serializeTransfer(baseRow);
    expect(dto).not.toHaveProperty('completedAt');
    expect(dto).not.toHaveProperty('rejectedReason');
  });

  it('includes completedAt/rejectedReason when present', () => {
    const dto = serializeTransfer({
      ...baseRow,
      status: 'rejected',
      completedAt: new Date('2026-06-10T00:00:00.000Z'),
      rejectedReason: 'cambiato idea',
    });
    expect(dto.completedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(dto.rejectedReason).toBe('cambiato idea');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/dtos/transfer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/lib/dtos/transfer.ts
import type { Prisma } from '@garageos/database';

// Select shared by every /me/transfers response. No recipient PII: in the
// physical_code flow toCustomerId is null until acceptance (PR2), and even
// later BR-045/BR-151 keep the other party's anagrafica hidden.
export const TRANSFER_SELECT = {
  id: true,
  vehicleId: true,
  method: true,
  status: true,
  transferCode: true,
  expiresAt: true,
  completedAt: true,
  rejectedReason: true,
  createdAt: true,
  vehicle: { select: { plate: true, make: true, model: true } },
} as const satisfies Prisma.VehicleTransferSelect;

type TransferRow = Prisma.VehicleTransferGetPayload<{ select: typeof TRANSFER_SELECT }>;

export interface TransferDto {
  id: string;
  vehicleId: string;
  vehicle: { plate: string; make: string; model: string };
  method: string;
  status: string;
  transferCode: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  rejectedReason?: string;
}

// DB enum TransferMethod describes WHO initiated; the client speaks the
// API-facing method (HOW the recipient is reached). Only initiated_by_seller
// reaches this serializer in the customer flow → expose it as physical_code.
function mapMethod(method: string): string {
  return method === 'initiated_by_seller' ? 'physical_code' : method;
}

export function serializeTransfer(row: TransferRow): TransferDto {
  const dto: TransferDto = {
    id: row.id,
    vehicleId: row.vehicleId,
    vehicle: { plate: row.vehicle.plate, make: row.vehicle.make, model: row.vehicle.model },
    method: mapMethod(row.method),
    status: row.status,
    transferCode: row.transferCode,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.completedAt) dto.completedAt = row.completedAt.toISOString();
  if (row.rejectedReason) dto.rejectedReason = row.rejectedReason;
  return dto;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/dtos/transfer.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/dtos/transfer.ts packages/api/tests/unit/lib/dtos/transfer.test.ts
git commit -m "feat(api): add transfer DTO serializer"
```

---

## Task 3: Route `POST /v1/me/transfers` + registrazione

> **CORREZIONE post-review (2026-06-09):** la review ha scoperto che APPENDICE_G ha già registrato
> la famiglia `transfer.creation.*` e che esiste l'indice partial-unique `uq_transfer_vehicle_active`
> (BR-047). Rispetto al codice incollato sotto valgono le correzioni della **spec §4.1 e §6 aggiornate**:
> (a) codici errore = `transfer.creation.vehicle_not_found` (404), `transfer.creation.not_current_owner`
> (403), `vehicle.archived` (409) per archived, `transfer.creation.vehicle_not_certified` (422) per
> pending, `transfer.creation.already_pending` (409); GET :id → `transfer.not_found` (404).
> (b) il `catch` del P2002 distingue via `err.meta.target`: `uq_transfer_vehicle_active` → 409
> `transfer.creation.already_pending` (no retry); `transfer_code` → retry. I test riflettono questo
> (meta.target nei P2002, branch archived→409, race→409). Vedi le istruzioni di fix passate all'implementer.

**Files:**
- Create: `packages/api/src/routes/v1/me-transfers.ts`
- Modify: `packages/api/src/server.ts` (import + register, accanto a `meVehicleRoutes`)
- Test: `packages/api/tests/unit/routes/v1/me-transfers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/tests/unit/routes/v1/me-transfers.test.ts
import { Prisma } from '@garageos/database';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meTransfersRoutes from '../../../../src/routes/v1/me-transfers.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  vehicle: { findFirst: ReturnType<typeof vi.fn> };
  vehicleTransfer: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function ownedCertifiedVehicle() {
  return {
    id: VEHICLE_ID,
    status: 'certified',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    ownerships: [{ id: 'own-1', customerId: CUSTOMER_ID }],
  };
}

function createdRow() {
  return {
    id: 'tr-1',
    vehicleId: VEHICLE_ID,
    method: 'initiated_by_seller',
    status: 'pending_recipient',
    transferCode: 'TR-9K4M-7P2X',
    expiresAt: new Date('2026-06-16T00:00:00.000Z'),
    completedAt: null,
    rejectedReason: null,
    createdAt: new Date('2026-06-09T00:00:00.000Z'),
    vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
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
      ...(overrides.vehicleTransfer ?? {}),
    },
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const withContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, { prisma: prisma as never, withContext: withContext as never });
  app.decorate('jwtVerifier', verifier);
  await app.register(meTransfersRoutes);
  return app;
}

describe('POST /v1/me/transfers', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => { app = undefined; });
  afterEach(async () => { await app?.close(); });

  function post(payload: unknown) {
    return app!.inject({
      method: 'POST',
      url: '/v1/me/transfers',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: payload as never,
    });
  }

  it('creates a pending_recipient transfer for the active owner', async () => {
    const prisma = buildFakePrisma();
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending_recipient');
    expect(body.method).toBe('physical_code');
    expect(body.transferCode).toBe('TR-9K4M-7P2X');
    const createArg = prisma.vehicleTransfer.create.mock.calls[0]![0];
    expect(createArg.data.fromCustomerId).toBe(CUSTOMER_ID);
    expect(createArg.data.method).toBe('initiated_by_seller');
    expect(createArg.data.status).toBe('pending_recipient');
  });

  it('returns 404 when the vehicle does not exist', async () => {
    const prisma = buildFakePrisma({ vehicle: { findFirst: vi.fn().mockResolvedValue(null) } });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the caller is not the active owner', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({
          ...ownedCertifiedVehicle(),
          ownerships: [{ id: 'own-1', customerId: 'someone-else' }],
        }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when the vehicle has no active owner', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ ...ownedCertifiedVehicle(), ownerships: [] }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 422 when the vehicle is not certified', async () => {
    const prisma = buildFakePrisma({
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ ...ownedCertifiedVehicle(), status: 'pending' }),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(422);
  });

  it('returns 409 when an active transfer already exists', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an unknown method with 400', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await post({ vehicleId: VEHICLE_ID, method: 'email_invitation' });
    expect(res.statusCode).toBe(400);
  });

  it('retries code generation once on a P2002 collision', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      )
      .mockResolvedValueOnce(createdRow());
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create },
    });
    app = await buildApp(prisma);
    const res = await post({ vehicleId: VEHICLE_ID, method: 'physical_code' });
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: FAIL — `Cannot find module '.../me-transfers.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/routes/v1/me-transfers.ts
import { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { serializeTransfer, TRANSFER_SELECT } from '../../lib/dtos/transfer.js';
import { generateTransferCode } from '../../lib/transfer-code.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/transfers* — customer-app surface for seller-initiated vehicle
// ownership transfer (F-CLI-401, parte 402). PR1 = avvio + lettura: the
// ownership does NOT move here (BR-043 step 1). Accept/confirm/reject and
// the atomic swap land in PR2.
//
// Security: vehicle_transfers RLS is USING(true), so visibility is enforced
// entirely app-layer — every query filters fromCustomerId = customerId
// (the #154 lesson). Reads/writes run under role:'user' since vehicles,
// vehicle_ownerships and vehicle_transfers are all USING(true).

const TRANSFER_VALIDITY_DAYS = 7;
const CODE_RETRY_LIMIT = 5;
const ACTIVE_TRANSFER_STATUSES = [
  'pending_recipient',
  'pending_seller_confirmation',
  'pending_validation',
] as const;

const createBodySchema = z
  .object({
    vehicleId: z.uuid(),
    // PR1 only accepts physical_code; email_invitation is deferred until
    // the email channel is unblocked. Any other value → 400 ZodError.
    method: z.literal('physical_code'),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const meTransfersRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/me/transfers — F-CLI-401. Seller initiates a physical_code
  // transfer. Creates the row in pending_recipient; vehicle stays put.
  app.post(
    '/v1/me/transfers',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const { vehicleId } = createBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const vehicle = await tx.vehicle.findFirst({
          where: { id: vehicleId },
          select: {
            id: true,
            status: true,
            plate: true,
            make: true,
            model: true,
            ownerships: { where: { endedAt: null }, select: { id: true, customerId: true } },
          },
        });
        if (!vehicle) {
          throw businessError('me.transfer.vehicle_not_found', 404, 'Veicolo non trovato.');
        }

        // BR-040: only the active owner may initiate.
        const active = vehicle.ownerships[0] ?? null;
        if (!active || active.customerId !== customerId) {
          throw businessError(
            'transfer.not_current_owner',
            403,
            'Non sei il proprietario attuale del veicolo.',
          );
        }

        // BR-046: pending/archived vehicles are not transferable.
        if (vehicle.status !== 'certified') {
          throw businessError(
            'transfer.vehicle_not_certified',
            422,
            'Veicolo non certificato: non puo essere trasferito.',
          );
        }

        // BR-047: at most one active transfer per vehicle.
        const existing = await tx.vehicleTransfer.findFirst({
          where: { vehicleId, status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
          select: { id: true },
        });
        if (existing) {
          throw businessError(
            'transfer.already_pending',
            409,
            'Esiste gia un trasferimento attivo per questo veicolo.',
          );
        }

        const expiresAt = new Date(Date.now() + TRANSFER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
        let lastErr: unknown;
        for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt++) {
          try {
            const row = await tx.vehicleTransfer.create({
              data: {
                vehicleId,
                fromCustomerId: customerId,
                toCustomerId: null,
                transferCode: generateTransferCode(),
                invitedEmail: null,
                method: 'initiated_by_seller',
                status: 'pending_recipient',
                expiresAt,
              },
              select: TRANSFER_SELECT,
            });
            reply.code(201);
            return serializeTransfer(row);
          } catch (err) {
            // transfer_code is @unique — a collision retries with a fresh
            // code. Any other error propagates.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              lastErr = err;
              continue;
            }
            throw err;
          }
        }
        throw lastErr; // exhausted retries on code collision (practically impossible)
      });
    },
  );

  // GET /v1/me/transfers — F-CLI-401/402. Transfers the caller initiated.
  // No pagination: a customer holds very few (YAGNI).
  app.get(
    '/v1/me/transfers',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const rows = await tx.vehicleTransfer.findMany({
          where: { fromCustomerId: customerId },
          orderBy: { createdAt: 'desc' },
          select: TRANSFER_SELECT,
        });
        return { data: rows.map(serializeTransfer) };
      });
    },
  );

  // GET /v1/me/transfers/:id — F-CLI-402. Detail of a transfer the caller
  // initiated. App-layer filter on fromCustomerId; out-of-perimeter id → 404
  // (does not reveal existence, mirrors me.vehicle.not_found).
  app.get(
    '/v1/me/transfers/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { id, fromCustomerId: customerId },
          select: TRANSFER_SELECT,
        });
        if (!row) {
          throw businessError('me.transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        return { transfer: serializeTransfer(row) };
      });
    },
  );
};

export default meTransfersRoutes;
```

- [ ] **Step 4: Register the route in `server.ts`**

In `packages/api/src/server.ts`, add the import next to the other `me-*` imports (after line 39, `import meVehicleRoutes from './routes/v1/me-vehicles.js';`):

```ts
import meTransfersRoutes from './routes/v1/me-transfers.js';
```

And register it next to `meVehicleRoutes` (after `await app.register(meVehicleRoutes);`, ~line 209):

```ts
  await app.register(meTransfersRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: PASS (8 test).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/v1/me-transfers.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/me-transfers.test.ts
git commit -m "feat(api): add POST /me/transfers initiate endpoint"
```

---

## Task 4: GET lista + GET dettaglio (test unit)

> Gli handler GET sono già stati scritti in Task 3 (stesso file route). Questo task aggiunge i test unit dedicati alla lettura e al filtro app-layer.

**Files:**
- Modify: `packages/api/tests/unit/routes/v1/me-transfers.test.ts` (aggiungi i describe sotto)

- [ ] **Step 1: Write the failing tests** (append in fondo al file, dentro nuovi `describe`)

```ts
describe('GET /v1/me/transfers', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => { app = undefined; });
  afterEach(async () => { await app?.close(); });

  it('lists transfers filtered by fromCustomerId', async () => {
    const findMany = vi.fn().mockResolvedValue([createdRow()]);
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst: vi.fn(), findMany, create: vi.fn() },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(findMany.mock.calls[0]![0].where).toEqual({ fromCustomerId: CUSTOMER_ID });
  });

  it('returns 401 without Authorization', async () => {
    app = await buildApp(buildFakePrisma());
    const res = await app.inject({ method: 'GET', url: '/v1/me/transfers' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/me/transfers/:id', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => { app = undefined; });
  afterEach(async () => { await app?.close(); });

  it('returns the transfer when owned by the caller', async () => {
    const findFirst = vi.fn().mockResolvedValue(createdRow());
    const prisma = buildFakePrisma({
      vehicleTransfer: { findFirst, findMany: vi.fn(), create: vi.fn() },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers/tr-1',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transfer.id).toBe('tr-1');
    // App-layer scoping: the query is constrained to the caller.
    expect(findFirst.mock.calls[0]![0].where).toEqual(
      expect.objectContaining({ fromCustomerId: CUSTOMER_ID }),
    );
  });

  it('returns 404 for a transfer the caller did not initiate', async () => {
    const prisma = buildFakePrisma({
      vehicleTransfer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
      },
    });
    app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers/tr-1',
      headers: { authorization: 'Bearer valid.jwt' },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (handler già implementati)

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-transfers.test.ts`
Expected: PASS (tutti, inclusi i 4 nuovi).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/unit/routes/v1/me-transfers.test.ts
git commit -m "test(api): cover GET /me/transfers list and detail"
```

---

## Task 5: Integration test (Testcontainers, CI)

**Files:**
- Create: `packages/api/tests/integration/me-transfers.test.ts`

> Verifica il comportamento reale con Postgres + RLS. **Non eseguire in locale** (Docker; CLAUDE.md) — gira su CI. La firma degli helper è in `tests/integration/helpers.ts` / `fixtures.ts` / `../helpers/jwt.ts`.

- [ ] **Step 1: Write the integration test**

```ts
// packages/api/tests/integration/me-transfers.test.ts
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createVehicle,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// F-CLI-401 PR1 — POST/GET /v1/me/transfers.
describe('Customer transfer initiate (F-CLI-401)', () => {
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

  // Creates an authenticated customer who owns a certified vehicle.
  async function ownerWithVehicle() {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    return { customerId, vehicleId, token };
  }

  function postTransfer(token: string, vehicleId: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/transfers',
      headers: { authorization: `Bearer ${token}` },
      payload: { vehicleId, method: 'physical_code' },
    });
  }

  it('initiates a pending_recipient transfer without moving ownership', async () => {
    const { vehicleId, token, customerId } = await ownerWithVehicle();
    const res = await postTransfer(token, vehicleId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending_recipient');
    expect(body.transferCode).toMatch(/^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/);

    // Ownership unchanged: the customer still owns the vehicle.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/vehicles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().data.map((v: { id: string }) => v.id)).toContain(vehicleId);
    expect(customerId).toBeTruthy();
  });

  it('rejects a second active transfer for the same vehicle (BR-047)', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(201);
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(409);
  });

  it('returns 403 when the caller is not the active owner (BR-040)', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'certified' });
    const { customerId: ownerId } = await createCustomer({ cognitoSub: `o-${randomUUID().slice(0, 8)}` });
    await createOwnership({ vehicleId, customerId: ownerId });

    const strangerSub = `s-${randomUUID().slice(0, 8)}`;
    const { customerId: strangerId } = await createCustomer({ cognitoSub: strangerSub });
    const token = await signTestToken({ pool: 'clienti', sub: strangerSub, customerId: strangerId });

    expect((await postTransfer(token, vehicleId)).statusCode).toBe(403);
  });

  it('returns 422 for a pending (non-certified) vehicle (BR-046)', async () => {
    const sub = `cust-${randomUUID().slice(0, 8)}`;
    const { customerId } = await createCustomer({ cognitoSub: sub });
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId, status: 'pending' });
    await createOwnership({ vehicleId, customerId });
    const token = await signTestToken({ pool: 'clienti', sub, customerId });
    expect((await postTransfer(token, vehicleId)).statusCode).toBe(422);
  });

  it('does not leak another seller transfer via GET :id (app-layer scoping)', async () => {
    const a = await ownerWithVehicle();
    const created = await postTransfer(a.token, a.vehicleId);
    const transferId = created.json().id;

    const strangerSub = `s-${randomUUID().slice(0, 8)}`;
    const { customerId: strangerId } = await createCustomer({ cognitoSub: strangerSub });
    const strangerToken = await signTestToken({ pool: 'clienti', sub: strangerSub, customerId: strangerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/transfers/${transferId}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists only the caller transfers', async () => {
    const { vehicleId, token } = await ownerWithVehicle();
    await postTransfer(token, vehicleId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/transfers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Commit** (l'esecuzione è su CI)

```bash
git add packages/api/tests/integration/me-transfers.test.ts
git commit -m "test(api): integration tests for /me/transfers initiate"
```

---

## Task 6: Documentazione (APPENDICE_G + APPENDICE_A)

**Files:**
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Aggiungi il codice NUOVO in APPENDICE_G** (gli altri sono già registrati)

> **CORREZIONE post-review:** APPENDICE_G ha già `transfer.creation.not_current_owner`,
> `transfer.creation.vehicle_not_certified`, `transfer.creation.already_pending`, `transfer.not_found`,
> `vehicle.archived`. PR1 NON aggiunge codici flat. Aggiungi SOLO il codice nuovo qui sotto alla
> tabella §2xx e all'indice alfabetico §7; opzionalmente popola la colonna Feature (`F-CLI-401`) dei
> tre `transfer.creation.*` oggi vuota.

| Codice | Status | Scenario |
|---|---|---|
| `transfer.creation.vehicle_not_found` | 404 | `vehicleId` inesistente in `POST /me/transfers` |

- [ ] **Step 2: Aggiorna APPENDICE_A §2.3 / §3.10**

Annota le divergenze decise in spec:
- Path consolidato sotto `/v1/me/transfers` (POST avvio, GET lista, GET :id) — non i path misti della §3.10.
- `method` API = `physical_code` (mappato su enum DB `initiated_by_seller`); `email_invitation` rinviato.
- Codici errore dotted `transfer.*` / `me.transfer.*` al posto dei flat (`not_current_owner` ecc.) citati in §2.3.
- Nota: la response usa camelCase (`vehicleId`, `transferCode`, `expiresAt`) coerente con la superficie cliente.

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_G_ERROR_CODES.md docs/APPENDICE_A_API.md
git commit -m "docs(api): document /me/transfers initiate endpoints and codes"
```

---

## Self-Review (eseguita)

**Spec coverage:** §4.1 POST → Task 3; §4.2 lista → Task 3+4; §4.3 :id → Task 3+4; §3.3 codice → Task 1; §4.4 DTO → Task 2; §3.2 sicurezza app-layer → asserzioni `fromCustomerId` in Task 3/4/5; §5 BR-040/043/046/047 → Task 3 + integration Task 5; §6 error codes → Task 6; §9 divergenze doc → Task 6. Nessun gap.

**Placeholder scan:** nessun TBD/TODO; ogni step di codice mostra il codice completo.

**Type consistency:** `TRANSFER_SELECT`/`serializeTransfer` (Task 2) usati identici in Task 3; `generateTransferCode`/`TRANSFER_CODE_RE` (Task 1) usati in Task 3/test; firma `withContext({ customerId, role: 'user' }, fn)` coerente col pattern `me-vehicles.ts`; helper integration (`createTenantWithLocation`, `createVehicle`, `createOwnership`, `createCustomer`, `signTestToken`, `buildTestServer`, `resetDb`) verificati contro le firme reali.

**Note di processo (memorie rilevanti):**
- `handler_change_breaks_unit_mock`: nuovo endpoint, nessun mock FakePrisma pre-esistente da aggiornare; il nuovo `me-transfers.test.ts` è autonomo.
- `ci_commitlint_all_commits_scope`: header ≤72, scope in enum (`api`), tipi `feat`/`test`/`docs`.
- Niente migration/dep/CDK/deploy (Task list non li include).

# F-CLI-101 Claim Vehicle API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/me/vehicles/claim` so a customer can attach a certified vehicle to their account by garage code (BR-042), the common backend for F-CLI-101/102/103.

**Architecture:** New route in the existing customer surface file `me-vehicles.ts`. All logic runs in `withContext({ customerId, role: 'user' })` — `vehicles` and `vehicle_ownerships` RLS are `USING(true)`, so the customer reads the vehicle by code and inserts the ownership without elevation. The security boundary is the explicit app-layer status/ownership check plus the partial unique index `uq_ownership_vehicle_active` (BR-040). Concurrent claims on a free vehicle collide on that index (P2002) and are resolved by a catch-and-refetch, mirroring `POST /vehicles`.

**Tech Stack:** Fastify, TypeScript, Zod v4, Prisma, Vitest (unit with FakePrisma + integration with Testcontainers Postgres).

---

## File Structure

- **Modify** `packages/api/src/routes/v1/me-vehicles.ts` — add the `POST /v1/me/vehicles/claim` handler (and a small `claimBodySchema` + `claimVehicleSelect`). Same file as the sibling `/me/vehicles*` reads; one responsibility (the customer vehicle surface).
- **Modify** `packages/api/tests/unit/routes/v1/me-vehicles.test.ts` — extend the `FakePrisma` harness with `vehicle.findFirst` + `vehicleOwnership.create`, add a `describe('POST /v1/me/vehicles/claim')` block.
- **Modify** `packages/api/tests/integration/me-vehicles.test.ts` — add a `describe('POST /v1/me/vehicles/claim (integration)')` block.
- **Modify** `docs/APPENDICE_A_API.md` — align §2.4 to the real path/casing/idempotent behavior.
- **Modify** `docs/APPENDICE_G_ERROR_CODES.md` — register the four dotted claim codes.

**Error codes (dotted, so the global handler wraps them RFC7807 — see `error-handler.ts`):**
- `me.vehicle.claim.code_not_found` → 404
- `me.vehicle.claim.pending` → 422
- `me.vehicle.claim.archived` → 422
- `me.vehicle.claim.owned_by_other` → 409

Invalid body (bad/garbled code) → 400 via Zod (no custom code needed). Self-owned → **not** an error: `200 { status: 'already_owned' }` (BR-042).

---

## Task 1: Route skeleton — body validation, auth guards, and 404 on unknown code

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

- [ ] **Step 1: Extend the FakePrisma harness**

In `me-vehicles.test.ts`, the `FakePrisma` interface and `buildFakePrisma` factory currently expose only `vehicleOwnership.{findMany,findFirst}`, `accessLog.findMany`, `customerTenantRelation.findMany`. Add a `vehicle.findFirst` and a `vehicleOwnership.create`.

Update the interface:

```ts
interface FakePrisma {
  vehicle: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  accessLog: {
    findMany: ReturnType<typeof vi.fn>;
  };
  customerTenantRelation: {
    findMany: ReturnType<typeof vi.fn>;
  };
}
```

Update the factory defaults (add the two new mocks; leave the existing ones):

```ts
function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    vehicleOwnership: {
      findMany: vi.fn().mockResolvedValue([OWNERSHIP_ROW]),
      findFirst: vi.fn().mockResolvedValue(OWNERSHIP_ROW),
      create: vi.fn().mockResolvedValue({
        id: OWNERSHIP_ID,
        startedAt: new Date('2026-06-05T00:00:00Z'),
      }),
    },
    accessLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customerTenantRelation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}
```

Note: existing `accessPrisma()` helper and the existing GET-test overrides call `buildFakePrisma({ vehicleOwnership: { findMany, findFirst } })` without `create`. Because `overrides` shallow-merges at the top level, those overrides will replace the whole `vehicleOwnership` object and drop `create`. The GET tests never call `create`, so this is harmless — **do not** touch those existing tests.

- [ ] **Step 2: Add a claim-vehicle fixture row + write the failing tests**

Add near the top of the file, after `OWNERSHIP_ROW`:

```ts
// A certified, currently-free vehicle as returned by the claim lookup
// (findFirst selects status + active ownerships for the decision).
const CLAIM_VEHICLE_FREE = {
  id: VEHICLE_ID,
  garageCode: 'GO-234-ABCD',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  plate: 'AB123CD',
  status: 'certified' as const,
  ownerships: [] as Array<{ id: string; customerId: string; startedAt: Date }>,
};
```

Add a new `describe` block at the end of the file:

```ts
describe('POST /v1/me/vehicles/claim', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    await app?.close();
  });

  function claimPrisma(vehicleRow: unknown) {
    return buildFakePrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue(vehicleRow) },
    });
  }

  it('returns 400 when the garage code is malformed', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-012-KXRI' }, // 0/1 digits + I letter: invalid per BR-020
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects officine pool tokens with 403', async () => {
    const officineVerifier: JwtVerifier = {
      verify: async (): Promise<VerifyResult> => ({
        pool: 'officine',
        payload: {
          sub: COGNITO_SUB,
          token_use: 'id',
          'custom:tenant_id': TENANT_ID,
          'custom:role': 'mechanic',
        },
      }),
    };
    app = await buildApp({ verifier: officineVerifier });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 me.vehicle.claim.code_not_found for an unknown code', async () => {
    const prisma = claimPrisma(null);
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.code_not_found',
      status: 404,
    });
  });

  it('normalizes the code (trim + uppercase) before the lookup', async () => {
    const prisma = claimPrisma(null);
    app = await buildApp({ prisma });
    await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: '  go-234-abcd  ' },
    });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { garageCode: 'GO-234-ABCD' } }),
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: FAIL — route not registered (404 from Fastify for all, or assertion failures).

> Mobile/jest gotcha does not apply (this is api/vitest). If the run auto-backgrounds, redirect to a file and poll: `... > /tmp/claim.out 2>&1; echo __EXIT $?__ >> /tmp/claim.out` then read the file.

- [ ] **Step 4: Implement the route skeleton + lookup + 404**

In `me-vehicles.ts`, add the import for `Prisma` at the top (alongside the existing imports):

```ts
import { Prisma } from '@garageos/database';
```

Add the schema + select constants near the other `const …Schema`/`…Select` declarations (after `meVehicleDetailSelect`):

```ts
// BR-020 garage code format: GO-NNN-AAAA, digits 2-9, letters minus
// I/O/Q/S/U. Normalize (trim + uppercase) so QR/manual entry casing is
// tolerated, then validate. Malformed input fails here → 400.
const claimBodySchema = z.object({
  garageCode: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(
      z
        .string()
        .regex(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/, 'Codice GarageOS non valido'),
    ),
});

// Lookup projection: public display fields returned to the client, plus
// status + active ownership rows used only for the BR-042 decision.
const claimVehicleSelect = {
  id: true,
  garageCode: true,
  make: true,
  model: true,
  year: true,
  plate: true,
  status: true,
  ownerships: {
    where: { endedAt: null },
    select: { id: true, customerId: true, startedAt: true },
  },
} as const;
```

Register the route inside `meVehicleRoutes`, after the access-log handler:

```ts
  // POST /v1/me/vehicles/claim — F-CLI-101/102/103 / BR-042.
  // The customer attaches a certified vehicle to their account by garage
  // code. Manual entry, QR scan and invite-link flows all converge here:
  // the client sends only the extracted code.
  //
  // Runs in role:'user': vehicles + vehicle_ownerships RLS are USING(true),
  // so the customer reads the vehicle and inserts the ownership without
  // elevation. The security boundary is the explicit status/ownership
  // check below plus the partial unique index uq_ownership_vehicle_active
  // (BR-040) — never RLS alone (the #154 lesson).
  app.post(
    '/v1/me/vehicles/claim',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { garageCode } = claimBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const vehicle = await tx.vehicle.findFirst({
          where: { garageCode },
          select: claimVehicleSelect,
        });
        if (!vehicle) {
          throw businessError(
            'me.vehicle.claim.code_not_found',
            404,
            'Nessun veicolo trovato per questo codice.',
          );
        }

        const { status, ownerships, ...vehiclePublic } = vehicle;
        void status; // guards added in Task 2
        void ownerships; // ownership decision added in Tasks 3-4
        void customerId;
        void Prisma; // race handling added in Task 5
        return { vehicle: vehiclePublic };
      });
    },
  );
```

> The `void` lines are scaffolding to keep TypeScript/ESLint quiet between TDD steps; they are removed as each later task consumes the symbol. (Per the repo lesson: don't leave a genuinely unused import — `Prisma` is consumed in Task 5; if you split the work across commits, add the import in Task 5 instead to avoid the eslint pre-commit no-unused-vars block.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: PASS (5 claim tests). The GET tests must remain green — run the whole file once: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -F- <<'EOF'
feat(api): claim route skeleton with code validation (F-CLI-101)

POST /v1/me/vehicles/claim: Zod BR-020 code normalization + lookup,
404 me.vehicle.claim.code_not_found. Auth/pool guards via shared
preHandlers. Ownership decision + race handling follow.
EOF
```

---

## Task 2: Status guards — 422 pending / 422 archived

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the `describe('POST /v1/me/vehicles/claim')` block:

```ts
  it('returns 422 me.vehicle.claim.pending for a pending vehicle', async () => {
    const prisma = claimPrisma({ ...CLAIM_VEHICLE_FREE, status: 'pending' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.pending',
      status: 422,
    });
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('returns 422 me.vehicle.claim.archived for an archived vehicle', async () => {
    const prisma = claimPrisma({ ...CLAIM_VEHICLE_FREE, status: 'archived' });
    app = await buildApp({ prisma });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.archived',
      status: 422,
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: FAIL — both return 200 (no guards yet).

- [ ] **Step 3: Implement the guards**

In the handler, replace `void status;` with the guards (place right after destructuring `{ status, ownerships, ...vehiclePublic }`):

```ts
        const { status, ownerships, ...vehiclePublic } = vehicle;

        if (status === 'pending') {
          throw businessError(
            'me.vehicle.claim.pending',
            422,
            'Veicolo non ancora certificato: non può essere agganciato.',
          );
        }
        if (status === 'archived') {
          throw businessError(
            'me.vehicle.claim.archived',
            422,
            'Veicolo archiviato: non può essere agganciato.',
          );
        }
        // status === 'certified' falls through.

        void ownerships; // ownership decision added in Tasks 3-4
        void customerId;
        void Prisma;
        return { vehicle: vehiclePublic };
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: PASS (7 claim tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -F- <<'EOF'
feat(api): claim status guards for pending/archived (F-CLI-101)

BR-042: pending -> 422 me.vehicle.claim.pending, archived -> 422
me.vehicle.claim.archived. Only certified vehicles proceed.
EOF
```

---

## Task 3: Free vehicle → 200 claimed (create ownership)

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the claim `describe` block:

```ts
  it('claims a free certified vehicle: creates ownership, returns status claimed', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE); // ownerships: []
    prisma.vehicleOwnership.create = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; garageCode: string; make: string; status?: string };
      ownership: { id: string; startedAt: string };
      status: string;
    };
    expect(body.status).toBe('claimed');
    expect(body.vehicle).toEqual({
      id: VEHICLE_ID,
      garageCode: 'GO-234-ABCD',
      make: 'Fiat',
      model: 'Panda',
      year: 2021,
      plate: 'AB123CD',
    });
    // status + ownerships are decision-only, never serialized.
    expect(body.vehicle).not.toHaveProperty('status');
    expect(body.vehicle).not.toHaveProperty('ownerships');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(body.ownership.startedAt).toBe('2026-06-05T12:00:00.000Z');

    expect(prisma.vehicleOwnership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          customerId: CUSTOMER_ID,
        }),
        select: { id: true, startedAt: true },
      }),
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claims a free certified"`
Expected: FAIL — response has no `status`/`ownership` (handler still returns `{ vehicle }`).

- [ ] **Step 3: Implement create-on-free**

Replace the trailing scaffolding (`void ownerships; void customerId; void Prisma; return { vehicle: vehiclePublic };`) with:

```ts
        const active = ownerships[0] ?? null;
        if (!active) {
          const ownership = await tx.vehicleOwnership.create({
            data: { vehicleId: vehicle.id, customerId, startedAt: new Date() },
            select: { id: true, startedAt: true },
          });
          return { vehicle: vehiclePublic, ownership, status: 'claimed' as const };
        }

        void active; // self/other branches added in Task 4
        void Prisma; // race handling added in Task 5
        return { vehicle: vehiclePublic };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: PASS (8 claim tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -F- <<'EOF'
feat(api): claim a free certified vehicle (F-CLI-101)

BR-042: certified vehicle with no active ownership -> create
vehicle_ownership for the caller, return 200 { status: 'claimed' }.
EOF
```

---

## Task 4: Already-owned branches — 200 already_owned (self) / 409 owned_by_other

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the claim `describe` block:

```ts
  it('is idempotent when the caller already owns the vehicle (status already_owned, no create)', async () => {
    const prisma = claimPrisma({
      ...CLAIM_VEHICLE_FREE,
      ownerships: [
        {
          id: OWNERSHIP_ID,
          customerId: CUSTOMER_ID,
          startedAt: new Date('2026-01-15T00:00:00.000Z'),
        },
      ],
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ownership: { id: string; startedAt: string };
      status: string;
    };
    expect(body.status).toBe('already_owned');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(body.ownership.startedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });

  it('returns 409 me.vehicle.claim.owned_by_other when another customer owns it', async () => {
    const prisma = claimPrisma({
      ...CLAIM_VEHICLE_FREE,
      ownerships: [
        {
          id: OWNERSHIP_ID,
          customerId: '99999999-9999-4999-8999-999999999999',
          startedAt: new Date('2026-01-15T00:00:00.000Z'),
        },
      ],
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.owned_by_other',
      status: 409,
    });
    expect(prisma.vehicleOwnership.create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: FAIL — both currently return `{ vehicle }` only (no status / wrong code).

- [ ] **Step 3: Implement self/other decision**

Replace the `void active; void Prisma; return { vehicle: vehiclePublic };` scaffolding with:

```ts
        if (active.customerId === customerId) {
          // BR-042: already owned by the caller -> idempotent success.
          return {
            vehicle: vehiclePublic,
            ownership: { id: active.id, startedAt: active.startedAt },
            status: 'already_owned' as const,
          };
        }

        // Owned by a different customer -> the caller must use the
        // ownership-transfer flow, not claim.
        void Prisma; // race handling added in Task 5
        throw businessError(
          'me.vehicle.claim.owned_by_other',
          409,
          'Veicolo già associato a un altro account.',
        );
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "claim"`
Expected: PASS (10 claim tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -F- <<'EOF'
feat(api): claim already-owned branches (F-CLI-101)

BR-042: vehicle owned by caller -> idempotent 200 already_owned (no
second ownership); owned by another customer -> 409
me.vehicle.claim.owned_by_other.
EOF
```

---

## Task 5: Concurrent-claim race — P2002 catch-and-refetch

**Files:**
- Modify: `packages/api/src/routes/v1/me-vehicles.ts`
- Test: `packages/api/tests/unit/routes/v1/me-vehicles.test.ts`

**Why:** Two customers (or two taps) claim the same free vehicle at once. Both read `ownerships: []`, both try to insert; the partial unique index `uq_ownership_vehicle_active` lets only one win, the loser gets Prisma `P2002`. We refetch the now-active ownership and resolve to idempotent success (if the caller won the second look) or 409.

- [ ] **Step 1: Write the failing tests**

Add inside the claim `describe` block. Build a `P2002` error the way Prisma raises it:

```ts
  function p2002(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  it('on a concurrent-claim P2002, refetches and returns already_owned if the caller won', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE); // ownerships: [] at read time
    prisma.vehicleOwnership.create = vi.fn().mockRejectedValue(p2002());
    // Refetch sees the now-active ownership belonging to the caller.
    prisma.vehicleOwnership.findFirst = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      customerId: CUSTOMER_ID,
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; ownership: { id: string } };
    expect(body.status).toBe('already_owned');
    expect(body.ownership.id).toBe(OWNERSHIP_ID);
    expect(prisma.vehicleOwnership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vehicleId: VEHICLE_ID, endedAt: null },
      }),
    );
  });

  it('on a concurrent-claim P2002, returns 409 owned_by_other if another customer won', async () => {
    const prisma = claimPrisma(CLAIM_VEHICLE_FREE);
    prisma.vehicleOwnership.create = vi.fn().mockRejectedValue(p2002());
    prisma.vehicleOwnership.findFirst = vi.fn().mockResolvedValue({
      id: OWNERSHIP_ID,
      customerId: '99999999-9999-4999-8999-999999999999',
      startedAt: new Date('2026-06-05T12:00:00.000Z'),
    });
    app = await buildApp({ prisma });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: 'Bearer valid.jwt' },
      payload: { garageCode: 'GO-234-ABCD' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.owned_by_other',
      status: 409,
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts -t "concurrent-claim"`
Expected: FAIL — the rejected `create` currently propagates as an unhandled 500.

- [ ] **Step 3: Implement the catch-and-refetch**

Wrap the free-vehicle `create` (in Task 3's block) in try/catch. The free-vehicle branch becomes:

```ts
        const active = ownerships[0] ?? null;
        if (!active) {
          try {
            const ownership = await tx.vehicleOwnership.create({
              data: { vehicleId: vehicle.id, customerId, startedAt: new Date() },
              select: { id: true, startedAt: true },
            });
            return { vehicle: vehiclePublic, ownership, status: 'claimed' as const };
          } catch (err) {
            // Concurrent claim won the active-ownership unique index
            // (uq_ownership_vehicle_active). Refetch and resolve.
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === 'P2002'
            ) {
              const raced = await tx.vehicleOwnership.findFirst({
                where: { vehicleId: vehicle.id, endedAt: null },
                select: { id: true, customerId: true, startedAt: true },
              });
              if (raced && raced.customerId === customerId) {
                return {
                  vehicle: vehiclePublic,
                  ownership: { id: raced.id, startedAt: raced.startedAt },
                  status: 'already_owned' as const,
                };
              }
              throw businessError(
                'me.vehicle.claim.owned_by_other',
                409,
                'Veicolo già associato a un altro account.',
              );
            }
            throw err;
          }
        }
```

Now remove the remaining `void Prisma;` from the self/other block (Task 4) — `Prisma` is used here. The self-owned branch and the final `owned_by_other` throw stay as written in Task 4 (drop their `void Prisma;` line).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts`
Expected: PASS — full file green (GET blocks + 12 claim tests). No `void` scaffolding left.

- [ ] **Step 5: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS. (Catches a dropped `void` leaving an unused symbol, or a `Prisma` import gap.)

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/v1/me-vehicles.ts packages/api/tests/unit/routes/v1/me-vehicles.test.ts
git commit -F- <<'EOF'
feat(api): claim concurrent-race handling via P2002 refetch (F-CLI-101)

Mirror POST /vehicles: a losing concurrent claim hits
uq_ownership_vehicle_active (P2002); refetch the active ownership and
resolve to idempotent already_owned or 409 owned_by_other.
EOF
```

---

## Task 6: Integration tests

**Files:**
- Modify: `packages/api/tests/integration/me-vehicles.test.ts`

These run against a real Postgres (RLS, the partial unique index, the `chk_garage_code_format` check). They exercise the clienti-pool JWT path end-to-end.

- [ ] **Step 1: Write the integration tests**

Append a new `describe` block at the end of the file (helpers `createCustomer`, `createTenantWithLocation`, `createVehicle`, `createOwnership`, `resetDb`, `signTestToken`, `pgAdmin` are already imported):

```ts
describe('POST /v1/me/vehicles/claim (integration)', () => {
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

  async function claimer(prefix: string) {
    const cognitoSub = `${prefix}-` + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    return { customerId, token };
  }

  it('claims a free certified vehicle and creates exactly one active ownership', async () => {
    const { customerId, token } = await claimer('claim-ok');
    const { tenantId } = await createTenantWithLocation('claim-ok');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      certifiedByTenantId: tenantId,
      vin: 'ZFA1CLAIM00000001',
      plate: 'CL001AA',
      status: 'certified',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vehicle: { id: string; garageCode: string };
      ownership: { id: string; startedAt: string };
      status: string;
    };
    expect(body.status).toBe('claimed');
    expect(body.vehicle.id).toBe(vehicleId);
    expect(body.ownership.id).toBeTruthy();

    const { rows } = await pgAdmin.query(
      `SELECT customer_id FROM vehicle_ownerships WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].customer_id).toBe(customerId);
  });

  it('is idempotent: re-claiming the same vehicle returns already_owned without a second ownership', async () => {
    const { token } = await claimer('claim-idem');
    const { tenantId } = await createTenantWithLocation('claim-idem');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      certifiedByTenantId: tenantId,
      vin: 'ZFA1CLAIMIDEM0001',
      plate: 'CL002BB',
      status: 'certified',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status: string }).status).toBe('claimed');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { status: string }).status).toBe('already_owned');

    const { rows } = await pgAdmin.query(
      `SELECT id FROM vehicle_ownerships WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
  });

  it('returns 409 owned_by_other when another customer owns the vehicle', async () => {
    const { customerId: ownerId } = await createCustomer({
      cognitoSub: 'claim-owner-' + Math.random().toString(36).slice(2, 10),
    });
    const { token } = await claimer('claim-other');
    const { tenantId } = await createTenantWithLocation('claim-other');
    const { vehicleId, garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      certifiedByTenantId: tenantId,
      vin: 'ZFA1CLAIMOTHER001',
      plate: 'CL003CC',
      status: 'certified',
    });
    await createOwnership({ vehicleId, customerId: ownerId });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.owned_by_other',
      status: 409,
    });
  });

  it('returns 422 pending for a pending vehicle (explicit code)', async () => {
    const { token } = await claimer('claim-pending');
    const { tenantId } = await createTenantWithLocation('claim-pending');
    // Pending vehicles normally have NULL garage_code; pass one explicitly
    // to exercise the defensive BR-042 pending guard.
    const { garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      vin: 'ZFA1CLAIMPEND0001',
      plate: 'CL004DD',
      status: 'pending',
      garageCode: 'GO-345-BCDF',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode: garageCode! },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.pending',
      status: 422,
    });
  });

  it('returns 422 archived for an archived vehicle', async () => {
    const { token } = await claimer('claim-arch');
    const { tenantId } = await createTenantWithLocation('claim-arch');
    const { garageCode } = await createVehicle({
      createdByTenantId: tenantId,
      certifiedByTenantId: tenantId,
      vin: 'ZFA1CLAIMARCH0001',
      plate: 'CL005EE',
      status: 'archived',
      garageCode: 'GO-456-CDFG',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode: garageCode! },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.archived',
      status: 422,
    });
  });

  it('returns 404 code_not_found for an unknown code', async () => {
    const { token } = await claimer('claim-404');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode: 'GO-789-DFGH' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/me.vehicle.claim.code_not_found',
      status: 404,
    });
  });

  it('returns 400 for a malformed code', async () => {
    const { token } = await claimer('claim-400');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { garageCode: 'NOPE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/vehicles/claim',
      payload: { garageCode: 'GO-234-ABCD' },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

> If `createVehicle`'s `garageCode: 'GO-345-BCDF'` (or the other explicit codes) trips `chk_garage_code_format`, regenerate using only digits 2-9 and letters from `[A-HJ-NPRTV-Z]`. The codes above are already conformant: digits 3/4/5/6/7/8/9, letters B,C,D,F,G,H (none of I/O/Q/S/U).

- [ ] **Step 2: Note on running integration tests**

Per repo policy (CLAUDE.md), **do not run the integration suite locally** by default — Docker/Testcontainers can freeze the machine; CI runs it. Only if reproducing a CI failure:
`pnpm --filter @garageos/api test:integration -t "claim"`

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/me-vehicles.test.ts
git commit -F- <<'EOF'
test(api): integration coverage for vehicle claim (F-CLI-101)

End-to-end BR-042 branches against real Postgres + RLS: claimed,
idempotent already_owned (single active ownership), owned_by_other 409,
pending/archived 422, code_not_found 404, malformed 400, 401.
EOF
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/APPENDICE_A_API.md` (§2.4 and the endpoint table row at line ~2277)
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`

- [ ] **Step 1: Update APPENDICE_A §2.4**

Change the section so it reflects the implemented contract:
- Path: `POST /v1/me/vehicles/claim` (was `/v1/vehicles/claim`). Update both the §2.4 heading/example and the endpoint-index table row (line ~2277: change `/vehicles/claim` to `/me/vehicles/claim`).
- Request body: `{ "garageCode": "GO-482-KXRT" }` (camelCase; normalized server-side trim+uppercase).
- Response `200`: camelCase, add `status: "claimed" | "already_owned"`:

```json
{
  "vehicle": { "id": "...", "garageCode": "GO-482-KXRT", "make": "Fiat", "model": "Panda", "year": 2021, "plate": "AB123CD" },
  "ownership": { "id": "...", "startedAt": "2026-06-05T14:32:05.000Z" },
  "status": "claimed"
}
```
- Errors table: replace the flat codes with the dotted ones and **remove** `409 vehicle_already_owned_by_you` (now idempotent `200 { status: "already_owned" }` per BR-042):

| Status | Codice | Scenario |
|---|---|---|
| 400 | (Zod validation) | `garageCode` mancante o formato non valido (BR-020) |
| 404 | `me.vehicle.claim.code_not_found` | Codice non esistente |
| 409 | `me.vehicle.claim.owned_by_other` | Veicolo già di un altro cliente (usare il passaggio di proprietà) |
| 422 | `me.vehicle.claim.pending` | Veicolo `pending` non certificato |
| 422 | `me.vehicle.claim.archived` | Veicolo archiviato |

Add a one-line note: *"Path divergente dalla v1 della doc (`/vehicles/claim`) per coerenza con la superficie cliente `/me/*`. Idempotenza allineata a BR-042 (già-tuo → 200, non 409)."*

- [ ] **Step 2: Update APPENDICE_G**

Add the four dotted codes to the error-code registry, following the existing table format (mirror how `me.vehicle.not_found` is listed): `me.vehicle.claim.code_not_found` (404), `me.vehicle.claim.owned_by_other` (409), `me.vehicle.claim.pending` (422), `me.vehicle.claim.archived` (422), each with a short Italian description and the BR-042 reference.

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
git commit -F- <<'EOF'
docs(api): align claim endpoint to /me/vehicles/claim (F-CLI-101)

APPENDICE_A §2.4 path/casing/idempotency + APPENDICE_G dotted claim
error codes. Resolves the BR-042 vs APPENDICE_A 409 conflict in favor
of the business rule.
EOF
```

---

## Final verification

- [ ] **Typecheck the repo:** `pnpm -r typecheck` → PASS.
- [ ] **Unit suite for the file:** `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-vehicles.test.ts` → all green (GET blocks unchanged + 12 claim tests).
- [ ] **Push & open PR:** branch `feat/me-vehicles-claim-api`. Let CI run lint/commitlint/unit/integration. Watch with `gh pr checks --watch`.
- [ ] **PR body:** cite F-CLI-101/102/103 + BR-042/BR-040/BR-020; note the two doc divergences resolved (path, idempotency); checklist per CLAUDE.md.

---

## Self-review notes

- **Spec coverage:** endpoint (Task 1), validation/normalization (Task 1), 404 (T1), pending/archived 422 (T2), claimed (T3), already_owned idempotent (T4), owned_by_other (T4), race P2002 (T5), integration all branches (T6), docs A+G (T7). No access_log / no relation writes — correctly absent (handler never touches `accessLog`/`customerTenantRelation`). ✓
- **No placeholders:** every step has full code/commands. ✓
- **Type consistency:** `claimVehicleSelect.ownerships` selects `{ id, customerId, startedAt }`; the self-owned (T4) and race-refetch (T5) branches read exactly those. `vehicleOwnership.create` selects `{ id, startedAt }`, matching the `claimed` response. `status` literal union `'claimed' | 'already_owned'`. ✓
- **Right-sizing:** single additive file + tests + docs. Inline execution recommended (the 7 tasks are fine-grained TDD steps, not cross-layer complexity).

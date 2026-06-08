# F-CLI-206 Contestazione intervento (mobile + API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere al cliente mobile di contestare un intervento officina e vedere lo stato/risposta della contestazione in un nuovo schermo di dettaglio.

**Architecture:** Nuovo endpoint cliente `GET /v1/me/interventions/:id` (intervento officina + thread contestazioni, gate ownership app-layer) consumato da un nuovo schermo mobile `app/interventions/[id].tsx` con form di contestazione testo-only (`POST /v1/interventions/:id/dispute`, già esistente). Le righe officina della timeline diventano tappabili e mostrano il badge CONTESTATO.

**Tech Stack:** Fastify + Prisma + Zod + Vitest (API); React Native + Expo Router + React Query + Jest (mobile).

**Pre-flight (già verificato in fase spec):** backend `POST /v1/interventions/:id/dispute` esistente (#21/#53); `me.intervention.not_found` è codice NUOVO; nessun `/me/interventions/*` preesistente; pattern da mirrorare = `me-private-interventions.ts` (API), `private-interventions/[id].tsx` + `PrivateInterventionForm.tsx` (mobile).

**Convenzioni operative (CLAUDE.md):**
- Commit header ≤72 char, Conventional Commits. Usa file temp: `printf '...' > /tmp/cm.txt && git commit -F /tmp/cm.txt`.
- Gate pre-push = `pnpm -r typecheck` (automatico). Integration NON girata localmente (Docker) → CI.
- Test API = **Vitest**. Test mobile = **Jest**.
- Dopo nuove route mobile: `rm -f packages/mobile/.expo/types/router.d.ts` (rigenerato da tsc).
- No emoji nel codice/commit. Commenti in inglese. Stringhe utente in italiano.

---

## File Structure

**API:**
- Create `packages/api/src/lib/customer-intervention-detail.ts` — serializer puro `projectShopInterventionDetail`.
- Create `packages/api/src/routes/v1/me-interventions.ts` — `GET /v1/me/interventions/:id`.
- Modify `packages/api/src/server.ts` — registra la route.
- Create `packages/api/tests/unit/lib/customer-intervention-detail.test.ts`.
- Create `packages/api/tests/unit/routes/v1/me-interventions.test.ts`.
- Create `packages/api/tests/integration/me-interventions.test.ts`.
- Modify `docs/APPENDICE_A_API.md`, `docs/APPENDICE_G_ERROR_CODES.md`.

**Mobile:**
- Create `packages/mobile/src/lib/types/intervention.ts` — tipi `ShopInterventionDetail`, `Dispute`, enum.
- Create `packages/mobile/src/lib/dispute-labels.ts` — label IT categorie + stati.
- Create `packages/mobile/src/lib/validators/dispute.ts` — `validateDisputeForm`.
- Create `packages/mobile/src/queries/meShopInterventionDetail.ts` — GET hook.
- Create `packages/mobile/src/queries/createDispute.ts` — POST mutation.
- Create `packages/mobile/src/components/DisputeForm.tsx`.
- Create `packages/mobile/src/components/BadgeContestato.tsx`.
- Create `packages/mobile/app/interventions/[id].tsx` — schermo dettaglio.
- Create `packages/mobile/app/interventions/[id]/dispute.tsx` — schermo form.
- Modify `packages/mobile/src/components/TimelineRow.tsx` — badge CONTESTATO + onPress officina.
- Modify `packages/mobile/app/(tabs)/vehicles/[id].tsx` — righe officina tappabili.
- Modify `packages/mobile/src/lib/error-messages.ts` — messaggi IT dispute.
- Tests: `tests/components/DisputeForm.test.tsx`, `tests/queries/meShopInterventionDetail.test.tsx`, `tests/queries/createDispute.test.tsx`, `tests/screens/intervention-detail.test.tsx`, update `tests/components/TimelineRow.test.tsx`, `tests/unit/validators/dispute.test.ts`.

---

## Task 1: API serializer `projectShopInterventionDetail`

**Files:**
- Create: `packages/api/src/lib/customer-intervention-detail.ts`
- Test: `packages/api/tests/unit/lib/customer-intervention-detail.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/tests/unit/lib/customer-intervention-detail.test.ts
import { describe, expect, it } from 'vitest';

import {
  projectShopInterventionDetail,
  type RawInterventionRow,
  type RawDisputeRow,
} from '../../../src/lib/customer-intervention-detail.js';

const baseRow: RawInterventionRow = {
  id: 'int-1',
  vehicleId: 'veh-1',
  interventionDate: new Date('2026-05-01T00:00:00.000Z'),
  odometerKm: 84210,
  title: 'Tagliando completo',
  description: 'Sostituzione olio e filtri',
  partsReplaced: [{ name: 'Olio' }, { name: 'Filtro' }, { name: 'Candele' }],
  status: 'disputed',
  interventionType: { code: 'TAGLIANDO', nameIt: 'Tagliando' },
  tenant: { businessName: 'Officina Rossi' },
  location: { city: 'Milano' },
};

describe('projectShopInterventionDetail', () => {
  it('serializes intervention with date-only interventionDate and derived counts', () => {
    const out = projectShopInterventionDetail(baseRow, [], 2);
    expect(out.intervention).toEqual({
      id: 'int-1',
      vehicleId: 'veh-1',
      interventionDate: '2026-05-01',
      odometerKm: 84210,
      type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando completo',
      description: 'Sostituzione olio e filtri',
      partsReplacedCount: 3,
      status: 'disputed',
      isDisputed: true,
      tenant: { businessName: 'Officina Rossi', locationCity: 'Milano' },
      attachmentsCount: 2,
    });
    expect(out.disputes).toEqual([]);
  });

  it('maps the dispute thread and exposes the tenant response', () => {
    const disputeRow: RawDisputeRow = {
      id: 'd-1',
      reasonCategory: 'wrong_data',
      customerDescription: 'I km riportati sono errati',
      status: 'responded',
      createdAt: new Date('2026-05-02T10:00:00.000Z'),
      tenantResponse: 'Abbiamo verificato il valore',
      tenantResponseAt: new Date('2026-05-03T09:00:00.000Z'),
      resolvedAt: null,
    };
    const out = projectShopInterventionDetail({ ...baseRow, status: 'disputed' }, [disputeRow], 0);
    expect(out.disputes).toEqual([
      {
        id: 'd-1',
        reasonCategory: 'wrong_data',
        customerDescription: 'I km riportati sono errati',
        status: 'responded',
        createdAt: '2026-05-02T10:00:00.000Z',
        tenantResponse: 'Abbiamo verificato il valore',
        tenantResponseAt: '2026-05-03T09:00:00.000Z',
        resolvedAt: null,
      },
    ]);
  });

  it('handles null title and non-array partsReplaced defensively', () => {
    const out = projectShopInterventionDetail(
      { ...baseRow, title: null, partsReplaced: null as unknown as unknown[], status: 'active' },
      [],
      0,
    );
    expect(out.intervention.title).toBeNull();
    expect(out.intervention.partsReplacedCount).toBe(0);
    expect(out.intervention.isDisputed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/customer-intervention-detail.test.ts`
Expected: FAIL — module not found / `projectShopInterventionDetail is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/api/src/lib/customer-intervention-detail.ts
// Pure serializer for GET /v1/me/interventions/:id (F-CLI-206). The route
// resolves the Prisma rows and the attachments count, then passes them here
// so this stays DB-free and unit-testable. camelCase wire shape, consistent
// with the other /me endpoints. interventionDate is @db.Date -> emitted
// date-only (YYYY-MM-DD), never a full ISO timestamp (see feedback
// db_date_serialized_as_iso, PR #156).

export interface RawInterventionRow {
  id: string;
  vehicleId: string;
  interventionDate: Date;
  odometerKm: number;
  title: string | null;
  description: string;
  partsReplaced: unknown;
  status: string;
  interventionType: { code: string; nameIt: string };
  tenant: { businessName: string };
  location: { city: string } | null;
}

export interface RawDisputeRow {
  id: string;
  reasonCategory: string;
  customerDescription: string;
  status: string;
  createdAt: Date;
  tenantResponse: string | null;
  tenantResponseAt: Date | null;
  resolvedAt: Date | null;
}

export interface ShopInterventionDetailDto {
  intervention: {
    id: string;
    vehicleId: string;
    interventionDate: string;
    odometerKm: number;
    type: { code: string; name_it: string };
    title: string | null;
    description: string;
    partsReplacedCount: number;
    status: string;
    isDisputed: boolean;
    tenant: { businessName: string; locationCity: string | null };
    attachmentsCount: number;
  };
  disputes: Array<{
    id: string;
    reasonCategory: string;
    customerDescription: string;
    status: string;
    createdAt: string;
    tenantResponse: string | null;
    tenantResponseAt: string | null;
    resolvedAt: string | null;
  }>;
}

export function projectShopInterventionDetail(
  row: RawInterventionRow,
  disputes: RawDisputeRow[],
  attachmentsCount: number,
): ShopInterventionDetailDto {
  return {
    intervention: {
      id: row.id,
      vehicleId: row.vehicleId,
      interventionDate: row.interventionDate.toISOString().slice(0, 10),
      odometerKm: row.odometerKm,
      type: { code: row.interventionType.code, name_it: row.interventionType.nameIt },
      title: row.title,
      description: row.description,
      partsReplacedCount: Array.isArray(row.partsReplaced) ? row.partsReplaced.length : 0,
      status: row.status,
      isDisputed: row.status === 'disputed',
      tenant: { businessName: row.tenant.businessName, locationCity: row.location?.city ?? null },
      attachmentsCount,
    },
    disputes: disputes.map((d) => ({
      id: d.id,
      reasonCategory: d.reasonCategory,
      customerDescription: d.customerDescription,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      tenantResponse: d.tenantResponse,
      tenantResponseAt: d.tenantResponseAt ? d.tenantResponseAt.toISOString() : null,
      resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/lib/customer-intervention-detail.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
printf 'feat(api): shop intervention detail serializer (F-CLI-206)' > /tmp/cm.txt
git add packages/api/src/lib/customer-intervention-detail.ts packages/api/tests/unit/lib/customer-intervention-detail.test.ts
git commit -F /tmp/cm.txt
```

---

## Task 2: API route `GET /v1/me/interventions/:id`

**Files:**
- Create: `packages/api/src/routes/v1/me-interventions.ts`
- Modify: `packages/api/src/server.ts`
- Test: `packages/api/tests/unit/routes/v1/me-interventions.test.ts`

- [ ] **Step 1: Write the failing test (route unit, FakePrisma)**

```typescript
// packages/api/tests/unit/routes/v1/me-interventions.test.ts
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meInterventionsRoutes from '../../../../src/routes/v1/me-interventions.js';

const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const INTERVENTION_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  intervention: { findFirst: ReturnType<typeof vi.fn> };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  interventionDispute: { findMany: ReturnType<typeof vi.fn> };
  attachment: { count: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    intervention: {
      findFirst: vi.fn().mockResolvedValue({
        id: INTERVENTION_ID,
        vehicleId: 'veh-1',
        interventionDate: new Date('2026-05-01T00:00:00.000Z'),
        odometerKm: 84210,
        title: 'Tagliando',
        description: 'desc',
        partsReplaced: [],
        status: 'active',
        interventionType: { code: 'TAGLIANDO', nameIt: 'Tagliando' },
        tenant: { businessName: 'Officina Rossi' },
        location: { city: 'Milano' },
      }),
    },
    vehicleOwnership: { findFirst: vi.fn().mockResolvedValue({ id: 'own-1' }) },
    interventionDispute: { findMany: vi.fn().mockResolvedValue([]) },
    attachment: { count: vi.fn().mockResolvedValue(0) },
    ...overrides,
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
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
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(meInterventionsRoutes);
  return app;
}

describe('GET /v1/me/interventions/:id (unit)', () => {
  it('returns intervention + disputes when the caller owns the vehicle', async () => {
    const app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { intervention: { id: string }; disputes: unknown[] };
    expect(body.intervention.id).toBe(INTERVENTION_ID);
    expect(body.disputes).toEqual([]);
    await app.close();
  });

  it('returns 404 me.intervention.not_found when no active ownership', async () => {
    const prisma = buildFakePrisma({
      vehicleOwnership: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
    await app.close();
  });

  it('returns 404 when the intervention does not exist', async () => {
    const prisma = buildFakePrisma({
      intervention: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-interventions.test.ts`
Expected: FAIL — `Cannot find module '.../me-interventions.js'`.

- [ ] **Step 3: Write the route**

```typescript
// packages/api/src/routes/v1/me-interventions.ts
// GET /v1/me/interventions/:id — F-CLI-206 customer view of a single shop
// intervention plus the caller's dispute thread on it (BR-128). The
// customer reaches this from the vehicle timeline; it powers the "Contesta"
// action and shows the officina's response.
//
// Auth chain: requireAuth -> requireClientiPool -> clientiContext.
//
// RLS: interventions SELECT is permissive (cross-tenant readable, migration
// 0003); intervention_disputes USING permits customer_id =
// current_customer_id(). role:'user' is therefore sufficient — no admin
// elevation needed. The privacy boundary is the application-side ownership
// gate below (the true frontier, never RLS alone — see feedback
// rls_only_endpoint_leaks_in_prod / PR #154): a non-owner gets a 404 with
// no existence leak.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { projectShopInterventionDetail } from '../../lib/customer-intervention-detail.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';
import { clientiContext } from '../../middleware/clienti-context.js';

const idParamSchema = z.object({ id: z.uuid() });

const meInterventionsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/v1/me/interventions/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' as const }, async (tx) => {
        const intervention = await tx.intervention.findFirst({
          where: { id },
          select: {
            id: true,
            vehicleId: true,
            interventionDate: true,
            odometerKm: true,
            title: true,
            description: true,
            partsReplaced: true,
            status: true,
            interventionType: { select: { code: true, nameIt: true } },
            tenant: { select: { businessName: true } },
            location: { select: { city: true } },
          },
        });
        if (!intervention) {
          throw businessError('me.intervention.not_found', 404, 'Intervento non trovato.');
        }

        // BR-120 frontier: only the current owner may read the detail.
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId: intervention.vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'me.intervention.not_found',
            404,
            'Intervento non trovato o non più di tua proprietà.',
          );
        }

        const [disputes, attachmentsCount] = await Promise.all([
          tx.interventionDispute.findMany({
            where: { interventionId: id, customerId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              reasonCategory: true,
              customerDescription: true,
              status: true,
              createdAt: true,
              tenantResponse: true,
              tenantResponseAt: true,
              resolvedAt: true,
            },
          }),
          tx.attachment.count({
            where: {
              ownerType: 'intervention',
              ownerId: id,
              processed: true,
              deletedAt: null,
            },
          }),
        ]);

        return projectShopInterventionDetail(intervention, disputes, attachmentsCount);
      });
    },
  );
};

export default meInterventionsRoutes;
```

- [ ] **Step 4: Register the route in `server.ts`**

In `packages/api/src/server.ts`, add the import alongside the other route imports:

```typescript
import meInterventionsRoutes from './routes/v1/me-interventions.js';
```

And register it alongside the other `me-*` registrations (near `meVehiclesRoutes` / `mePrivateInterventionRoutes`):

```typescript
  await app.register(meInterventionsRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/api exec vitest run tests/unit/routes/v1/me-interventions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
printf 'feat(api): GET /me/interventions/:id with dispute thread (F-CLI-206)' > /tmp/cm.txt
git add packages/api/src/routes/v1/me-interventions.ts packages/api/src/server.ts packages/api/tests/unit/routes/v1/me-interventions.test.ts
git commit -F /tmp/cm.txt
```

---

## Task 3: API integration test

**Files:**
- Create: `packages/api/tests/integration/me-interventions.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// packages/api/tests/integration/me-interventions.test.ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

async function seed(suffix: string) {
  const { tenantId, locationId } = await createTenantWithLocation(suffix);
  const { userId } = await createUser({ tenantId, cognitoSub: `mech-${suffix}`, locationId });
  const { customerId } = await createCustomer({ cognitoSub: `cust-${suffix}` });
  const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
  await createOwnership({ vehicleId, customerId });
  const tagliando = await ensureSystemInterventionType('TAGLIANDO');
  const { interventionId } = await createIntervention({
    tenantId,
    locationId,
    userId,
    vehicleId,
    interventionTypeId: tagliando.id,
    interventionDate: '2026-04-21',
    odometerKm: 45000,
    description: 'Tagliando con sostituzione olio',
  });
  return { tenantId, customerId, vehicleId, interventionId, cognitoSub: `cust-${suffix}` };
}

describe('GET /v1/me/interventions/:id (integration)', () => {
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

  it('returns the intervention and an empty dispute thread for the owner', async () => {
    const s = await seed('me-int-happy');
    const token = await signTestToken({ pool: 'clienti', sub: s.cognitoSub, customerId: s.customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { id: string; interventionDate: string; status: string; isDisputed: boolean };
      disputes: unknown[];
    };
    expect(body.intervention.id).toBe(s.interventionId);
    // @db.Date must serialize date-only (BR/feedback db_date_serialized_as_iso).
    expect(body.intervention.interventionDate).toBe('2026-04-21');
    expect(body.intervention.isDisputed).toBe(false);
    expect(body.disputes).toEqual([]);
  });

  it('includes the tenant response once the officina has replied', async () => {
    const s = await seed('me-int-resp');
    // Insert a responded dispute directly + flip the intervention to disputed.
    await pgAdmin.query(
      `INSERT INTO intervention_disputes
         (intervention_id, customer_id, reason_category, customer_description, status,
          tenant_response, tenant_response_at, updated_at)
       VALUES ($1, $2, 'wrong_data', 'I km sono errati e voglio una verifica', 'responded',
          'Abbiamo ricontrollato il tagliando', NOW(), NOW())`,
      [s.interventionId, s.customerId],
    );
    await pgAdmin.query(`UPDATE interventions SET status = 'disputed' WHERE id = $1`, [
      s.interventionId,
    ]);
    const token = await signTestToken({ pool: 'clienti', sub: s.cognitoSub, customerId: s.customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: { isDisputed: boolean };
      disputes: Array<{ status: string; tenantResponse: string | null }>;
    };
    expect(body.intervention.isDisputed).toBe(true);
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]).toMatchObject({
      status: 'responded',
      tenantResponse: 'Abbiamo ricontrollato il tagliando',
    });
  });

  it('returns 404 for a customer who does not own the vehicle (RLS + app gate)', async () => {
    const s = await seed('me-int-iso');
    const other = await createCustomer({ cognitoSub: 'cust-me-int-other' });
    const token = await signTestToken({
      pool: 'clienti',
      sub: 'cust-me-int-other',
      customerId: other.customerId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
  });

  it('rejects an officine-pool token (wrong pool)', async () => {
    const s = await seed('me-int-pool');
    const token = await signTestToken({ pool: 'officine', sub: 'mech-x', tenantId: s.tenantId, role: 'mechanic' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${s.interventionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

> Note: confirm the `signTestToken` officine signature against an existing integration test (e.g. `me-vehicles.test.ts`) — if the helper rejects unknown keys, copy the exact shape used there. The dispute insert column list mirrors `intervention_disputes` (snake_case) and includes `updated_at = NOW()` because `@updatedAt` is client-side only (feedback prisma_updatedat_raw_sql).

- [ ] **Step 2: Verify it compiles (typecheck only; integration runs on CI)**

Run: `pnpm --filter @garageos/api typecheck`
Expected: no errors. Do NOT run the integration suite locally (Docker — CLAUDE.md). CI executes it.

- [ ] **Step 3: Commit**

```bash
printf 'test(api): integration for GET /me/interventions/:id (F-CLI-206)' > /tmp/cm.txt
git add packages/api/tests/integration/me-interventions.test.ts
git commit -F /tmp/cm.txt
```

---

## Task 4: API docs (APPENDICE_A + APPENDICE_G)

**Files:**
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`

- [ ] **Step 1: Add the endpoint section to APPENDICE_A**

Add a new subsection near the other `/me/*` customer endpoints (e.g. after the vehicle timeline / access-log sections). Use this content:

```markdown
### 2.4c `GET /v1/me/interventions/:id` — Dettaglio intervento officina + contestazioni

**Feature:** F-CLI-206 · **Auth:** Customer (clienti pool)

Restituisce un singolo intervento officina e il **thread delle contestazioni del cliente** su di esso. Il chiamante deve essere il proprietario attuale del veicolo (gate app-layer); altrimenti `404`.

**Response 200:**
\```json
{
  "intervention": {
    "id": "uuid",
    "interventionDate": "2026-05-01",
    "odometerKm": 84210,
    "type": { "code": "TAGLIANDO", "name_it": "Tagliando" },
    "title": "Tagliando completo",
    "description": "...",
    "partsReplacedCount": 3,
    "status": "disputed",
    "isDisputed": true,
    "tenant": { "businessName": "Officina Rossi", "locationCity": "Milano" },
    "attachmentsCount": 2
  },
  "disputes": [
    {
      "id": "uuid",
      "reasonCategory": "wrong_data",
      "customerDescription": "...",
      "status": "responded",
      "createdAt": "2026-05-02T10:00:00.000Z",
      "tenantResponse": "...",
      "tenantResponseAt": "2026-05-03T09:00:00.000Z",
      "resolvedAt": null
    }
  ]
}
\```

**Errori:** `404 me.intervention.not_found` (intervento inesistente o veicolo non più di proprietà del cliente).
```

Also add a row to the customer endpoints index table (the `/me/*` table) for `GET /v1/me/interventions/:id`.

- [ ] **Step 2: Add the error code to APPENDICE_G**

Add `me.intervention.not_found` to the relevant table (status `404`, descrizione "Intervento non trovato o non più di proprietà del cliente") and to the alphabetical index.

- [ ] **Step 3: Format + commit**

```bash
pnpm exec prettier --write docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
printf 'docs(api): document GET /me/interventions/:id (F-CLI-206)' > /tmp/cm.txt
git add docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
git commit -F /tmp/cm.txt
```

---

## Task 5: Mobile types, labels, validator

**Files:**
- Create: `packages/mobile/src/lib/types/intervention.ts`
- Create: `packages/mobile/src/lib/dispute-labels.ts`
- Create: `packages/mobile/src/lib/validators/dispute.ts`
- Test: `packages/mobile/tests/unit/validators/dispute.test.ts`

- [ ] **Step 1: Write the failing validator test**

```typescript
// packages/mobile/tests/unit/validators/dispute.test.ts
import { validateDisputeForm } from '@/lib/validators/dispute';

describe('validateDisputeForm', () => {
  it('passes with a category and a 20..2000 char description', () => {
    const errors = validateDisputeForm({
      reasonCategory: 'wrong_data',
      description: 'I dati riportati su questo intervento sono errati.',
    });
    expect(errors).toEqual({});
  });

  it('requires a category', () => {
    const errors = validateDisputeForm({
      reasonCategory: null,
      description: 'I dati riportati su questo intervento sono errati.',
    });
    expect(errors.reasonCategory).toBeTruthy();
  });

  it('rejects a description shorter than 20 chars', () => {
    const errors = validateDisputeForm({ reasonCategory: 'other', description: 'troppo corta' });
    expect(errors.description).toBeTruthy();
  });

  it('rejects a description longer than 2000 chars', () => {
    const errors = validateDisputeForm({
      reasonCategory: 'other',
      description: 'a'.repeat(2001),
    });
    expect(errors.description).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- dispute`
Expected: FAIL — cannot find module `@/lib/validators/dispute`.

- [ ] **Step 3: Write types, labels, validator**

```typescript
// packages/mobile/src/lib/types/intervention.ts
// Mirror of GET /v1/me/interventions/:id (api/mobile share no package).
export type DisputeReasonCategory = 'not_performed' | 'wrong_data' | 'not_authorized' | 'other';
export type DisputeStatus =
  | 'open'
  | 'responded'
  | 'resolved_by_cancellation'
  | 'escalated'
  | 'closed_by_admin';

export type Dispute = {
  id: string;
  reasonCategory: DisputeReasonCategory;
  customerDescription: string;
  status: DisputeStatus;
  createdAt: string;
  tenantResponse: string | null;
  tenantResponseAt: string | null;
  resolvedAt: string | null;
};

export type ShopInterventionDetail = {
  intervention: {
    id: string;
    vehicleId: string;
    interventionDate: string;
    odometerKm: number;
    type: { code: string; name_it: string };
    title: string | null;
    description: string;
    partsReplacedCount: number;
    status: string;
    isDisputed: boolean;
    tenant: { businessName: string; locationCity: string | null };
    attachmentsCount: number;
  };
  disputes: Dispute[];
};

export type CreateDisputeBody = {
  reasonCategory: DisputeReasonCategory;
  description: string;
};
```

```typescript
// packages/mobile/src/lib/dispute-labels.ts
import type { DisputeReasonCategory, DisputeStatus } from '@/lib/types/intervention';

// BR-123 reason categories (Italian, user-facing).
export const REASON_CATEGORY_LABELS: Record<DisputeReasonCategory, string> = {
  not_performed: "L'intervento non è mai stato effettuato",
  wrong_data: 'I dati riportati sono errati (km, data, pezzi)',
  not_authorized: 'Non ho autorizzato questo intervento',
  other: 'Altro',
};

export const REASON_CATEGORY_ORDER: DisputeReasonCategory[] = [
  'not_performed',
  'wrong_data',
  'not_authorized',
  'other',
];

// BR-125 lifecycle states (Italian, user-facing).
export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Aperta',
  responded: 'Risposta ricevuta',
  resolved_by_cancellation: 'Risolta (intervento annullato)',
  escalated: 'In gestione GarageOS',
  closed_by_admin: 'Chiusa',
};

// A dispute is "active" (blocks a new one, BR-122) while open or responded.
export function isDisputeActive(status: DisputeStatus): boolean {
  return status === 'open' || status === 'responded';
}
```

```typescript
// packages/mobile/src/lib/validators/dispute.ts
// BR-123 (category required) + BR-124 (description 20..2000). Mirrors the
// server-side CreateDisputeSchema so the client blocks before the request.
import type { DisputeReasonCategory } from '@/lib/types/intervention';

export type DisputeFormErrors = {
  reasonCategory?: string;
  description?: string;
};

export function validateDisputeForm(input: {
  reasonCategory: DisputeReasonCategory | null;
  description: string;
}): DisputeFormErrors {
  const errors: DisputeFormErrors = {};
  if (!input.reasonCategory) {
    errors.reasonCategory = 'Seleziona una motivazione.';
  }
  const len = input.description.trim().length;
  if (len < 20) {
    errors.description = 'La descrizione deve contenere almeno 20 caratteri.';
  } else if (len > 2000) {
    errors.description = 'La descrizione non può superare i 2000 caratteri.';
  }
  return errors;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @garageos/mobile test -- dispute`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): dispute types, labels and form validator (F-CLI-206)' > /tmp/cm.txt
git add packages/mobile/src/lib/types/intervention.ts packages/mobile/src/lib/dispute-labels.ts packages/mobile/src/lib/validators/dispute.ts packages/mobile/tests/unit/validators/dispute.test.ts
git commit -F /tmp/cm.txt
```

---

## Task 6: Mobile query hooks (detail GET + dispute POST)

**Files:**
- Create: `packages/mobile/src/queries/meShopInterventionDetail.ts`
- Create: `packages/mobile/src/queries/createDispute.ts`
- Test: `packages/mobile/tests/queries/meShopInterventionDetail.test.tsx`
- Test: `packages/mobile/tests/queries/createDispute.test.tsx`

- [ ] **Step 1: Write the failing hook tests**

```tsx
// packages/mobile/tests/queries/meShopInterventionDetail.test.tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useMeShopInterventionDetail', () => {
  beforeEach(() => mockFetch.mockReset());

  it('GETs the intervention detail by id', async () => {
    mockFetch.mockResolvedValue({ intervention: { id: 'int-1' }, disputes: [] });
    const { result } = renderHook(() => useMeShopInterventionDetail('int-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith('/v1/me/interventions/int-1');
    expect(result.current.data?.intervention.id).toBe('int-1');
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useMeShopInterventionDetail(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

```tsx
// packages/mobile/tests/queries/createDispute.test.tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useCreateDispute } from '@/queries/createDispute';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

const invalidateSpy = jest.fn();
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.invalidateQueries = invalidateSpy as never;
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useCreateDispute', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    invalidateSpy.mockReset();
  });

  it('POSTs the dispute and invalidates the detail + timeline', async () => {
    mockFetch.mockResolvedValue({ dispute: { id: 'd-1' }, interventionStatus: 'disputed' });
    const { result } = renderHook(() => useCreateDispute('int-1', 'veh-1'), {
      wrapper: makeWrapper(),
    });
    await result.current.mutateAsync({ reasonCategory: 'wrong_data', description: 'x'.repeat(25) });
    expect(mockFetch).toHaveBeenCalledWith('/v1/interventions/int-1/dispute', {
      method: 'POST',
      body: { reasonCategory: 'wrong_data', description: 'x'.repeat(25) },
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'intervention', 'int-1'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle', 'veh-1', 'timeline'] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @garageos/mobile test -- meShopInterventionDetail createDispute`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the hooks**

```typescript
// packages/mobile/src/queries/meShopInterventionDetail.ts
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { ShopInterventionDetail } from '@/lib/types/intervention';

export function useMeShopInterventionDetail(id: string) {
  const api = useApiClient();
  return useQuery<ShopInterventionDetail, Error>({
    queryKey: ['me', 'intervention', id],
    queryFn: () => api.fetch<ShopInterventionDetail>(`/v1/me/interventions/${id}`),
    enabled: id.length > 0,
  });
}
```

```typescript
// packages/mobile/src/queries/createDispute.ts
// POSTs a customer dispute (F-CLI-206) and invalidates both the intervention
// detail and the vehicle timeline so the CONTESTATO badge appears.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { CreateDisputeBody } from '@/lib/types/intervention';

type CreateDisputeResponse = {
  dispute: { id: string };
  interventionStatus: string;
};

export function useCreateDispute(interventionId: string, vehicleId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<CreateDisputeResponse, Error, CreateDisputeBody>({
    mutationFn: (body) =>
      api.fetch<CreateDisputeResponse>(`/v1/interventions/${interventionId}/dispute`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'intervention', interventionId] });
      void qc.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'timeline'] });
    },
  });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @garageos/mobile test -- meShopInterventionDetail createDispute`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): query hooks for intervention detail + dispute (F-CLI-206)' > /tmp/cm.txt
git add packages/mobile/src/queries/meShopInterventionDetail.ts packages/mobile/src/queries/createDispute.ts packages/mobile/tests/queries/meShopInterventionDetail.test.tsx packages/mobile/tests/queries/createDispute.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 7: Mobile `DisputeForm` component

**Files:**
- Create: `packages/mobile/src/components/DisputeForm.tsx`
- Test: `packages/mobile/tests/components/DisputeForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/mobile/tests/components/DisputeForm.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DisputeForm } from '@/components/DisputeForm';

describe('DisputeForm', () => {
  it('renders the four reason categories', () => {
    render(<DisputeForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText("L'intervento non è mai stato effettuato")).toBeTruthy();
    expect(screen.getByText('I dati riportati sono errati (km, data, pezzi)')).toBeTruthy();
    expect(screen.getByText('Non ho autorizzato questo intervento')).toBeTruthy();
    expect(screen.getByText('Altro')).toBeTruthy();
  });

  it('blocks submit and shows a field error when description is too short', async () => {
    const onSubmit = jest.fn();
    render(<DisputeForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByText('Altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Descrivi il motivo della contestazione'), 'corta');
    fireEvent.press(screen.getByText('Invia contestazione'));
    await waitFor(() =>
      expect(screen.getByText('La descrizione deve contenere almeno 20 caratteri.')).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with the chosen category and description', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<DisputeForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByText('I dati riportati sono errati (km, data, pezzi)'));
    fireEvent.changeText(
      screen.getByPlaceholderText('Descrivi il motivo della contestazione'),
      'I chilometri riportati non corrispondono al cruscotto.',
    );
    fireEvent.press(screen.getByText('Invia contestazione'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        reasonCategory: 'wrong_data',
        description: 'I chilometri riportati non corrispondono al cruscotto.',
      }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- DisputeForm`
Expected: FAIL — cannot find module `@/components/DisputeForm`.

- [ ] **Step 3: Write the component** (mirrors `PrivateInterventionForm`: banner + field errors + submitting state)

```tsx
// packages/mobile/src/components/DisputeForm.tsx
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateDisputeForm, type DisputeFormErrors } from '@/lib/validators/dispute';
import { REASON_CATEGORY_LABELS, REASON_CATEGORY_ORDER } from '@/lib/dispute-labels';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { CreateDisputeBody, DisputeReasonCategory } from '@/lib/types/intervention';
import { colors, spacing } from '@/theme/colors';

export type DisputeFormResult = { ok: true } | { ok: false; code: string; message?: string };

type Props = {
  onSubmit: (body: CreateDisputeBody) => Promise<DisputeFormResult>;
  onCancel: () => void;
};

export function DisputeForm({ onSubmit, onCancel }: Props) {
  const [reasonCategory, setReasonCategory] = useState<DisputeReasonCategory | null>(null);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<DisputeFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (submitting) return;
    const v = validateDisputeForm({ reasonCategory, description });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const result = await onSubmit({
        reasonCategory: reasonCategory!,
        description: description.trim(),
      });
      if (result.ok) return; // parent navigates away
      setBanner(result.message ?? mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Motivazione</Text>
        {REASON_CATEGORY_ORDER.map((cat) => {
          const selected = reasonCategory === cat;
          return (
            <Pressable
              key={cat}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => !submitting && setReasonCategory(cat)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                {REASON_CATEGORY_LABELS[cat]}
              </Text>
            </Pressable>
          );
        })}
        {errors.reasonCategory ? (
          <Text style={styles.fieldError}>{errors.reasonCategory}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Descrizione ({description.trim().length}/2000)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Descrivi il motivo della contestazione"
          multiline
          numberOfLines={6}
          editable={!submitting}
        />
        {errors.description ? <Text style={styles.fieldError}>{errors.description}</Text> : null}
      </View>

      <Pressable
        onPress={handleSubmit}
        accessibilityRole="button"
        disabled={submitting}
        style={({ pressed }) => [
          styles.submit,
          pressed && styles.submitPressed,
          submitting && styles.submitDisabled,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryFg} />
        ) : (
          <Text style={styles.submitText}>Invia contestazione</Text>
        )}
      </Pressable>

      <Pressable onPress={onCancel} accessibilityRole="button" disabled={submitting} style={styles.cancel}>
        <Text style={styles.cancelText}>Annulla</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.dangerBg },
  optionText: { fontSize: 15, color: colors.fg },
  optionTextSelected: { fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.fg,
    backgroundColor: colors.bg,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  submit: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitPressed: { opacity: 0.8 },
  submitDisabled: { backgroundColor: colors.muted },
  submitText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
```

> If `colors.dangerBg` / `colors.border` are absent in `theme/colors.ts`, reuse the closest token already used by `PrivateInterventionForm` (it references `colors.dangerBg`, `colors.border`, `colors.danger`, `colors.primary`, `colors.primaryFg`, `colors.muted`, `colors.fg`, `colors.bg`) — all confirmed present there.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @garageos/mobile test -- DisputeForm`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): DisputeForm component (F-CLI-206)' > /tmp/cm.txt
git add packages/mobile/src/components/DisputeForm.tsx packages/mobile/tests/components/DisputeForm.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 8: Mobile detail + dispute screens

**Files:**
- Create: `packages/mobile/src/components/BadgeContestato.tsx`
- Create: `packages/mobile/app/interventions/[id].tsx`
- Create: `packages/mobile/app/interventions/[id]/dispute.tsx`
- Test: `packages/mobile/tests/screens/intervention-detail.test.tsx`

- [ ] **Step 1: Write the failing screen test**

```tsx
// packages/mobile/tests/screens/intervention-detail.test.tsx
import { render, screen } from '@testing-library/react-native';
import React from 'react';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

const mockDetail = { data: undefined as unknown, isLoading: false, isError: false, refetch: jest.fn() };
jest.mock('@/queries/meShopInterventionDetail', () => ({
  useMeShopInterventionDetail: () => mockDetail,
}));

import InterventionDetailScreen from '@/../app/interventions/[id]';

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    intervention: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      interventionDate: '2026-05-01',
      odometerKm: 84210,
      type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando completo',
      description: 'desc',
      partsReplacedCount: 2,
      status: 'active',
      isDisputed: false,
      tenant: { businessName: 'Officina Rossi', locationCity: 'Milano' },
      attachmentsCount: 0,
    },
    disputes: [],
    ...overrides,
  };
}

describe('InterventionDetailScreen', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockDetail.isLoading = false;
    mockDetail.isError = false;
  });

  it('shows the "Contesta" button when there is no active dispute', () => {
    mockDetail.data = baseData();
    render(<InterventionDetailScreen />);
    expect(screen.getByText('Contesta intervento')).toBeTruthy();
  });

  it('hides "Contesta" and shows the thread when a dispute is active', () => {
    mockDetail.data = baseData({
      intervention: { ...baseData().intervention, isDisputed: true, status: 'disputed' },
      disputes: [
        {
          id: 'd-1',
          reasonCategory: 'wrong_data',
          customerDescription: 'I km sono errati',
          status: 'responded',
          createdAt: '2026-05-02T10:00:00.000Z',
          tenantResponse: 'Verificato',
          tenantResponseAt: '2026-05-03T09:00:00.000Z',
          resolvedAt: null,
        },
      ],
    });
    render(<InterventionDetailScreen />);
    expect(screen.queryByText('Contesta intervento')).toBeNull();
    expect(screen.getByText('Risposta ricevuta')).toBeTruthy();
    expect(screen.getByText('Verificato')).toBeTruthy();
  });

  it('renders a LoadingState while pending without data (offline-paused safe)', () => {
    mockDetail.data = undefined;
    mockDetail.isLoading = false;
    render(<InterventionDetailScreen />);
    // No crash on intervention.* access; the screen must guard on !data.
    expect(screen.queryByText('Contesta intervento')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- intervention-detail`
Expected: FAIL — cannot find module `app/interventions/[id]`.

- [ ] **Step 3: Write `BadgeContestato`**

```tsx
// packages/mobile/src/components/BadgeContestato.tsx
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

export function BadgeContestato() {
  return (
    <View accessibilityLabel="Intervento contestato" style={styles.pill}>
      <Text style={styles.text}>Contestato</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    alignSelf: 'flex-start',
    backgroundColor: colors.danger,
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: colors.primaryFg,
  },
});
```

- [ ] **Step 4: Write the detail screen** (guards `!data` to avoid the offline-paused `data!` crash — feedback react_query_data_bang_offline_paused)

```tsx
// packages/mobile/app/interventions/[id].tsx
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { BadgeContestato } from '@/components/BadgeContestato';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { formatDate, formatKm } from '@/lib/format';
import {
  DISPUTE_STATUS_LABELS,
  REASON_CATEGORY_LABELS,
  isDisputeActive,
} from '@/lib/dispute-labels';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function InterventionDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const router = useRouter();
  const detail = useMeShopInterventionDetail(id);

  if (!id) return <ErrorState message="Intervento non valido." />;
  if (detail.isLoading || !detail.data) {
    if (detail.isError) {
      const code = detail.error instanceof ApiError ? detail.error.code : undefined;
      return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
    }
    return <LoadingState variant="fullscreen" />;
  }

  const { intervention, disputes } = detail.data;
  const hasActiveDispute = disputes.some((d) => isDisputeActive(d.status));

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Intervento' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.badgeRow}>
            {intervention.isDisputed ? <BadgeContestato /> : null}
            <Text style={styles.tenant}>
              {intervention.tenant.businessName}
              {intervention.tenant.locationCity ? ` · ${intervention.tenant.locationCity}` : ''}
            </Text>
          </View>
          <Text style={styles.title}>{intervention.title ?? intervention.type.name_it}</Text>
          <Text style={styles.meta}>
            {formatDate(intervention.interventionDate)} · {formatKm(intervention.odometerKm)}
          </Text>
          {intervention.description ? (
            <Text style={styles.description}>{intervention.description}</Text>
          ) : null}
        </View>

        {disputes.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Contestazioni</Text>
            {disputes.map((d) => (
              <View key={d.id} style={styles.dispute}>
                <Text style={styles.disputeStatus}>{DISPUTE_STATUS_LABELS[d.status]}</Text>
                <Text style={styles.disputeReason}>{REASON_CATEGORY_LABELS[d.reasonCategory]}</Text>
                <Text style={styles.disputeBody}>{d.customerDescription}</Text>
                {d.tenantResponse ? (
                  <View style={styles.response}>
                    <Text style={styles.responseLabel}>Risposta dell'officina</Text>
                    <Text style={styles.disputeBody}>{d.tenantResponse}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {!hasActiveDispute ? (
          <Pressable
            accessibilityRole="button"
            style={styles.disputeBtn}
            onPress={() => router.push(`/interventions/${id}/dispute`)}
          >
            <Text style={styles.disputeBtnText}>Contesta intervento</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: { gap: spacing.xs },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tenant: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: colors.fg },
  meta: { fontSize: 13, color: colors.muted },
  description: { fontSize: 15, color: colors.fg, marginTop: spacing.xs },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.fg },
  dispute: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  disputeStatus: { fontSize: 12, fontWeight: '700', color: colors.danger, textTransform: 'uppercase' },
  disputeReason: { fontSize: 14, fontWeight: '600', color: colors.fg },
  disputeBody: { fontSize: 14, color: colors.fg },
  response: { marginTop: spacing.sm, gap: spacing.xs, paddingLeft: spacing.md, borderLeftWidth: 2, borderLeftColor: colors.primary },
  responseLabel: { fontSize: 12, fontWeight: '600', color: colors.muted },
  disputeBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  disputeBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
});
```

- [ ] **Step 5: Write the dispute form screen**

```tsx
// packages/mobile/app/interventions/[id]/dispute.tsx
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { DisputeForm, type DisputeFormResult } from '@/components/DisputeForm';
import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';
import { useCreateDispute } from '@/queries/createDispute';
import { ApiError } from '@/lib/api-error';
import type { CreateDisputeBody } from '@/lib/types/intervention';
import { colors } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function DisputeScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const router = useRouter();
  // The vehicleId is needed to invalidate the timeline; read it from the
  // cached detail (already fetched on the previous screen — same query key).
  const detail = useMeShopInterventionDetail(id);
  const vehicleId = detail.data?.intervention.vehicleId ?? '';
  const create = useCreateDispute(id, vehicleId);

  async function onSubmit(body: CreateDisputeBody): Promise<DisputeFormResult> {
    try {
      await create.mutateAsync(body);
      router.back();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Contesta intervento' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <DisputeForm onSubmit={onSubmit} onCancel={() => router.back()} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
```

> **vehicleId for timeline invalidation:** `vehicleId` is part of the detail DTO (added in Tasks 1, 2, 5). The form screen reads it from the cached detail (`useMeShopInterventionDetail(id)` hits the same `['me','intervention',id]` query already populated by the detail screen) and passes it to `useCreateDispute(id, vehicleId)`, which invalidates `['vehicle', vehicleId, 'timeline']`. No navigation param threading needed. If `detail.data` is somehow cold (cache evicted), `vehicleId` is `''` and only the detail key is invalidated — the timeline still refetches on its next mount; acceptable degradation.

- [ ] **Step 6: Remove stale router types + run tests**

```bash
rm -f packages/mobile/.expo/types/router.d.ts
pnpm --filter @garageos/mobile test -- intervention-detail
```
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
printf 'feat(mobile): shop intervention detail + dispute screens (F-CLI-206)' > /tmp/cm.txt
git add packages/mobile/src/components/BadgeContestato.tsx packages/mobile/app/interventions packages/mobile/tests/screens/intervention-detail.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 9: TimelineRow badge + tappable shop rows + error messages

**Files:**
- Modify: `packages/mobile/src/components/TimelineRow.tsx`
- Modify: `packages/mobile/app/(tabs)/vehicles/[id].tsx`
- Modify: `packages/mobile/src/lib/error-messages.ts`
- Test: update `packages/mobile/tests/components/TimelineRow.test.tsx`

- [ ] **Step 1: Add the failing TimelineRow test cases**

Append to `packages/mobile/tests/components/TimelineRow.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { TimelineRow } from '@/components/TimelineRow';

const shopItem = {
  kind: 'shop_intervention' as const,
  id: 'int-1',
  intervention_date: '2026-05-01',
  odometer_km: 84210,
  type: { id: 't', code: 'TAGLIANDO', name_it: 'Tagliando' },
  title: 'Tagliando',
  description: null,
  parts_replaced_count: 0,
  status: 'disputed',
  is_disputed: true,
  wiki_window_open: false,
  tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
  has_attachments: false,
  attachments_count: 0,
};

describe('TimelineRow dispute affordances', () => {
  it('shows the CONTESTATO badge when is_disputed', () => {
    render(<TimelineRow item={shopItem} />);
    expect(screen.getByText('Contestato')).toBeTruthy();
  });

  it('does not show the badge when not disputed', () => {
    render(<TimelineRow item={{ ...shopItem, is_disputed: false }} />);
    expect(screen.queryByText('Contestato')).toBeNull();
  });

  it('fires onPress for shop interventions', () => {
    const onPress = jest.fn();
    render(<TimelineRow item={shopItem} onPress={onPress} />);
    fireEvent.press(screen.getByText('Tagliando'));
    expect(onPress).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify the badge cases fail**

Run: `pnpm --filter @garageos/mobile test -- TimelineRow`
Expected: FAIL — "Contestato" not found (badge not yet rendered).

- [ ] **Step 3: Render the badge in TimelineRow**

In `packages/mobile/src/components/TimelineRow.tsx`, import the badge:

```tsx
import { BadgeContestato } from './BadgeContestato';
```

In the `badgeRow` View, after the existing `BadgeCertificato`, add (only for shop interventions that are disputed):

```tsx
        <View style={styles.badgeRow}>
          <BadgeCertificato variant={isShop ? 'certificato' : 'privato'} />
          {isShop && item.is_disputed ? <BadgeContestato /> : null}
          {isShop ? <Text style={styles.tenantName}>{item.tenant.business_name}</Text> : null}
        </View>
```

- [ ] **Step 4: Run to verify TimelineRow passes**

Run: `pnpm --filter @garageos/mobile test -- TimelineRow`
Expected: PASS.

- [ ] **Step 5: Make shop rows tappable in HistoryTab**

In `packages/mobile/app/(tabs)/vehicles/[id].tsx`, the `renderItem` currently only wires `onPress` for private interventions. Change it to also navigate for shop interventions:

```tsx
          renderItem={({ item }) => (
            <TimelineRow
              item={item}
              onPress={() =>
                router.push(
                  item.kind === 'private_intervention'
                    ? `/private-interventions/${item.id}`
                    : `/interventions/${item.id}`,
                )
              }
            />
          )}
```

- [ ] **Step 6: Add dispute error messages**

In `packages/mobile/src/lib/error-messages.ts`, add these entries to the `MESSAGES` map:

```typescript
  // Dispute domain codes (F-CLI-206)
  'me.intervention.not_found': 'Intervento non trovato o non più di tua proprietà.',
  'intervention.dispute.not_owner':
    'Solo il proprietario attuale può contestare questo intervento.',
  'intervention.dispute.already_exists':
    'Hai già una contestazione aperta per questo intervento.',
  'intervention.dispute.intervention_cancelled':
    'Non puoi contestare un intervento annullato.',
```

- [ ] **Step 7: Run the full mobile suite + typecheck**

```bash
rm -f packages/mobile/.expo/types/router.d.ts
pnpm --filter @garageos/mobile test
pnpm --filter @garageos/mobile typecheck
```
Expected: all suites PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
printf 'feat(mobile): CONTESTATO badge + tappable shop rows + error copy (F-CLI-206)' > /tmp/cm.txt
git add packages/mobile/src/components/TimelineRow.tsx "packages/mobile/app/(tabs)/vehicles/[id].tsx" packages/mobile/src/lib/error-messages.ts packages/mobile/tests/components/TimelineRow.test.tsx
git commit -F /tmp/cm.txt
```

---

## Final verification + PR

- [ ] **Step 1: Full typecheck across workspaces**

Run: `pnpm -r typecheck`
Expected: no errors (this is the pre-push gate).

- [ ] **Step 2: API + mobile unit suites locally (no integration — CI)**

```bash
pnpm --filter @garageos/api exec vitest run tests/unit/lib/customer-intervention-detail.test.ts tests/unit/routes/v1/me-interventions.test.ts
pnpm --filter @garageos/mobile test
```
Expected: PASS.

- [ ] **Step 3: Push + open PR**

```bash
git push origin feat/cli-206-dispute-mobile
gh pr create --title "feat(api,mobile): customer dispute intervention (F-CLI-206)" --body "<fill from PR template: What / Why F-CLI-206 + BR-120/122/123/124/127/128 / new GET /me/interventions/:id + mobile detail+dispute screens / text-only (attachments deferred) / Tests>"
```

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on failure.

---

## Self-Review (plan author)

**Spec coverage:**
- Endpoint `GET /v1/me/interventions/:id` → Tasks 1-4. ✓
- Mobile detail screen + dispute thread + officina response → Task 8. ✓
- Dispute form (text-only, 4 categories, 20-2000) → Tasks 5, 7. ✓
- CONTESTATO badge (BR-127) + tappable shop rows → Task 9. ✓
- Error handling (403/409/422/404) → Task 9 Step 6 + DisputeForm banner. ✓
- Docs (APPENDICE_A + G) → Task 4. ✓
- Tests (API unit + integration, mobile unit/component/screen) → every task. ✓

**Placeholder scan:** `vehicleId` is folded into the DTO from Tasks 1/2/5 and read from the cached detail in the dispute screen — no ambiguity, no retrofit. No remaining TODO/TBD.

**Type consistency:** `ShopInterventionDetail`/`Dispute`/`DisputeReasonCategory`/`DisputeStatus` defined in Task 5 and used in Tasks 6-8. `CreateDisputeBody` in Task 5, consumed in Tasks 6-7. `projectShopInterventionDetail(row, disputes, attachmentsCount)` signature consistent Tasks 1-2-8. Query keys: detail `['me','intervention',id]` and timeline `['vehicle',vehicleId,'timeline']` consistent across Task 6 hooks and invalidations. Reason category enum values match the server `CreateDisputeSchema` (`not_performed`/`wrong_data`/`not_authorized`/`other`).

**Note for executor:** `vehicleId` is included in the serializer (Task 1), route select (Task 2), and mobile type (Task 5) from the start, so no later task needs to retrofit API files. Execute tasks in order.
```


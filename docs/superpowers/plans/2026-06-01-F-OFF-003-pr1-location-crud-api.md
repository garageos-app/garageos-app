# F-OFF-003 PR1 — Location CRUD API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST`/`PATCH`/`DELETE /v1/tenants/me/locations[/:id]` so a super_admin can create, edit, promote-to-primary, and deactivate the tenant's locations.

**Architecture:** One Fastify plugin file (`tenants-locations-write.ts`) hosting all three handlers behind the existing auth chain (`requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin`). Writes go through `app.withContext({ tenantId }, …)`; the `locations_write` RLS policy (`FOR ALL USING/WITH CHECK (is_admin_role() OR tenant_id = current_tenant_id())`, migration `20260427120000`) makes `{ tenantId }` sufficient. Primary swap is an atomic two-statement transaction (demote old primary → promote target) to respect the partial unique index `uq_locations_tenant_primary` (BR-201). No DB migration.

**Tech Stack:** Fastify, Zod (`.strict()`/`.partial()`), Prisma, Vitest + Testcontainers (integration), `businessError(code, status, detail)` for domain 4xx.

**Testing note (project rule, CLAUDE.md):** Do NOT run `test:integration` locally (Docker freezes Windows). Local gate per task = `pnpm -r typecheck` (and, since these are route handlers, `pnpm --filter @garageos/api test:unit` to catch FakePrisma/registration breaks). Integration suite runs on CI — push and watch `gh pr checks --watch`. The "Run … Expected FAIL/PASS" steps below describe the CI outcome; locally you verify typecheck + unit.

**Pre-flight facts already verified (do not re-litigate):**
- Schema `Location` + partial unique index BR-201 exist; **no migration**.
- RLS: `locations_read` permissive (`USING true`) → tenant filter must be **application-side** (`where: { id, tenantId, deletedAt: null }`), never `findFirst({ id })` alone. `locations_write` is tenant-scoped (`{ tenantId }` context is enough).
- `businessError` sets `err.name = code`; dotted codes pass the global handler → Problem+JSON. P2025 from Prisma maps to 404 by the shared handler, but we throw an explicit `…not_found` for testability.
- Test helpers: `createTenantWithLocation(suffix) → { tenantId, locationId }` (primary 'Sede', MI), `createUser({ tenantId, cognitoSub, role, locationId, email })`, `signTestToken({ pool:'officine', sub, tenantId, role })`, `resetDb()`, `pgAdmin`, `buildTestServer()`.
- `requireSuperAdmin` → 403 `auth.forbidden.super_admin_required` for mechanic.

---

## File Structure

- **Create** `packages/api/src/routes/v1/tenants-locations-write.ts` — POST/PATCH/DELETE handlers + shared Zod schema + `LOCATION_SELECT` + response serializer.
- **Modify** `packages/api/src/server.ts` — import + register the new plugin (next to `tenantsLocationsListRoutes`).
- **Create** `packages/api/tests/integration/tenants-locations-write.test.ts` — integration suite (3 describe blocks).
- **Modify** `docs/APPENDICE_G_ERROR_CODES.md` — §3.3, add 6 location codes.
- **Modify** `docs/APPENDICE_A_API.md` — detailed section for the 3 endpoints (replace the one-line table rows' "[DETTAGLIATO sotto]" gap).

Shared constants used across handlers (define once in the route file):

```ts
const LOCATION_SELECT = {
  id: true, name: true, addressLine: true, city: true, province: true,
  postalCode: true, country: true, phone: true, email: true,
  isPrimary: true, status: true, createdAt: true, updatedAt: true,
} as const;
```

Response wrapper is `{ location: <row> }` (parallel to the list's `{ locations: [...] }`).

Error codes (all under `tenants.me.locations.`):

| Code | Status | When |
|---|---|---|
| `tenants.me.locations.not_found` | 404 | `:id` not in tenant or soft-deleted |
| `tenants.me.locations.update.empty_body` | 422 | PATCH `{}` |
| `tenants.me.locations.update.unknown_field` | 422 | POST/PATCH unknown key |
| `tenants.me.locations.cannot_unset_primary` | 422 | PATCH `isPrimary:false` |
| `tenants.me.locations.cannot_delete_primary` | 422 | DELETE primary |
| `tenants.me.locations.has_active_users` | 422 | DELETE with active mechanics assigned |

---

## Task 1: POST create location

**Files:**
- Create: `packages/api/src/routes/v1/tenants-locations-write.ts`
- Modify: `packages/api/src/server.ts` (import ~line 57, register ~line 161)
- Create: `packages/api/tests/integration/tenants-locations-write.test.ts`

- [ ] **Step 1: Write the route file with the POST handler + shared schema**

Create `packages/api/src/routes/v1/tenants-locations-write.ts`:

```ts
// POST/PATCH/DELETE /v1/tenants/me/locations — F-OFF-003 location CRUD.
// Super Admin only. See BR-200/BR-201/BR-204/BR-205 and the design spec
// docs/superpowers/specs/2026-06-01-F-OFF-003-location-crud-design.md.
//
// RLS: locations_read is permissive (USING true) so every read filters
// tenantId application-side; locations_write is tenant-scoped, so a
// withContext({ tenantId }) is sufficient for INSERT/UPDATE.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const LOCATION_SELECT = {
  id: true, name: true, addressLine: true, city: true, province: true,
  postalCode: true, country: true, phone: true, email: true,
  isPrimary: true, status: true, createdAt: true, updatedAt: true,
} as const;

// Shared field rules (regex mirrored from tenants-update.ts).
const name = z.string().trim().min(1).max(200);
const addressLine = z.string().trim().min(1).max(255);
const city = z.string().trim().min(1).max(100);
const province = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere'));
const postalCode = z.string().regex(/^[0-9]{5}$/, 'CAP: 5 cifre');
const country = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Country: 2 lettere'))
  .default('IT');
const phone = z.string().regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido');
const email = z.email('Email non valida');

// POST body: all address fields required, isPrimary NOT accepted
// (a new location is always secondary; promotion happens via PATCH).
const createSchema = z
  .object({
    name,
    addressLine,
    city,
    province,
    postalCode,
    country,
    phone: phone.nullish(),
    email: email.nullish(),
  })
  .strict();

const tenantsLocationsWriteRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/me/locations',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'tenants.me.locations.update.unknown_field',
            422,
            'Campo non riconosciuto.',
          );
        }
        throw parsed.error;
      }
      const b = parsed.data;
      const tenantId = request.tenantId!;

      const created = await app.withContext({ tenantId }, (tx) =>
        tx.location.create({
          data: {
            tenantId,
            name: b.name,
            addressLine: b.addressLine,
            city: b.city,
            province: b.province,
            postalCode: b.postalCode,
            country: b.country,
            phone: b.phone ?? null,
            email: b.email ?? null,
            isPrimary: false,
            status: 'active',
          },
          select: LOCATION_SELECT,
        }),
      );

      return reply.code(201).send({ location: created });
    },
  );
};

export default tenantsLocationsWriteRoutes;
```

- [ ] **Step 2: Register the plugin in `server.ts`**

Add the import next to the existing locations-list import (~line 57):

```ts
import tenantsLocationsWriteRoutes from './routes/v1/tenants-locations-write.js';
```

Add the registration next to the existing one (~line 161, right after `await app.register(tenantsLocationsListRoutes);`):

```ts
  await app.register(tenantsLocationsWriteRoutes);
```

- [ ] **Step 3: Write the failing integration test (POST describe block)**

Create `packages/api/tests/integration/tenants-locations-write.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Unique remoteAddress per file to isolate any global rate-limit bucket
// (feedback_integration_test_rate_limit_isolation).
const TEST_IP = '10.20.41.1';

async function superAdminToken(tenantId: string, locationId: string) {
  const sub = `sa-locw-${crypto.randomUUID()}`;
  await createUser({ tenantId, cognitoSub: sub, email: `${sub}@locw.test`, role: 'super_admin', locationId });
  return signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });
}

describe('POST /v1/tenants/me/locations', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await resetDb(); });

  it('creates a secondary location (isPrimary=false, active)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: TEST_IP,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Sede Roma', addressLine: 'Via Roma 1', city: 'Roma',
        province: 'rm', postalCode: '00100', phone: '+39 06 1234567',
      },
    });

    expect(res.statusCode).toBe(201);
    const { location } = res.json() as { location: Record<string, unknown> };
    expect(location.isPrimary).toBe(false);
    expect(location.status).toBe('active');
    expect(location.province).toBe('RM'); // uppercased
    expect(location.country).toBe('IT'); // default
    expect(location.email).toBeNull();
  });

  it('rejects isPrimary in POST body as unknown_field (422)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-prim');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: TEST_IP,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'X', addressLine: 'Via 1', city: 'Roma', province: 'RM',
        postalCode: '00100', isPrimary: true,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.unknown_field');
  });

  it('returns 403 for mechanic', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-403');
    const sub = `mech-locw-${crypto.randomUUID()}`;
    await createUser({ tenantId, cognitoSub: sub, email: `${sub}@locw.test`, role: 'mechanic', locationId });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'mechanic' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: TEST_IP,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X', addressLine: 'Via 1', city: 'Roma', province: 'RM', postalCode: '00100' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });

  it('returns 400 VALIDATION_ERROR on malformed province', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-val');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: TEST_IP,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X', addressLine: 'Via 1', city: 'Roma', province: 'ROMA', postalCode: '00100' },
    });

    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Verify locally what can be verified**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (no type errors).

Run: `pnpm --filter @garageos/api test:unit`
Expected: PASS (route registration doesn't break existing unit suites).

(Integration verified on CI after push — Expected: PASS for the 4 POST tests.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/tenants-locations-write.ts packages/api/src/server.ts packages/api/tests/integration/tenants-locations-write.test.ts
git commit -m "feat(api): POST /v1/tenants/me/locations create endpoint (F-OFF-003)"
```

---

## Task 2: PATCH update + primary swap

**Files:**
- Modify: `packages/api/src/routes/v1/tenants-locations-write.ts`
- Modify: `packages/api/tests/integration/tenants-locations-write.test.ts`

- [ ] **Step 1: Add the PATCH schema + handler**

In `tenants-locations-write.ts`, add the update schema after `createSchema`:

```ts
// PATCH body: every field optional; isPrimary accepted as boolean so the
// handler can return 422 cannot_unset_primary on explicit false (a bare
// z.literal(true) would surface a generic 400 instead).
const updateSchema = z
  .object({
    name,
    addressLine,
    city,
    province,
    postalCode,
    country,
    phone: phone.nullable(),
    email: email.nullable(),
    isPrimary: z.boolean(),
  })
  .partial()
  .strict();

const ADDRESS_KEYS = [
  'name', 'addressLine', 'city', 'province', 'postalCode', 'country', 'phone', 'email',
] as const;
```

Add the handler inside the plugin (after the `app.post(...)` block):

```ts
  app.patch<{ Params: { id: string } }>(
    '/v1/tenants/me/locations/:id',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'tenants.me.locations.update.unknown_field',
            422,
            'Campo non riconosciuto.',
          );
        }
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'tenants.me.locations.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }
      if (body.isPrimary === false) {
        throw businessError(
          'tenants.me.locations.cannot_unset_primary',
          422,
          'Per cambiare la sede primaria, designa un’altra sede come primaria.',
        );
      }

      const { id } = request.params;
      const tenantId = request.tenantId!;
      const promote = body.isPrimary === true;

      // Build the address patch (exactOptionalPropertyTypes-safe).
      const patch: Record<string, unknown> = {};
      for (const k of ADDRESS_KEYS) {
        if (k in body) patch[k] = body[k] ?? null;
      }

      return app.withContext({ tenantId }, async (tx) => {
        // Application-side tenant guard (SELECT RLS is permissive).
        const target = await tx.location.findFirst({
          where: { id, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!target) {
          throw businessError('tenants.me.locations.not_found', 404, 'Sede non trovata.');
        }

        if (promote) {
          // Demote the current active primary first to respect
          // uq_locations_tenant_primary (BR-201), then promote target.
          await tx.location.updateMany({
            where: { tenantId, isPrimary: true, status: 'active', deletedAt: null, NOT: { id } },
            data: { isPrimary: false },
          });
          patch.isPrimary = true;
        }

        const updated = await tx.location.update({
          where: { id },
          data: patch,
          select: LOCATION_SELECT,
        });
        return { location: updated };
      });
    },
  );
```

- [ ] **Step 2: Add the failing PATCH integration tests**

Append to `tenants-locations-write.test.ts`:

```ts
describe('PATCH /v1/tenants/me/locations/:id', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await resetDb(); });

  const TEST_IP_P = '10.20.42.1';

  async function secondaryLocation(tenantId: string, name = 'Sede 2') {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations (id, tenant_id, name, address_line, city, province,
         postal_code, country, is_primary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Via 2', 'Roma', 'RM', '00100', 'IT',
         false, 'active'::"LocationStatus", NOW(), NOW()) RETURNING id`,
      [tenantId, name],
    );
    return rows[0]!.id;
  }

  it('edits address fields', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-patch');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${token}` },
      payload: { city: 'Torino', province: 'to' },
    });

    expect(res.statusCode).toBe(200);
    const { location } = res.json() as { location: Record<string, unknown> };
    expect(location.city).toBe('Torino');
    expect(location.province).toBe('TO');
  });

  it('promotes a secondary to primary, demoting the old primary (exactly one primary)', async () => {
    const { tenantId, locationId: primaryId } = await createTenantWithLocation('locw-swap');
    const token = await superAdminToken(tenantId, primaryId);
    const secId = await secondaryLocation(tenantId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${token}` },
      payload: { isPrimary: true },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { location: { isPrimary: boolean } }).location.isPrimary).toBe(true);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM locations
       WHERE tenant_id = $1 AND is_primary = true AND status = 'active' AND deleted_at IS NULL`,
      [tenantId],
    );
    expect(rows[0]!.count).toBe('1');
    const { rows: oldPrimary } = await pgAdmin.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM locations WHERE id = $1`, [primaryId],
    );
    expect(oldPrimary[0]!.is_primary).toBe(false);
  });

  it('rejects explicit isPrimary:false (422 cannot_unset_primary)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-unset');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${token}` },
      payload: { isPrimary: false },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.cannot_unset_primary');
  });

  it('rejects empty body (422 empty_body)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-empty');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.empty_body');
  });

  it('rejects unknown field (422 unknown_field)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-unk');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.unknown_field');
  });

  it('returns 404 for a location of another tenant', async () => {
    const { tenantId: tA, locationId: lA } = await createTenantWithLocation('locw-iso-A');
    const { tenantId: tB } = await createTenantWithLocation('locw-iso-B');
    const tokenB = await superAdminToken(tB, (await createTenantWithLocation('locw-iso-Bx')).locationId);
    // Use a real super_admin of tenant B; target tenant A's location.
    void tA;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${lA}`,
      remoteAddress: TEST_IP_P,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { city: 'Hack' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('tenants.me.locations.not_found');
  });
});
```

> Note on the 404 test: `superAdminToken` seeds the super_admin in the token's own tenant; the body targets tenant A's `lA`, which the application-side `findFirst({ id, tenantId })` filter excludes → 404. The extra `createTenantWithLocation('locw-iso-Bx')` just supplies a valid `locationId` for the token user; simplify if a cleaner fixture is preferred during execution.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @garageos/api typecheck` → Expected: PASS.
Run: `pnpm --filter @garageos/api test:unit` → Expected: PASS.
(CI integration: 6 PATCH tests green.)

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/tenants-locations-write.ts packages/api/tests/integration/tenants-locations-write.test.ts
git commit -m "feat(api): PATCH /v1/tenants/me/locations/:id with primary swap (F-OFF-003)"
```

---

## Task 3: DELETE deactivate + guards

**Files:**
- Modify: `packages/api/src/routes/v1/tenants-locations-write.ts`
- Modify: `packages/api/tests/integration/tenants-locations-write.test.ts`

- [ ] **Step 1: Add the DELETE handler**

In `tenants-locations-write.ts`, add inside the plugin (after the `app.patch(...)` block):

```ts
  app.delete<{ Params: { id: string } }>(
    '/v1/tenants/me/locations/:id',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const target = await tx.location.findFirst({
          where: { id, tenantId, deletedAt: null },
          select: { id: true, isPrimary: true },
        });
        if (!target) {
          throw businessError('tenants.me.locations.not_found', 404, 'Sede non trovata.');
        }
        // BR-201: cannot deactivate the primary location.
        if (target.isPrimary) {
          throw businessError(
            'tenants.me.locations.cannot_delete_primary',
            422,
            'Designa prima un’altra sede come primaria.',
          );
        }
        // BR-204: a mechanic must have an active location — block
        // deactivation while active users are still assigned here.
        const activeUsers = await tx.user.count({
          where: { tenantId, locationId: id, status: 'active', deletedAt: null },
        });
        if (activeUsers > 0) {
          throw businessError(
            'tenants.me.locations.has_active_users',
            422,
            'Riassegna o disattiva prima i meccanici di questa sede.',
          );
        }

        const updated = await tx.location.update({
          where: { id },
          data: { status: 'inactive', deletedAt: new Date() },
          select: LOCATION_SELECT,
        });
        return { location: updated };
      });
    },
  );
```

> Check during execution: confirm `User` has a `deletedAt` field (soft-delete column used by BR-207). If the model name differs, adjust the `tx.user.count` where-clause; the intent is "active users assigned to this location".

- [ ] **Step 2: Add the failing DELETE integration tests**

Append to `tenants-locations-write.test.ts`:

```ts
describe('DELETE /v1/tenants/me/locations/:id', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await resetDb(); });

  const TEST_IP_D = '10.20.43.1';

  async function secondaryLocation(tenantId: string) {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO locations (id, tenant_id, name, address_line, city, province,
         postal_code, country, is_primary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Sede 2', 'Via 2', 'Roma', 'RM', '00100', 'IT',
         false, 'active'::"LocationStatus", NOW(), NOW()) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  }

  it('soft-deletes a secondary location without users', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-ok');
    const token = await superAdminToken(tenantId, locationId);
    const secId = await secondaryLocation(tenantId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: TEST_IP_D,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { location: { status: string } }).location.status).toBe('inactive');
    const { rows } = await pgAdmin.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM locations WHERE id = $1`, [secId],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('rejects deleting the primary (422 cannot_delete_primary)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-prim');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: TEST_IP_D,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.cannot_delete_primary');
  });

  it('rejects deleting a location with active mechanics (422 has_active_users)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-users');
    const token = await superAdminToken(tenantId, locationId);
    const secId = await secondaryLocation(tenantId);
    await createUser({
      tenantId, cognitoSub: `mech-del-${crypto.randomUUID()}`,
      email: `mech-del-${crypto.randomUUID()}@locw.test`, role: 'mechanic', locationId: secId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: TEST_IP_D,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.has_active_users');
  });

  it('returns 404 for an already-deactivated or cross-tenant location', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-404');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${crypto.randomUUID()}`,
      remoteAddress: TEST_IP_D,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('tenants.me.locations.not_found');
  });
});
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @garageos/api typecheck` → Expected: PASS.
Run: `pnpm --filter @garageos/api test:unit` → Expected: PASS.
(CI integration: 4 DELETE tests green.)

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/tenants-locations-write.ts packages/api/tests/integration/tenants-locations-write.test.ts
git commit -m "feat(api): DELETE /v1/tenants/me/locations/:id soft-delete with guards (F-OFF-003)"
```

---

## Task 4: Documentation (error codes + API spec)

**Files:**
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` (§3.3 Tenant & organizzazione)
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Add the 6 error codes to APPENDICE_G §3.3**

After the existing `tenants.me.update.unknown_field` row (~line 201), add:

```markdown
| `tenants.me.locations.not_found` | 404 | info | Sede non trovata | PATCH/DELETE /v1/tenants/me/locations/:id con id non del tenant o gia disattivato | F-OFF-003 |
| `tenants.me.locations.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH location con body vuoto | F-OFF-003 |
| `tenants.me.locations.update.unknown_field` | 422 | info | Campo non riconosciuto | POST/PATCH location con chiave non in schema | F-OFF-003 |
| `tenants.me.locations.cannot_unset_primary` | 422 | info | Non si puo togliere la sede primaria | PATCH location con isPrimary:false | F-OFF-003 (BR-201) |
| `tenants.me.locations.cannot_delete_primary` | 422 | warning | Non si puo disattivare la sede primaria | DELETE sulla sede primaria | F-OFF-003 (BR-201) |
| `tenants.me.locations.has_active_users` | 422 | warning | Sede con meccanici attivi | DELETE sede con utenti attivi assegnati | F-OFF-003 (BR-204) |
```

- [ ] **Step 2: Add the detailed endpoint section to APPENDICE_A**

Add a subsection documenting request/response/errors for `POST`, `PATCH`, `DELETE /v1/tenants/me/locations[/:id]` near the locations table (~line 1616-1619). Mirror the format of the existing "GET /v1/tenants/me/locations — Lista location attive (F-OFF-004 scope)" detailed block (~line 2136). Include: auth (Super Admin), request body fields + validation, response `{ location: {...} }` shape, and the error table from Task 4 Step 1. (Use the field list and codes already finalized above — no new shapes.)

- [ ] **Step 3: Commit**

```bash
git add docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
git commit -m "docs: detail F-OFF-003 location CRUD endpoints and error codes"
```

---

## Task 5: Open PR & watch CI

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin feat/location-crud-api
gh pr create --title "feat(api): location CRUD endpoints (F-OFF-003 PR1)" --body "<fill from CLAUDE.md PR template: What/Why F-OFF-003 + BR-200/201/204/205, Implementation notes, Tests checklist>"
```

- [ ] **Step 2: Watch CI**

Run: `gh pr checks --watch`
Expected: all jobs green (typecheck, lint, commitlint, test:unit, test:integration, cdk-synth). Fix-forward on red.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- POST create (isPrimary not accepted) → Task 1. ✓
- PATCH edit + isPrimary:true swap + cannot_unset_primary + empty/unknown + 404 → Task 2. ✓
- DELETE soft-delete + cannot_delete_primary + has_active_users + 404 → Task 3. ✓
- 6 error codes → Task 4. ✓ (added `not_found`; spec said "404" generically — refinement, documented.)
- Auth Super Admin + 403 mechanic → covered in Task 1 & inherited by all. ✓
- RLS WRITE risk (#1) → resolved: `withContext({ tenantId })`. ✓
- Primary-swap order risk (#2) → demote-then-promote in tx (Task 2). ✓
- DTO list extension (#3) → deferred to PR2 (out of PR1 scope; GET untouched). ✓
- No DB migration → confirmed. ✓

**Placeholder scan:** No TBD/TODO in code steps; every code step shows full code. The 404 fixture in Task 2 has an execution note (acceptable simplify-on-execution guidance, not a placeholder). APPENDICE_A Step 2 references the finalized field list rather than re-printing the JSON (the shapes are fully defined in the route file + error table).

**Type consistency:** `LOCATION_SELECT`, `createSchema`, `updateSchema`, `ADDRESS_KEYS`, `businessError` codes, response `{ location }` wrapper, and `tenantsLocationsWriteRoutes` (default export) are used consistently across Tasks 1-3 and the registration in `server.ts`.

**Execution caveat to confirm on first task:** `User.deletedAt` field name (Task 3 note) and that `app.withContext` + `tx.location`/`tx.user` exist on the test server's Prisma extension (they do — used by `tenants-update.ts` and others).

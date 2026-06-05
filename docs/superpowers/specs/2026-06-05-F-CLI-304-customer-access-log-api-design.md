# F-CLI-304 — Customer access-log API (`GET /v1/me/vehicles/:id/access-log`)

**Date:** 2026-06-05
**Feature:** F-CLI-304 (audit accessi) — completes the last missing section of F-CLI-106 vehicle detail.
**Business rules:** BR-154 (vehicle access audit), BR-155 (audit-log visibility to the customer), BR-151 (PII visibility by relation).
**Scope:** This spec covers **PR1 (the API only)**. The mobile "Accessi" tab is PR2, a separate slice that consumes this endpoint.

## What

A read-only customer endpoint that returns the audit trail of accesses to a vehicle the
authenticated customer owns. BR-155 mandates that the owning customer sees, in their app, the
list of accesses to their vehicle with a **redacted** shape.

```
GET /v1/me/vehicles/:id/access-log?limit=20&cursor=<opaque>
```

Response (camelCase, consistent with the `/me`, `/me/vehicles`, `/me/deadlines` neighbours):

```jsonc
{
  "data": [
    {
      "action": "view",            // "view" | "new_intervention"
      "tenantName": "Officina Rossi",
      "locationCity": "Bologna",   // string | null
      "occurredAt": "2026-06-04T14:32:10.123Z", // ISO timestamptz
      "mechanicName": "Mario Bianchi"           // OPTIONAL — present only if a
                                                // customer_tenant_relation exists
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaque>" }
}
```

BR-155 redaction is enforced at the serializer boundary. The response **never** contains:
`ipAddress`, `userAgent`, or any internal id (`tenantId`, `userId`, `locationId`, `vehicleId`,
or the access-log row `id`).

## Why

F-CLI-106 (`docs/GarageOS-Specifiche.md:518`) defines the customer vehicle-detail view as: technical
data + history (shop + private) + deadlines + **audit accessi**. The first three shipped (#149/#150/#151);
this is the remaining section. It also delivers tangible GDPR/transparency value ("who has accessed my
vehicle") for the pilot.

## Architecture

### 1. Security & RLS context — the crux

`access_logs` carries only the generic `tenant_isolation` RLS policy:

```sql
USING (is_admin_role() OR tenant_id = current_tenant_id())
```

A customer authenticates through the clienti pool with **no `tenant_id`** and is **not** an admin
role, so under their own RLS context they would read **zero** rows. This is the same shape solved by
F-CLI-004's `PATCH /me/profile` (where the customer-write RLS policy did not permit a self-update).

**Resolution — admin context + app-layer ownership gate** (the lesson from the #154 leak: never rely on
RLS alone for a customer endpoint; the app-layer filter is the real security boundary):

1. Auth chain identical to the sibling `/me/vehicles` routes:
   `requireAuth → requireClientiPool → clientiContext` (sets `request.customerId` from the JWT).
2. All DB reads run inside a single `app.withContext({ role: 'admin' }, ...)` block so the
   `access_logs` `tenant_isolation` policy is satisfied. `role: 'admin'` bypasses RLS via
   `is_admin_role()`.
3. **404-gate first** — exactly mirrors `GET /v1/me/vehicles/:id`:
   ```ts
   const ownership = await tx.vehicleOwnership.findFirst({
     where: { vehicleId, customerId, endedAt: null },
     select: { id: true },
   });
   if (!ownership) throw businessError('me.vehicle.not_found', 404, 'Veicolo non trovato o non più di tua proprietà.');
   ```
   The explicit `{ vehicleId, customerId, endedAt: null }` predicate — with `customerId` taken from
   the authenticated JWT — **is** the ownership boundary even though admin bypasses RLS. Returning 404
   (not 403) avoids leaking the existence of vehicles outside the customer's perimeter (same as the
   neighbour). `vehicle_ownerships` RLS is `USING(true)`, so the gate behaves identically under admin
   context.

The endpoint reads only; `access_logs` is append-only (BR-282 trigger blocks UPDATE/DELETE) and we
write nothing here.

### 2. Distinguishing "vehicle registration" from "new intervention" — Option A (enum split)

`access_logs.action='create'` is currently **overloaded**: it is written both when a tenant registers a
vehicle (`vehicles.ts:544`, `recordVehicleAccess({ action: 'create' })`) and when a tenant creates an
intervention (`interventions.ts:288`). The row has no discriminator, so the customer audit cannot tell a
registration from an intervention. BR-155 only contemplates `view` and "new intervention", so a
registration row would be mislabelled.

We fix the **modelling gap at the source** rather than encode a fragile read-time heuristic
(timestamp-correlation was rejected: the create-path certifies pre-existing pending vehicles, so
`accessLog.createdAt == vehicle.createdAt` is not guaranteed):

- **Migration (additive, zero-risk):** add a new value to the `AccessLogAction` enum:
  ```sql
  ALTER TYPE "AccessLogAction" ADD VALUE IF NOT EXISTS 'vehicle_registered';
  ```
  *Postgres caveat:* a newly added enum value cannot be used in the **same** transaction that adds it.
  We only add it here and use it from application code in a later request, so there is no conflict. The
  Prisma `schema.prisma` enum gains the value; `pnpm prisma generate` regenerates the client.
- **Write-site change:** `packages/api/src/routes/v1/vehicles.ts:544` logs the vehicle-registration access
  as `action: 'vehicle_registered'` (was `'create'`). `interventions.ts:288` stays `'create'`. Update the
  BR-154 comment there.
- **Lib type:** extend the inlined `AccessLogAction` union in `packages/api/src/lib/access-log.ts:10`
  with `'vehicle_registered'` (kept in sync with the Prisma enum).
- **Customer audit filter:** `action: { in: ['view', 'create'] }`. After the split, `'create'` means
  **only** an intervention create → mapped to the customer-facing `'new_intervention'`. `'vehicle_registered'`
  falls out of scope of the customer audit (BR-155 names only view + new intervention).
- **Blast radius:** there is **no reader** of `access_logs` in the api source (verified by grep), so the
  only consumers to update are the `vehicles-post` unit + integration tests that assert
  `action='create'`.
- **Legacy caveat:** pre-PR `create` rows written for vehicle registrations remain `'create'`
  (`access_logs` is immutable, BR-282 — no backfill possible) and would surface as `new_intervention`.
  This affects only pilot/demo vehicles registered before this PR and is neutralised in practice by the
  pending demo re-seed (`PILOT_DEMO_EMAIL_BASE` runbook). Documented; cosmetic.

### 3. Serializer (BR-155) — pure, isolated module

New `packages/api/src/lib/customer-access-log.ts` (mirrors the `serializeUserMe` / `pii-filter` pattern:
a pure function, unit-testable without a DB). Input: the raw access-log rows (with `tenant`, `location`,
`user` relations selected) + the set of tenant ids the customer has a `customer_tenant_relation` with.
Output: the redacted, customer-facing shape.

Mapping rules:
- `action`: internal `'view' → 'view'`, internal `'create' → 'new_intervention'`. The internal enum is
  never exposed; the API contract is the two customer-facing values.
- `tenantName`: from `tenant.businessName` (required).
- `locationCity`: from `location.city`. `locationId` is nullable on the row; if absent, `null`
  (BR-155 calls it required, but we degrade gracefully rather than drop the row — `view`/`create` rows
  written by a logged-in mechanic carry a location in practice).
- `occurredAt`: `createdAt.toISOString()` — a full `timestamptz`, **not** a `@db.Date`, so the #156
  date-only serialization bug does not apply here.
- `mechanicName`: `\`${user.firstName} ${user.lastName}\`` **only if** `tenant.id ∈ relationTenantIds`
  (BR-155 + BR-151: mechanic name visible only to a customer who has a relationship with that tenant);
  otherwise the key is **omitted** entirely.

The label localisation (Italian "Consultazione" / "Nuovo intervento") is **not** the API's job — per
CLAUDE.md, user-facing strings are localised on the client via i18n. The API returns the stable
`'view' | 'new_intervention'` discriminator; the mobile PR2 maps it to Italian.

### 4. Pagination — compound cursor (reuse existing helper)

`access_logs` rows are ordered newest-first. `lib/cursor.ts` already provides the exact tool: a compound
`(field, id)` cursor with a timestamp guard.

- `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` (`id` is the stable tiebreaker for equal timestamps).
- `limit` query param: `z.coerce.number().int().min(1).max(50).default(20)`.
- Cursor decode: `decodeDateCompoundCursor('at', cursor, 'timestamp')` → `{ at: <ISO>, id }`.
- "Older than cursor" predicate (matches `desc, desc` ordering):
  ```ts
  OR: [
    { createdAt: { lt: new Date(cur.at) } },
    { createdAt: new Date(cur.at), id: { lt: cur.id } },
  ]
  ```
- `take: limit + 1` → `has_more = rows.length > limit`; page = first `limit`.
- Next cursor: `encodeCompoundCursor('at', lastRow.createdAt.toISOString(), lastRow.id)`.

No new cursor code is required — the field key `'at'` is introduced at the call site, consistent with how
other endpoints use distinctive keys (`ra`, `d`).

### 5. Handler shape (single `withContext` block)

```ts
app.get('/v1/me/vehicles/:id/access-log',
  { preHandler: [requireAuth, requireClientiPool, clientiContext] },
  async (request) => {
    const { id: vehicleId } = idParamSchema.parse(request.params);
    const { limit, cursor } = listQuerySchema.parse(request.query);
    const customerId = request.customerId!;

    return app.withContext({ role: 'admin' }, async (tx) => {
      // 404-gate: ownership is the security boundary (app-layer, not RLS).
      const ownership = await tx.vehicleOwnership.findFirst({
        where: { vehicleId, customerId, endedAt: null },
        select: { id: true },
      });
      if (!ownership) throw businessError('me.vehicle.not_found', 404, '...');

      const cur = decodeDateCompoundCursor('at', cursor, 'timestamp');
      const rows = await tx.accessLog.findMany({
        where: {
          vehicleId,
          action: { in: ['view', 'create'] },
          ...(cur ? { OR: [/* older-than predicate */] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true, action: true, createdAt: true,
          tenant: { select: { id: true, businessName: true } },
          location: { select: { city: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      });

      const relations = await tx.customerTenantRelation.findMany({
        where: { customerId }, select: { tenantId: true },
      });
      const relationTenantIds = new Set(relations.map((r) => r.tenantId));

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const data = serializeCustomerAccessLog(page, relationTenantIds);
      const last = page.at(-1);
      return {
        data,
        meta: {
          has_more: hasMore,
          ...(hasMore && last ? { cursor: encodeCompoundCursor('at', last.createdAt.toISOString(), last.id) } : {}),
        },
      };
    });
  });
```

`tenant.id` is selected only to compute the relation gate and is stripped by the serializer (never
returned).

### 6. Error handling

| Case | Response |
|---|---|
| Vehicle not owned / never owned / sold (`ended_at NOT NULL`) | `404 me.vehicle.not_found` (reused, identical to `GET /me/vehicles/:id`) |
| Malformed `:id` (not a uuid) | `400` (zod param parse) |
| Malformed/foreign `cursor` | Silently treated as page 1 (`decodeDateCompoundCursor` returns `undefined`) |
| No access logs yet | `200` with `data: []`, `meta.has_more: false` |

No new error code is expected in `APPENDICE_G` (the 404 code already exists).

## Testing

### Unit (FakePrisma, route)
- 404 when the customer does not own the vehicle.
- Query applies `action IN ('view','create')` and `orderBy [createdAt desc, id desc]`.
- Redaction: response objects expose only `action`, `tenantName`, `locationCity`, `occurredAt`, and
  optionally `mechanicName` — **assert absence** of `ipAddress`, `userAgent`, `tenantId`, `userId`,
  `locationId`, `vehicleId`, `id`.
- Action mapping: internal `'create' → 'new_intervention'`, `'view' → 'view'`.
- `mechanicName` present when a relation exists for the row's tenant, omitted when not.
- Cursor: `has_more`/`cursor` emitted on overflow; decode roundtrip.

### Serializer unit (pure)
- Mapping + conditional `mechanicName` (relation present vs absent) + `locationCity: null` when location absent.

### Integration (real Postgres, free IP `10.20.4x`)
- Seed: a customer owning a vehicle; `access_logs` rows across **two tenants** — one with a
  `customer_tenant_relation`, one without — spanning actions `view`, `create` (intervention),
  `vehicle_registered`, `search_match`, `cancel`.
- Assert: only `view` + `create` returned (i.e. `vehicle_registered`/`search_match`/`cancel` excluded),
  with `create → 'new_intervention'`.
- Assert the **exact serialized shape** and field values (per the #156 lesson: integration asserts exact
  field names and values, including `occurredAt`), `mechanicName` gated by relation, `locationCity` value.
- Assert newest-first ordering and correct cursor pagination across a page boundary.
- Cross-customer request for the same vehicle id → `404`.
- A second tenant's rows for the same vehicle (cross-tenant officina that legitimately viewed the
  vehicle) **are** included (the audit is per-vehicle, not per-tenant) — assert this.

### `vehicles-post` regression
- Update unit + integration assertions that currently expect `access_logs.action='create'` for a vehicle
  registration to expect `'vehicle_registered'`.

## Docs to update
- `APPENDICE_A_API.md` — add the `GET /v1/me/vehicles/:id/access-log` section (request, response, BR-155
  redaction note, cursor).
- `APPENDICE_B_DATABASE.md` — note the new `AccessLogAction` value `vehicle_registered` and that the
  vehicle-registration audit now uses it.
- `APPENDICE_F_BUSINESS_LOGIC.md` — annotate BR-154/BR-155 with the registration/intervention action
  split and that the customer audit surfaces `view` + intervention `create` only.
- `APPENDICE_G_ERROR_CODES.md` — no change (reuses `me.vehicle.not_found`).

## Out of scope (PR2 / later)
- Mobile "Accessi" tab UI (PR2).
- Surfacing `vehicle_registered`, `update`, `cancel`, `respond`, `ownership_transfer`, or `search_match`
  in the customer audit (BR-155 names only view + new intervention).
- Backfilling legacy `create` rows (immutable, BR-282).
- Officina-side access-log reader endpoint (none exists today).

## Right-sizing
~5–6 cohesive tasks (migration + write-site rename + its tests; route handler + 404-gate + admin context;
serializer + its unit tests; route unit tests; integration test; docs). Executed **inline**
(`executing-plans`) with a single final Opus review. Escalate to subagent-driven only if real task count
crosses ~6 during execution.

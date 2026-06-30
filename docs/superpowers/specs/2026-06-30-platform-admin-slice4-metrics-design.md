# Platform-admin Slice 4 — Metrics Dashboard (design)

**Date:** 2026-06-30
**Status:** approved (pending user spec review)
**Arc:** Platform-admin console (Slices 0-3 complete). This is **Slice 4**, scoped to
**metrics only**. The platform **audit viewer** ("who created/suspended which tenant")
is explicitly deferred to a later slice.

## What

Add operational-visibility metrics to the platform-admin back-office (`packages/admin-web`):

1. **Platform-level dashboard** on the landing page (`PlatformConsole`): aggregate counts
   across all tenants + a trend chart of interventions per week.
2. **Per-tenant metrics block** on `TenantDetail`: volume + activity counts for a single
   workshop (stat cards only, no chart).

## Why

Slice 4 of the platform-admin arc (roadmap in
`docs/superpowers/specs/2026-06-27-platform-admin-tenant-provisioning-design.md` §"Slices").
The operator needs to see, at a glance: how many workshops exist and their state, how much
they're using the product (adoption signal), and whether a given workshop is active or
dormant. No business rule mandates this; it is internal back-office tooling.

## Scope decisions (from brainstorming)

- **Metrics now, audit later.** Audit-log viewer is a separate future slice.
- **Both placements:** platform dashboard **and** per-tenant block.
- **Trend chart only on the platform dashboard.** Per-tenant is stat cards only.
- **Charting library: shadcn `chart` (recharts).** Adds the `recharts` dependency to
  `packages/admin-web` — justified in the PR description (ecosystem-standard, room to grow
  to tooltips/axes/more charts). Mirror the shadcn chart wrapper already used elsewhere if
  present; otherwise add it via `shadcn add chart`.
- **Zero migration, zero new error codes, zero new BRs.** Reuses the cross-tenant access
  model settled in Slices 1-3.

## PR split

Hard 1500-LOC limit + the Slice 2/3 precedent → **two PRs**:

- **PR-A — Platform dashboard.** `GET /v1/admin/metrics` + `PlatformConsole` stat cards +
  trend chart.
- **PR-B — Per-tenant metrics.** `GET /v1/admin/tenants/:id/metrics` + `TenantDetail`
  metrics block.

PR-B depends on PR-A only for shared DTO/UI helpers (stat-card component); otherwise
independent.

## Cross-tenant access — no migration needed

Verified against the RLS migrations. Under `withContext({ role: 'admin' })` (GUC
`app.current_role='admin'`, runtime role `garageos_app` is `NOBYPASSRLS`), every table we
read already grants admin SELECT:

| Table | SELECT policy | Admin reads all |
|---|---|---|
| `tenants` | `tenants_isolation` USING `is_admin_role() OR id = current_tenant_id()` | ✓ |
| `users` | `users_read` USING `is_admin_role() OR tenant_id = current_tenant_id()` | ✓ |
| `interventions` | `interventions_read` USING `is_admin_role() OR tenant_id = …` | ✓ |
| `customers` | `customers_read` USING `(true)` | ✓ |
| `vehicles` | `vehicles_read` USING `(true)` | ✓ |
| `customer_tenant_relations` | `*_tenant_isolation` loop USING `is_admin_role() OR tenant_id = …` | ✓ |
| `deadlines` | `deadlines_tenant_isolation` (loop) USING `is_admin_role() OR tenant_id = …` | ✓ |
| `invitations` | `invitations_tenant_isolation` with `is_admin_role()` branch (used by Slice 1) | ✓ |

This is consistent with Slices 1-3 being zero-migration. **No new RLS policy is added.**

## Computation approach

**On-demand counts via Prisma under admin context** (option A from brainstorming). At
pilot scale (few tenants, modest rows) this is instant and needs zero new infrastructure.
Rejected: materialized aggregates / cache (YAGNI), raw GROUP BY for all counts (overkill
for the row counts involved). Every query runs inside `withContext({ role: 'admin' })`.

### Platform metrics — `GET /v1/admin/metrics`

`[requireAuth, requirePlatformAdminsPool]`, **no tenant context**. Response DTO:

```jsonc
{
  "tenants":      { "total": 12, "active": 10, "suspended": 2 },
  "usersTotal":   34,                 // staff users with status = active
  "interventions":{ "total": 1840, "last30d": 212 },
  "vehiclesTotal":  980,
  "customersTotal": 760,
  "trend": [                          // interventions per ISO week, last 8 weeks
    { "week": "2026-05-12", "count": 38 },
    { "week": "2026-05-19", "count": 41 },
    // … exactly 8 entries, empty weeks filled with count: 0, ascending by week
  ]
}
```

Counts:
- `tenants.*` — `tenant.count` by `status`. `total` excludes soft-deleted
  (`deletedAt: null`); `active`/`suspended` from `status`.
- `usersTotal` — `user.count({ where: { status: 'active' } })`.
- `interventions.total` — `intervention.count()`.
- `interventions.last30d` — `intervention.count({ where: { createdAt: { gte: now-30d } } })`.
- `vehiclesTotal` — `vehicle.count()`.
- `customersTotal` — `customer.count()` (global customers table).
- `trend` — a single `$queryRaw`:
  ```sql
  SELECT date_trunc('week', created_at) AS week, count(*)::int AS count
  FROM interventions
  WHERE created_at >= date_trunc('week', now()) - interval '7 weeks'
  GROUP BY 1 ORDER BY 1;
  ```
  The handler then builds a continuous 8-element series (current week + 7 prior),
  zero-filling weeks with no rows, formatting `week` as `YYYY-MM-DD` (Monday of the ISO
  week). Zero-fill happens in the handler, not SQL.

### Per-tenant metrics — `GET /v1/admin/tenants/:id/metrics`

`[requireAuth, requirePlatformAdminsPool]`. Separate from the existing tenant-detail
endpoint so `TenantDetail` loads it lazily and the detail payload stays stable. Validate
the tenant exists first (reuse `tenant.not_found` 404 — same pattern as
`admin-tenant-detail.ts`). Response DTO:

```jsonc
{
  "interventions":     { "total": 84, "last30d": 12, "lastAt": "2026-06-27T09:14:00Z" },
  "usersTotal":        3,            // status = active, this tenant
  "vehiclesTotal":     61,
  "customersTotal":    52,
  "openDeadlines":     7,
  "pendingInvitations":1
}
```

Counts (all scoped to `:id`, under admin context):
- `interventions.total/last30d` — `intervention.count` `where tenantId = :id` (+ createdAt
  window for last30d).
- `interventions.lastAt` — `intervention.findFirst({ where: { tenantId }, orderBy:
  { createdAt: 'desc' }, select: { createdAt } })` → `null` if none.
- `usersTotal` — `user.count({ where: { tenantId, status: 'active' } })`.
- `vehiclesTotal` — vehicles have **no** `tenantId`; count with
  `where: { OR: [{ createdByTenantId: id }, { certifiedByTenantId: id }] }`
  (see memory `vehicle-no-tenantid-field`).
- `customersTotal` — `customerTenantRelation.count({ where: { tenantId, customerDeleted:
  false } })`.
- `openDeadlines` — `deadline.count` `where tenantId = :id` and status = open/active.
  **Plan-stage pre-flight:** grep the `DeadlineStatus` enum for the exact "open"/"upcoming"
  values; do not invent.
- `pendingInvitations` — `invitation.count` `where tenantId = :id, acceptedAt: null,
  expiresAt: { gt: now }`.

## Frontend (admin-web)

### PR-A — `PlatformConsole`
- Keep the existing operator-identity header.
- Add a responsive grid of **stat cards** (shadcn `card`): Officine (total / active /
  suspended), Utenti, Interventi (total + "ultimi 30gg"), Veicoli, Clienti.
- Add a **bar chart** (shadcn `chart`/recharts): "Interventi per settimana (ultime 8)".
- react-query for `GET /v1/admin/metrics`. Loading skeleton + error state. Gate render on
  `isLoading || !data` (memory `react-query-data-bang-offline-paused`).
- All user-facing strings in Italian via the existing pattern.

### PR-B — `TenantDetail`
- New "Metriche" section below the profile/users area: stat cards for interventi
  (total / 30gg / ultimo), utenti, veicoli, clienti, scadenze aperte, inviti pendenti.
- Lazy react-query for `GET /v1/admin/tenants/:id/metrics`. Same loading/error treatment.
- "Ultimo intervento" rendered as a relative/absolute date; "—" when `lastAt` is null.

A small shared `StatCard` component (PR-A) is reused by PR-B.

## Error handling

- Reuse existing codes only: `FORBIDDEN` (wrong pool, via `requirePlatformAdminsPool`),
  `UNAUTHORIZED` (no/invalid token), `tenant.not_found` (per-tenant endpoint, unknown id).
- **No new error codes, no `APPENDICE_G` additions.** (Plan-stage: grep `APPENDICE_G` to
  confirm reuse — memory `preflight-must-grep-appendice-g-codes`.)
- RFC 7807 envelope via the standard `businessError`/error-handler path.

## Testing

**Tier 1 (full) — API:**
- Contract: 200 + exact DTO shape for both endpoints.
- Security isolation (negative): officine-pool token → 403, clienti-pool token → 403,
  no-auth → 401, on **both** endpoints.
- Correctness: counts computed against a multi-tenant seed (≥2 tenants with differing
  interventions/users/vehicles/customers) prove cross-tenant aggregation for the platform
  endpoint and correct scoping for the per-tenant endpoint (a tenant's count excludes the
  other tenant's rows).
- Trend: bucket boundaries + **zero-fill** (a week with no interventions appears as
  `count: 0`); series length is always 8, ascending.
- Per-tenant 404 for unknown id; `lastAt: null` when the tenant has no interventions.
- `vehiclesTotal` per-tenant counts both `createdByTenantId` and `certifiedByTenantId`
  without double-counting a vehicle that is both.

**Tier 2 (minimal) — UI:** 2-3 tests per page — happy path with data, error/empty state,
and (PlatformConsole) that the chart receives the trend series. No pure-rendering tests.

**Smoke (BLOCKER):** admin-web is UI-facing → browser smoke in prod before merging each
PR (login → dashboard shows real numbers + chart renders; open a tenant → per-tenant block
shows numbers; browser console clean for the Vite `global` shim).

## Out of scope

- Audit-log viewer (future slice).
- Per-tenant trend chart.
- Time-series beyond the 8-week interventions trend; any drill-down/export.
- Billing/revenue metrics.
- Caching/materialized aggregates.

## Plan-stage pre-flight checklist (per PLAN_TEMPLATE)

- Grep `DeadlineStatus` enum for exact open/upcoming values before writing `openDeadlines`.
- Grep `APPENDICE_G` to confirm no new error code is needed.
- Grep existing admin routes for the registration pattern (`admin-tenant-detail.ts`,
  `admin-tenants-list.ts`) and mirror auth-guard + tenant-existence-check wiring.
- Confirm whether a shadcn `chart` wrapper already exists in `packages/admin-web` or
  `packages/web` before running `shadcn add chart`.
- Verify the raw-SQL trend query under the Prisma pg adapter (casts: `count(*)::int`;
  `date_trunc` returns timestamptz) — integration test catches param/cast issues
  (memory `pg-void-needs-text-cast`, `pg-param-type-inference-cast`).
- Check resource/count assertions are not affected (API-only change; no CDK resources).

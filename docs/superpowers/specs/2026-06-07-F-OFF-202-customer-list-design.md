# F-OFF-202 — Elenco clienti (read-only) — Design

**Date:** 2026-06-07 · **Feature:** F-OFF-202 (MUST) · **Scope:** read-only list (API + web)

## What

A tenant-scoped, paginated, searchable list of the officina's customers. Each
row shows: name, phone, number of associated vehicles, and last intervention
date. Clicking a row opens the existing customer detail page (`/customers/:id`).

Out of scope (separate slices, per audit `2026-05-31`): standalone customer
creation (F-OFF-201), global search by phone (F-OFF-502).

## Why

F-OFF-202 is a MUST officina feature and a genuine gap (audit `2026-05-31`):
today only customer *detail* and *autocomplete search* exist — there is no
customer list page or list endpoint. Daily-use, no external blocker. Spec:
`docs/GarageOS-Specifiche.md` §3.2.3 F-OFF-202; index in
`docs/APPENDICE_A_API.md` already lists `GET /v1/customers` as
"Lista clienti del tenant (con ricerca)".

## API — `GET /v1/customers`

New handler `packages/api/src/routes/v1/customers-list.ts`, sibling of
`customers.ts` (search) and `customers-detail.ts`. Same stack:
`requireAuth → requireOfficinaPool → tenantContext`, body inside
`app.withContext({ tenantId }, …)`.

### Query parameters

| Param | Rule | Default |
|---|---|---|
| `q` | optional; when present `trim().min(2).max(60)` | — |
| `limit` | `coerce.number().int().min(1).max(50)` | 20 |
| `cursor` | optional opaque id-only cursor (`encode/decodeCursor`) | — |

When `q` is present, split into whitespace tokens; each token must match at
least one of `firstName / lastName / businessName` (case-insensitive
`contains`), AND across tokens, OR across columns — identical to
`/v1/customers/search`. `email / taxCode / vatNumber` are NOT matchable
(keeps PII off the search surface).

### Query

```
tx.customer.findMany({
  where: {
    status: 'active',
    tenantRelations: { some: { tenantId, customerDeleted: false } },
    ...(tokens.length ? { AND: tokens.map(...) } : {}),
  },
  select: {
    id, firstName, lastName, phone, isBusiness, businessName,
    tenantRelations: { where: { tenantId, customerDeleted: false },
                       select: { lastInterventionAt: true } },
    _count: { select: { ownerships: { where: { endedAt: null } } } },
  },
  orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
  take: limit + 1,
  ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
})
```

Prisma cursor pagination with an id-only cursor works with a compound
non-unique `orderBy`: Prisma seeks to the cursor row by id and applies the
order. `firstName`/`lastName` are `NOT NULL` in the schema (true even for
business customers), so alphabetical ordering is universal.

`vehicleCount` uses Prisma filtered relation counts
(`_count.ownerships where endedAt:null`) — counts the customer's currently
active ownerships, **not** tenant-scoped. This matches the detail endpoint,
whose `vehicles` array is the customer's active ownerships regardless of
tenant.

`lastInterventionAt` is read from the denormalized
`CustomerTenantRelation.lastInterventionAt` (per-tenant) — no join on
`interventions`. The CTR array is filtered to the calling tenant and is
guaranteed non-empty by the outer `tenantRelations.some` filter.

### Response DTO (camelCase, like the other `/customers` routes)

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Mario",
      "lastName": "Rossi",
      "phone": "+39…" | null,
      "isBusiness": false,
      "businessName": null,
      "vehicleCount": 2,
      "lastInterventionAt": "2026-05-01T…Z" | null
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaque>" }
}
```

`has_more` derived from the `take: limit + 1` overshoot; `cursor` present only
when `has_more`, encoding the last returned row's `id`.

### Security / PII (BR-151)

Tenant-scoped via the `tenantRelations.some({ tenantId })` filter (mirrors
search/detail). The DTO returns only the fields the list displays —
**no email, taxCode, or vatNumber** (least-PII surface; the detail page
already exposes those to the same related tenant). Distinct from
`/v1/customers/search` (autocomplete, `q` required, id-ordered): the list has
optional `q` and alphabetical order.

A pure serializer `projectCustomerListRow(row)` lives in a small shared module
(`lib/customer-list-shared.ts`) with the select shape and row/DTO types, so the
handler stays thin and the projection is unit-testable DB-free.

No migration (existing columns + `_count` only).

## Web — `/customers` page

- Route `/customers` in `App.tsx` (inside `ProtectedRoute`/`AppLayout`) →
  new `pages/CustomerList.tsx`, mirroring `DeadlineDashboard` structure
  (header, controls, loading skeleton, error alert with retry, empty state,
  list, "Carica altre").
- Query hook `queries/customersList.ts`: `useInfiniteQuery`, `getNextPageParam`
  from `meta.has_more ? meta.cursor : undefined`, queryKey
  `['customers', 'list', { q }]`. `q` is debounced before entering the key.
- **Table columns**: Nome (`businessName` when `isBusiness`, else
  "Cognome Nome") · Telefono (`—` when null) · N° veicoli · Ultimo intervento
  (IT date `GG/MM/AAAA`, "Nessuno" when null). Row is clickable → navigate to
  `/customers/:id`.
- Search input (debounced) at the top filters by name. Empty `q` lists all
  tenant customers alphabetically.
- **Sidebar**: the "Clienti" item already exists but is `enabled:false`
  ("soon"). Flip to `enabled:true, to:'/customers'` and add `/customers`
  handling in `isActiveFor`.

## Tests

- **API unit** (`FakePrisma`): `customer.findMany` returning the `_count` +
  filtered-CTR shape; assert tenant-scoping `where`, pagination
  (`take/cursor/skip`), `q`-token match, and projection (`vehicleCount`,
  `lastInterventionAt`, `phone` null).
- **API integration** (real Postgres, free IP `10.20.4x`): alphabetical
  ordering; `vehicleCount` counts only active ownerships (a terminated
  ownership is excluded); `lastInterventionAt` reflects the CTR value;
  cross-tenant isolation (a customer related only to another tenant is
  absent); cursor paginates without gaps/dupes; `q` filters by name.
- **Web**: `customersList` query test; `CustomerList` page test
  (render rows, loading/error/empty, search updates results, "Carica altre"
  fetches next page); `Sidebar` test updated (Clienti enabled, links to
  `/customers`, active state).
- **Docs**: expand `GET /v1/customers` into a detailed APPENDICE_A section
  (today only an index row).

## Right-sizing

~6 additive cross-layer tasks on well-established patterns →
**inline execution (executing-plans), TDD red→green, a single final Opus
review** (the cadence of recent slices). No subagent-per-task pipeline.

## Open questions

None — design approved 2026-06-07.

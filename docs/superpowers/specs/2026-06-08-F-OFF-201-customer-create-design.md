# F-OFF-201 — Creazione cliente standalone — Design

**Date:** 2026-06-08 · **Feature:** F-OFF-201 (MUST) · **Scope:** standalone customer creation (API + web dialog)

## What

A standalone way to create a customer for the tenant, independent of vehicle
creation: a new `POST /v1/customers` endpoint and a "Nuovo cliente" dialog
launched from the customer list page (F-OFF-202, #163). On success the UI
navigates to the new customer's detail page.

Today customer creation only exists **embedded** in vehicle creation
(`vehicles.ts` `resolveCustomer`). This adds the missing standalone surface.

## Why

F-OFF-201 is a MUST officina feature and a gap from the audit
`docs/superpowers/audits/2026-05-31` (only embedded create existed). Spec:
`docs/GarageOS-Specifiche.md` §3.2.3 F-OFF-201 — "Form con: nome, cognome,
codice fiscale (opzionale), email, telefono, indirizzo (opzionale).
Possibilità di flaggare come cliente aziendale con ragione sociale e P.IVA".
Index in `docs/APPENDICE_A_API.md` already lists `POST /v1/customers`.

## Data model constraint (drives the dedupe policy)

`Customer.email` is **globally unique** across all tenants. A person is a
single `Customer` row, shared between officine via `customer_tenant_relations`
(CTR). Therefore "creating a customer" whose email already exists in the
system means **reusing the existing row and ensuring a CTR** — a second row
cannot be created.

## API — `POST /v1/customers`

New handler `packages/api/src/routes/v1/customers-create.ts`, sibling of the
other `customers-*.ts` routes. Stack:
`requireAuth → requireOfficinaPool → tenantContext`, body inside
`app.withContext({ tenantId }, …)`.

### Request body (camelCase, `.strict()`)

| Field | Rule |
|---|---|
| `firstName` | string 1..100, required |
| `lastName` | string 1..100, required |
| `email` | valid email, max 255, required |
| `phone` | string max 30, optional |
| `taxCode` | string max 20, optional |
| `addressLine` | string max 255, optional |
| `city` | string max 100, optional |
| `province` | string max 2, optional |
| `postalCode` | string max 10, optional |
| `isBusiness` | boolean, default false |
| `businessName` | string max 200, optional |
| `vatNumber` | string max 20, optional |

`.strict()` so unknown keys → `422 customer.create.unknown_field` (mirrors the
PATCH handler's `unknown_field` discrimination). A Zod `.refine` enforces:
when `isBusiness` is true, `businessName` is required (non-empty) →
`422 customer.create.business_name_required`. `tenantNotes` is intentionally
out of scope for creation (set later via PATCH — YAGNI).

### Behavior (mirrors `resolveCustomer` create_new; `vehicles.ts` untouched)

1. `findUnique({ where: { email } })`.
2. **Exists** → `customerTenantRelation.upsert` (BR-152, ensures this tenant is
   related), re-query the full detail row, return it with `created: false`.
   The typed anagrafica is **ignored** when the row already exists (the
   existing row wins — consistent with the embedded flow).
3. **Not exists** → `$transaction`: `customer.create` with the body fields +
   `customerTenantRelation.create({ tenantId, customerId, interventionCount: 0 })`.
   Return the detail row with `created: true`.
4. **P2002 race** (concurrent insert won between findUnique and create) →
   catch, re-fetch by email, ensure CTR, return with `created: false`.

Optional fields are written only when present (`...(phone ? { phone } : {})`),
matching `resolveCustomer`.

### Response `201 Created`

The full customer DTO — same shape as `GET /v1/customers/:id` (reuses
`customerDetailSelect` + `projectCustomerDetail`) — plus a top-level
`created: boolean`:

```json
{
  "id": "uuid",
  "email": "mario@example.it",
  "firstName": "Mario",
  "lastName": "Rossi",
  "phone": "+39…" ,
  "taxCode": null,
  "isBusiness": false,
  "businessName": null,
  "vatNumber": null,
  "addressLine": null,
  "city": null,
  "province": null,
  "postalCode": null,
  "cognitoSub": null,
  "status": "active",
  "createdAt": "…Z",
  "tenantRelation": { "tenantNotes": null, "interventionCount": 0,
                      "firstInterventionAt": null, "lastInterventionAt": null },
  "vehicles": [],
  "created": true
}
```

`201` is returned in both cases (new row or linked-existing); `created`
carries the nuance. This is a minor pragmatic divergence from strict REST
(a pure "link existing" is arguably `200`); documented in APPENDICE_A so the
client has one code path.

### BR / security

- **BR-041**: relation to a pre-existing customer (reuse by email).
- **BR-152**: ensure CTR for the calling tenant (atomic upsert).
- **BR-151**: the creating tenant becomes related → may see the customer
  (consistent — they just added them to their roster).

No migration. No new dependency.

## Web — "Nuovo cliente" dialog

- `CreateCustomerDialog` (mirrors `InviteUserDialog` from UserManagement):
  modal with the form fields above; a "Cliente aziendale" toggle reveals
  `businessName` + `vatNumber`. Client-side validation via a pure helper
  `lib/customer-create.ts` (required firstName/lastName/email, email format,
  businessName required when business). Field errors + an error banner mapped
  from the server error code.
- Query hook `queries/customersCreate.ts`: `useMutation` POST `/v1/customers`.
  On success: invalidate `['customers', 'list']`, close the dialog, navigate
  to `/customers/:id`, and surface a message that differs on `created`
  ("Cliente creato" vs "Cliente già esistente, collegato alla tua officina").
- A **"Nuovo cliente"** button in the `/customers` page header opens the
  dialog.

## Tests

- **API unit** (`FakePrisma`): auth/pool (401/403); validation (missing
  required → 400; unknown key → 422; `isBusiness` without `businessName` →
  422); create-new path (`customer.create` + CTR upsert/create called,
  `created:true`); dedupe path (existing email → no `create`, CTR upsert,
  `created:false`); P2002 race → refetch + `created:false`.
- **API integration** (real Postgres, free IP `10.20.4x`): create persists the
  row + CTR; duplicate email links the existing customer (`created:false`) and
  ensures the CTR; an email belonging to another tenant's customer links it to
  the caller; the returned DTO matches the GET detail shape.
- **Web**: `useCreateCustomer` (POST body, invalidation, navigate); `customer-create`
  validator; `CreateCustomerDialog` (render, required-field errors, business
  toggle reveals fields, submit success closes + navigates, server error
  banner); `CustomerList` "Nuovo cliente" button opens the dialog.
- **Docs**: detailed `POST /v1/customers` section in APPENDICE_A.

## Right-sizing

~7–8 additive cross-layer tasks on established patterns →
**inline execution (executing-plans), TDD red→green, a single final Opus
review**. No subagent-per-task pipeline. `vehicles.ts` is left untouched
(the dedupe logic is mirrored, not extracted, to avoid touching the live
vehicle-creation flow).

## Open questions

None — design approved 2026-06-08.

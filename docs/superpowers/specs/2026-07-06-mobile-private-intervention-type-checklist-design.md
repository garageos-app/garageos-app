# Design — Mobile private interventions: type selection + checklist

**Date:** 2026-07-06
**Status:** approved (brainstorming), pending implementation plan
**Scope:** large cross-layer slice — Database + API + Mobile. Delivered as a **2-PR arc**.

## What

Bring the mobile **private intervention** create/edit flow to parity with the web
officina intervention flow: instead of typing the "Tipo" as free text, the customer
**selects an intervention type from the global catalog** and **selects the checklist
items** relative to that type. A free-text fallback ("Altro") is preserved for cases
not covered by the catalog.

## Why

- Product parity: officina interventions already use a structured type + checklist
  (`packages/web/src/components/intervention-form/InterventionForm.tsx`). Private
  interventions lagged behind with a plain `TextInput` for "Tipo"
  (`packages/mobile/src/components/PrivateInterventionForm.tsx`, free-text `custom_type`).
- Data quality: structured type + checklist selections (persisted as snapshots) make
  private history comparable to officina history and displayable in the vehicle timeline.

## Decisions taken during brainstorming

1. **Checklist is persisted and displayed** (full parity), not just a creation-time aid.
   → requires a new DB table + migration.
2. **Free-text preserved as "Altro"** fallback. Catalog type ⇒ checklist path;
   "Altro" ⇒ free-text path, no checklist. Mirrors the existing API XOR
   (`intervention_type_id` XOR `custom_type`).
3. **Checklist mandatory (min 1)** when a catalog type is chosen — same as BR-300.
4. **Edit (PATCH) also supported**, with re-snapshot (replace-set), mirroring officina
   BR-303.
5. **Same catalog source** as the web officina app: the global rows
   (`intervention_types` / `intervention_checklist_items` with `tenant_id = NULL`,
   `active = true`) managed from the admin console. The only difference on the customer
   path is that **per-tenant exclusions (BR-304) do not apply** (customers are not
   tenant-scoped).

## Approach

**Chosen: A — full parity, dedicated customer-scoped table, 2-PR arc.**

Rejected alternatives:
- **B — reuse `InterventionChecklistSelection` with a nullable `privateInterventionId`.**
  Mixes tenant-scoped and customer-scoped rows in one RLS table (two scoping columns,
  ambiguous policy). Security smell — rejected.
- **C — store a JSON array of checklist item ids on `private_interventions`.** Violates
  BR-303 (frozen `label_snapshot` + `onDelete: SetNull`) and diverges from the officina
  pattern. Rejected given the full-parity requirement.

---

## PR-1 — Backend (Database + API)

### 1. Database

New table `PrivateInterventionChecklistSelection` — twin of `InterventionChecklistSelection`
(schema.prisma:512-528) but **customer-scoped** instead of tenant-scoped:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `privateInterventionId` | FK → `private_interventions(id)` **ON DELETE CASCADE** | |
| `customerId` | uuid, denormalized | RLS scoping column |
| `checklistItemId` | uuid? FK → `intervention_checklist_items(id)` **ON DELETE SET NULL** | BR-303 |
| `labelSnapshot` | `VarChar(150)` | frozen at save |
| `sortOrderSnapshot` | `SmallInt?` | frozen at save |
| `createdAt` | `timestamptz` default now | |

- `@@unique([privateInterventionId, checklistItemId])`, `@@index([privateInterventionId])`.
- **RLS**: single `FOR ALL` policy mirroring `private_int_isolation`
  (migration `20260424100000_rls_triggers_checks/migration.sql:438-445`):
  ```sql
  ALTER TABLE private_intervention_checklist_selections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE private_intervention_checklist_selections FORCE ROW LEVEL SECURITY;
  CREATE POLICY private_int_checklist_isolation
    ON private_intervention_checklist_selections
    USING (is_admin_role() OR customer_id = current_customer_id());
  ```
  (Chosen over the split SELECT/WRITE append-only pattern for consistency with the
  direct parent table `private_interventions`.)
- Additive migration, **no drops** → no DROP approval needed. Blanket grants +
  `ALTER DEFAULT PRIVILEGES` (migration `20260430120000_...:36-37,58-63`) cover the new
  table; `garageos_app` stays NOBYPASSRLS.
- Migration is operator-driven (`prisma migrate deploy` on DIRECT_URL) — not in the
  deploy workflow. Portable SQL (no hardcoded role/db).

### 2. API

**a) New customer catalog endpoint** — `GET /v1/me/intervention-types`
- Guards `[requireAuth, requireClientiPool, clientiContext]`.
- Returns the **global** catalog (`tenantId: null, active: true`) with nested active
  `checklistItems`, **without** per-tenant exclusions. BR-305 applies: omit types with
  0 visible checklist items.
- snake_case shape, consistent with the other `/me` private-intervention endpoints:
  ```json
  { "data": [
    { "id": "...", "code": "...", "name_it": "...", "icon": "...",
      "checklist_items": [ { "id": "...", "code": "...", "name_it": "...", "sort_order": 0 } ] }
  ] }
  ```
- Deadline fields (`suggestsDeadline`, `defaultDeadline*`) are omitted — private
  interventions have no deadline logic.

**b) `validateChecklistSelection` → make `tenantId` optional**
(`packages/api/src/lib/intervention-shared.ts:131-201`). The per-tenant exclusion checks
(BR-302/304, lines 158-168 and 188-198) run **only when `tenantId != null`**. Officina
path unchanged (passes `tenantId`); private path passes `tenantId: undefined` and thus
skips only the tenant-exclusion checks, while still enforcing BR-300 (min 1) and BR-301
(item belongs to active type). Single source of truth — no duplicated validator.

**c) `POST /v1/me/vehicles/:id/private-interventions`** (me-private-interventions.ts:218-298)
- Add `checklist_item_ids: z.array(z.uuid()).optional()` to `createBodySchema`.
- Handler rules:
  - `intervention_type_id` set ⇒ checklist **required** (BR-300), validate via the shared
    validator (tenant-less), then snapshot into `private_intervention_checklist_selections`
    via `createMany` (`checklistItemId`, `labelSnapshot: nameIt`, `sortOrderSnapshot: sortOrder`,
    `customerId`).
  - `custom_type` ("Altro") set ⇒ `checklist_item_ids` must be **absent/empty**, else
    `422 intervention.creation.checklist_item_invalid`.
- Existing XOR refine (type_id XOR custom_type) preserved.

**d) `PATCH /v1/me/private-interventions/:id`** (me-private-interventions.ts:300-386)
- Add `checklist_item_ids` (optional) to `patchBodySchema`.
- Replace-set with retain-preserve, mirroring officina BR-303
  (`interventions-update.ts:230-283`): validate against the **effective** type; delete
  selections whose `checklistItemId` is null or not in the desired set; insert only newly
  added items with a fresh snapshot; retained items keep their original snapshot.
- If the merged post-state is a catalog type and `checklist_item_ids` was **not** provided
  while the type **changed** ⇒ `400 intervention.creation.checklist_required` (officina parity).
- Switching to `custom_type` ("Altro") ⇒ delete all existing selections.

**e) Read DTOs** — `GET` detail + per-vehicle list add
`checklist_items: [{ id, label }]` via the pure `serializeChecklistItems`
(`intervention-shared.ts:104-124`, reusable, no tenant coupling). Empty array for
free-text ("Altro") private interventions.

**Error codes** — reuse the existing checklist family (APPENDICE_G:285-286): identical
semantics, no new codes:
| code | status | BR |
|---|---|---|
| `intervention.creation.checklist_required` | 400 | BR-300 |
| `intervention.creation.checklist_item_invalid` | 422 | BR-301, BR-302 |

### 3. Tests (PR-1, Tier 1 — full coverage)

- **New endpoint contract**: 200 shape; clienti-pool only (officina → 403); returns global
  catalog with checklist items; BR-305 (types with 0 visible items omitted).
- **Create**: type + checklist snapshots persisted; BR-300 (empty checklist → 400);
  BR-301 (item not belonging to type → 422); XOR (type_id + custom_type → 422);
  custom_type + checklist → 422.
- **PATCH**: replace-set; retained item keeps original snapshot (BR-303); type change
  without checklist → 400; switch to custom_type clears selections.
- **RLS (negative)**: customer A cannot read/write customer B's
  `private_intervention_checklist_selections` (cross-customer isolation).

### 4. Docs (PR-1)

- APPENDICE_A: document `GET /v1/me/intervention-types` and the new `checklist_item_ids`
  request field + `checklist_items` response field on the private-intervention endpoints.
- APPENDICE_F: add a private-family note (e.g. **BR-086**) pointing to BR-300/301/303 for
  the private-intervention checklist parity.
- APPENDICE_G: no new codes (reuse noted).

---

## PR-2 — Mobile

### 1. Data layer
- New query `useMeInterventionTypes()` → `GET /v1/me/intervention-types` (mirror
  `packages/web/src/queries/interventionTypes.ts`), with an appropriate query key.
- Update `packages/mobile/src/lib/types/private-intervention.ts`:
  `CreatePrivateInterventionBody` gains `checklist_item_ids`, detail type gains
  `checklist_items`.

### 2. Form (`PrivateInterventionForm.tsx`)
- Replace the free-text "Tipo" `TextInput` with a **type selector** (catalog types +
  an "Altro" entry), using the existing mobile selection idiom.
- Catalog type selected ⇒ render the **checklist** (checkboxes) filtered to that type,
  reset on type change (BR-300 parity).
- "Altro" selected ⇒ show the free-text input, no checklist.
- Body builder emits `intervention_type_id` + `checklist_item_ids` **or** `custom_type`.
- Validator `packages/mobile/src/lib/validators/privateIntervention.ts`: conditional —
  catalog type ⇒ `checklistItemIds` min 1; "Altro" ⇒ `customType` required.

### 3. Edit (`app/private-interventions/[id].tsx`)
- Preload existing type + checklist selections; allow changing type and re-selecting
  checklist (drives the PATCH replace-set).

### 4. Detail display
- Show the checklist items for private interventions (mirror the customer checklist
  display shipped in #253).

### 5. Tests (PR-2)
- **Tier 2 (mobile)**: form happy path (type → checklist → submit), "Altro" path,
  error state. No pure-rendering tests.
- **Smoke runbook** (BLOCKER — UI, device-facing): create with catalog type + checklist,
  create with "Altro", edit an existing private intervention, verify detail shows checklist.

---

## Open implementation details (resolved with recommendations)

- **RLS**: single `FOR ALL` policy (mirrors parent) — **chosen**.
- **Error codes**: reuse `intervention.creation.checklist_*` — **chosen**.

## Risks / notes

- `validateChecklistSelection` is shared with the production officina path — making
  `tenantId` optional must not change officina behavior; covered by keeping the tenant
  branch gated and by the existing officina tests.
- Mobile needs a native selection UI (modal picker / list) — pick the idiom already used
  elsewhere in the app during planning; avoid introducing a new dependency (CLAUDE.md #7).
- PR sizing: each PR targets <500-800 LOC (well under the 1500 hard limit). If PR-1
  approaches the limit, the new endpoint can split from the create/patch changes.

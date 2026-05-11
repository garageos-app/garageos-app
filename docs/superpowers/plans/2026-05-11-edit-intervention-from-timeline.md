# Edit intervention from timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the web UI for editing an existing intervention from the
vehicle timeline. PATCH endpoint already exists; this slice adds a
dialog modal, the BR-062 banner, the conditional `reason` field, and
extends the timeline DTO to surface `wiki_locked_at` and intervention
type id.

**Architecture:** TimelineRow expands → "Modifica" button in the
expanded panel → `<EditInterventionDialog>` mounts → RHF + Zod form
pre-populated from the row data → diff-on-submit → `useUpdateIntervention`
hook → invalidate `['vehicle-timeline', vehicleId]` and close.

**Tech Stack:** React 19, react-hook-form 7, Zod 4, @tanstack/react-query
5, shadcn/ui (Dialog, Select, Textarea, Input, Alert, Button), Sonner,
Vitest + RTL + JSDOM, Fastify 5 + Prisma 7 (backend, single file edit).

**Spec:** `docs/superpowers/specs/2026-05-11-edit-intervention-from-timeline-design.md`

---

## File map

**Backend (1 modified):**
- `packages/api/src/routes/v1/vehicles-timeline.ts` — extend
  `shopRowSelect` + DTO mapper.
- `packages/api/tests/integration/vehicles-timeline.test.ts` — extend
  existing assertion + add 1 new scenario.
- `docs/APPENDICE_A_API.md` — §2.5 timeline response schema.

**Web (5 new + 4 modified):**
- NEW `packages/web/src/lib/validators/editIntervention.ts`
- NEW `packages/web/src/lib/validators/editIntervention.test.ts`
- NEW `packages/web/src/queries/updateIntervention.ts`
- NEW `packages/web/src/queries/updateIntervention.test.tsx`
- NEW `packages/web/src/components/EditInterventionDialog.tsx`
- NEW `packages/web/src/components/EditInterventionDialog.test.tsx`
- MOD `packages/web/src/queries/types.ts` — extend `ShopTimelineItem`.
- MOD `packages/web/src/components/TimelineRow.tsx` — wire edit button +
  dialog mount.
- MOD `packages/web/src/components/TimelineRow.test.tsx` — 3 new
  scenarios.

---

## Pre-flight checklist (verified by author 2026-05-11)

1. **RLS topology** — slice C does NOT introduce a new read endpoint on
   the `interventions` table. Timeline DTO extension reuses the existing
   `vehicles-timeline.ts` route (single consumer of `shopRowSelect`).
   No `findUniqueOrThrow` mirror pattern at risk.
2. **Error code spelling** — verified in
   `packages/api/src/routes/v1/interventions-update.ts:126-153`:
   - 422 `intervention.modification.cancelled` (BR-130)
   - 422 `intervention.modification.disputed` (BR-128)
   - 400 `intervention.modification.revision_reason_required` (BR-064)
3. **Backend Zod `reason` constraint** — verified in
   `packages/database/src/validators/intervention.ts:57`: `reason:
   z.string().min(10).max(2000).optional()`. Web form must NOT send
   `reason` when its value is `< 10` chars (the dialog strips it; the
   backend handler additionally guards with the 400 above).
4. **Query key** — `['vehicle-timeline', vehicleId]` (kebab-case),
   matches `useVehicleTimeline` at
   `packages/web/src/queries/vehicleTimeline.ts:8`.
5. **Toast library** — `sonner`, imported as `import { toast } from
   'sonner';`. Mock pattern verified at
   `packages/web/src/queries/createIntervention.test.tsx:27`.
6. **`useApiFetch` + `ApiError`** — from `@/lib/api-client`. `ApiError`
   exposes `code: string`, `status: number`, `message: string`.
7. **`useInterventionTypes` shape** — returns `{ data:
   InterventionType[] }`; `InterventionType` includes `id`, `code`,
   `nameIt`. Verified at `packages/web/src/queries/interventionTypes.ts`
   and `packages/web/src/queries/types.ts:118-127`.
8. **`PartReplacedSchema`** — exported by `@garageos/database`. Already
   consumed by `lib/validators/intervention.ts` (create form). Reuse for
   `partsReplaced` field validation.
9. **`PartsRepeater`** — at
   `packages/web/src/components/intervention-form/PartsRepeater.tsx`.
   Consumes RHF context via `useFormContext` + `useFieldArray` —
   reusable in any `FormProvider` with `partsReplaced` field array.
10. **`collectErrorMessages` walker** — currently inlined in
    `packages/web/src/components/intervention-form/InterventionForm.tsx:31-44`.
    The plan duplicates the helper inline in the dialog (the spec
    explicitly accepts this duplication; extracting to a shared module
    is out of scope and would change line count by 2 files).

---

## Task 1: Backend timeline DTO extension

**Files:**
- Modify: `packages/api/src/routes/v1/vehicles-timeline.ts:91-102` (extend
  `shopRowSelect`)
- Modify: `packages/api/src/routes/v1/vehicles-timeline.ts:282-299` (extend
  DTO mapper)
- Modify: `packages/api/tests/integration/vehicles-timeline.test.ts`
  (extend existing officina scenario + add 1 new)
- Modify: `docs/APPENDICE_A_API.md` §2.5

- [ ] **Step 1: Write the failing integration test (new scenario)**

Open `packages/api/tests/integration/vehicles-timeline.test.ts` and add a
new test inside the officina describe block (use the same `beforeEach`
fixtures already in scope). Place it after the existing happy-path
scenario:

```typescript
it('surfaces wiki_locked_at as ISO string when intervention is locked', async () => {
  // Create an officina intervention, then force lock by writing
  // wiki_locked_at directly (mirrors the production trigger that fires
  // when first_seen_by_customer_at is set or createdAt > 48h ago).
  const intervention = await helpers.createIntervention({
    vehicleId: vehicle.id,
    tenantId: tenant.id,
    userId: user.id,
    interventionTypeId: maintenanceType.id,
  });
  const lockedAt = new Date('2026-05-01T10:00:00.000Z');
  await prismaAsAdmin.intervention.update({
    where: { id: intervention.id },
    data: { wikiLockedAt: lockedAt },
  });

  const response = await app.inject({
    method: 'GET',
    url: `/v1/vehicles/${vehicle.id}/timeline`,
    headers: { authorization: `Bearer ${officinaToken}` },
    remoteAddress: '10.20.30.41',
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  const row = body.data.find((r: { id: string }) => r.id === intervention.id);
  expect(row).toBeDefined();
  expect(row.wiki_locked_at).toBe(lockedAt.toISOString());
  expect(row.type).toMatchObject({
    id: maintenanceType.id,
    code: maintenanceType.code,
    name_it: maintenanceType.nameIt,
  });
});
```

Additionally, extend the FIRST officina happy-path assertion in the
same file. Find the existing block that asserts the shop row shape (it
matches the kind, id, type, etc.) and append:

```typescript
expect(row.wiki_locked_at).toBeNull();
expect(row.type.id).toEqual(expect.any(String));
```

- [ ] **Step 2: Run integration tests to confirm they fail**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-timeline
```

Expected: 2 failures — `Cannot read properties of undefined` on
`wiki_locked_at` and `type.id` (current DTO does not select them).

- [ ] **Step 3: Extend `shopRowSelect` and DTO mapper**

In `packages/api/src/routes/v1/vehicles-timeline.ts`, modify
`shopRowSelect` (lines 91-102):

```typescript
const shopRowSelect = {
  id: true,
  interventionDate: true,
  odometerKm: true,
  title: true,
  description: true,
  partsReplaced: true,
  status: true,
  wikiLockedAt: true,
  tenant: { select: { businessName: true } },
  location: { select: { city: true } },
  interventionType: { select: { id: true, code: true, nameIt: true } },
} as const;
```

In the shop-branch DTO mapper (lines 282-299), update the `return`
object inside `if (item.kind === 'shop_intervention')` to add `wiki_locked_at`
and `id` to the `type` object:

```typescript
return {
  kind: 'shop_intervention' as const,
  id: r.id,
  intervention_date: r.interventionDate.toISOString().slice(0, 10),
  odometer_km: r.odometerKm,
  type: {
    id: r.interventionType.id,
    code: r.interventionType.code,
    name_it: r.interventionType.nameIt,
  },
  title: r.title,
  description: r.description,
  parts_replaced_count: partsReplacedCount(r.partsReplaced),
  status: r.status,
  is_disputed: r.status === 'disputed',
  wiki_locked_at: r.wikiLockedAt ? r.wikiLockedAt.toISOString() : null,
  tenant: {
    business_name: r.tenant.businessName,
    location_city: r.location.city,
  },
  has_attachments: attachments > 0,
  attachments_count: attachments,
};
```

- [ ] **Step 4: Run the integration tests to confirm they pass**

```bash
pnpm --filter @garageos/api test:integration -- vehicles-timeline
```

Expected: all scenarios pass.

- [ ] **Step 5: Update APPENDICE_A_API.md §2.5**

Open `docs/APPENDICE_A_API.md`, locate the GET `/v1/vehicles/:id/timeline`
section (§2.5), find the `shop_intervention` row schema documentation,
and add two new fields:

```markdown
| `wiki_locked_at` | string \| null | ISO 8601 UTC timestamp. `null` = wiki window open (free edits per BR-062). Non-null = locked; subsequent PATCH requires `reason` ≥10 chars per BR-064. |
| `type.id` | string (uuid) | Intervention type UUID. Used by clients that need to populate edit forms with the current type. |
```

If the existing table contains `type.code` and `type.name_it`, place
`type.id` immediately before `type.code` for readability.

- [ ] **Step 6: Typecheck the API package**

```bash
pnpm --filter @garageos/api typecheck
```

Expected: clean exit.

- [ ] **Step 7: Commit Task 1**

```bash
git add packages/api/src/routes/v1/vehicles-timeline.ts \
        packages/api/tests/integration/vehicles-timeline.test.ts \
        docs/APPENDICE_A_API.md
git commit -m "$(cat <<'EOF'
feat(api): surface wiki_locked_at and type.id on timeline DTO

Extends GET /v1/vehicles/:id/timeline shop-intervention rows with
wiki_locked_at (nullable ISO timestamp) and type.id (uuid). Required
by the upcoming edit-intervention dialog (F-OFF-303) to render the
BR-062 wiki/locked banner and pre-populate the intervention type
Select. Zero handler logic change; DTO-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Web — extend TimelineItem types + fixture backfill

**Files:**
- Modify: `packages/web/src/queries/types.ts:70-84` (extend
  `ShopTimelineItem`)
- Modify: `packages/web/src/components/TimelineRow.test.tsx:23-37`
  (backfill `SHOP_ITEM` fixture with the new required fields)

- [ ] **Step 1: Extend ShopTimelineItem**

Open `packages/web/src/queries/types.ts` and modify the
`ShopTimelineItem` interface (around lines 70-84) to add the two new
fields:

```typescript
export interface ShopTimelineItem {
  kind: 'shop_intervention';
  id: string;
  intervention_date: string;
  odometer_km: number;
  type: { id: string; code: string; name_it: string };
  title: string | null;
  description: string;
  parts_replaced_count: number;
  status: string;
  is_disputed: boolean;
  wiki_locked_at: string | null;
  tenant: { business_name: string; location_city: string };
  has_attachments: boolean;
  attachments_count: number;
}
```

(`type.id` added inline as a required field; `wiki_locked_at` added as
a new required field. Order follows the backend DTO mapper for
readability.)

- [ ] **Step 2: Backfill the existing SHOP_ITEM fixture**

The TimelineRow tests construct a `ShopTimelineItem` literal that
previously omitted `type.id` and `wiki_locked_at`. The new contract
requires both. Open
`packages/web/src/components/TimelineRow.test.tsx` (around lines
23-37) and update `SHOP_ITEM`:

```typescript
const SHOP_ITEM: ShopTimelineItem = {
  kind: 'shop_intervention',
  id: 'shop-1',
  intervention_date: '2025-03-15T10:00:00Z',
  odometer_km: 30200,
  type: { id: 'type-tagliando', code: 'TAGLIANDO', name_it: 'Tagliando' },
  title: 'Tagliando 30000 km',
  description: 'Cambio olio motore e filtro olio.\nSostituiti dischi anteriori e pastiglie.',
  parts_replaced_count: 3,
  status: 'active',
  is_disputed: false,
  wiki_locked_at: null,
  tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
  has_attachments: true,
  attachments_count: 2,
};
```

`SHOP_ITEM_DISPUTED` already spreads from `SHOP_ITEM` and overrides
only a subset of fields, so it automatically inherits the new ones —
no edit needed there.

If any other file in the web package constructs a `ShopTimelineItem`
literal, the typecheck step below will surface it. Backfill those the
same way (`type: { id: '...', code: '...', name_it: '...' }`,
`wiki_locked_at: null` unless a different value is meaningful for the
test).

- [ ] **Step 3: Typecheck the web package**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: clean exit.

- [ ] **Step 4: Run the timeline-related tests to confirm fixtures still parse**

```bash
pnpm --filter @garageos/web test -- TimelineRow
```

Expected: existing scenarios still pass (no behavior change yet, only
fixture extension).

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/web/src/queries/types.ts \
        packages/web/src/components/TimelineRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): extend ShopTimelineItem with wiki_locked_at and type.id

Mirrors the new DTO fields shipped by the previous commit. Backfills
the TimelineRow test fixture to satisfy the new required fields.
Consumed by the upcoming edit-intervention dialog (F-OFF-303); zero
behavior change for existing timeline rendering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Web — EditInterventionFormSchema (Zod, TDD)

**Files:**
- Create: `packages/web/src/lib/validators/editIntervention.ts`
- Create: `packages/web/src/lib/validators/editIntervention.test.ts`

- [ ] **Step 1: Write the failing schema unit tests**

Create `packages/web/src/lib/validators/editIntervention.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { EditInterventionFormSchema } from './editIntervention';

describe('EditInterventionFormSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(EditInterventionFormSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully populated form payload', () => {
    const result = EditInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      title: 'Tagliando',
      description: 'Olio + filtri',
      partsReplaced: [{ name: 'Olio motore', quantity: 1, unit: 'L' }],
      internalNotes: 'Cliente segnala rumore',
      reason: 'Aggiunta nota interna su rumore',
    });
    expect(result.success).toBe(true);
  });

  it('rejects title longer than 200 chars', () => {
    const result = EditInterventionFormSchema.safeParse({
      title: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('rejects description with zero characters when provided', () => {
    const result = EditInterventionFormSchema.safeParse({
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null for nullable optional fields (title, internalNotes)', () => {
    expect(
      EditInterventionFormSchema.safeParse({ title: null, internalNotes: null }).success,
    ).toBe(true);
  });

  it('rejects reason longer than 2000 chars', () => {
    const result = EditInterventionFormSchema.safeParse({
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @garageos/web test -- editIntervention
```

Expected: every test fails with `Cannot find module './editIntervention'`.

- [ ] **Step 3: Implement the schema**

Create `packages/web/src/lib/validators/editIntervention.ts`:

```typescript
import { z } from 'zod';
import { PartReplacedSchema } from '@garageos/database';

// Mirrors @garageos/database UpdateInterventionSchema for the 5 BR-065
// editable fields, with two intentional divergences:
//
//   - `reason` is NOT min(10) here even though the backend Zod is. The
//     web dialog allows the user to type a partial reason while editing;
//     the "min 10 when locked" gate lives in the dialog handler so we can
//     surface inline error copy ("almeno 10 caratteri") under the field
//     instead of a generic Zod validation message. The dialog strips
//     reason from the PATCH body if the trimmed length is < 10, so the
//     backend Zod constraint is never reached for "too short" values.
//
//   - No "at least one field changed" refine — that constraint depends
//     on `defaultValues` context which Zod has no access to. The dialog
//     handles it via a diff helper before calling the mutation.
//
// The two fields nullable+optional (title, internalNotes) mirror the
// backend: `null` clears the field, `undefined` leaves it unchanged.

export const EditInterventionFormSchema = z.object({
  interventionTypeId: z.string().uuid().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(5000).optional(),
  partsReplaced: z.array(PartReplacedSchema).optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  reason: z.string().max(2000).optional(),
});

export type EditInterventionFormValues = z.infer<typeof EditInterventionFormSchema>;

// Body shape sent to PATCH /v1/interventions/:id. Identical to
// EditInterventionFormValues; aliased for clarity at the call site.
export type EditInterventionPayload = EditInterventionFormValues;
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @garageos/web test -- editIntervention
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/web/src/lib/validators/editIntervention.ts \
        packages/web/src/lib/validators/editIntervention.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add EditInterventionFormSchema (F-OFF-303)

Zod schema for the edit dialog. Mirrors the backend UpdateInterventionSchema
for the 5 BR-065 mutable fields with two web-specific divergences
documented inline (reason min-10 in dialog handler, no "at-least-one"
refine).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Web — useUpdateIntervention mutation hook (TDD)

**Files:**
- Create: `packages/web/src/queries/updateIntervention.ts`
- Create: `packages/web/src/queries/updateIntervention.test.tsx`

- [ ] **Step 1: Write the failing mutation tests**

Create `packages/web/src/queries/updateIntervention.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useUpdateIntervention } from './updateIntervention';
import { ApiError } from '@/lib/api-client';

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe('useUpdateIntervention', () => {
  it('happy path: PATCHes the endpoint and invalidates the timeline query', async () => {
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' } });
    const { qc, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await result.current.mutateAsync({
      id: 'i-1',
      body: { description: 'updated' },
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/v1/interventions/i-1', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'updated' }),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['vehicle-timeline', 'v-1'],
    });
  });

  it('propagates 400 revision_reason_required to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.revision_reason_required', 400, 'reason required'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { description: 'updated' } }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'intervention.modification.revision_reason_required',
    });
  });

  it('propagates 422 disputed error to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.disputed', 422, 'disputed'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 422, code: 'intervention.modification.disputed' });
  });

  it('propagates 422 cancelled error to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.cancelled', 422, 'cancelled'),
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 422, code: 'intervention.modification.cancelled' });
  });

  it('propagates 403/404/5xx errors', async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError('not_found', 404, 'not found'));
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUpdateIntervention('v-1'), { wrapper });

    await expect(
      result.current.mutateAsync({ id: 'i-1', body: { description: 'x' } }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @garageos/web test -- updateIntervention
```

Expected: every test fails with `Cannot find module './updateIntervention'`.

- [ ] **Step 3: Implement the mutation hook**

Create `packages/web/src/queries/updateIntervention.ts`:

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { EditInterventionPayload } from '@/lib/validators/editIntervention';

interface UpdateInterventionVariables {
  id: string;
  body: EditInterventionPayload;
}

// PATCH /v1/interventions/:id (F-OFF-304). On success, invalidates the
// vehicle-timeline query so the row re-renders with updated values.
// All error codes (400 revision_reason_required, 422 disputed/cancelled,
// 403/404, 5xx) bubble unchanged to the dialog, which maps them to
// inline errors or Sonner toasts.
export function useUpdateIntervention(vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, UpdateInterventionVariables>({
    mutationFn: ({ id, body }) =>
      apiFetch<unknown>(`/v1/interventions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vehicle-timeline', vehicleId] });
    },
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @garageos/web test -- updateIntervention
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add packages/web/src/queries/updateIntervention.ts \
        packages/web/src/queries/updateIntervention.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add useUpdateIntervention mutation hook (F-OFF-303)

PATCH /v1/interventions/:id with timeline invalidation on success. All
error codes bubble unchanged to the consumer so the dialog can map them
to inline errors or toasts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Web — EditInterventionDialog component (TDD)

**Files:**
- Create: `packages/web/src/components/EditInterventionDialog.tsx`
- Create: `packages/web/src/components/EditInterventionDialog.test.tsx`

- [ ] **Step 1: Write the failing dialog tests**

Create `packages/web/src/components/EditInterventionDialog.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EditInterventionDialog } from './EditInterventionDialog';
import { ApiError } from '@/lib/api-client';
import type { ShopTimelineItem } from '@/queries/types';

const { mockApiFetch, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

// Module-level mock of the intervention-types query so the dialog can
// render the <Select> without a network round trip. JSDOM does not
// open Radix Select portals reliably; we test the Select's value
// indirectly via the submitted PATCH body.
vi.mock('@/queries/interventionTypes', () => ({
  useInterventionTypes: () => ({
    data: {
      data: [
        {
          id: 't-1',
          code: 'tagliando',
          nameIt: 'Tagliando',
          description: '',
          icon: '',
          category: 'maintenance',
          suggestsDeadline: true,
          defaultDeadlineMonths: 12,
          defaultDeadlineKm: 15000,
        },
        {
          id: 't-2',
          code: 'gomme',
          nameIt: 'Cambio gomme',
          description: '',
          icon: '',
          category: 'tires',
          suggestsDeadline: false,
          defaultDeadlineMonths: null,
          defaultDeadlineKm: null,
        },
      ],
    },
    isPending: false,
    isError: false,
  }),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeShopItem(overrides: Partial<ShopTimelineItem> = {}): ShopTimelineItem {
  return {
    kind: 'shop_intervention',
    id: 'i-1',
    intervention_date: '2026-05-10',
    odometer_km: 50000,
    type: { id: 't-1', code: 'tagliando', name_it: 'Tagliando' },
    title: 'Tagliando 50k',
    description: 'Olio motore + filtri',
    parts_replaced_count: 2,
    status: 'active',
    is_disputed: false,
    wiki_locked_at: null,
    tenant: { business_name: 'Garage Acme', location_city: 'Milano' },
    has_attachments: false,
    attachments_count: 0,
    ...overrides,
  };
}

describe('EditInterventionDialog', () => {
  it('renders pre-populated form values from intervention prop', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByLabelText(/descrizione/i)).toHaveValue('Olio motore + filtri');
    // Title section is auto-expanded because intervention.title is non-null.
    expect(screen.getByLabelText(/titolo/i)).toHaveValue('Tagliando 50k');
  });

  it('renders "Modifiche libere" banner when wiki_locked_at is null', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: null })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/modifiche libere/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo della modifica/i)).not.toBeInTheDocument();
  });

  it('renders "Audit attivo" banner and reason field when wiki_locked_at is set', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: '2026-05-01T10:00:00.000Z' })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/audit attivo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/motivo della modifica/i)).toBeInTheDocument();
  });

  it('blocks submit when no fields changed (form-level error, no mutation)', async () => {
    const user = userEvent.setup();
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    await user.click(screen.getByRole('button', { name: /salva/i }));
    expect(await screen.findByText(/nessuna modifica da salvare/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('submits wiki-window edit (no reason in body), success toast + closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo testo');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/v1/interventions/i-1', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Nuovo testo' }),
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Intervento aggiornato');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks locked submit when reason < 10 chars (inline error, no mutation)', async () => {
    const user = userEvent.setup();
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: '2026-05-01T10:00:00.000Z' })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo');
    await user.type(screen.getByLabelText(/motivo della modifica/i), 'corto');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    expect(await screen.findByText(/almeno 10 caratteri/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('handles 422 disputed: shows toast and closes dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.disputed', 422, 'disputed'),
    );
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Modifica');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Intervento contestato: rispondi alla disputa prima di modificare.',
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @garageos/web test -- EditInterventionDialog
```

Expected: every test fails — `Cannot find module './EditInterventionDialog'`.

- [ ] **Step 3: Implement the dialog**

Create `packages/web/src/components/EditInterventionDialog.tsx`:

```typescript
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Info, AlertTriangle } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PartsRepeater } from '@/components/intervention-form/PartsRepeater';
import { ApiError } from '@/lib/api-client';
import {
  EditInterventionFormSchema,
  type EditInterventionFormValues,
  type EditInterventionPayload,
} from '@/lib/validators/editIntervention';
import { useUpdateIntervention } from '@/queries/updateIntervention';
import { useInterventionTypes } from '@/queries/interventionTypes';
import type { ShopTimelineItem } from '@/queries/types';

interface Props {
  intervention: ShopTimelineItem;
  vehicleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Walker copied from InterventionForm.tsx (lesson PR #64 — Zod errors
// hidden in collapsed optional sections are invisible to users). Surface
// every leaf `message` string in a top-of-form Alert.
function collectErrorMessages(errors: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.length > 0) {
      out.push(obj.message);
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(errors);
  return out;
}

// Cheap deep-equality for the parts array. Stable because both sides
// originate from Zod parses with the same key order.
function partsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildPatchBody(
  values: EditInterventionFormValues,
  original: EditInterventionFormValues,
): EditInterventionPayload {
  const patch: EditInterventionPayload = {};
  if (values.interventionTypeId !== original.interventionTypeId) {
    patch.interventionTypeId = values.interventionTypeId;
  }
  if (values.title !== original.title) {
    // Empty string -> null (clear); non-empty -> set.
    patch.title = values.title && values.title.length > 0 ? values.title : null;
  }
  if (values.description !== original.description) {
    patch.description = values.description;
  }
  if (values.internalNotes !== original.internalNotes) {
    patch.internalNotes =
      values.internalNotes && values.internalNotes.length > 0 ? values.internalNotes : null;
  }
  if (!partsEqual(values.partsReplaced ?? [], original.partsReplaced ?? [])) {
    patch.partsReplaced = values.partsReplaced ?? [];
  }
  // reason is wired only when locked AND >= 10 chars (handled inline).
  if (values.reason && values.reason.trim().length >= 10) {
    patch.reason = values.reason.trim();
  }
  return patch;
}

function mapApiError(err: ApiError): { message: string; close: boolean } {
  switch (err.code) {
    case 'intervention.modification.disputed':
      return {
        message: 'Intervento contestato: rispondi alla disputa prima di modificare.',
        close: true,
      };
    case 'intervention.modification.cancelled':
      return { message: 'Intervento cancellato: non modificabile.', close: true };
    case 'intervention.modification.revision_reason_required':
      return { message: 'Motivo richiesto (almeno 10 caratteri).', close: false };
    case 'not_found':
    case 'intervention.not_found':
      return { message: 'Intervento non trovato.', close: true };
    default:
      if (err.status === 403) {
        return { message: 'Non puoi modificare questo intervento.', close: true };
      }
      if (err.status >= 500) {
        return { message: 'Errore temporaneo, riprova.', close: false };
      }
      return { message: err.message || 'Errore imprevisto.', close: false };
  }
}

export function EditInterventionDialog({
  intervention,
  vehicleId,
  open,
  onOpenChange,
}: Props) {
  const types = useInterventionTypes();
  const mutation = useUpdateIntervention(vehicleId);
  const isLocked = intervention.wiki_locked_at !== null;

  const defaults: EditInterventionFormValues = {
    interventionTypeId: intervention.type.id,
    title: intervention.title ?? null,
    description: intervention.description,
    internalNotes: null, // timeline DTO does not expose internalNotes — see note below.
    partsReplaced: [], // timeline DTO does not expose partsReplaced JSON — see note below.
    reason: '',
  };

  // NOTE: timeline DTO surfaces parts_replaced_count and a coarse
  // description but NOT the raw `partsReplaced` JSON nor `internalNotes`.
  // Starting these defaults at empty is intentional: the diff helper
  // will only include them in the PATCH body if the user explicitly
  // edits them. If the user leaves them untouched, the backend keeps
  // the existing DB values (PATCH is per-field partial). The collapsible
  // sections render closed by default in this case so the user sees an
  // explicit "Pezzi sostituiti" / "Note interne" toggle rather than an
  // empty editor that looks like data was lost.

  const methods = useForm<EditInterventionFormValues>({
    resolver: zodResolver(EditInterventionFormSchema),
    defaultValues: defaults,
  });

  // Collapsible expansion state. partsReplaced and internalNotes default
  // to collapsed because the timeline DTO does not surface their full
  // contents; expanding the section is the user's signal that they
  // intend to overwrite. Title is auto-expanded if the row already has
  // one (so the user sees what's there rather than an "Aggiungi titolo"
  // button on an intervention that already has a title).
  const [showTitle, setShowTitle] = useState(!!intervention.title);
  const [showParts, setShowParts] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);

  const allErrorMessages = collectErrorMessages(methods.formState.errors);

  async function onSubmit(values: EditInterventionFormValues) {
    setFormError(null);

    // Locked-but-reason-too-short guard: inline error under reason.
    if (isLocked && (!values.reason || values.reason.trim().length < 10)) {
      methods.setError('reason', {
        type: 'manual',
        message: 'Motivo richiesto (almeno 10 caratteri).',
      });
      return;
    }

    const patch = buildPatchBody(values, defaults);
    if (Object.keys(patch).length === 0) {
      setFormError('Nessuna modifica da salvare.');
      return;
    }

    try {
      await mutation.mutateAsync({ id: intervention.id, body: patch });
      toast.success('Intervento aggiornato');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped = mapApiError(err);
        if (mapped.close) {
          toast.error(mapped.message);
          onOpenChange(false);
        } else if (err.code === 'intervention.modification.revision_reason_required') {
          methods.setError('reason', { type: 'manual', message: mapped.message });
        } else {
          toast.error(mapped.message);
        }
      } else {
        toast.error('Errore imprevisto.');
      }
    }
  }

  const submitting = mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifica intervento</DialogTitle>
          <DialogDescription>
            Aggiorna i campi modificabili dell&apos;intervento.
          </DialogDescription>
        </DialogHeader>

        <FormProvider {...methods}>
          <form
            onSubmit={methods.handleSubmit(onSubmit)}
            noValidate
            className="space-y-4"
          >
            {/* BR-062 banner */}
            {isLocked ? (
              <Alert variant="default">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Audit attivo. La modifica sarà registrata e visibile al cliente. Motivo
                  richiesto.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  Modifiche libere. La modifica non sarà tracciata né visibile al cliente.
                </AlertDescription>
              </Alert>
            )}

            {/* Top-of-form aggregated Zod errors (lesson PR #64) */}
            {allErrorMessages.length > 0 && (
              <div
                className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
                role="alert"
              >
                <div className="font-medium mb-1">Correggi i campi seguenti:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {allErrorMessages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Form-level error (no-change guard) */}
            {formError && (
              <div
                className="border border-amber-200 bg-amber-50 text-amber-900 rounded-md p-3 text-sm"
                role="alert"
              >
                {formError}
              </div>
            )}

            {/* Description */}
            <div>
              <Label htmlFor="desc">Descrizione</Label>
              <Textarea id="desc" rows={4} {...methods.register('description')} />
              {methods.formState.errors.description && (
                <p className="text-sm text-red-600 mt-1">
                  {methods.formState.errors.description.message}
                </p>
              )}
            </div>

            {/* Intervention type select */}
            <div>
              <Label htmlFor="type">Tipo intervento</Label>
              <Select
                value={methods.watch('interventionTypeId') ?? ''}
                onValueChange={(v) =>
                  methods.setValue('interventionTypeId', v, { shouldValidate: true })
                }
              >
                <SelectTrigger id="type">
                  <SelectValue placeholder="Seleziona…" />
                </SelectTrigger>
                <SelectContent>
                  {types.data?.data.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.nameIt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Title (collapsible) */}
            {!showTitle ? (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground block"
                onClick={() => setShowTitle(true)}
              >
                ▸ Aggiungi titolo personalizzato
              </button>
            ) : (
              <div>
                <Label htmlFor="title">Titolo</Label>
                <Input id="title" {...methods.register('title')} />
              </div>
            )}

            {/* Parts replaced (collapsible) */}
            {!showParts ? (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground block"
                onClick={() => setShowParts(true)}
              >
                ▸ Modifica pezzi sostituiti
              </button>
            ) : (
              <div>
                <Label>Pezzi sostituiti</Label>
                <PartsRepeater />
              </div>
            )}

            {/* Internal notes (collapsible) */}
            {!showNotes ? (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground block"
                onClick={() => setShowNotes(true)}
              >
                ▸ Modifica note interne
              </button>
            ) : (
              <div>
                <Label htmlFor="notes">Note interne</Label>
                <Textarea id="notes" rows={3} {...methods.register('internalNotes')} />
              </div>
            )}

            {/* Reason (only when locked) */}
            {isLocked && (
              <div>
                <Label htmlFor="reason">Motivo della modifica (richiesto, min 10 caratteri)</Label>
                <Textarea id="reason" rows={3} {...methods.register('reason')} />
                <p className="text-xs text-muted-foreground mt-1">
                  Sarà visibile al cliente nello storico revisioni.
                </p>
                {methods.formState.errors.reason && (
                  <p className="text-sm text-red-600 mt-1">
                    {methods.formState.errors.reason.message}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Annulla
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Salvataggio…' : 'Salva'}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @garageos/web test -- EditInterventionDialog
```

Expected: all 7 tests pass.

If the Select trigger tests fail due to JSDOM portal issues, apply the
mock pattern from `feedback_jsdom_radix_select_mock_pattern.md`:
module-level mock the `@/components/ui/select` exports with simple
`<select>`/`<option>` shims for the test file only.

- [ ] **Step 5: Commit Task 5**

```bash
git add packages/web/src/components/EditInterventionDialog.tsx \
        packages/web/src/components/EditInterventionDialog.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add EditInterventionDialog component (F-OFF-303)

Dialog modal wrapping an RHF + Zod form with the 5 BR-065 editable
fields, the BR-062 banner (wiki window vs locked), and the conditional
reason field. Diffs against defaults pre-submit so unchanged fields
never reach the backend. Maps all known PATCH error codes to inline
errors or Sonner toasts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Web — wire edit button into TimelineRow

**Files:**
- Modify: `packages/web/src/components/TimelineRow.tsx`
- Modify: `packages/web/src/components/TimelineRow.test.tsx` (add 3
  scenarios)

- [ ] **Step 1: Add the EditInterventionDialog mock and new test scenarios**

Open `packages/web/src/components/TimelineRow.test.tsx`. The file uses
constant fixtures (`SHOP_ITEM`, `SHOP_ITEM_DISPUTED`, `PRIVATE_ITEM` —
already backfilled with `wiki_locked_at` and `type.id` in Task 2) and a
`renderRow(item, vehicleId?)` helper — match those patterns.

Add a module-level mock of `EditInterventionDialog` immediately below
the existing `DisputeResponseDialog` mock (around line 21):

```typescript
vi.mock('./EditInterventionDialog', () => ({
  EditInterventionDialog: ({
    open,
    intervention,
  }: {
    open: boolean;
    intervention: { id: string };
  }) =>
    open ? <div data-testid={`edit-dialog-open-${intervention.id}`} /> : null,
}));
```

Finally, append a new `describe` block at the bottom of the file (after
the existing `describe('TimelineRow — expanded private content')`):

```typescript
describe('TimelineRow — edit affordance', () => {
  const SHOP_ITEM_CANCELLED: ShopTimelineItem = {
    ...SHOP_ITEM,
    id: 'shop-cancelled',
    status: 'cancelled',
  };

  it('shows "Modifica" button in expanded panel when status=active', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument();
  });

  it('hides "Modifica" button when status=disputed', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.queryByRole('button', { name: 'Modifica' })).not.toBeInTheDocument();
  });

  it('hides "Modifica" button when status=cancelled', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_CANCELLED);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));

    expect(screen.queryByRole('button', { name: 'Modifica' })).not.toBeInTheDocument();
  });

  it('clicking "Modifica" mounts EditInterventionDialog with open=true', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    await user.click(screen.getByRole('button', { name: 'Espandi dettagli intervento' }));
    await user.click(screen.getByRole('button', { name: 'Modifica' }));

    expect(screen.getByTestId(`edit-dialog-open-${SHOP_ITEM.id}`)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @garageos/web test -- TimelineRow
```

Expected: 4 failures — the new scenarios reference a "Modifica" button
that does not yet exist.

- [ ] **Step 3: Wire the edit button and dialog into TimelineRow**

Modify `packages/web/src/components/TimelineRow.tsx`. Apply three
changes:

(a) Add the import at the top of the file (after the existing
`DisputeResponseDialog` import):

```typescript
import { EditInterventionDialog } from '@/components/EditInterventionDialog';
```

(b) Inside the `TimelineRow` component body, add edit dialog state
alongside the existing dispute state (just under `const [disputeDialogOpen,
setDisputeDialogOpen] = useState(false);`):

```typescript
const [editDialogOpen, setEditDialogOpen] = useState(false);
const isEditable = isShop && item.status === 'active';
```

(c) Pass `isEditable` and an open callback down to `ExpandedPanel`, and
add the conditional dialog mount near the existing `<DisputeResponseDialog>`
mount.

Replace the existing `<ExpandedPanel item={item} />` call with:

```typescript
<ExpandedPanel
  item={item}
  isEditable={isEditable}
  onEditClick={() => setEditDialogOpen(true)}
/>
```

Below the existing dispute dialog mount (`{isShop && isDisputed && ...}`),
add:

```typescript
{isShop && isEditable && (
  <EditInterventionDialog
    intervention={item}
    vehicleId={vehicleId}
    open={editDialogOpen}
    onOpenChange={setEditDialogOpen}
  />
)}
```

Then update the `ExpandedPanel` function signature and body to accept
the new props and render the "Modifica" button at the top of the
content area. Replace the existing `ExpandedPanel` function with:

```typescript
function ExpandedPanel({
  item,
  isEditable,
  onEditClick,
}: {
  item: TimelineItem;
  isEditable: boolean;
  onEditClick: () => void;
}) {
  const description = item.description.trim();
  const isShop = item.kind === 'shop_intervention';
  const partsCount = isShop ? item.parts_replaced_count : 0;
  const hasAttachments = item.has_attachments && item.attachments_count > 0;

  return (
    <div className="space-y-3 pl-28">
      {description ? (
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{description}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">Nessuna descrizione.</p>
      )}
      {(partsCount > 0 || hasAttachments) && (
        <div className="flex flex-wrap gap-2">
          {partsCount > 0 && (
            <Badge variant="secondary" className="text-[11px]">
              {partsCount} ricambi
            </Badge>
          )}
          {hasAttachments && (
            <Badge variant="secondary" className="text-[11px]">
              Con allegati ({item.attachments_count})
            </Badge>
          )}
        </div>
      )}
      {isEditable && (
        <div>
          <button
            type="button"
            onClick={onEditClick}
            className="text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
          >
            Modifica
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: `isShop` is no longer used inside `ExpandedPanel` after this
refactor — leave the local variable since it's still referenced for
`partsCount`. The TypeScript narrowing relies on the discriminated
union check.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @garageos/web test -- TimelineRow
```

Expected: all scenarios pass (existing + 4 new).

- [ ] **Step 5: Commit Task 6**

```bash
git add packages/web/src/components/TimelineRow.tsx \
        packages/web/src/components/TimelineRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): wire Modifica button into TimelineRow (F-OFF-303)

Renders a "Modifica" button inside the expanded panel of officina
timeline rows when the intervention is in an editable status
(active). Mounts EditInterventionDialog conditionally on
the same gate so disputed and cancelled rows never expose the action.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full web test suite**

```bash
pnpm --filter @garageos/web test
```

Expected: all suites pass. Any unrelated failure that surfaces here
is a regression — investigate before proceeding.

- [ ] **Step 2: Run the full web + api typecheck**

```bash
pnpm -r typecheck
```

Expected: clean exit across all packages. (The pre-push hook will
also run this, so a clean local run is the final gate before push.)

- [ ] **Step 3: Verify the commit log**

```bash
git log --oneline main..HEAD
```

Expected: 6 commits (one per Task 1–6), each conventional-commit
formatted with `feat(api)` or `feat(web)` scope.

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/edit-intervention-from-timeline-spec
gh pr create --title "feat(web): edit intervention from timeline (F-OFF-303)" --body "$(cat <<'EOF'
## What

Ship the web UI for editing an existing intervention directly from the
vehicle timeline. PATCH /v1/interventions/:id (F-OFF-304) was shipped
pre-pivot; this slice adds:

- The "Modifica" button inside expanded timeline rows (gated on
  `status === 'active'`)
- `EditInterventionDialog` — dialog modal with RHF + Zod form,
  BR-062 banner (wiki vs locked), conditional reason field
- `useUpdateIntervention` mutation hook with timeline invalidation
- Backend DTO extension: surface `wiki_locked_at` and `type.id` on
  the timeline shop-intervention rows

## Why

F-OFF-303 — officina users need to correct interventions they
mistakenly recorded. Without this slice, the only path is to cancel
the row (BR-130 terminal) and log a new one. Spec at
`docs/superpowers/specs/2026-05-11-edit-intervention-from-timeline-design.md`.

## Implementation notes

- BR-062 wiki window vs locked is communicated upfront via a banner
  in the dialog header. The reason field is in DOM only when locked;
  the client also pre-validates `reason ≥ 10` to surface inline copy
  instead of letting the backend Zod produce a generic error.
- The dialog computes a diff against defaults pre-submit. Unchanged
  fields are never included in the PATCH body, which keeps the backend
  revision row free of no-op entries.
- `partsReplaced` and `internalNotes` start at empty defaults because
  the timeline DTO does not surface their full contents. The
  collapsible sections render closed by default so users see an
  explicit "Modifica pezzi sostituiti" toggle rather than what looks
  like an empty editor.
- AuthContext does not expose role; client-side gating is purely
  status-based (cancelled/disputed hide the button). Backend 403 is
  the authoritative fence for non-officina principals.

## Tests

- [ ] Unit tests added (schema, mutation hook, dialog, TimelineRow scenarios)
- [ ] Integration test extended (vehicles-timeline DTO surface)
- [ ] BR-062 (banner + reason gate), BR-064 (reason min-10), BR-128
      (disputed hide + 422), BR-130 (cancelled hide + 422) verified
- [ ] Manual smoke (post-deploy):
  - Wiki happy path: edit immediately, save without reason
  - Locked happy path: reason ≥10, revision visible to customer
  - Reason missing post-lock: inline error
  - Disputed/cancelled: button hidden

## Checklist

- [ ] Code follows conventions in CONTRIBUTING.md
- [ ] Types compile (`pnpm -r typecheck`)
- [ ] Tests pass (`pnpm --filter @garageos/web test`)
- [ ] No new console.log, no commented-out code
- [ ] No secrets committed
- [ ] APPENDICE_A_API.md updated for new DTO fields

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(If the PR description checkboxes don't render cleanly through the
HEREDOC, paste them manually via the GitHub UI.)

---

## Definition of done

- All 7 tasks committed.
- `pnpm -r typecheck` clean.
- `pnpm --filter @garageos/web test` green (all suites).
- CI green (`pnpm --filter @garageos/api test:integration` covers the
  DTO extension — runs in CI only per the pre-push hook policy).
- PR opened with the description above.
- Post-merge: operator smoke (see "Manual smoke" in PR description).

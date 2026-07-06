# PR-2 (mobile) — Private intervention type + checklist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the mobile customer private-intervention create/edit flow to parity with the officina flow — pick an `intervention_type_id` from the global catalog and select its checklist items (persisted server-side by PR-1 #256), keeping a free-text ("Altro") fallback.

**Architecture:** A new `useMeInterventionTypes()` query wraps the PR-1 `GET /v1/me/intervention-types` catalog endpoint. `PrivateInterventionForm` fetches that catalog internally and replaces the free-text "Tipo" `TextInput` with a single-select **chip row** (catalog types + an "Altro" chip). A catalog type reveals a **checkbox-row checklist** (mandatory ≥1, reset on type change); "Altro" reveals the free-text input (no checklist). The pure validator becomes conditional on the selection. The edit screen preloads the selection + checked items from the detail DTO — since `private-interventions/[id].tsx` is the editable form (there is no separate read-only private detail), the pre-checked checklist **is** the detail display.

**Tech Stack:** React Native + Expo (expo-router), TypeScript strict, `@tanstack/react-query@^5`, `@expo/vector-icons` (Ionicons), Jest + `@testing-library/react-native`. No Zod on mobile (hand-rolled pure validator).

## Global Constraints

- TypeScript strict; no `any` without a justified comment.
- Comments in **English**; user-facing strings in **Italian** (no i18n table on these screens — literal Italian copy).
- **No new npm dependency** (CLAUDE.md #7). Reuse the existing chip idiom (`PersonalDeadlineForm`) and `Ionicons` — both already deps.
- Conventional Commits, summary ≤ 72 chars (commitlint is a hard CI gate on every commit).
- Tier-2 mobile tests: 2-3 per screen — happy path, error state, and conditional logic that gates data. **No pure-rendering tests.** The pure validator is business logic → test-first, full coverage (Tier 1).
- Local pre-push gate is **typecheck only** (`pnpm -r typecheck`); the rest runs on CI. Run the targeted mobile test suite locally only for the files this PR rewrites (React-dup Windows fix in jest config makes mobile tests pass locally — project memory).
- Never weaken a validator/invariant to make a test pass.

## Deviations from spec (verified against actual code — the code wins)

1. **The form fetches the catalog internally** via `useMeInterventionTypes()` (not passed as a prop). Both thin screens (`new.tsx`, `[id].tsx`) stay unchanged w.r.t. data-fetching; catalog loading/error is a form concern. Consequence: the form test mocks `@/queries/meInterventionTypes` (one `jest.mock`, mirroring the existing `datetimepicker` mock idiom in the same file).
2. **No separate read-only private detail screen exists.** `app/private-interventions/[id].tsx` serves both view and edit. Spec §4 ("detail display shows checklist") is satisfied by the edit form rendering the checklist **pre-checked** for the loaded type — no extra "Voci eseguite" read-only section is added on the private path. (The #253 read-only "Voci eseguite" section stays only on the **officina** detail `app/interventions/[id].tsx`.)
3. **"Altro" is a sentinel selection key** (`ALTRO_TYPE_KEY = 'altro'`), stored in the same `selectedKey: string | null` state as catalog UUIDs — `'altro'` can never collide with a UUID. Exported from the validator (pure, no RN deps) and imported by the form and the edit screen.
4. **Checklist reset on type change happens in the chip `onPress` handler**, not a mount effect — so the edit preload (set via `useState` initializer) is never clobbered. Simpler and safer than the web's `useEffect` (project memory: async-mount effect clobbers user action / render-phase state sync).
5. **Edit checklist labels come from the live catalog**, not the frozen snapshot — the edit form re-selects from the current catalog (same as web edit). The persisted snapshot is authoritative in storage; a snapshot item whose catalog row was deleted has `id: null` in the DTO and cannot be re-checked (BR-303 SetNull) — it silently drops on the next save. Logged as a known Minor.

## Gotchas the implementer MUST respect (from project memory)

- **New hook dependency / new required field breaks pre-existing consumer tests.** The validator signature change breaks `tests/lib/validators/privateIntervention.test.ts`; the form change + new `useMeInterventionTypes` hook breaks `tests/components/PrivateInterventionForm.test.tsx`. Both are rewritten **within their task** — run the full mobile suite (`pnpm --filter @garageos/mobile test`) at the end, not just the new files.
- **Defensive `?? []` on `checklist_items`** in the edit screen — stale react-query cache or a partially-typed source can yield `undefined`; mirror the #253 `checklistItems ?? []` pattern.
- **snake_case wire, camelCase never** on these `/me` DTOs — the API returns `name_it`, `sort_order`, `checklist_items`, `intervention_type_id`. Mirror exactly (project memory: field-name drift API vs mobile surfaces only on integration/manual).
- **`select: (r) => r.data`** on the catalog query — the endpoint wraps in `{ data: [...] }` (like `useMeVehiclesList`), so the hook's `data` is `MeInterventionType[]`.
- **Body XOR**: catalog path sends `intervention_type_id` + `checklist_item_ids` + `custom_type: null`; "Altro" sends `custom_type` + `intervention_type_id: null` and **omits** `checklist_item_ids` (backend refine: `custom_type != null` ⇒ checklist absent/empty).

## Branch

`feat/mobile-private-intervention-checklist` off updated `main`.

```bash
git checkout main && git pull origin main
git checkout -b feat/mobile-private-intervention-checklist
```

---

### Task 1: Data layer — DTO types + `useMeInterventionTypes` query

**Files:**
- Modify: `packages/mobile/src/lib/types/private-intervention.ts` (whole file)
- Create: `packages/mobile/src/queries/meInterventionTypes.ts`
- Test: `packages/mobile/tests/queries/meInterventionTypes.test.tsx`

**Interfaces:**
- Produces: type `MeInterventionType = { id: string; code: string; name_it: string; icon: string | null; checklist_items: { id: string; code: string; name_it: string; sort_order: number }[] }`; type `MeInterventionTypesResponse = { data: MeInterventionType[] }`; hook `useMeInterventionTypes(): UseQueryResult<MeInterventionTypesResponse, Error, MeInterventionType[]>` (select projects to the array). `CreatePrivateInterventionBody` gains `checklist_item_ids?: string[]`; `PrivateInterventionDetail` gains `checklist_items: { id: string | null; label: string }[]`.

- [ ] **Step 1: Extend the private-intervention types.** Replace the whole file `packages/mobile/src/lib/types/private-intervention.ts` with:

```ts
// Request body for POST /v1/me/vehicles/:id/private-interventions and PATCH
// /v1/me/private-interventions/:id. XOR: a catalog type sends
// intervention_type_id + checklist_item_ids (custom_type null); the free-text
// "Altro" path sends custom_type and omits checklist_item_ids.
export type CreatePrivateInterventionBody = {
  intervention_date: string; // YYYY-MM-DD
  odometer_km: number | null;
  intervention_type_id: string | null;
  custom_type: string | null;
  description: string;
  checklist_item_ids?: string[];
};

// Frozen checklist snapshot returned on the detail DTO. `id` is the catalog
// checklistItemId, nullable if the catalog row was later deleted (BR-303
// onDelete: SetNull). `label` is the frozen snapshot label.
export type PrivateInterventionChecklistItem = { id: string | null; label: string };

// snake_case response (serializer projectDetail).
export type PrivateInterventionDetail = {
  id: string;
  vehicle_id: string;
  intervention_date: string;
  odometer_km: number | null;
  type: { id: string; name_it: string } | null;
  custom_type: string | null;
  description: string;
  checklist_items: PrivateInterventionChecklistItem[];
  created_at: string;
  updated_at: string;
};

// GET /v1/me/intervention-types — the customer-facing global catalog (PR-1).
// Deadline fields are intentionally absent (private interventions have no
// deadline logic). checklist_items are pre-filtered active + BR-305 server-side.
export type MeInterventionChecklistItem = {
  id: string;
  code: string;
  name_it: string;
  sort_order: number;
};

export type MeInterventionType = {
  id: string;
  code: string;
  name_it: string;
  icon: string | null;
  checklist_items: MeInterventionChecklistItem[];
};

export type MeInterventionTypesResponse = { data: MeInterventionType[] };
```

- [ ] **Step 2: Write the failing query test.** Create `packages/mobile/tests/queries/meInterventionTypes.test.tsx` (mirrors `mePrivateInterventionDetail.test.tsx`):

```tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';
import * as apiClientHook from '@/lib/use-api-client';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useMeInterventionTypes', () => {
  it('fetches the catalog and projects to the data array', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      data: [{ id: 't1', code: 'GOMME', name_it: 'Cambio Gomme', icon: null, checklist_items: [] }],
    });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeInterventionTypes(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/intervention-types');
    expect(result.current.data).toEqual([
      { id: 't1', code: 'GOMME', name_it: 'Cambio Gomme', icon: null, checklist_items: [] },
    ]);
  });
});
```

- [ ] **Step 3: Run to verify it fails.**

Run: `pnpm --filter @garageos/mobile test -- meInterventionTypes`
Expected: FAIL — cannot resolve `@/queries/meInterventionTypes` (module not created).

- [ ] **Step 4: Implement the query.** Create `packages/mobile/src/queries/meInterventionTypes.ts`:

```ts
// useMeInterventionTypes — GET /v1/me/intervention-types (PR-1 catalog for
// private interventions). Projects the { data } wrapper to the array, mirroring
// meVehicles.ts. Long staleTime: the global catalog is admin-managed and rarely
// changes (parity with web useInterventionTypes).
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  MeInterventionType,
  MeInterventionTypesResponse,
} from '@/lib/types/private-intervention';

export function useMeInterventionTypes() {
  const api = useApiClient();
  return useQuery<MeInterventionTypesResponse, Error, MeInterventionType[]>({
    queryKey: ['me', 'intervention-types'],
    queryFn: () => api.fetch<MeInterventionTypesResponse>('/v1/me/intervention-types'),
    select: (r) => r.data,
    staleTime: 30 * 60 * 1000,
  });
}
```

- [ ] **Step 5: Run tests + typecheck.**

Run: `pnpm --filter @garageos/mobile test -- meInterventionTypes`
Expected: PASS.
Run: `pnpm --filter @garageos/mobile typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/mobile/src/lib/types/private-intervention.ts packages/mobile/src/queries/meInterventionTypes.ts packages/mobile/tests/queries/meInterventionTypes.test.tsx
git commit -m "feat(mobile): add useMeInterventionTypes catalog query"
```

---

### Task 2: Conditional validator + `ALTRO_TYPE_KEY` sentinel

**Files:**
- Modify: `packages/mobile/src/lib/validators/privateIntervention.ts` (whole file)
- Test: `packages/mobile/tests/lib/validators/privateIntervention.test.ts` (whole file — rewrite)

**Interfaces:**
- Produces: `export const ALTRO_TYPE_KEY = 'altro'`; `type PrivateInterventionFormInput = { selectedKey: string | null; customType: string; checklistItemIds: string[]; interventionDate: string; odometerKm: string; description: string }`; `type PrivateInterventionFormErrors = Partial<{ type: string; customType: string; checklistItemIds: string; interventionDate: string; odometerKm: string; description: string }>`; `validatePrivateInterventionForm(input): PrivateInterventionFormErrors` — conditional on `selectedKey`.

- [ ] **Step 1: Rewrite the failing validator test.** Replace the whole file `packages/mobile/tests/lib/validators/privateIntervention.test.ts`:

```ts
import {
  ALTRO_TYPE_KEY,
  validatePrivateInterventionForm,
} from '@/lib/validators/privateIntervention';

const VALID_CATALOG = {
  selectedKey: '11111111-1111-1111-1111-111111111111',
  customType: '',
  checklistItemIds: ['a'],
  interventionDate: '2020-05-10',
  odometerKm: '120000',
  description: 'Tagliando completo',
};

const VALID_ALTRO = {
  selectedKey: ALTRO_TYPE_KEY,
  customType: 'Lavaggio',
  checklistItemIds: [],
  interventionDate: '2020-05-10',
  odometerKm: '120000',
  description: 'Lavaggio completo interni ed esterni',
};

describe('validatePrivateInterventionForm', () => {
  it('accepts a valid catalog-type input', () => {
    expect(validatePrivateInterventionForm(VALID_CATALOG)).toEqual({});
  });

  it('accepts a valid Altro (free-text) input', () => {
    expect(validatePrivateInterventionForm(VALID_ALTRO)).toEqual({});
  });

  it('requires a type selection (selectedKey null)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, selectedKey: null }).type,
    ).toBeDefined();
  });

  it('requires at least one checklist item for a catalog type (BR-300 parity)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, checklistItemIds: [] }).checklistItemIds,
    ).toBeDefined();
  });

  it('does not require checklist items on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, checklistItemIds: [] }).checklistItemIds,
    ).toBeUndefined();
  });

  it('requires customType on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, customType: '  ' }).customType,
    ).toBeDefined();
  });

  it('rejects customType longer than 150 chars on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, customType: 'x'.repeat(151) }).customType,
    ).toBeDefined();
  });

  it('does not require customType on the catalog path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, customType: '' }).customType,
    ).toBeUndefined();
  });

  it('requires description', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, description: '' }).description,
    ).toBeDefined();
  });

  it('rejects description longer than 5000 chars', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, description: 'x'.repeat(5001) })
        .description,
    ).toBeDefined();
  });

  it('rejects a malformed date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '10/05/2020' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects an impossible date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '2026-02-30' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects a future date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '2099-01-01' })
        .interventionDate,
    ).toBeDefined();
  });

  it('accepts an empty odometer (optional)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '' }).odometerKm,
    ).toBeUndefined();
  });

  it('rejects a non-numeric odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '12a' }).odometerKm,
    ).toBeDefined();
  });

  it('rejects an out-of-range odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '10000000' }).odometerKm,
    ).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/mobile test -- validators/privateIntervention`
Expected: FAIL — `ALTRO_TYPE_KEY` not exported / input shape mismatch.

- [ ] **Step 3: Rewrite the validator.** Replace the whole file `packages/mobile/src/lib/validators/privateIntervention.ts`:

```ts
// Pure validator for the create/edit private-intervention form. Conditional on
// the type selection: a catalog type (UUID selectedKey) requires >= 1 checklist
// item (BR-300 parity); the free-text "Altro" path requires a customType
// (1..150). Mirrors the backend rules in routes/v1/me-private-interventions.ts
// (date YYYY-MM-DD not-future per BR-069, odometer 0..9_999_999, description
// 1..5000). No Zod in mobile deps; date-fns (already a dep) validates real dates.
import { isAfter, isValid, parse, startOfToday } from 'date-fns';

// Sentinel selection key for the free-text ("Altro") branch. Stored in the same
// selectedKey state as catalog UUIDs; 'altro' can never collide with a UUID.
export const ALTRO_TYPE_KEY = 'altro';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PrivateInterventionFormInput = {
  selectedKey: string | null;
  customType: string;
  checklistItemIds: string[];
  interventionDate: string;
  odometerKm: string;
  description: string;
};

export type PrivateInterventionFormErrors = Partial<{
  type: string;
  customType: string;
  checklistItemIds: string;
  interventionDate: string;
  odometerKm: string;
  description: string;
}>;

export function validatePrivateInterventionForm(
  input: PrivateInterventionFormInput,
): PrivateInterventionFormErrors {
  const errors: PrivateInterventionFormErrors = {};

  if (input.selectedKey === null) {
    errors.type = 'Seleziona un tipo di intervento';
  } else if (input.selectedKey === ALTRO_TYPE_KEY) {
    const customType = input.customType.trim();
    if (!customType) errors.customType = 'Tipo obbligatorio';
    else if (customType.length > 150) errors.customType = 'Massimo 150 caratteri';
  } else if (input.checklistItemIds.length < 1) {
    // Catalog type -> checklist mandatory (BR-300 parity with officina).
    errors.checklistItemIds = 'Seleziona almeno una voce';
  }

  const date = input.interventionDate.trim();
  if (!date) {
    errors.interventionDate = 'Data obbligatoria';
  } else if (!DATE_RE.test(date) || !isValid(parse(date, 'yyyy-MM-dd', new Date()))) {
    errors.interventionDate = 'Data non valida (AAAA-MM-GG)';
  } else if (isAfter(parse(date, 'yyyy-MM-dd', new Date()), startOfToday())) {
    errors.interventionDate = 'Non puoi registrare una data futura';
  }

  const km = input.odometerKm.trim();
  if (km) {
    if (!/^\d+$/.test(km)) errors.odometerKm = 'Inserisci solo numeri';
    else if (Number(km) > 9_999_999) errors.odometerKm = 'Valore troppo grande';
  }

  const description = input.description.trim();
  if (!description) errors.description = 'Descrizione obbligatoria';
  else if (description.length > 5000) errors.description = 'Massimo 5000 caratteri';

  return errors;
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `pnpm --filter @garageos/mobile test -- validators/privateIntervention`
Expected: PASS.
Run: `pnpm --filter @garageos/mobile typecheck`
Expected: FAIL — `PrivateInterventionForm.tsx` still calls the validator with the old input shape. That is expected and fixed in Task 3. (Do not "fix" it here.)

- [ ] **Step 5: Commit.**

```bash
git add packages/mobile/src/lib/validators/privateIntervention.ts packages/mobile/tests/lib/validators/privateIntervention.test.ts
git commit -m "feat(mobile): conditional private-intervention validator + Altro key"
```

---

### Task 3: Form — type chips + checklist + Altro branch

**Files:**
- Modify: `packages/mobile/src/components/PrivateInterventionForm.tsx` (whole file)
- Test: `packages/mobile/tests/components/PrivateInterventionForm.test.tsx` (whole file — rewrite)

**Interfaces:**
- Consumes: `useMeInterventionTypes` (Task 1), `validatePrivateInterventionForm` + `ALTRO_TYPE_KEY` (Task 2), `CreatePrivateInterventionBody` (Task 1).
- Produces: `PrivateInterventionFormInitial = { selectedKey: string | null; customType: string; checklistItemIds: string[]; interventionDate: string; odometerKm: string; description: string }`; the `PrivateInterventionForm` component and `PrivateInterventionFormResult` type (unchanged). Submitted body is XOR per the selection.

- [ ] **Step 1: Rewrite the form test.** Replace the whole file `packages/mobile/tests/components/PrivateInterventionForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PrivateInterventionForm } from '@/components/PrivateInterventionForm';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';

// The native date picker has no JS implementation under jest. Mock it as a
// Pressable that, when pressed, emits onChange with a fixed past date.
jest.mock('@react-native-community/datetimepicker', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    default: ({
      testID,
      onChange,
    }: {
      testID?: string;
      onChange?: (e: unknown, d?: Date) => void;
    }) =>
      React.createElement(
        Pressable,
        { testID, onPress: () => onChange?.({ type: 'set' }, new Date('2020-05-10T00:00:00')) },
        React.createElement(Text, null, 'picker'),
      ),
  };
});

jest.mock('@/queries/meInterventionTypes', () => ({
  useMeInterventionTypes: jest.fn(),
}));

const CATALOG = [
  {
    id: 'type-gomme',
    code: 'GOMME',
    name_it: 'Cambio Gomme',
    icon: null,
    checklist_items: [
      { id: 'i-pneu', code: 'PNEU', name_it: 'Sostituzione Pneumatici', sort_order: 0 },
      { id: 'i-conv', code: 'CONV', name_it: 'Convergenza', sort_order: 1 },
    ],
  },
];

const mockedTypes = useMeInterventionTypes as jest.Mock;

function stubCatalog(overrides: Record<string, unknown> = {}) {
  mockedTypes.mockReturnValue({ data: CATALOG, isLoading: false, isError: false, ...overrides });
}

// Drive the shared valid-date/description fields so submit is not blocked by them.
function fillDateAndDescription() {
  fireEvent.press(screen.getByTestId('intervention-date-field'));
  fireEvent.press(screen.getByTestId('intervention-date-picker'));
  fireEvent.changeText(screen.getByPlaceholderText('Descrizione'), 'Descrizione valida');
}

beforeEach(() => {
  mockedTypes.mockReset();
  stubCatalog();
});

describe('PrivateInterventionForm', () => {
  it('submits a catalog type + checklist as a snake_case body', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fireEvent.press(screen.getByTestId('checklist-item-PNEU'));
    fireEvent.press(screen.getByTestId('checklist-item-CONV'));
    fillDateAndDescription();
    fireEvent.changeText(screen.getByPlaceholderText('Chilometri (opzionale)'), '120000');
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      intervention_date: '2020-05-10',
      odometer_km: 120000,
      intervention_type_id: 'type-gomme',
      custom_type: null,
      description: 'Descrizione valida',
      checklist_item_ids: ['i-pneu', 'i-conv'],
    });
  });

  it('blocks submit and shows an inline error when no checklist item is selected', async () => {
    const onSubmit = jest.fn();
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Seleziona almeno una voce')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the Altro free-text path without checklist_item_ids', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), '  Lavaggio ');
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      intervention_date: '2020-05-10',
      odometer_km: null,
      intervention_type_id: null,
      custom_type: 'Lavaggio',
      description: 'Descrizione valida',
    });
  });

  it('resets the checklist when the type changes', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fireEvent.press(screen.getByTestId('checklist-item-PNEU'));
    // Switch to Altro and back — the previous checklist selection must be cleared.
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.press(screen.getByTestId('type-chip-GOMME'));
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Seleziona almeno una voce')).toBeOnTheScreen();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prefills the selected type + checked items from initial', () => {
    render(
      <PrivateInterventionForm
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
        initial={{
          selectedKey: 'type-gomme',
          customType: '',
          checklistItemIds: ['i-pneu'],
          interventionDate: '2021-03-03',
          odometerKm: '90000',
          description: 'Cambio gomme invernali',
        }}
      />,
    );
    // The checklist for the preloaded type is rendered (detail display parity).
    expect(screen.getByTestId('checklist-item-PNEU')).toBeOnTheScreen();
    expect(screen.getByTestId('checklist-item-CONV')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('90000')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Cambio gomme invernali')).toBeOnTheScreen();
  });

  it('shows a banner when onSubmit returns an error result', async () => {
    const onSubmit = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'private_intervention.rate_limit' });
    render(<PrivateInterventionForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('type-chip-altro'));
    fireEvent.changeText(screen.getByPlaceholderText('Es. Lavaggio, Cambio gomme'), 'Lavaggio');
    fillDateAndDescription();
    fireEvent.press(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText(/limite giornaliero/)).toBeOnTheScreen();
    });
  });

  it('calls onCancel when Annulla tapped', () => {
    const onCancel = jest.fn();
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders Elimina and calls onDelete when onDelete provided', () => {
    const onDelete = jest.fn();
    render(
      <PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} onDelete={onDelete} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Elimina' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows a loading indicator while the catalog loads', () => {
    stubCatalog({ data: undefined, isLoading: true });
    render(<PrivateInterventionForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId('type-loading')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @garageos/mobile test -- components/PrivateInterventionForm`
Expected: FAIL — no `type-chip-*` / `checklist-item-*` testIDs (old free-text form).

- [ ] **Step 3: Rewrite the form.** Replace the whole file `packages/mobile/src/components/PrivateInterventionForm.tsx`:

```tsx
import { useState } from 'react';
import { format, parse, isValid } from 'date-fns';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import {
  ALTRO_TYPE_KEY,
  validatePrivateInterventionForm,
  type PrivateInterventionFormErrors,
} from '@/lib/validators/privateIntervention';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/colors';

export type PrivateInterventionFormResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

// Specific Italian copy for the per-field/banner server codes; anything else
// falls back to mapErrorToUserMessage.
const SERVER_MESSAGES: Record<string, string> = {
  'private_intervention.vehicle_not_owned':
    'Puoi registrare interventi solo su veicoli che possiedi.',
  'private_intervention.date_future': 'Non puoi registrare un intervento con data futura.',
  'private_intervention.rate_limit': 'Hai raggiunto il limite giornaliero (50 interventi).',
};

type PrivateInterventionFormInitial = {
  selectedKey: string | null;
  customType: string;
  checklistItemIds: string[];
  interventionDate: string;
  odometerKm: string;
  description: string;
};

type Props = {
  onSubmit: (body: CreatePrivateInterventionBody) => Promise<PrivateInterventionFormResult>;
  onCancel: () => void;
  initial?: PrivateInterventionFormInitial;
  submitLabel?: string;
  onDelete?: () => void;
};

export function PrivateInterventionForm({
  onSubmit,
  onCancel,
  initial,
  submitLabel = 'Salva',
  onDelete,
}: Props) {
  const typesQuery = useMeInterventionTypes();
  const types = typesQuery.data ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(initial?.selectedKey ?? null);
  const [checklistItemIds, setChecklistItemIds] = useState<string[]>(
    initial?.checklistItemIds ?? [],
  );
  const [customType, setCustomType] = useState(initial?.customType ?? '');
  const [interventionDate, setInterventionDate] = useState(
    initial?.interventionDate ?? format(new Date(), 'yyyy-MM-dd'),
  );
  const [odometerKm, setOdometerKm] = useState(initial?.odometerKm ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<PrivateInterventionFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const isAltro = selectedKey === ALTRO_TYPE_KEY;
  const selectedType =
    selectedKey !== null && !isAltro ? (types.find((t) => t.id === selectedKey) ?? null) : null;

  function parseDateOrToday(value: string): Date {
    const d = parse(value, 'yyyy-MM-dd', new Date());
    return isValid(d) ? d : new Date();
  }

  function handleDateChange(event: DateTimePickerEvent, date?: Date) {
    setShowPicker(false);
    if (event.type !== 'dismissed' && date) {
      setInterventionDate(format(date, 'yyyy-MM-dd'));
    }
  }

  // Selecting a different type clears any prior checklist selection (BR-300
  // parity: the checklist is per-type). Runs only on user tap, so the edit
  // preload (useState initializer) is never clobbered.
  function selectType(key: string) {
    if (key === selectedKey) return;
    setSelectedKey(key);
    setChecklistItemIds([]);
    setErrors((e) => ({ ...e, type: undefined, checklistItemIds: undefined, customType: undefined }));
  }

  function toggleItem(itemId: string) {
    setChecklistItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((x) => x !== itemId) : [...prev, itemId],
    );
  }

  async function handleSubmit() {
    if (submitting) return;
    const v = validatePrivateInterventionForm({
      selectedKey,
      customType,
      checklistItemIds,
      interventionDate,
      odometerKm,
      description,
    });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);

    const km = odometerKm.trim();
    const base = {
      intervention_date: interventionDate.trim(),
      odometer_km: km === '' ? null : Number(km),
      description: description.trim(),
    };

    let body: CreatePrivateInterventionBody;
    if (isAltro) {
      body = { ...base, intervention_type_id: null, custom_type: customType.trim() };
    } else if (selectedKey !== null) {
      body = {
        ...base,
        intervention_type_id: selectedKey,
        custom_type: null,
        checklist_item_ids: checklistItemIds,
      };
    } else {
      return; // unreachable: the validator requires a selection
    }

    setSubmitting(true);
    try {
      const result = await onSubmit(body);
      if (result.ok) return; // parent navigates away
      if (result.code === 'private_intervention.date_future') {
        setErrors({ interventionDate: SERVER_MESSAGES[result.code] });
        return;
      }
      setBanner(
        SERVER_MESSAGES[result.code] ?? result.message ?? mapErrorToUserMessage(result.code),
      );
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
        <Text style={styles.label}>Tipo</Text>
        {typesQuery.isLoading ? (
          <ActivityIndicator testID="type-loading" color={colors.primary} />
        ) : typesQuery.isError ? (
          <Text style={styles.fieldError}>Impossibile caricare i tipi. Riprova.</Text>
        ) : (
          <View style={styles.chipRow}>
            {types.map((t) => {
              const selected = t.id === selectedKey;
              return (
                <Pressable
                  key={t.id}
                  testID={`type-chip-${t.code}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  disabled={submitting}
                  onPress={() => selectType(t.id)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {t.name_it}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              testID="type-chip-altro"
              accessibilityRole="button"
              accessibilityState={{ selected: isAltro }}
              disabled={submitting}
              onPress={() => selectType(ALTRO_TYPE_KEY)}
              style={[styles.chip, isAltro && styles.chipSelected]}
            >
              <Text style={[styles.chipText, isAltro && styles.chipTextSelected]}>Altro</Text>
            </Pressable>
          </View>
        )}
        {errors.type ? <Text style={styles.fieldError}>{errors.type}</Text> : null}
      </View>

      {isAltro ? (
        <View style={styles.field}>
          <Text style={styles.label}>Descrizione tipo</Text>
          <TextInput
            style={styles.input}
            value={customType}
            onChangeText={setCustomType}
            placeholder="Es. Lavaggio, Cambio gomme"
            editable={!submitting}
          />
          {errors.customType ? <Text style={styles.fieldError}>{errors.customType}</Text> : null}
        </View>
      ) : null}

      {selectedType ? (
        <View style={styles.field}>
          <Text style={styles.label}>Voci eseguite (almeno una) *</Text>
          {[...selectedType.checklist_items]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => {
              const checked = checklistItemIds.includes(item.id);
              return (
                <Pressable
                  key={item.id}
                  testID={`checklist-item-${item.code}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  disabled={submitting}
                  onPress={() => toggleItem(item.id)}
                  style={styles.checklistRow}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? colors.primary : colors.muted}
                  />
                  <Text style={styles.checklistLabel}>{item.name_it}</Text>
                </Pressable>
              );
            })}
          {errors.checklistItemIds ? (
            <Text style={styles.fieldError}>{errors.checklistItemIds}</Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Data</Text>
        <Pressable
          testID="intervention-date-field"
          accessibilityRole="button"
          onPress={() => {
            if (!submitting) setShowPicker(true);
          }}
          style={styles.input}
        >
          <Text style={styles.dateText}>{formatDate(interventionDate)}</Text>
        </Pressable>
        {showPicker ? (
          <DateTimePicker
            testID="intervention-date-picker"
            value={parseDateOrToday(interventionDate)}
            mode="date"
            maximumDate={new Date()}
            onChange={handleDateChange}
          />
        ) : null}
        {errors.interventionDate ? (
          <Text style={styles.fieldError}>{errors.interventionDate}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Chilometri</Text>
        <TextInput
          style={styles.input}
          value={odometerKm}
          onChangeText={setOdometerKm}
          placeholder="Chilometri (opzionale)"
          keyboardType="number-pad"
          editable={!submitting}
        />
        {errors.odometerKm ? <Text style={styles.fieldError}>{errors.odometerKm}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Descrizione</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Descrizione"
          multiline
          numberOfLines={4}
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
          <Text style={styles.submitText}>{submitLabel}</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        disabled={submitting}
        style={styles.cancel}
      >
        <Text style={styles.cancelText}>Annulla</Text>
      </Pressable>

      {onDelete ? (
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          disabled={submitting}
          style={styles.delete}
        >
          <Text style={styles.deleteText}>Elimina</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, color: colors.fg },
  chipTextSelected: { color: colors.primaryFg, fontWeight: '600' },
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  checklistLabel: { fontSize: 15, color: colors.fg, flexShrink: 1 },
  dateText: { fontSize: 16, color: colors.fg },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
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
  delete: { alignItems: 'center', padding: spacing.sm },
  deleteText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `pnpm --filter @garageos/mobile test -- components/PrivateInterventionForm`
Expected: PASS.
Run: `pnpm --filter @garageos/mobile typecheck`
Expected: FAIL — `app/private-interventions/[id].tsx` still builds the old `initial` shape (no `selectedKey`/`checklistItemIds`). Fixed in Task 4.

- [ ] **Step 5: Commit.**

```bash
git add packages/mobile/src/components/PrivateInterventionForm.tsx packages/mobile/tests/components/PrivateInterventionForm.test.tsx
git commit -m "feat(mobile): private intervention form type chips + checklist"
```

---

### Task 4: Edit screen — preload selection + checked items

**Files:**
- Modify: `packages/mobile/app/private-interventions/[id].tsx:68-74` (the `initial` object)
- Test: covered by the form's `prefills…` test (Task 3) + the smoke runbook. The screen is a thin wrapper (no new logic worth a JSDOM test — the timeline→edit navigation is exercised on device).

**Interfaces:**
- Consumes: `PrivateInterventionDetail` (Task 1, now with `type.id` + `checklist_items`), `ALTRO_TYPE_KEY` (Task 2), `PrivateInterventionFormInitial` (Task 3).
- Produces: an `initial` prop carrying `selectedKey` (catalog type id, `ALTRO_TYPE_KEY`, or null), `checklistItemIds` (non-null snapshot ids), and `customType`.

- [ ] **Step 1: Update the import and the `initial` builder.** In `packages/mobile/app/private-interventions/[id].tsx`, add `ALTRO_TYPE_KEY` to the imports:

```ts
import { ALTRO_TYPE_KEY } from '@/lib/validators/privateIntervention';
```

Then replace the `initial` object (lines 69-74) with:

```ts
  const d = detail.data!;
  const initial = {
    // A persisted catalog type wins; else a free-text row maps to "Altro";
    // else nothing is preselected (new-style rows always have one of the two).
    selectedKey: d.type ? d.type.id : d.custom_type ? ALTRO_TYPE_KEY : null,
    customType: d.custom_type ?? '',
    // Non-null snapshot ids only — a deleted catalog item (id null, BR-303
    // SetNull) cannot be re-checked and drops on the next save. Defensive
    // `?? []` guards a stale/partial cache (project memory).
    checklistItemIds: (d.checklist_items ?? [])
      .map((i) => i.id)
      .filter((v): v is string => v !== null),
    interventionDate: d.intervention_date,
    odometerKm: d.odometer_km != null ? String(d.odometer_km) : '',
    description: d.description,
  };
```

- [ ] **Step 2: Typecheck.**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: PASS (form `initial` shape now satisfied end-to-end; no other callers of the form).

- [ ] **Step 3: Full mobile test suite.** New hook dep + rewritten forms can ripple into other suites (project memory). Run everything:

Run: `pnpm --filter @garageos/mobile test`
Expected: PASS. If a neighbouring suite constructs a `PrivateInterventionDetail`/body literal and now fails on the new fields, fix that fixture in-place (do not weaken the type) and re-run.

- [ ] **Step 4: Commit.**

```bash
git add packages/mobile/app/private-interventions/[id].tsx
git commit -m "feat(mobile): preload type + checklist on private intervention edit"
```

---

## Final gates (after all tasks)

1. `pnpm -r typecheck` (pre-push hook — mandatory local gate).
2. Confirm no new dependency crept into `packages/mobile/package.json` (`git diff main -- packages/mobile/package.json` — must be empty).
3. Include this plan doc in the PR. (The arc spec `docs/superpowers/specs/2026-07-06-mobile-private-intervention-type-checklist-design.md` was already committed with PR-1; no new spec.)
4. Push branch, open PR (title `feat(mobile): private intervention type + checklist (BR-086)`), fill the CLAUDE.md PR template (link BR-086 → BR-300/301/303; note "no API/docs change — API + docs shipped in PR-1 #256").
5. **Final whole-branch `/code-review high`** — load-bearing gate. Apply Critical/Important; list Minor in the PR description.
6. CI full matrix green (`gh pr checks --watch`).
7. **Smoke runbook (BLOCKER — device-facing UI).** Do NOT self-merge before the smoke passes. On the Xiaomi via Expo Go → Metro (the preview APK is stale — project memory: it silently smokes old code):
   ```
   cd packages/mobile && npx expo start --offline --port 8081   # background
   adb reverse tcp:8081 tcp:8081
   adb shell am start -a android.intent.action.VIEW -d "exp://localhost:8081"
   ```
   Login: `matulamichele+cliente@gmail.com` (prod clienti pool). Steps:
   1. Open a vehicle → "Nuovo intervento". The "Tipo" row shows catalog chips (Intervento Meccanico / Cambio Gomme / Revisione) + "Altro".
   2. Tap a catalog type → the "Voci eseguite" checklist appears; tap ≥1 item; fill date + description → **Salva** → 201, row appears in Storico.
   3. Create again, tap **Altro** → free-text "Descrizione tipo" appears (no checklist) → save → row appears.
   4. Try to save a catalog type with **no** checklist item → inline "Seleziona almeno una voce", no submit.
   5. Open an existing private intervention (edit) → the previously-saved type is preselected and its checklist is **pre-checked** (this is the detail display) → change the type, re-select items → **Salva modifiche** → the Storico reflects the change.
8. Self-merge (squash) only when CI green + review passed + smoke passed + zero open questions (CLAUDE.md self-merge rules).

## Self-review

- **Spec coverage (PR-2 §1-5):** data layer query + type extensions (Task 1) ✅; conditional validator (Task 2) ✅; form type selector + "Altro" + checklist + reset-on-change (Task 3) ✅; edit preload (Task 4) ✅; detail display = pre-checked checklist in the edit form (Deviation #2, Task 4) ✅; Tier-2 form tests + Tier-1 validator tests (Tasks 2-3) ✅; smoke runbook (Final gates) ✅. No API/DB/docs work — all shipped in PR-1.
- **Placeholder scan:** none — every step carries concrete TS/TSX/commands. Task 4's "detail display" is realized by the form rendering pre-checked items (no separate screen exists — verified).
- **Type consistency:** `selectedKey: string | null` + `ALTRO_TYPE_KEY` used identically across validator (Task 2), form (Task 3), edit screen (Task 4); `checklist_items: { id: string|null; label }` (DTO) → `.map(i=>i.id).filter(non-null)` (Task 4) → `checklist_item_ids: string[]` (body, Task 1) → catalog `checklist_items: { id, code, name_it, sort_order }` (Task 1) consumed by the form's `item.code`/`item.name_it`/`item.sort_order` (Task 3). Query key `['me','intervention-types']`. Wire paths `/v1/me/intervention-types`.
- **Test breakage handled:** validator test (Task 2) and form test (Task 3) rewritten within their tasks; full-suite run (Task 4 Step 3) catches ripple.
```


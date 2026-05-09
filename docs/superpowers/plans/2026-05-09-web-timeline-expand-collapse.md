# Web Timeline Expand/Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estrai la riga timeline da `VehicleDetail.tsx` in un componente `TimelineRow` autonomo che supporta expand/collapse inline e surface description / parts count / attachments / dispute badge — campi già presenti nel DTO timeline ma invisibili oggi.

**Architecture:** Pure web slice, zero backend. Multi-open accordion (state locale per riga). Animation via Tailwind grid-rows trick (no JS measure). ARIA `aria-expanded` + `aria-controls` per accessibility. Vertical slice paradigmatica del pivot agile post-#78.

**Tech Stack:** React 19 + TypeScript, Vite 6, TanStack Query 5 (consumed), shadcn UI Badge + cn, lucide-react ChevronDown, Tailwind CSS, Vitest 4 + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-09-web-timeline-expand-collapse-design.md`

---

## File structure

| File | Stato | Responsibility | Est LOC |
|---|---|---|---|
| `packages/web/src/components/TimelineRow.tsx` | NEW | Riga timeline con expand/collapse, props `{ item: TimelineItem }` | ~130 |
| `packages/web/src/components/TimelineRow.test.tsx` | NEW | 10 scenari (compact / dispute / expanded shop / expanded private / toggle / empty description) | ~165 |
| `packages/web/src/pages/VehicleDetail.tsx` | MOD | Sostituisci inline timeline rendering con `<TimelineRow item={item} />` | net ~−5 (-30 / +25) |
| `packages/web/src/pages/VehicleDetail.test.tsx` | NEW | 6 scenari page-level (loading / 404 / error / happy path / archived / empty timeline) | ~110 |

**Net LOC stimato:** ~400 (130 prod + 275 test − 5 modifica).

---

## Pre-req: working directory & branch

Branch: `feat/web-timeline-expand-collapse` (already created). HEAD: `f0ca66f` (spec doc commit). Working directory: `C:\Users\Michele\source\repos\garageos`.

Pre-commit hook: prettier + eslint --fix + secretlint. Pre-push hook: `pnpm -r typecheck`.

DO NOT run `pnpm test:integration`. DO NOT run `pnpm dev` for browser smoke unless explicitly debugging — vitest unit tests are the gate.

---

## Task 1: Build `TimelineRow` component (TDD)

**Why first:** è l'unità autonoma di questo slice. Va costruita end-to-end (test + impl) prima di toccare la pagina.

**Files:**
- Create: `packages/web/src/components/TimelineRow.test.tsx`
- Create: `packages/web/src/components/TimelineRow.tsx`

### Step 1.1: Write the component test (RED)

Create `packages/web/src/components/TimelineRow.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TimelineRow } from './TimelineRow';
import type {
  PrivateTimelineItem,
  ShopTimelineItem,
  TimelineItem,
} from '@/queries/types';

const SHOP_ITEM: ShopTimelineItem = {
  kind: 'shop_intervention',
  id: 'shop-1',
  intervention_date: '2025-03-15T10:00:00Z',
  odometer_km: 30200,
  type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
  title: 'Tagliando 30000 km',
  description:
    'Cambio olio motore e filtro olio.\nSostituiti dischi anteriori e pastiglie.',
  parts_replaced_count: 3,
  status: 'active',
  is_disputed: false,
  tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
  has_attachments: true,
  attachments_count: 2,
};

const SHOP_ITEM_DISPUTED: ShopTimelineItem = {
  ...SHOP_ITEM,
  id: 'shop-disputed',
  is_disputed: true,
  title: 'Cambio frizione',
  description: 'Sostituzione frizione completa.',
  parts_replaced_count: 1,
  has_attachments: false,
  attachments_count: 0,
};

const PRIVATE_ITEM: PrivateTimelineItem = {
  kind: 'private_intervention',
  id: 'private-1',
  intervention_date: '2025-02-10T08:00:00Z',
  odometer_km: 28100,
  custom_type: 'Cambio gomme',
  description: 'Stagionali invernali montate.',
  has_attachments: false,
  attachments_count: 0,
};

function renderRow(item: TimelineItem) {
  return render(<TimelineRow item={item} />);
}

describe('TimelineRow — compact rendering', () => {
  it('renders shop row with title, subtitle, kind badge, no dispute', () => {
    renderRow(SHOP_ITEM);
    expect(screen.getByText('Tagliando 30000 km')).toBeInTheDocument();
    expect(screen.getByText(/Officina Rossi.*Milano/)).toBeInTheDocument();
    expect(screen.getByText('Officina')).toBeInTheDocument();
    expect(screen.queryByText('Disputa')).not.toBeInTheDocument();
  });

  it('renders private row with custom_type as title and "Cliente" subtitle', () => {
    renderRow(PRIVATE_ITEM);
    expect(screen.getByText('Cambio gomme')).toBeInTheDocument();
    expect(screen.getByText(/Cliente/)).toBeInTheDocument();
    expect(screen.getByText('Privato')).toBeInTheDocument();
  });

  it('shows Disputa badge in compact when shop is_disputed=true', () => {
    renderRow(SHOP_ITEM_DISPUTED);
    expect(screen.getByText('Disputa')).toBeInTheDocument();
  });

  it('starts collapsed (aria-expanded=false)', () => {
    renderRow(SHOP_ITEM);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TimelineRow — toggle behavior', () => {
  it('toggles aria-expanded on click', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('TimelineRow — expanded shop content', () => {
  it('shows description, parts count, attachments badge after expansion', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/Cambio olio motore/)).toBeInTheDocument();
    expect(screen.getByText('3 ricambi')).toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits parts badge when parts_replaced_count is 0', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, parts_replaced_count: 0 };
    renderRow(item);
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.getByText('Con allegati (2)')).toBeInTheDocument();
  });

  it('omits attachments badge when has_attachments is false', async () => {
    const user = userEvent.setup();
    renderRow(SHOP_ITEM_DISPUTED); // has_attachments: false
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
    expect(screen.getByText('1 ricambi')).toBeInTheDocument();
  });

  it('shows "Nessuna descrizione." when description is empty', async () => {
    const user = userEvent.setup();
    const item: ShopTimelineItem = { ...SHOP_ITEM, description: '   ' };
    renderRow(item);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Nessuna descrizione.')).toBeInTheDocument();
  });
});

describe('TimelineRow — expanded private content', () => {
  it('shows description, no parts badge for private items', async () => {
    const user = userEvent.setup();
    renderRow(PRIVATE_ITEM);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Stagionali invernali montate.')).toBeInTheDocument();
    expect(screen.queryByText(/ricambi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Con allegati/)).not.toBeInTheDocument();
  });
});
```

### Step 1.2: Run failing test (RED)

```bash
pnpm --filter @garageos/web exec vitest run src/components/TimelineRow.test.tsx
```

Expected: FAIL with "Cannot find module './TimelineRow'".

### Step 1.3: Implement `TimelineRow.tsx`

Create `packages/web/src/components/TimelineRow.tsx`:

```tsx
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { fallback, formatDate, formatKm } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import type { TimelineItem } from '@/queries/types';

// Timeline row con expand/collapse inline. Surfacia description,
// parts_replaced_count, attachments_count, is_disputed che il DTO
// timeline (PR vehicles-timeline) già contiene ma il rendering
// compact precedente non mostrava.
//
// Multi-open accordion: ogni riga ha state locale, niente coordinamento
// globale. Animazione via Tailwind grid-rows trick (no JS measure).

interface Props {
  item: TimelineItem;
}

export function TimelineRow({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const isShop = item.kind === 'shop_intervention';
  const title = isShop
    ? (item.title ?? item.type.name_it)
    : (item.custom_type ?? 'Intervento privato');
  const subtitle = isShop
    ? `${item.tenant.business_name}${item.tenant.location_city ? ' · ' + item.tenant.location_city : ''}`
    : 'Cliente';
  const isDisputed = isShop && item.is_disputed;

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <div className="text-xs text-muted-foreground w-24 shrink-0">
          {formatDate(item.intervention_date)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-foreground truncate">{fallback(title)}</div>
          <div className="text-xs text-muted-foreground truncate">
            {subtitle} · {formatKm(item.odometer_km)}
          </div>
        </div>
        {isDisputed && (
          <Badge variant="destructive" className="text-[10px]">
            Disputa
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px]">
          {isShop ? 'Officina' : 'Privato'}
        </Badge>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground transition-transform', expanded && 'rotate-180')}
        />
      </button>

      <div
        id={panelId}
        className={cn(
          'grid transition-all duration-200 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-t' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <ExpandedPanel item={item} />
        </div>
      </div>
    </div>
  );
}

function ExpandedPanel({ item }: { item: TimelineItem }) {
  const description = item.description?.trim();
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
    </div>
  );
}
```

### Step 1.4: Run test (GREEN)

```bash
pnpm --filter @garageos/web exec vitest run src/components/TimelineRow.test.tsx
```

Expected: PASS — 11 tests across 4 describe blocks.

**Note on test 7 ("toggle aria-expanded")**: the description div remains in the DOM when collapsed (CSS hides it via grid-rows: 0fr + opacity 0). That's why we test via `aria-expanded` attribute, not via `queryByText` of description content. The collapsed-state assertions in tests 8–11 must run AFTER `await user.click(button)` — the description is already in the DOM but hidden, so `getByText` will find it. The tests are written to assert presence after expansion (where it matters); they don't assert absence in collapsed state.

If a test fails because of the always-rendered DOM behavior (e.g. you wanted to assert "no description visible before expansion"), adjust by checking `aria-expanded` rather than visibility.

### Step 1.5: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

### Step 1.6: Commit

```bash
git add packages/web/src/components/TimelineRow.tsx packages/web/src/components/TimelineRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): TimelineRow component with expand/collapse

Extracts the compact timeline row from VehicleDetail and surfaces
description, parts_replaced_count, attachments_count, is_disputed —
fields already in the timeline DTO but invisible until now. Multi-open
accordion via local state. Tailwind grid-rows trick handles animation
without JS measurement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire `TimelineRow` into `VehicleDetail.tsx`

**Files:**
- Modify: `packages/web/src/pages/VehicleDetail.tsx`

### Step 2.1: Replace the inline timeline rendering with `<TimelineRow>`

Open `packages/web/src/pages/VehicleDetail.tsx`. Locate the block at lines ~169-194 (inside the `timeline.isSuccess && timelineItems.length > 0` branch) — currently builds title/subtitle inline and renders each row by hand.

Replace just that JSX block (the `<div className="bg-card border border-border rounded-lg divide-y divide-border">...</div>` containing the `.map(...)` of inline rows) with:

```tsx
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
              {timelineItems.map((item) => (
                <TimelineRow key={item.id} item={item} />
              ))}
            </div>
```

Add the import at the top of the file (alongside the other component imports — Skeleton/Alert/Badge/Button area):

```tsx
import { TimelineRow } from '@/components/TimelineRow';
```

Remove the now-unused `formatKm` and `fallback` imports IF they were used only inside the deleted block. Check by Grep — if `formatKm` or `fallback` is still used elsewhere in VehicleDetail.tsx, keep the import; otherwise drop. (As of the current state, `fallback` is used at line 130 for color and `formatKm` is no longer used after the refactor — adjust accordingly.)

The `formatDate` import will still be unused after this refactor (the component used it only inside the now-deleted block); remove it from the imports.

### Step 2.2: Run the full web unit suite to ensure no regression

```bash
pnpm --filter @garageos/web test:unit
```

Expected: all existing tests still pass (Dashboard, SearchResults, CustomerAutocomplete, useDebouncedValue, useCustomerSearch, customerSearch, plus the new TimelineRow tests).

### Step 2.3: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors. If you see "imported but never used" for `formatDate`/`formatKm`/`fallback`, you missed a removal in Step 2.1 — fix it.

### Step 2.4: Commit

```bash
git add packages/web/src/pages/VehicleDetail.tsx
git commit -m "$(cat <<'EOF'
refactor(web): VehicleDetail uses TimelineRow component

Replaces the inline timeline row rendering with the new TimelineRow
component. Behavior unchanged at the compact-list level; expand/
collapse + dispute badge surface comes for free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `VehicleDetail.test.tsx` (page integration)

**Files:**
- Create: `packages/web/src/pages/VehicleDetail.test.tsx`

### Step 3.1: Write the page test

Create `packages/web/src/pages/VehicleDetail.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { VehicleDetail } from './VehicleDetail';
import { ApiError } from '@/lib/api-client';
import type { TimelineResponse, VehicleDetailResponse } from '@/queries/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}));

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';

const VEHICLE_DETAIL_FIXTURE: VehicleDetailResponse = {
  vehicle: {
    id: VEHICLE_ID,
    garageCode: 'GO-234-ABCD',
    vin: 'ZFA31200000123456',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    version: null,
    year: 2021,
    registrationDate: null,
    vehicleType: 'auto',
    fuelType: 'gasoline',
    engineDisplacement: null,
    powerKw: null,
    color: null,
    status: 'certified',
    certifiedAt: '2024-06-01T00:00:00Z',
    certifiedByTenantId: null,
    createdAt: '2024-06-01T00:00:00Z',
  },
  currentOwnership: null,
};

const TIMELINE_FIXTURE: TimelineResponse = {
  data: [
    {
      kind: 'shop_intervention',
      id: 'shop-1',
      intervention_date: '2025-03-15T10:00:00Z',
      odometer_km: 30200,
      type: { code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando 30000 km',
      description: 'Cambio olio.',
      parts_replaced_count: 3,
      status: 'active',
      is_disputed: false,
      tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
      has_attachments: true,
      attachments_count: 2,
    },
    {
      kind: 'private_intervention',
      id: 'private-1',
      intervention_date: '2025-02-10T08:00:00Z',
      odometer_km: 28100,
      custom_type: 'Cambio gomme',
      description: 'Stagionali invernali.',
      has_attachments: false,
      attachments_count: 0,
    },
  ],
  meta: { has_more: false },
};

function setupApiFetch(opts: {
  detail?: VehicleDetailResponse | ApiError;
  timeline?: TimelineResponse;
}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === `/v1/vehicles/${VEHICLE_ID}`) {
      if (opts.detail instanceof ApiError) throw opts.detail;
      if (opts.detail) return opts.detail;
      throw new Error(`unexpected: ${path}`);
    }
    if (path.startsWith(`/v1/vehicles/${VEHICLE_ID}/timeline`)) {
      if (opts.timeline) return opts.timeline;
      throw new Error(`unexpected: ${path}`);
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/vehicles/${VEHICLE_ID}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/vehicles/:id" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('VehicleDetail', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastErrorMock.mockClear();
  });
  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows skeletons while detail is loading', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(wrap({ children: <VehicleDetail /> }));
    expect(document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length).toBeGreaterThan(0);
  });

  it('redirects and toasts on 404 vehicle', async () => {
    setupApiFetch({
      detail: new ApiError('vehicle.not_found', 404, 'Veicolo non trovato'),
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Veicolo non trovato'));
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows generic error alert with Riprova on non-404 detail error', async () => {
    setupApiFetch({
      detail: new ApiError('http.500', 500, 'Internal Server Error'),
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument(),
    );
  });

  it('renders header + 2 timeline rows on happy path', async () => {
    setupApiFetch({ detail: VEHICLE_DETAIL_FIXTURE, timeline: TIMELINE_FIXTURE });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() => expect(screen.getByText(/Fiat Panda/)).toBeInTheDocument());
    expect(screen.getByText('Tagliando 30000 km')).toBeInTheDocument();
    expect(screen.getByText('Cambio gomme')).toBeInTheDocument();
  });

  it('disables "Registra intervento" when vehicle is archived', async () => {
    setupApiFetch({
      detail: {
        ...VEHICLE_DETAIL_FIXTURE,
        vehicle: { ...VEHICLE_DETAIL_FIXTURE.vehicle, status: 'archived' },
      },
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /registra intervento/i })).toBeDisabled(),
    );
  });

  it('shows the empty timeline message when no interventions', async () => {
    setupApiFetch({
      detail: VEHICLE_DETAIL_FIXTURE,
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(
        screen.getByText('Nessun intervento registrato per questo veicolo.'),
      ).toBeInTheDocument(),
    );
  });
});
```

### Step 3.2: Run the test

```bash
pnpm --filter @garageos/web exec vitest run src/pages/VehicleDetail.test.tsx
```

Expected: PASS — 6 tests.

If the loading-skeleton test (#1) fails because the actual `Skeleton` component doesn't carry the expected class/data attribute, inspect the rendered DOM with `screen.debug()` and adjust the selector. The shadcn `Skeleton` typically renders as `<div data-slot="skeleton" className="animate-pulse ...">`. The query in the test catches both forms.

### Step 3.3: Run the full web unit suite

```bash
pnpm --filter @garageos/web test:unit
```

Expected: full PASS across all test files.

### Step 3.4: Typecheck

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

### Step 3.5: Commit

```bash
git add packages/web/src/pages/VehicleDetail.test.tsx
git commit -m "$(cat <<'EOF'
test(web): VehicleDetail page integration test

Six scenarios: loading state, 404 redirect+toast, generic error
alert, happy-path rendering with TimelineRow, archived disables
"Registra intervento", empty timeline message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final validation, push, PR

**Files:** none (verification + git operations).

### Step 4.1: Workspace typecheck

```bash
pnpm -r typecheck
```

Expected: 0 errors across all 4 packages.

### Step 4.2: Web unit suite

```bash
pnpm --filter @garageos/web test:unit
```

Expected: all tests pass (existing 134 + 11 TimelineRow + 6 VehicleDetail = ~151).

### Step 4.3: LOC budget check

```bash
git diff main..HEAD --stat
```

Expected: total ~400 net LOC code (excluding spec/plan docs). No drift outside `packages/web/**` and `docs/superpowers/**`.

### Step 4.4: Push the branch

```bash
git push -u origin feat/web-timeline-expand-collapse
```

Expected: pre-push hook runs `pnpm -r typecheck` and passes. Push succeeds.

### Step 4.5: Open the PR

```bash
gh pr create --title "feat(web): timeline interventi con expand/collapse + dispute badge" --body "$(cat <<'EOF'
## What

Estrae la riga timeline da `VehicleDetail.tsx` in un componente `TimelineRow` autonomo che supporta expand/collapse inline. Surfacia `description`, `parts_replaced_count`, `attachments_count`, `is_disputed` — campi già nel DTO timeline ma invisibili dall'UI compact precedente.

Primo vertical slice post pivot agile: pure web, zero backend, demo-impactful per Persona Giuseppe.

## Why

- Spec: `docs/superpowers/specs/2026-05-09-web-timeline-expand-collapse-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-web-timeline-expand-collapse.md`
- Strategy pivot: dopo PR #78 abbiamo deciso di passare da "API first, batch UI dopo" a vertical slicing demo-driven (vedi `project_resume_checkpoint.md` post #78). Questo è lo slice di apertura.
- Valore principale demo: BR-129 dispute surface ottiene visibilità lato officina per la prima volta.

## Implementation notes

- `TimelineRow` ha state locale `expanded` (multi-open accordion). Niente coordinazione globale: il caso d'uso "confronta 2-3 tagliandi precedenti aperti insieme" è naturale.
- Animation via Tailwind grid-rows trick (`grid-rows-[0fr]` ↔ `grid-rows-[1fr]` + `opacity` + `mt`/`pt`/`border-t`). Niente JS measure.
- ARIA: `<button aria-expanded aria-controls={useId()}>` + focus-visible ring.
- Rendering condizionale: `parts_replaced_count > 0` e `has_attachments && attachments_count > 0` gating dei badge nel pannello expanded. Description vuoto → "Nessuna descrizione." italic muted.
- Dispute badge (`variant="destructive"`) visibile in compact accanto al kind badge — informazione critica per operatore.
- `VehicleDetail.test.tsx` è nuovo (non esisteva): aggiunge 6 scenari page-level + sblocca futuro test pattern per le altre pagine.

## Tests

- [x] `TimelineRow.test.tsx` (11): compact shop, compact private, dispute badge present/absent, aria-expanded toggle, expanded shop full, parts=0 omits badge, has_attachments=false omits badge, empty description shows "Nessuna descrizione.", expanded private (no parts badge)
- [x] `VehicleDetail.test.tsx` (6): loading skeletons, 404 redirect+toast, 500 error alert, happy path with 2 rows rendered, archived disables CTA, empty timeline message
- [x] Full web suite passes (~151 tests)
- [ ] Manual smoke (post-deploy, optional):
  1. Login web Giuseppe
  2. Apri veicolo con interventi (es. via tab Cliente)
  3. Click su una riga → animazione expand mostra description + badges
  4. Re-click → collapse animato
  5. Se intervento ha is_disputed=true (richiede dataset reale o setup pilot) → badge "Disputa" visibile in compact

## Followup tickets to file (post-merge)

- **Intervention detail page** (`/vehicles/:id/interventions/:iid`): spec successivo. Decision: riusare timeline DTO via location state vs nuovo `GET /v1/interventions/:id`.
- **Edit intervento dalla timeline** (consume PATCH /interventions/:id, BR-062 wiki window).
- **View dispute thread completo** + responses + revisions inline.
- **Filter timeline** (anno / categoria / has-disputes).
- **Followup tickets PR #78** (a11y tabpanel, customer name header, ecc.) ancora aperti.

## Checklist

- [x] Conventional Commits title
- [x] Types compile (`pnpm -r typecheck` clean across 4 packages)
- [x] No console.log, no commented-out code
- [x] No secrets committed
- [x] Spec + plan committed
- [x] Subagent-driven 3-stage review loop + opus final reviewer
EOF
)"
```

### Step 4.6: Watch CI

```bash
gh pr checks --watch
```

Expected: 9/9 green. Web tests run inside the workspace `test:unit` job.

If anything fails, fix and push a follow-up commit.

---

## Self-review summary

Spec → plan coverage:

| Spec section | Covered by |
|---|---|
| §2.1 Refactoring (extract TimelineRow) | Task 1 (build) + Task 2 (wire) |
| §2.2 Componente shape | Task 1 step 1.3 (full implementation) |
| §2.3 Multi-open accordion | Task 1 step 1.3 (state locale per riga); Task 1 test #6 verifies toggle independence |
| §2.4 Animazione grid-rows | Task 1 step 1.3 (className conditionals) |
| §2.5 Accessibility (aria-expanded, aria-controls, useId) | Task 1 step 1.3 + tests #4, #6 |
| §3 Files & components | Tasks 1, 2, 3 |
| §4 Edge cases | Task 1 tests #8 (parts=0), #9 (no attachments), #10 (empty description) |
| §5.1 TimelineRow tests (11 spec, 11 plan) | Task 1 step 1.1 |
| §5.2 VehicleDetail tests (6 spec, 6 plan) | Task 3 step 3.1 |
| §6 Non-goals | Out of scope by construction (no tasks). |
| §7 BR coverage | None directly — UI consuming an existing endpoint; BR-129 dispute surface is the demo value. |
| §8 Operational | Task 4 covers CI gates; smoke optional manual. |
| §9 PR description | Task 4.5 |

No placeholders. Every step has actual content. Type signatures cross-reference: `TimelineItem`, `ShopTimelineItem`, `PrivateTimelineItem`, `VehicleDetailResponse`, `TimelineResponse`, `ApiError` are all in existing files (`@/queries/types`, `@/lib/api-client`).

Type consistency check:
- `Props { item: TimelineItem }` consistent across Task 1 + Task 2 + Task 3 fixtures.
- `panelId = useId()` used both in implementation (step 1.3) and referenced in test #4 ("aria-expanded=false").
- `formatDate`, `formatKm`, `fallback` already exist in `@/lib/format` (verified pre-plan).
- `Badge` `variant: 'destructive' | 'outline' | 'secondary'` all valid (verified `badge.tsx`).

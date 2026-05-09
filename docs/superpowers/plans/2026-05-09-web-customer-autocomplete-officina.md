# Web Customer Autocomplete Officina Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the customers/search backend (PR #77) and vehicles/search-by-customer backend (PR #76) into the web app officina UI so the operator can find a customer by name and reach the intervention-create flow.

**Architecture:** Dashboard acquisisce 2 tab (Veicolo / Cliente). Tab Cliente ospita un `CustomerAutocomplete` (shadcn `Command` + `Popover` + cmdk) che consuma `/v1/customers/search?q=`. Selezione customer → `navigate(/search?customer=<uuid>&t=customer)`. SearchResults estende il branching su `t`: per `t='customer'` chiama `/v1/vehicles/search?customer=<uuid>` riusando `VehicleResultCard`. InterventionCreate è invariato.

**Tech Stack:** React 19, Vite 6, TanStack Query 5, shadcn UI, cmdk 1.x, Radix Popover, Vitest 4 + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-09-web-customer-autocomplete-officina-design.md`

---

## File structure

| File | Stato | Responsibility | Est LOC |
|---|---|---|---|
| `packages/web/package.json` | MOD | Aggiunge `cmdk: "^1.0.4"` | +1 |
| `packages/web/src/components/ui/command.tsx` | NEW | shadcn Command boilerplate (Command/Input/List/Item/Empty/Loading/Group) | ~135 |
| `packages/web/src/queries/types.ts` | MOD | Aggiunge `Customer` + `CustomerSearchResponse` | +20 |
| `packages/web/src/lib/use-debounced-value.ts` | NEW | `useDebouncedValue<T>(v, ms): T` | ~15 |
| `packages/web/tests/unit/lib/use-debounced-value.test.tsx` (or `src/lib/use-debounced-value.test.tsx`) | NEW | Hook unit test | ~30 |
| `packages/web/src/queries/customerSearch.ts` | NEW | `useCustomerSearch(q)` con `enabled: q ≥ 2` | ~25 |
| `packages/web/src/queries/customerSearch.test.tsx` | NEW | Query hook test | ~40 |
| `packages/web/src/components/CustomerAutocomplete.tsx` | NEW | Input + Popover + Command + debounce + onSelect | ~150 |
| `packages/web/src/components/CustomerAutocomplete.test.tsx` | NEW | Component test (jsdom) | ~120 |
| `packages/web/src/lib/search-input.ts` | MOD | Aggiunge `'customer'` a `SearchType` | +1 |
| `packages/web/src/queries/vehicleSearch.ts` | MOD | Discriminated union args supports `customerId` | +12 |
| `packages/web/src/pages/SearchResults.tsx` | MOD | Branch `t='customer'` legge `customer=<uuid>`, header dedicato | +35 |
| `packages/web/src/pages/SearchResults.test.tsx` | NEW | Page test (uuid valid, invalid, t branches) | ~80 |
| `packages/web/src/pages/Dashboard.tsx` | MOD | Tab toggle + render CustomerAutocomplete in tab Cliente | +50 |
| `packages/web/src/pages/Dashboard.test.tsx` | MOD | Test tab switch + autocomplete onSelect → navigate | +50 |

**Net LOC stimato:** ~764 (135 shadcn scaffold + ~270 prod + ~270 test + ~90 modifiche).

> **Note convenzionale:** test paths in `packages/web` vivono accanto al source (es. `queries/interventionTypes.test.tsx`). Mirror that — do NOT create `tests/unit/...` paths. Vitest config covers `src/**/*.test.{ts,tsx}`.

---

## Pre-req: working directory & branch

You are working on branch `feat/web-customer-autocomplete-officina` (already created). Do NOT switch branches mid-task. Working directory: `C:\Users\Michele\source\repos\garageos`. The spec is at `docs/superpowers/specs/2026-05-09-web-customer-autocomplete-officina-design.md`. The branch HEAD before any task is `4ce585f` (spec doc commit on top of main).

The repo is a pnpm monorepo. Web package: `packages/web`. Relevant scripts:
- `pnpm --filter @garageos/web typecheck` — fast TS check (~6s)
- `pnpm --filter @garageos/web test:unit` — vitest run
- `pnpm install` — root install (after package.json changes)

Pre-commit hook: prettier + eslint --fix + secretlint. Pre-push hook: `pnpm -r typecheck`.

DO NOT run `pnpm test:integration` (irrelevant for web). DO NOT run `pnpm dev` to smoke-test in-browser unless explicitly debugging — vitest unit tests are the gate.

---

## Task 1: Add `cmdk` dep + scaffold shadcn `command.tsx`

**Why first:** every later task imports from `@/components/ui/command`. Get the boilerplate in place + dependency resolved.

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/components/ui/command.tsx`

- [ ] **Step 1.1: Add `cmdk` dependency**

Open `packages/web/package.json`. In the `dependencies` block, add (alphabetical order — between `clsx` and `date-fns`):

```json
"cmdk": "^1.0.4",
```

- [ ] **Step 1.2: Install**

```bash
pnpm install
```

Expected: lockfile updates, no peer dependency errors. cmdk 1.0.4+ supports React 19.

- [ ] **Step 1.3: Create the shadcn Command boilerplate**

Create `packages/web/src/components/ui/command.tsx` with this exact content (lifted verbatim from the official shadcn registry, adapted to repo style — uses `cn` from `@/lib/utils` like other UI components):

```tsx
'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm" {...props} />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandLoading = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Loading>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Loading>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Loading
    ref={ref}
    className={cn('py-6 text-center text-sm text-muted-foreground', className)}
    {...props}
  />
));
CommandLoading.displayName = CommandPrimitive.Loading.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandLoading,
  CommandGroup,
  CommandItem,
};
```

- [ ] **Step 1.4: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors. (If cmdk has new TS exports that error, downgrade to `^1.0.4` exactly.)

- [ ] **Step 1.5: Commit**

```bash
git add packages/web/package.json packages/web/src/components/ui/command.tsx pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(web): scaffold shadcn Command component (cmdk)

Adds cmdk dependency + boilerplate shadcn Command primitives needed
by the upcoming customer autocomplete on the officina dashboard.
No consumers yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add types + `useDebouncedValue` + `useCustomerSearch` (data layer)

**Why next:** the autocomplete component depends on these. Build them with TDD before the component to get green imports.

**Files:**
- Modify: `packages/web/src/queries/types.ts`
- Create: `packages/web/src/lib/use-debounced-value.ts`
- Create: `packages/web/src/lib/use-debounced-value.test.tsx`
- Create: `packages/web/src/queries/customerSearch.ts`
- Create: `packages/web/src/queries/customerSearch.test.tsx`

- [ ] **Step 2.1: Add `Customer` types to `queries/types.ts`**

Open `packages/web/src/queries/types.ts`. Append at the end of the file (after the last existing export):

```ts
// Returned by /v1/customers/search (PR #77). Tenant-scoped: every row
// is by construction related to the calling tenant, so PII is fully
// visible (no `redacted` discriminator like MaskedCustomer).
export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
  status: 'active';
}

export interface CustomerSearchResponse {
  data: Customer[];
  meta: { has_more: boolean; cursor?: string };
}
```

- [ ] **Step 2.2: Write `useDebouncedValue` test (RED)**

Create `packages/web/src/lib/use-debounced-value.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useDebouncedValue } from './use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 250));
    expect(result.current).toBe('hello');
  });

  it('does not update before the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('a');
  });

  it('updates after the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('ab');
  });

  it('resets the timer on each new value', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ v: 'abc' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe('abc');
  });
});
```

- [ ] **Step 2.3: Run failing test (RED)**

```bash
pnpm --filter @garageos/web exec vitest run src/lib/use-debounced-value.test.tsx
```

Expected: FAIL with "Cannot find module './use-debounced-value'".

- [ ] **Step 2.4: Implement `useDebouncedValue`**

Create `packages/web/src/lib/use-debounced-value.ts`:

```ts
import { useEffect, useState } from 'react';

// Returns a value that lags behind the input by `ms` milliseconds.
// Used by CustomerAutocomplete to coalesce keystrokes before firing
// the /v1/customers/search query.
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);

  return debounced;
}
```

- [ ] **Step 2.5: Run test (GREEN)**

```bash
pnpm --filter @garageos/web exec vitest run src/lib/use-debounced-value.test.tsx
```

Expected: PASS — 4 tests.

- [ ] **Step 2.6: Write `useCustomerSearch` test**

Create `packages/web/src/queries/customerSearch.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCustomerSearch } from './customerSearch';
import type { CustomerSearchResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCustomerSearch', () => {
  it('does not fire the query when q is shorter than 2 chars', () => {
    apiFetchMock.mockClear();
    const { result } = renderHook(() => useCustomerSearch('a'), { wrapper: wrap });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does not fire the query when q is empty', () => {
    apiFetchMock.mockClear();
    const { result } = renderHook(() => useCustomerSearch(''), { wrapper: wrap });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('fires the query and returns data when q is at least 2 chars', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      data: [
        {
          id: 'cust-1',
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@example.it',
          phone: null,
          isBusiness: false,
          businessName: null,
          vatNumber: null,
          status: 'active',
        },
      ],
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const { result } = renderHook(() => useCustomerSearch('mar'), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/search?q=mar&limit=20');
    expect(result.current.data?.data[0]?.firstName).toBe('Mario');
  });
});
```

- [ ] **Step 2.7: Run failing test (RED)**

```bash
pnpm --filter @garageos/web exec vitest run src/queries/customerSearch.test.tsx
```

Expected: FAIL with "Cannot find module './customerSearch'".

- [ ] **Step 2.8: Implement `useCustomerSearch`**

Create `packages/web/src/queries/customerSearch.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { CustomerSearchResponse } from './types';

// E2 customer autocomplete officina (Persona Giuseppe demo).
// Consumes /v1/customers/search (PR #77) — tenant-scoped, ILIKE
// substring on firstName/lastName/businessName.
//
// `enabled` mirrors the backend's q ≥ 2 char requirement so we never
// fire a guaranteed-400 request just to prefill the dropdown.

export function useCustomerSearch(q: string) {
  const apiFetch = useApiFetch();
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['customer-search', trimmed] as const,
    queryFn: () => {
      const search = new URLSearchParams({ q: trimmed, limit: '20' });
      return apiFetch<CustomerSearchResponse>(`/v1/customers/search?${search.toString()}`);
    },
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2.9: Run test (GREEN)**

```bash
pnpm --filter @garageos/web exec vitest run src/queries/customerSearch.test.tsx
```

Expected: PASS — 3 tests.

- [ ] **Step 2.10: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 2.11: Commit**

```bash
git add packages/web/src/queries/types.ts packages/web/src/lib/use-debounced-value.ts packages/web/src/lib/use-debounced-value.test.tsx packages/web/src/queries/customerSearch.ts packages/web/src/queries/customerSearch.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): customer search query hook + debounce helper

Adds useDebouncedValue<T>, the Customer / CustomerSearchResponse DTO
types, and the useCustomerSearch query hook. The hook gates fetches
on q.trim().length >= 2 to mirror the backend min-length contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Build `CustomerAutocomplete` component (TDD)

**Files:**
- Create: `packages/web/src/components/CustomerAutocomplete.test.tsx`
- Create: `packages/web/src/components/CustomerAutocomplete.tsx`

- [ ] **Step 3.1: Write the component test (RED)**

Create `packages/web/src/components/CustomerAutocomplete.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CustomerAutocomplete } from './CustomerAutocomplete';
import type { Customer, CustomerSearchResponse } from '@/queries/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const customers: Customer[] = [
  {
    id: 'cust-mario',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario.rossi@example.it',
    phone: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    status: 'active',
  },
  {
    id: 'cust-marina',
    firstName: 'Marina',
    lastName: 'Bianchi',
    email: 'marina@example.it',
    phone: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    status: 'active',
  },
  {
    id: 'cust-trattoria',
    firstName: 'Luigi',
    lastName: 'Trattoria',
    email: 'mario@trattoria.it',
    phone: null,
    isBusiness: true,
    businessName: 'Trattoria Da Luigi S.r.l.',
    vatNumber: 'IT01234567890',
    status: 'active',
  },
];

describe('CustomerAutocomplete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the input and an initial hint when empty', () => {
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText(/nessun cliente/i)).not.toBeInTheDocument();
  });

  it('shows the min-2-char hint when typing 1 char', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'a');
    expect(screen.getByText(/almeno 2 caratteri/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('debounces 250ms before firing the search', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    expect(apiFetchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/search?q=mar&limit=20');
  });

  it('renders B2C and B2B rows correctly with email and badge', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/Mario Rossi/i)).toBeInTheDocument());
    expect(screen.getByText('mario.rossi@example.it')).toBeInTheDocument();
    expect(screen.getByText(/Trattoria Da Luigi/)).toBeInTheDocument();
    expect(screen.getByText('B2B')).toBeInTheDocument();
  });

  it('shows "Nessun cliente trovato" on empty result', async () => {
    apiFetchMock.mockResolvedValue({
      data: [],
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'zz');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/nessun cliente trovato/i)).toBeInTheDocument());
  });

  it('shows an error fallback on query failure', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/errore/i)).toBeInTheDocument());
  });

  it('invokes onSelect with the full customer when an item is clicked', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const onSelect = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={onSelect} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/Marina Bianchi/i)).toBeInTheDocument());
    await user.click(screen.getByText(/Marina Bianchi/i));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cust-marina', firstName: 'Marina' }),
    );
  });
});
```

- [ ] **Step 3.2: Run failing test (RED)**

```bash
pnpm --filter @garageos/web exec vitest run src/components/CustomerAutocomplete.test.tsx
```

Expected: FAIL with "Cannot find module './CustomerAutocomplete'".

- [ ] **Step 3.3: Implement `CustomerAutocomplete`**

Create `packages/web/src/components/CustomerAutocomplete.tsx`:

```tsx
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from '@/components/ui/command';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useCustomerSearch } from '@/queries/customerSearch';
import type { Customer } from '@/queries/types';

// E2 customer autocomplete officina. Consumes /v1/customers/search
// (PR #77) and surfaces a tenant-scoped name search to the operator.
// Selection navigates the consumer to the customer's vehicle list
// (Dashboard wires onSelect → /search?customer=<id>&t=customer).

interface Props {
  onSelect: (customer: Customer) => void;
}

function customerLabel(c: Customer): string {
  return c.isBusiness && c.businessName
    ? c.businessName
    : `${c.firstName} ${c.lastName}`.trim();
}

export function CustomerAutocomplete({ onSelect }: Props) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const debounced = useDebouncedValue(trimmed, 250);
  const query = useCustomerSearch(debounced);

  const showHint = trimmed.length > 0 && trimmed.length < 2;
  const showResults = trimmed.length >= 2;

  return (
    <div className="w-full max-w-2xl">
      <Command shouldFilter={false} className="rounded-md border shadow-sm">
        <CommandInput
          placeholder="Digita nome o cognome cliente…"
          value={value}
          onValueChange={setValue}
          autoFocus
        />
        <CommandList>
          {showHint && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Digita almeno 2 caratteri.
            </div>
          )}
          {showResults && query.isPending && <CommandLoading>Cercando…</CommandLoading>}
          {showResults && query.isError && (
            <div className="py-6 text-center text-sm text-destructive">
              Errore. Riprova.
            </div>
          )}
          {showResults && query.isSuccess && query.data.data.length === 0 && (
            <CommandEmpty>Nessun cliente trovato.</CommandEmpty>
          )}
          {showResults &&
            query.isSuccess &&
            query.data.data.map((c) => (
              <CommandItem
                key={c.id}
                value={c.id}
                onSelect={() => onSelect(c)}
                className="flex flex-col items-start gap-0.5"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{customerLabel(c)}</span>
                  {c.isBusiness && <Badge variant="secondary">B2B</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">{c.email}</span>
              </CommandItem>
            ))}
        </CommandList>
      </Command>
    </div>
  );
}
```

- [ ] **Step 3.4: Run test (GREEN — iterate)**

```bash
pnpm --filter @garageos/web exec vitest run src/components/CustomerAutocomplete.test.tsx
```

Expected: PASS — 7 tests. If any fail (likely Command's role/labelling differs from what the test queries), inspect the rendered DOM and adjust the test (NOT the component) — for example, `getByRole('combobox')` may need to be `getByRole('textbox')` depending on cmdk's internals. The component's behavior is the contract; the test query strategy is the implementation detail.

If Cmdk renders no `combobox` role, switch the test query to:
```ts
screen.getByPlaceholderText(/nome o cognome cliente/i);
```

- [ ] **Step 3.5: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 3.6: Commit**

```bash
git add packages/web/src/components/CustomerAutocomplete.tsx packages/web/src/components/CustomerAutocomplete.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): CustomerAutocomplete component

Composes shadcn Command + cmdk + the customer search hook with a 250ms
debounce. shouldFilter is disabled because the backend filters; cmdk
renders the items in receipt order. B2B rows surface a badge so an
operator can disambiguate a business customer from a name-collision
homonym.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `SearchType` + `useVehicleSearch` + `SearchResults` branch

**Why bundled:** `SearchType` is the type contract; `useVehicleSearch` consumes it; `SearchResults` is the only consumer of `useVehicleSearch`. All three change together to land a coherent diff.

**Files:**
- Modify: `packages/web/src/lib/search-input.ts`
- Modify: `packages/web/src/queries/vehicleSearch.ts`
- Modify: `packages/web/src/pages/SearchResults.tsx`
- Create: `packages/web/src/pages/SearchResults.test.tsx`

- [ ] **Step 4.1: Extend `SearchType`**

Open `packages/web/src/lib/search-input.ts`. Replace the type definition at line 1:

```ts
export type SearchType = 'vin' | 'plate' | 'garage_code';
```

with:

```ts
export type SearchType = 'vin' | 'plate' | 'garage_code' | 'customer';
```

Note: `parseSearchInput` does not need changes — it only auto-detects VIN/plate/garage_code from a free-text input. The 'customer' branch is reached only via explicit URL params from `CustomerAutocomplete.onSelect`.

- [ ] **Step 4.2: Extend `useVehicleSearch` to support `customerId`**

Open `packages/web/src/queries/vehicleSearch.ts`. Replace the entire file content with:

```ts
import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';
import type { SearchType } from '@/lib/search-input';

import type { VehicleSearchResponse } from './types';

// Discriminated union: either a free-text search by selector type
// (vin/plate/garage_code) OR a customer-id lookup. The customer branch
// reaches /v1/vehicles/search?customer=<uuid> (PR #76) and inherits
// the same pagination contract.

export type VehicleSearchParams =
  | { kind: 'query'; q: string; t: SearchType | null }
  | { kind: 'customer'; customerId: string };

export function useVehicleSearch(params: VehicleSearchParams) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['vehicle-search', params] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (params.kind === 'customer') {
        search.set('customer', params.customerId);
      } else if (params.t) {
        search.set(params.t, params.q);
      }
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<VehicleSearchResponse>(`/v1/vehicles/search?${search.toString()}`);
    },
    enabled:
      params.kind === 'customer'
        ? !!params.customerId
        : !!params.q && !!params.t && params.t !== 'customer',
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.cursor ?? undefined,
    staleTime: 30_000,
  });
}
```

The `params.t !== 'customer'` guard in the `enabled` predicate is defensive: the query branch should never receive `t='customer'` (only the customer branch does), but the union allows it syntactically because `SearchType` includes 'customer'. Disabling rather than errorring is the right behavior for a misuse path.

- [ ] **Step 4.3: Update `SearchResults.tsx` to handle `t='customer'`**

Open `packages/web/src/pages/SearchResults.tsx`. Replace the entire file content with:

```tsx
// IT-strings — hardcoded
import { useSearchParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';

import { useVehicleSearch, type VehicleSearchParams } from '@/queries/vehicleSearch';
import type { SearchType } from '@/lib/search-input';
import { VehicleResultCard } from '@/components/VehicleResultCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const typeLabel: Record<SearchType, string> = {
  vin: 'VIN',
  plate: 'targa',
  garage_code: 'codice GarageOS',
  customer: 'cliente',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidType(t: string | null): t is SearchType {
  return t === 'vin' || t === 'plate' || t === 'garage_code' || t === 'customer';
}

function paramsForCustomer(customerId: string | null): VehicleSearchParams | null {
  if (!customerId || !UUID_RE.test(customerId)) return null;
  return { kind: 'customer', customerId };
}

export function SearchResults() {
  const [params] = useSearchParams();
  const tRaw = params.get('t');
  const t = isValidType(tRaw) ? tRaw : null;

  if (t === 'customer') {
    return <SearchResultsByCustomer customerId={params.get('customer')} />;
  }

  const q = params.get('q')?.trim() ?? '';
  return <SearchResultsByQuery q={q} t={t} />;
}

function SearchResultsByCustomer({ customerId }: { customerId: string | null }) {
  const queryParams = paramsForCustomer(customerId);
  const query = useVehicleSearch(queryParams ?? { kind: 'customer', customerId: '' });
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  if (!queryParams) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Parametri di ricerca mancanti o invalidi.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ResultsLayout
      header={
        <div>
          <div className="text-sm text-muted-foreground mb-2">
            Veicoli del <Badge variant="outline">cliente</Badge>
          </div>
          <div className="font-mono text-lg font-semibold text-foreground">
            {queryParams.customerId}
          </div>
        </div>
      }
      query={query}
      items={items}
    />
  );
}

function SearchResultsByQuery({ q, t }: { q: string; t: SearchType | null }) {
  const query = useVehicleSearch({ kind: 'query', q, t });
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  if (!q || !t || t === 'customer') {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Parametri di ricerca mancanti o invalidi.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ResultsLayout
      header={
        <div>
          <div className="text-sm text-muted-foreground mb-2">
            Ricerca per <Badge variant="outline">{typeLabel[t]}</Badge>
          </div>
          <div className="font-mono text-lg font-semibold text-foreground">{q}</div>
        </div>
      }
      query={query}
      items={items}
    />
  );
}

interface ResultsLayoutProps {
  header: React.ReactNode;
  query: ReturnType<typeof useVehicleSearch>;
  items: Array<{ id: string }>;
}

function ResultsLayout({ header, query, items }: ResultsLayoutProps) {
  return (
    <div className="p-8 space-y-6">
      {header}

      {query.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{query.error instanceof Error ? query.error.message : 'Errore sconosciuto'}</span>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.isSuccess && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchX size={48} className="mb-3" />
          <div className="font-medium text-foreground">Nessun veicolo trovato.</div>
          <div className="text-sm">Verifica il dato inserito.</div>
        </div>
      )}

      {query.isSuccess && items.length > 0 && (
        <>
          <div className="text-sm text-muted-foreground">
            {items.length} risultat{items.length === 1 ? 'o' : 'i'}
          </div>
          <div className="space-y-3">
            {items.map((v) => (
              <VehicleResultCard key={v.id} vehicle={v as never} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="pt-4">
              <Button
                variant="outline"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altri'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

Note the `vehicle={v as never}` cast inside `ResultsLayout`: this is a deliberate compromise — the inner shared layout doesn't constrain the item shape past `id`, but `VehicleResultCard` expects the full `VehicleSearchItem`. The `as never` keeps the layout generic. The two callers (`SearchResultsByQuery`, `SearchResultsByCustomer`) both consume `useVehicleSearch`, which returns `VehicleSearchItem[]`, so the runtime shape is correct. (If you'd rather not use `as never`, parameterize `ResultsLayout` over `<T extends { id: string }>` and pass a `renderCard` prop — costs ~6 LOC extra.)

- [ ] **Step 4.4: Write `SearchResults.test.tsx`**

Create `packages/web/src/pages/SearchResults.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SearchResults } from './SearchResults';
import type { VehicleSearchResponse } from '@/queries/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ initialPath, children }: { initialPath: string; children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const VEHICLE_FIXTURE = {
  id: 'veh-1',
  garageCode: 'GO-234-ABCD',
  vin: 'ZFA31200000123456',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'auto',
  fuelType: 'gasoline',
  status: 'certified',
  currentOwnership: null,
};

describe('SearchResults — t=customer branch', () => {
  it('renders the vehicles list when ?customer=<uuid>&t=customer', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce({
      data: [VEHICLE_FIXTURE],
      meta: { has_more: false },
    } satisfies VehicleSearchResponse);

    const path = '/search?customer=11111111-1111-4111-8111-111111111111&t=customer';
    render(
      wrap({
        initialPath: path,
        children: <SearchResults />,
      }),
    );

    await waitFor(() => expect(screen.getByText(/Fiat Panda/i)).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/vehicles/search?customer=11111111-1111-4111-8111-111111111111'),
    );
    expect(screen.getByText(/Veicoli del/i)).toBeInTheDocument();
  });

  it('shows the invalid-params alert when customer is not a UUID', () => {
    apiFetchMock.mockClear();
    render(
      wrap({
        initialPath: '/search?customer=not-a-uuid&t=customer',
        children: <SearchResults />,
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/parametri.*invalidi/i);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('shows the invalid-params alert when customer is missing', () => {
    apiFetchMock.mockClear();
    render(
      wrap({
        initialPath: '/search?t=customer',
        children: <SearchResults />,
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/parametri.*invalidi/i);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('SearchResults — q+t branch (regression)', () => {
  it('still works for plate search', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce({
      data: [VEHICLE_FIXTURE],
      meta: { has_more: false },
    } satisfies VehicleSearchResponse);

    render(
      wrap({
        initialPath: '/search?q=AB123CD&t=plate',
        children: <SearchResults />,
      }),
    );

    await waitFor(() => expect(screen.getByText(/Fiat Panda/i)).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('plate=AB123CD'));
    expect(screen.getByText(/Ricerca per/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4.5: Run all related tests**

```bash
pnpm --filter @garageos/web exec vitest run src/pages/SearchResults.test.tsx src/queries/vehicleSearch
```

Expected: PASS — 4 tests in SearchResults.test.tsx (3 customer + 1 regression). If `vehicleSearch` has no test file (currently it does not), only the page test runs.

- [ ] **Step 4.6: Run the full unit suite to catch regressions in other consumers**

```bash
pnpm --filter @garageos/web test:unit
```

Expected: full PASS. Any failure points at a consumer of `useVehicleSearch` (only `SearchResults`) or `SearchType` (only `Dashboard`'s vehicle branch). `Dashboard.test.tsx` should still pass because the existing inputs still produce VIN/plate/garage_code typed values.

- [ ] **Step 4.7: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 4.8: Commit**

```bash
git add packages/web/src/lib/search-input.ts packages/web/src/queries/vehicleSearch.ts packages/web/src/pages/SearchResults.tsx packages/web/src/pages/SearchResults.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): SearchResults handles t=customer (vehicles by customer id)

Adds the customer-id branch of vehicle search wired to PR #76's
customer= selector. The page splits into SearchResultsByQuery and
SearchResultsByCustomer with a shared ResultsLayout so the existing
plate / vin / garage_code path is untouched at runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Dashboard tabs + autocomplete integration

**Files:**
- Modify: `packages/web/src/pages/Dashboard.tsx`
- Modify: `packages/web/src/pages/Dashboard.test.tsx`

- [ ] **Step 5.1: Replace `Dashboard.tsx`**

Open `packages/web/src/pages/Dashboard.tsx`. Replace the entire file content with:

```tsx
// IT-strings — hardcoded, no i18n in demo-2
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';

import { parseSearchInput } from '@/lib/search-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CustomerAutocomplete } from '@/components/CustomerAutocomplete';

type Tab = 'vehicle' | 'customer';

export function Dashboard() {
  const [tab, setTab] = useState<Tab>('vehicle');

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-8">
      <h1 className="text-4xl font-extrabold tracking-tight text-foreground mb-2">Cerca</h1>
      <p className="text-muted-foreground mb-6">
        {tab === 'vehicle' ? 'VIN, targa o codice GarageOS' : 'Nome o ragione sociale del cliente'}
      </p>

      <div className="flex gap-2 mb-6" role="tablist" aria-label="Modalità di ricerca">
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'vehicle'}
          variant={tab === 'vehicle' ? 'default' : 'outline'}
          onClick={() => setTab('vehicle')}
        >
          Veicolo
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'customer'}
          variant={tab === 'customer' ? 'default' : 'outline'}
          onClick={() => setTab('customer')}
        >
          Cliente
        </Button>
      </div>

      {tab === 'vehicle' ? <VehicleSearchForm /> : <CustomerSearchPanel />}
    </div>
  );
}

function VehicleSearchForm() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseSearchInput(value);
    if (parsed.kind === 'invalid') {
      setError(
        'Inserisci un VIN (17 caratteri), una targa, o un codice GarageOS (formato GO-XXX-XXXX).',
      );
      return;
    }
    setError(null);
    navigate(`/search?q=${encodeURIComponent(parsed.value)}&t=${parsed.type}`);
  };

  const hint = (() => {
    const p = parseSearchInput(value);
    if (p.kind === 'invalid') return null;
    if (p.type === 'vin') return '→ ricerca per VIN';
    if (p.type === 'plate') return '→ ricerca per targa';
    return '→ ricerca per codice GarageOS';
  })();

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-2xl space-y-3">
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Inserisci VIN, targa o codice GO-…"
            className="h-14 pl-11 text-base"
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" className="h-14 px-6">
          Cerca →
        </Button>
      </div>
      {hint && <div className="text-xs text-muted-foreground pl-1">{hint}</div>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

function CustomerSearchPanel() {
  const navigate = useNavigate();
  return (
    <div className="w-full max-w-2xl">
      <CustomerAutocomplete
        onSelect={(c) => navigate(`/search?customer=${c.id}&t=customer`)}
      />
    </div>
  );
}
```

- [ ] **Step 5.2: Update `Dashboard.test.tsx`**

Open `packages/web/src/pages/Dashboard.test.tsx`. Replace the entire file content with:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { Dashboard } from './Dashboard';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/components/CustomerAutocomplete', () => ({
  CustomerAutocomplete: ({ onSelect }: { onSelect: (c: { id: string }) => void }) => (
    <button
      type="button"
      data-testid="autocomplete-stub"
      onClick={() => onSelect({ id: 'cust-test' })}
    >
      stub
    </button>
  ),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function renderDashboard() {
  return render(<Dashboard />, { wrapper: wrap });
}

describe('Dashboard — vehicle tab (regression)', () => {
  it('input invalido mostra alert con suggerimento formati', async () => {
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/VIN.*targa.*GarageOS/i);
  });

  it('VIN valido naviga a /search?q=...&t=vin', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'ZFA31200000123456');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=ZFA31200000123456&t=vin');
  });

  it('plate valida naviga a /search?q=...&t=plate', async () => {
    navigateMock.mockClear();
    renderDashboard();
    const input = screen.getByPlaceholderText(/VIN/i);
    await userEvent.type(input, 'AB123CD');
    await userEvent.click(screen.getByRole('button', { name: /cerca/i }));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=AB123CD&t=plate');
  });
});

describe('Dashboard — tab toggle', () => {
  it('defaults to the vehicle tab', () => {
    renderDashboard();
    expect(screen.getByPlaceholderText(/VIN/i)).toBeInTheDocument();
    expect(screen.queryByTestId('autocomplete-stub')).not.toBeInTheDocument();
  });

  it('switches to the customer tab and renders the autocomplete', async () => {
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    expect(screen.getByTestId('autocomplete-stub')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/VIN/i)).not.toBeInTheDocument();
  });

  it('switches back to the vehicle tab', async () => {
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    await userEvent.click(screen.getByRole('tab', { name: /veicolo/i }));
    expect(screen.getByPlaceholderText(/VIN/i)).toBeInTheDocument();
  });
});

describe('Dashboard — customer tab → navigate', () => {
  it('navigates to /search?customer=<id>&t=customer when autocomplete fires onSelect', async () => {
    navigateMock.mockClear();
    renderDashboard();
    await userEvent.click(screen.getByRole('tab', { name: /cliente/i }));
    await userEvent.click(screen.getByTestId('autocomplete-stub'));
    expect(navigateMock).toHaveBeenCalledWith('/search?customer=cust-test&t=customer');
  });
});
```

- [ ] **Step 5.3: Run all Dashboard tests**

```bash
pnpm --filter @garageos/web exec vitest run src/pages/Dashboard.test.tsx
```

Expected: PASS — 7 tests (3 vehicle regression + 3 tab + 1 customer-nav).

- [ ] **Step 5.4: Run the full web unit suite**

```bash
pnpm --filter @garageos/web test:unit
```

Expected: PASS across all test files.

- [ ] **Step 5.5: Typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: no errors.

- [ ] **Step 5.6: Commit**

```bash
git add packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Dashboard tabs Veicolo / Cliente with autocomplete

Splits the dashboard into a tab switcher; the customer tab hosts
CustomerAutocomplete and on selection navigates to
/search?customer=<id>&t=customer where SearchResultsByCustomer
takes over.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final validation, push, PR

**Files:** none (verification + git operations).

- [ ] **Step 6.1: Workspace typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors across all 4 packages. Pre-push hook re-runs this.

- [ ] **Step 6.2: Web unit suite**

```bash
pnpm --filter @garageos/web test:unit
```

Expected: full pass (all new tests + all pre-existing tests).

- [ ] **Step 6.3: LOC budget check**

```bash
git diff main..HEAD --stat
```

Expected: ~750–800 net LOC across `packages/web/**`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`. No drift into other packages.

- [ ] **Step 6.4: Push the branch**

```bash
git push -u origin feat/web-customer-autocomplete-officina
```

Expected: pre-push hook runs `pnpm -r typecheck` and passes. Push succeeds.

- [ ] **Step 6.5: Open the PR**

```bash
gh pr create --title "feat(web): customer autocomplete officina (Persona Giuseppe demo)" --body "$(cat <<'EOF'
## What

Wires `/v1/customers/search` (PR #77) and `/v1/vehicles/search?customer=` (PR #76) into the web app. Officina operator now has a "Cliente" tab on the dashboard with a name-based autocomplete; selecting a customer navigates to a vehicle list scoped to that customer, then the existing `VehicleDetail → Registra intervento` flow takes over.

## Why

- Spec: `docs/superpowers/specs/2026-05-09-web-customer-autocomplete-officina-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-web-customer-autocomplete-officina.md`
- Closes the autocomplete officina demo loop end-to-end (Persona Giuseppe / F-WEB-DEMO3) — backend was shipped in #76 and #77 without a consumer until now.

## Implementation notes

- Dashboard splits into `VehicleSearchForm` (existing input + auto-detect) and `CustomerSearchPanel` (new autocomplete). Tab state lives in component state; not persisted in URL on purpose (refresh returns to the default Veicolo tab).
- `CustomerAutocomplete` composes shadcn `Command` (`cmdk` 1.x added as a new dep) with `useDebouncedValue(250ms)` and `useCustomerSearch`. `shouldFilter={false}` because the backend is the filter; cmdk just renders rows in receipt order.
- `useVehicleSearch` becomes a discriminated union (`{kind:'query'} | {kind:'customer'}`). Only `SearchResults` consumes it; the call sites updated in lockstep.
- `SearchResults` splits into `SearchResultsByQuery` and `SearchResultsByCustomer` with a shared `ResultsLayout`. The customer header shows the UUID mono — looking up the name client-side is deliberately out of scope for this PR (followup ticket).

## Tests

- [x] `useDebouncedValue` (4): initial, before-delay, after-delay, timer reset
- [x] `useCustomerSearch` (3): empty q, q < 2, q ≥ 2 fires + returns data
- [x] `CustomerAutocomplete` (7): render, hint, debounce, B2C/B2B rows, empty, error, onSelect
- [x] `SearchResults` (4): t=customer happy path, invalid uuid, missing customer, t=plate regression
- [x] `Dashboard` (7): 3 regression vehicle + 3 tab + 1 customer-nav
- [ ] Manual smoke (post-deploy, optional):
  1. Login web app as Giuseppe operator
  2. Click tab Cliente
  3. Type "Mario" → assert dropdown populates
  4. Click a result → URL becomes `/search?customer=<id>&t=customer`
  5. SearchResults shows the customer's vehicles
  6. Click a card → VehicleDetail → "Registra intervento" → form opens

## Followup tickets to file

- **Customer name in `SearchResults` header**: currently shows the UUID mono. Needs either `GET /v1/customers/:id` or location state passing.
- **Tab state in URL** (`?tab=customer`): YAGNI for v1 demo, would survive refresh.

## Checklist

- [x] Conventional Commits title
- [x] Types compile (`pnpm -r typecheck` clean)
- [x] No console.log, no commented-out code
- [x] No secrets committed
- [x] Spec + plan committed
- [x] Subagent-driven 3-stage review loop + opus final reviewer
EOF
)"
```

- [ ] **Step 6.6: Watch CI**

```bash
gh pr checks --watch
```

Expected: all 9 checks green. Web tests run inside the workspace `test:unit` job which is part of CI; integration tests do not exercise the web app, but typecheck + format + lint all do.

If anything fails, fix and push a follow-up commit.

---

## Self-review summary

Spec → plan coverage:

| Spec section | Covered by |
|---|---|
| §2.1 UX flow (tabs, navigate to /search?customer=…) | Task 5 |
| §2.2 Data flow | Tasks 2 + 3 + 5 |
| §2.3 Component dependencies (shadcn Command, no Radix Tabs) | Task 1 + Task 5 (custom 2-button toggle) |
| §3.1 NEW files | Tasks 1, 2, 3, 4 |
| §3.2 MODIFIED files | Tasks 2, 4, 5 |
| §3.3 Module shapes (full code blocks) | Tasks 2, 3, 4, 5 |
| §4 Edge cases (q<2, empty, error, click outside, invalid uuid) | Test scenarios in Tasks 3 + 4 |
| §5.1 CustomerAutocomplete tests (9 spec → 7 in plan) | Task 3 — collapsed "render initial" + "hint" into a single render+hint flow; spec 9 maps to plan 7 with 100% behavior coverage. Keyboard ↓↓⏎ test deliberately deferred to manual smoke (cmdk's keyboard nav is library-tested upstream; testing it under userEvent + fake timers in jsdom is brittle without high payoff). If you want it, add a 9th case in step 3.1 with `await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')`. |
| §5.2 Dashboard tests (4 spec) | Task 5 — 7 tests (3 regression + 3 tab + 1 customer-nav). Module-mock pattern from `feedback_jsdom_radix_select_mock_pattern.md` applied: CustomerAutocomplete mocked at module level so the test exercises Dashboard orchestration without the cmdk portal. |
| §5.3 SearchResults tests (4 spec) | Task 4 |
| §6 Non-goals | Out of scope by construction (no tasks). |
| §7 BR coverage | None applicable (UI consuming endpoints that already enforce BR-151). |
| §8 Operational | Task 6 covers CI gates; smoke is optional manual. |
| §9 PR description | Task 6.5 |

No placeholders. Every step has the actual content. Type signatures cross-reference: `Customer`, `CustomerSearchResponse`, `VehicleSearchParams`, `SearchType` are all defined in earlier tasks before consumed by later ones.

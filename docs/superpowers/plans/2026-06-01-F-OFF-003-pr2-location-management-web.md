# F-OFF-003 PR2 — Location Management (web) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give super_admins a "Sedi" tab in Settings to list, create, edit, set-primary, and deactivate the tenant's locations, wired to the PR1 CRUD API.

**Architecture:** A self-contained `LocationManagement` page (mirrors `UserManagement`) rendered inside the URL-driven `Settings` tabs, plus a `LocationFormDialog` (create/edit, mirrors `EditUserDialog`). React-Query hooks in a focused `queries/locations.ts`; client validation in `lib/validators/location.ts` mirroring the backend Zod. The PR1 `GET /v1/tenants/me/locations` select is extended to return the full address fields the edit form needs (the list previously returned only id/name/city/isPrimary).

**Tech Stack:** React + Vite, TanStack Query, react-hook-form + zodResolver, shadcn/ui (Dialog, Select, Button, AlertDialog), sonner toasts, Vitest + Testing Library (jsdom — runs locally, fast).

**Right-sizing / testing:** Web component tests are jsdom (no Docker) and DO run locally fast — use real red-green per task with `pnpm --filter @garageos/web test`. Still push and let CI run the full matrix. Local gate also includes `pnpm -r typecheck`.

**Pre-flight facts already verified (do not re-litigate):**
- `useLocations` (queryKey `['tenant-locations']`) and `TenantLocation` live in `queries/users-admin.ts`, imported by EditUserDialog, InviteUserDialog, ReactivateSection(+test), UserManagement.test. We EXTEND `TenantLocation` (additive — existing consumers ignore new fields) and re-export from the new `queries/locations.ts`; no import-site churn.
- Mutation pattern: `useApiFetch`, `useMutation`, `qc.invalidateQueries`, `toast.success/error`, `translateError(err.code, err.message)`. DELETE needs `body: '{}'` (apiFetch hardcodes Content-Type and Fastify rejects an empty body) — see `queries/users-admin.ts:206`.
- Settings tabs are URL-driven: `pathnameToTab` / `tabToPath` map `/settings`, `/settings/users`. Add `/settings/locations` → tab `'locations'`. `App.tsx:52-53` registers `<Route path="/settings" .../>` and `/settings/users`; add `/settings/locations`.
- `LocationManagement` (like `UserManagement`) is self-contained and does NOT register a formRef, so the unsaved-changes guard in Settings doesn't apply to it.
- Error mapping: add codes to `ERROR_MESSAGES` in `lib/error-messages.ts`; `translateError(code, fallback)` falls back to the server detail.
- Radix Select/Dialog need `userEvent.click` (not `fireEvent`) in jsdom — see `feedback_radix_tabs_user_event_not_fire_event`.
- Backend field rules (mirror in client zod): name 1-200, addressLine 1-255, city 1-100, province `[A-Z]{2}` upper, postalCode `[0-9]{5}`, country `[A-Z]{2}` default IT, phone `/^[+]?[0-9 ()-]{6,30}$/`, email. Error codes from PR1: `tenants.me.locations.{cannot_delete_primary,has_active_users,cannot_unset_primary,not_found,update.empty_body,update.unknown_field}`.

---

## File Structure

- **Modify** `packages/api/src/routes/v1/tenants-locations-list.ts` — extend `select` with address fields.
- **Modify** `packages/api/tests/integration/tenants-locations-list.test.ts` — assert new fields present.
- **Modify** `docs/APPENDICE_A_API.md` — update GET response example.
- **Modify** `packages/web/src/queries/users-admin.ts` — extend `TenantLocation` interface (additive).
- **Create** `packages/web/src/queries/locations.ts` — re-export `useLocations`/`TenantLocation` + `useCreateLocation`/`useUpdateLocation`/`useDeleteLocation` + body types.
- **Create** `packages/web/src/lib/validators/location.ts` — client form schema.
- **Modify** `packages/web/src/lib/error-messages.ts` — add 6 location codes.
- **Create** `packages/web/src/components/locations/LocationFormDialog.tsx` + `.test.tsx`.
- **Create** `packages/web/src/pages/LocationManagement.tsx` + `.test.tsx`.
- **Modify** `packages/web/src/pages/Settings.tsx` — add "Sedi" tab.
- **Modify** `packages/web/src/App.tsx` — add `/settings/locations` route.
- **Modify** `packages/web/src/pages/Settings.test.tsx` — assert the new tab renders for super_admin.

---

## Task 1: Extend GET locations select (API)

**Files:**
- Modify: `packages/api/src/routes/v1/tenants-locations-list.ts`
- Modify: `packages/api/tests/integration/tenants-locations-list.test.ts`
- Modify: `docs/APPENDICE_A_API.md`

- [ ] **Step 1: Extend the select**

In `tenants-locations-list.ts`, replace the `select`:

```ts
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          province: true,
          postalCode: true,
          country: true,
          phone: true,
          email: true,
          isPrimary: true,
        },
```

(Keep the existing `where: { tenantId, status: 'active', deletedAt: null }` and `orderBy`.)

- [ ] **Step 2: Add field assertions to the existing integration test**

In `tenants-locations-list.test.ts`, in the first test ("returns 200 with active locations…"), after the existing `toHaveProperty` checks, add:

```ts
    expect(body.locations[0]).toHaveProperty('addressLine');
    expect(body.locations[0]).toHaveProperty('province');
    expect(body.locations[0]).toHaveProperty('postalCode');
    expect(body.locations[0]).toHaveProperty('country');
    expect(body.locations[0]).toHaveProperty('phone');
    expect(body.locations[0]).toHaveProperty('email');
```

Update the local response type annotation in that test to include the new fields (or loosen to `Record<string, unknown>[]`).

- [ ] **Step 3: Update APPENDICE_A GET response example**

In the "GET /v1/tenants/me/locations — Lista location attive" block (~line 2142), extend the JSON example object with `addressLine`, `province`, `postalCode`, `country`, `phone`, `email` and note these were added for the F-OFF-003 management UI.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @garageos/api typecheck` → Expected: PASS.
(CI integration: list test still green with the new assertions.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/tenants-locations-list.ts packages/api/tests/integration/tenants-locations-list.test.ts docs/APPENDICE_A_API.md
git commit -m "feat(api): return full address fields from GET locations (F-OFF-003 PR2)"
```

---

## Task 2: Query layer + validator + error messages (web)

**Files:**
- Modify: `packages/web/src/queries/users-admin.ts`
- Create: `packages/web/src/queries/locations.ts`
- Create: `packages/web/src/lib/validators/location.ts`
- Modify: `packages/web/src/lib/error-messages.ts`

- [ ] **Step 1: Extend `TenantLocation` (additive) in users-admin.ts**

Replace the existing `TenantLocation` interface (`queries/users-admin.ts:43-48`) with:

```ts
export interface TenantLocation {
  id: string;
  name: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}
```

(Existing consumers read only id/name/city/isPrimary — adding fields is non-breaking.)

- [ ] **Step 2: Create `queries/locations.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError, useApiFetch } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';

// useLocations + TenantLocation already live in users-admin.ts (shared with
// the user-invite flow). Re-export so location features import from one place.
export { useLocations, type TenantLocation } from './users-admin';

export interface LocationWriteBody {
  name: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string | null;
  email: string | null;
}

export type UpdateLocationBody = Partial<LocationWriteBody> & { isPrimary?: boolean };

interface LocationResponse {
  location: import('./users-admin').TenantLocation;
}

/** POST /v1/tenants/me/locations — create a secondary location. */
export function useCreateLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<LocationResponse, ApiError, LocationWriteBody>({
    mutationFn: (body) =>
      apiFetch<LocationResponse>('/v1/tenants/me/locations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede creata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** PATCH /v1/tenants/me/locations/:id — edit fields and/or promote to primary. */
export function useUpdateLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<LocationResponse, ApiError, { id: string; body: UpdateLocationBody }>({
    mutationFn: ({ id, body }) =>
      apiFetch<LocationResponse>(`/v1/tenants/me/locations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede aggiornata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** DELETE /v1/tenants/me/locations/:id — soft-delete (deactivate) a location. */
export function useDeleteLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    // body: '{}' — apiFetch hardcodes Content-Type: application/json and
    // Fastify rejects that header with no body (see users-admin.ts:206).
    mutationFn: (id) =>
      apiFetch<void>(`/v1/tenants/me/locations/${id}`, { method: 'DELETE', body: '{}' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede disattivata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}
```

- [ ] **Step 3: Create `lib/validators/location.ts`**

```ts
import { z } from 'zod';

// Mirror of the backend POST /v1/tenants/me/locations body schema, adapted
// for form inputs. Keep in sync with
// packages/api/src/routes/v1/tenants-locations-write.ts.
//
// name/addressLine/city/province/postalCode are required (NOT NULL in DB).
// country defaults to IT. phone/email optional: empty string in UI → null.
export const locationFormSchema = z.object({
  name: z.string().trim().min(1, 'Nome obbligatorio').max(200, 'Nome troppo lungo'),
  addressLine: z
    .string()
    .trim()
    .min(1, 'Indirizzo obbligatorio')
    .max(255, 'Indirizzo troppo lungo'),
  city: z.string().trim().min(1, 'Città obbligatoria').max(100, 'Città troppo lunga'),
  province: z
    .string()
    .trim()
    .min(1, 'Provincia obbligatoria')
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere')),
  postalCode: z
    .string()
    .trim()
    .min(1, 'CAP obbligatorio')
    .pipe(z.string().regex(/^[0-9]{5}$/, 'CAP: 5 cifre')),
  country: z
    .string()
    .trim()
    .transform((s) => (s === '' ? 'IT' : s.toUpperCase()))
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'Country: 2 lettere')),
  phone: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .pipe(
      z
        .string()
        .regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido')
        .nullable(),
    ),
  email: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .pipe(z.email('Email non valida').nullable()),
});

export type LocationFormValues = z.input<typeof locationFormSchema>;
export type LocationFormParsed = z.output<typeof locationFormSchema>;
```

- [ ] **Step 4: Add error codes to `lib/error-messages.ts`**

In the `ERROR_MESSAGES` object, after the `tenants.me.update.*` entries, add:

```ts
  'tenants.me.locations.not_found': 'Sede non trovata.',
  'tenants.me.locations.update.empty_body': 'Nessuna modifica da salvare.',
  'tenants.me.locations.update.unknown_field': 'Campo non modificabile.',
  'tenants.me.locations.cannot_unset_primary':
    "Per cambiare la sede primaria, designa un'altra sede come primaria.",
  'tenants.me.locations.cannot_delete_primary':
    "Non puoi disattivare la sede primaria. Designa prima un'altra sede come primaria.",
  'tenants.me.locations.has_active_users':
    "Questa sede ha meccanici attivi. Riassegnali a un'altra sede prima di disattivarla.",
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @garageos/web typecheck` → Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/users-admin.ts packages/web/src/queries/locations.ts packages/web/src/lib/validators/location.ts packages/web/src/lib/error-messages.ts
git commit -m "feat(web): location query hooks, form validator, error messages (F-OFF-003 PR2)"
```

---

## Task 3: LocationFormDialog (create / edit)

**Files:**
- Create: `packages/web/src/components/locations/LocationFormDialog.tsx`
- Create: `packages/web/src/components/locations/LocationFormDialog.test.tsx`

- [ ] **Step 1: Write the dialog**

```tsx
// LocationFormDialog — F-OFF-003 PR2 create/edit a tenant location.
// `location` null → create mode (POST); non-null → edit mode (PATCH all
// editable fields). Promotion-to-primary and deactivation are row actions
// in LocationManagement, not part of this form.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import {
  locationFormSchema,
  type LocationFormValues,
  type LocationFormParsed,
} from '@/lib/validators/location';
import {
  useCreateLocation,
  useUpdateLocation,
  type TenantLocation,
} from '@/queries/locations';
import { useState } from 'react';

interface Props {
  location: TenantLocation | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function toDefaults(loc: TenantLocation | null): LocationFormValues {
  return {
    name: loc?.name ?? '',
    addressLine: loc?.addressLine ?? '',
    city: loc?.city ?? '',
    province: loc?.province ?? '',
    postalCode: loc?.postalCode ?? '',
    country: loc?.country ?? 'IT',
    phone: loc?.phone ?? '',
    email: loc?.email ?? '',
  };
}

export function LocationFormDialog({ location, open, onOpenChange }: Props) {
  const createMut = useCreateLocation();
  const updateMut = useUpdateLocation();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LocationFormValues, unknown, LocationFormParsed>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: toDefaults(location),
  });

  // Re-seed the form whenever the dialog opens for a different location.
  useEffect(() => {
    if (open) form.reset(toDefaults(location));
  }, [open, location, form]);

  const errors = form.formState.errors;
  const isEdit = location !== null;

  async function onSubmit(values: LocationFormParsed) {
    setFormError(null);
    try {
      if (isEdit) {
        await updateMut.mutateAsync({ id: location.id, body: values });
      } else {
        await createMut.mutateAsync(values);
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setFormError(translateError(err.code, err.message));
      else setFormError('Errore imprevisto, riprova.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Modifica sede' : 'Aggiungi sede'}</DialogTitle>
          <DialogDescription>
            {isEdit ? location.name : 'Crea una nuova sede per la tua officina.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-3">
          {formError && (
            <div
              className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
              role="alert"
              data-testid="location-form-error"
            >
              {formError}
            </div>
          )}

          <div>
            <Label htmlFor="loc-name">Nome *</Label>
            <Input id="loc-name" {...form.register('name')} />
            {errors.name && <p className="text-sm text-red-600 mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="loc-address">Indirizzo *</Label>
            <Input id="loc-address" {...form.register('addressLine')} />
            {errors.addressLine && (
              <p className="text-sm text-red-600 mt-1">{errors.addressLine.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="loc-city">Città *</Label>
              <Input id="loc-city" {...form.register('city')} />
              {errors.city && <p className="text-sm text-red-600 mt-1">{errors.city.message}</p>}
            </div>
            <div>
              <Label htmlFor="loc-province">Provincia *</Label>
              <Input id="loc-province" maxLength={2} {...form.register('province')} />
              {errors.province && (
                <p className="text-sm text-red-600 mt-1">{errors.province.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="loc-cap">CAP *</Label>
              <Input id="loc-cap" {...form.register('postalCode')} />
              {errors.postalCode && (
                <p className="text-sm text-red-600 mt-1">{errors.postalCode.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="loc-country">Paese</Label>
              <Input id="loc-country" maxLength={2} {...form.register('country')} />
              {errors.country && (
                <p className="text-sm text-red-600 mt-1">{errors.country.message}</p>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="loc-phone">Telefono</Label>
            <Input id="loc-phone" {...form.register('phone')} />
            {errors.phone && <p className="text-sm text-red-600 mt-1">{errors.phone.message}</p>}
          </div>
          <div>
            <Label htmlFor="loc-email">Email</Label>
            <Input id="loc-email" {...form.register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Salvataggio…' : isEdit ? 'Salva' : 'Crea sede'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

> Confirm `@/components/ui/input` exists (it's used across forms, e.g. ProfileForm/TenantForm). If the shadcn Input is named differently, adjust the import.

- [ ] **Step 2: Write the test**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { LocationFormDialog } from './LocationFormDialog';

const create = vi.fn();
const update = vi.fn();
vi.mock('@/queries/locations', async () => {
  const actual = await vi.importActual<object>('@/queries/locations');
  return {
    ...actual,
    useCreateLocation: () => ({ mutateAsync: create, isPending: false }),
    useUpdateLocation: () => ({ mutateAsync: update, isPending: false }),
  };
});

function renderDialog(location: Parameters<typeof LocationFormDialog>[0]['location']) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LocationFormDialog location={location} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('LocationFormDialog', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ location: {} });
    update.mockReset().mockResolvedValue({ location: {} });
  });

  it('creates a location with uppercased province and IT country default', async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(screen.getByLabelText('Nome *'), 'Sede Roma');
    await user.type(screen.getByLabelText('Indirizzo *'), 'Via Roma 1');
    await user.type(screen.getByLabelText('Città *'), 'Roma');
    await user.type(screen.getByLabelText('Provincia *'), 'rm');
    await user.type(screen.getByLabelText('CAP *'), '00100');
    await user.click(screen.getByRole('button', { name: 'Crea sede' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ province: 'RM', country: 'IT', phone: null, email: null }),
    );
  });

  it('shows a validation error for a malformed CAP', async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(screen.getByLabelText('Nome *'), 'X');
    await user.type(screen.getByLabelText('Indirizzo *'), 'Via 1');
    await user.type(screen.getByLabelText('Città *'), 'Roma');
    await user.type(screen.getByLabelText('Provincia *'), 'RM');
    await user.type(screen.getByLabelText('CAP *'), '123');
    await user.click(screen.getByRole('button', { name: 'Crea sede' }));

    expect(await screen.findByText('CAP: 5 cifre')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('prefills fields in edit mode and PATCHes', async () => {
    const user = userEvent.setup();
    renderDialog({
      id: 'loc-1',
      name: 'Sede Milano',
      addressLine: 'Via Milano 1',
      city: 'Milano',
      province: 'MI',
      postalCode: '20100',
      country: 'IT',
      phone: null,
      email: null,
      isPrimary: false,
    });

    expect(screen.getByLabelText('Nome *')).toHaveValue('Sede Milano');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'loc-1', body: expect.objectContaining({ city: 'Milano' }) }),
    );
  });
});
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @garageos/web test -- LocationFormDialog` → Expected: 3 PASS.
Run: `pnpm --filter @garageos/web typecheck` → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/locations/LocationFormDialog.tsx packages/web/src/components/locations/LocationFormDialog.test.tsx
git commit -m "feat(web): location create/edit dialog (F-OFF-003 PR2)"
```

---

## Task 4: LocationManagement page (list + actions)

**Files:**
- Create: `packages/web/src/pages/LocationManagement.tsx`
- Create: `packages/web/src/pages/LocationManagement.test.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { LocationFormDialog } from '@/components/locations/LocationFormDialog';
import {
  useLocations,
  useUpdateLocation,
  useDeleteLocation,
  type TenantLocation,
} from '@/queries/locations';

export function LocationManagement() {
  const locationsQ = useLocations();
  const updateMut = useUpdateLocation();
  const deleteMut = useDeleteLocation();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TenantLocation | null>(null);
  const [toDeactivate, setToDeactivate] = useState<TenantLocation | null>(null);

  if (locationsQ.isPending) return <div>Caricamento...</div>;
  if (locationsQ.isError) return <div className="text-red-600">Errore caricamento sedi.</div>;

  const locations = locationsQ.data?.locations ?? [];

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(loc: TenantLocation) {
    setEditing(loc);
    setFormOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Sedi</h2>
        <Button onClick={openCreate}>Aggiungi sede</Button>
      </div>

      {!locations.length ? (
        <p className="text-muted-foreground">Nessuna sede.</p>
      ) : (
        <ul className="divide-y border rounded">
          {locations.map((loc) => (
            <li
              key={loc.id}
              className="p-3 flex justify-between items-center"
              data-testid={`location-row-${loc.id}`}
            >
              <div>
                <div className="font-medium">
                  {loc.name}
                  {loc.isPrimary && (
                    <span className="ml-2 inline-block text-xs font-normal text-muted-foreground border border-muted-foreground/30 rounded px-1.5 py-0.5">
                      Primaria
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">
                  {loc.addressLine}, {loc.postalCode} {loc.city} ({loc.province})
                </div>
              </div>
              <div className="flex gap-2">
                {!loc.isPrimary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={updateMut.isPending}
                    onClick={() => updateMut.mutate({ id: loc.id, body: { isPrimary: true } })}
                    data-testid={`set-primary-${loc.id}`}
                  >
                    Imposta primaria
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => openEdit(loc)}>
                  Modifica
                </Button>
                {!loc.isPrimary && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setToDeactivate(loc)}
                    data-testid={`deactivate-${loc.id}`}
                  >
                    Disattiva
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <LocationFormDialog
        location={editing}
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
      />

      <AlertDialog
        open={toDeactivate !== null}
        onOpenChange={(o) => {
          if (!o) setToDeactivate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disattivare la sede?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDeactivate?.name} verrà disattivata. Gli interventi storici restano consultabili.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toDeactivate) deleteMut.mutate(toDeactivate.id);
                setToDeactivate(null);
              }}
            >
              Disattiva
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 2: Write the test**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { LocationManagement } from './LocationManagement';

const update = vi.fn();
const del = vi.fn();
const locations = [
  {
    id: 'p1', name: 'Sede Milano', addressLine: 'Via Milano 1', city: 'Milano',
    province: 'MI', postalCode: '20100', country: 'IT', phone: null, email: null, isPrimary: true,
  },
  {
    id: 's2', name: 'Sede Roma', addressLine: 'Via Roma 2', city: 'Roma',
    province: 'RM', postalCode: '00100', country: 'IT', phone: null, email: null, isPrimary: false,
  },
];

vi.mock('@/queries/locations', async () => {
  const actual = await vi.importActual<object>('@/queries/locations');
  return {
    ...actual,
    useLocations: () => ({ isPending: false, isError: false, data: { locations } }),
    useUpdateLocation: () => ({ mutate: update, isPending: false }),
    useDeleteLocation: () => ({ mutate: del, isPending: false }),
  };
});

// LocationFormDialog is exercised in its own test; stub it here to keep this
// page test about the list + actions only.
vi.mock('@/components/locations/LocationFormDialog', () => ({
  LocationFormDialog: () => null,
}));

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LocationManagement />
    </QueryClientProvider>,
  );
}

describe('LocationManagement', () => {
  beforeEach(() => {
    update.mockReset();
    del.mockReset();
  });

  it('lists locations with a Primaria badge and hides destructive actions on the primary', () => {
    renderPage();
    expect(screen.getByText('Sede Milano')).toBeInTheDocument();
    expect(screen.getByText('Primaria')).toBeInTheDocument();
    // Primary has no set-primary / deactivate; secondary does.
    expect(screen.queryByTestId('set-primary-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deactivate-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('set-primary-s2')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-s2')).toBeInTheDocument();
  });

  it('promotes a secondary location to primary', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('set-primary-s2'));
    expect(update).toHaveBeenCalledWith({ id: 's2', body: { isPrimary: true } });
  });

  it('deactivates a secondary location after confirming', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('deactivate-s2'));
    // AlertDialog confirm
    await user.click(await screen.findByRole('button', { name: 'Disattiva' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('s2'));
  });
});
```

> Note: the destructive row button label is "Disattiva" and the AlertDialog confirm action is also "Disattiva". The confirm test clicks the one rendered inside the dialog (appears after opening). If the role-query ambiguity bites in jsdom, scope with `within(screen.getByRole('alertdialog'))`.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @garageos/web test -- LocationManagement` → Expected: 3 PASS.
Run: `pnpm --filter @garageos/web typecheck` → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/LocationManagement.tsx packages/web/src/pages/LocationManagement.test.tsx
git commit -m "feat(web): location management page with list and actions (F-OFF-003 PR2)"
```

---

## Task 5: Wire into Settings tab + route

**Files:**
- Modify: `packages/web/src/pages/Settings.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/pages/Settings.test.tsx`

- [ ] **Step 1: Add the route in App.tsx**

After the `/settings/users` route (App.tsx:53), add:

```tsx
                  <Route path="/settings/locations" element={<Settings />} />
```

- [ ] **Step 2: Update Settings.tsx tab plumbing**

Add the import:

```tsx
import { LocationManagement } from '@/pages/LocationManagement';
```

Extend the `TabId` type:

```ts
type TabId = 'profile' | 'security' | 'tenant' | 'users' | 'locations';
```

Update `pathnameToTab`:

```ts
function pathnameToTab(pathname: string): TabId {
  if (pathname === '/settings/users') return 'users';
  if (pathname === '/settings/locations') return 'locations';
  return 'profile';
}
```

Update `tabToPath`:

```ts
  function tabToPath(tab: TabId): string {
    if (tab === 'users') return '/settings/users';
    if (tab === 'locations') return '/settings/locations';
    return '/settings';
  }
```

Add the trigger after the "users" trigger (line 101):

```tsx
          {isSuperAdmin && <TabsTrigger value="locations">Sedi</TabsTrigger>}
```

Add the content after the "users" TabsContent (after line 146):

```tsx
        {isSuperAdmin && (
          <TabsContent value="locations" className="mt-6">
            <LocationManagement />
          </TabsContent>
        )}
```

- [ ] **Step 3: Update Settings.test.tsx**

Add a test asserting the Sedi tab is present for super_admin. Mirror the existing super_admin tab assertions in that file (find the test that checks the "Utenti" tab/trigger and add an analogous check for "Sedi"). Mock `@/pages/LocationManagement` with `vi.mock('@/pages/LocationManagement', () => ({ LocationManagement: () => <div>Sedi mock</div> }))` if the file mocks heavy children (mirror however Settings.test already isolates `UserManagement`). If it doesn't mock UserManagement, no new mock is needed — just assert `screen.getByRole('tab', { name: 'Sedi' })` renders.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @garageos/web test -- Settings` → Expected: PASS.
Run: `pnpm --filter @garageos/web typecheck` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/Settings.tsx packages/web/src/App.tsx packages/web/src/pages/Settings.test.tsx
git commit -m "feat(web): add Sedi tab to Settings (F-OFF-003 PR2)"
```

---

## Task 6: Push, PR & watch CI

- [ ] **Step 1: Full local web suite + typecheck**

Run: `pnpm -r typecheck` → Expected: PASS.
Run: `pnpm --filter @garageos/web test` → Expected: all green.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/location-crud-web
gh pr create --title "feat(web): location management UI (F-OFF-003 PR2)" --body "<fill from CLAUDE.md template: What (Sedi tab CRUD), Why F-OFF-003 + unblocks F-OFF-503, Implementation notes (extended GET select, new queries/locations.ts, mirror UserManagement/EditUserDialog), Tests checklist>"
```

- [ ] **Step 3: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on red.

---

## Self-Review (completed by plan author)

**Spec coverage (design §Web):**
- Settings → Sedi page with list (name, città, badge Primaria, indirizzo) → Task 4. ✓
- Create + edit dialog → Task 3. ✓
- "Imposta come primaria" (PATCH isPrimary:true) + "Disattiva" (DELETE) row actions → Task 4. ✓
- Single-location usable but sober: primary row shows no set-primary/deactivate; "Aggiungi sede" always available → Task 4. ✓
- Error mapping IT for the 422 guards → Task 2 Step 4. ✓
- Risk #3 (GET select only id/name/city/isPrimary) → resolved in Task 1 (extend select) + Task 2 Step 1 (extend type). ✓

**Placeholder scan:** Every code step has full code. Task 5 Step 3 (Settings.test) describes the assertion concretely and defers the exact mock to "mirror the existing file" — acceptable because it depends on whether Settings.test already isolates UserManagement; the executor reads the file. Task 1 Step 3 (APPENDICE_A) is a doc edit described precisely (extend the JSON example).

**Type consistency:** `TenantLocation` (extended, used in queries/locations.ts re-export, LocationFormDialog, LocationManagement), `LocationWriteBody`/`UpdateLocationBody`, `locationFormSchema`/`LocationFormValues`/`LocationFormParsed`, hook names `useCreateLocation`/`useUpdateLocation`/`useDeleteLocation`, queryKey `['tenant-locations']`, and the `{ location }` response wrapper all match across tasks and align with PR1's API shapes.

**Risks / confirm during execution:**
- `@/components/ui/input` exists (Task 3 note). It's used by ProfileForm/TenantForm — almost certainly present; verify import name.
- Settings.test existing structure (Task 5) — read before editing to mirror its mocking style.
- The "Disattiva" label collision between the row button and the AlertDialog confirm (Task 4 test note) — scope with `within(getByRole('alertdialog'))` if needed.

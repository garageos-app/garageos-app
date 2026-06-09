# F-OFF-102 — Form web "Censimento nuovo veicolo" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing web-officina UI to register a new vehicle (with inline new-or-existing customer) by calling the already-shipped `POST /v1/vehicles`.

**Architecture:** A standalone page-form at `/vehicles/new` (pattern: `InterventionCreate`) using `react-hook-form` + `zodResolver` on a web-local mirror of the backend `CreateVehicleSchema`. One atomic `POST /v1/vehicles` creates vehicle + GO-code + ownership + customer-tenant relation. Three entry points reach the same form (sidebar global, customer-detail card, search empty-state). No API changes.

**Tech Stack:** React + Vite + TypeScript, react-hook-form, zod, @tanstack/react-query, shadcn/ui, sonner, react-router-dom, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-09-F-OFF-102-vehicle-create-web-design.md`

**Planning refinement vs spec:** the spec said "use `queries/locations.ts`" for the location picker. That endpoint is **super_admin-gated** (`GET /v1/tenants/me/locations`); a mechanic would 403. The plan resolves location role-correctly: super_admin via `useLocationFilter()` (already wraps `useLocations` with `enabled: isSuperAdmin`), mechanic via `useProfileMe().locationId`. Same behavior the spec intended ("pick the right location"), role-correct mechanism.

---

## File Structure

**Create:**
- `packages/web/src/lib/validators/createVehicle.ts` — web-local mirror of backend payload schema + RHF form schema + `transformToPayload`. One responsibility: vehicle-create validation & form↔payload mapping.
- `packages/web/src/lib/validators/createVehicle.parity.test.ts` — parity vs backend `CreateVehicleSchema`.
- `packages/web/src/lib/validators/createVehicle.test.ts` — unit tests for `transformToPayload`.
- `packages/web/src/queries/vehicleCreate.ts` — `useCreateVehicle()` mutation hook + response type.
- `packages/web/src/queries/vehicleCreate.test.tsx` — mutation hook test.
- `packages/web/src/pages/VehicleCreate.tsx` — the page (data/location/error orchestration + form).
- `packages/web/src/pages/VehicleCreate.test.tsx` — page behavior tests.

**Modify:**
- `packages/web/src/lib/error-messages.ts` — add `vehicle.creation.*` IT strings.
- `packages/web/src/App.tsx` — register `/vehicles/new` before `/vehicles/:id`.
- `packages/web/src/components/layout/Sidebar.tsx` — primary "+ Nuovo veicolo" CTA.
- `packages/web/src/pages/CustomerDetail.tsx` — "+ Aggiungi veicolo" CTA on the Veicoli card.
- `packages/web/src/pages/SearchResults.tsx` — "+ Censisci questo veicolo" CTA in the empty-state.

**Test command (local debugging):** `pnpm --filter @garageos/web exec vitest run <path>` (uses `vitest run`, avoids the `pnpm -- ` v9/v10 forwarding gotcha). Typecheck: `pnpm -r typecheck`.

---

## Task 1: Web-local mirror payload schema + parity test

**Files:**
- Create: `packages/web/src/lib/validators/createVehicle.ts`
- Test: `packages/web/src/lib/validators/createVehicle.parity.test.ts`

- [ ] **Step 1: Write the failing parity test**

Create `packages/web/src/lib/validators/createVehicle.parity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { CreateVehiclePayloadSchema } from './createVehicle';

// Backend authoritative schema imported via deep relative path. Dev-time
// only (test file). We deliberately do NOT add @garageos/database as a web
// runtime dep to keep Prisma client out of the Vite bundle. The cross-package
// import sits outside tsconfig.app.json's file list (surfaces as TS6307 under
// tsc -b); Vitest resolves it at test time. Mirror of the parts-replaced
// parity pattern.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS6307 cross-package dev-time-only import
import { CreateVehicleSchema as BackendCreateVehicleSchema } from '../../../../database/src/validators/vehicle';

// Canonical valid payload: non-business new customer, standard 17-char VIN.
const canonical = {
  vehicle: {
    vin: '1HGCM82633A004352',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    year: 2020,
    vehicleType: 'car',
    fuelType: 'petrol',
    odometerKm: 45000,
  },
  customer: {
    mode: 'create_new',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario@example.it',
    isBusiness: false,
  },
  locationId: '11111111-1111-4111-8111-111111111111',
};

describe('CreateVehiclePayloadSchema parity (web mirror vs backend)', () => {
  it('both accept the canonical payload and produce the same top-level keys', () => {
    const web = CreateVehiclePayloadSchema.safeParse(canonical);
    const backend = BackendCreateVehicleSchema.safeParse(canonical);
    expect(web.success).toBe(true);
    expect(backend.success).toBe(true);
    if (web.success && backend.success) {
      expect(Object.keys(web.data).sort()).toEqual(Object.keys(backend.data).sort());
    }
  });

  it('both reject a payload missing the required odometerKm (drift detection)', () => {
    const noKm = { ...canonical, vehicle: { ...canonical.vehicle } } as Record<string, unknown>;
    delete (noKm.vehicle as Record<string, unknown>).odometerKm;
    expect(CreateVehiclePayloadSchema.safeParse(noKm).success).toBe(false);
    expect(BackendCreateVehicleSchema.safeParse(noKm).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/validators/createVehicle.parity.test.ts`
Expected: FAIL — cannot resolve `./createVehicle` (module does not exist yet).

- [ ] **Step 3: Create the mirror schema**

Create `packages/web/src/lib/validators/createVehicle.ts`:

```ts
import { z } from 'zod';

// Web-local mirror of the backend authoritative CreateVehicleSchema
// (packages/database/src/validators/vehicle.ts). Kept web-local to keep
// @prisma/client out of the Vite bundle; createVehicle.parity.test.ts
// asserts it stays in sync with the backend at test time.
//
// NOTE: backend layers an API-only `force` flag onto this schema at the
// route boundary (vehicles.ts) — it is NOT part of this payload shape. The
// mutation hook (vehicleCreate.ts) adds `force` to the request body.

export const VehicleTypeEnum = z.enum(['car', 'motorcycle', 'van', 'truck', 'agricultural']);
export const FuelTypeEnum = z.enum([
  'petrol',
  'diesel',
  'electric',
  'hybrid',
  'lpg',
  'methane',
  'hydrogen',
  'other',
]);
export type VehicleType = z.infer<typeof VehicleTypeEnum>;
export type FuelType = z.infer<typeof FuelTypeEnum>;

const CURRENT_YEAR = new Date().getUTCFullYear();

export const CreateVehiclePayloadSchema = z.object({
  vehicle: z.object({
    vin: z.string().length(17),
    plate: z.string().min(1).max(10),
    plateCountry: z.string().length(2).default('IT'),
    make: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    version: z.string().max(150).optional(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(CURRENT_YEAR + 1),
    registrationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    engineDisplacement: z.number().int().positive().optional(),
    powerKw: z.number().int().positive().optional(),
    color: z.string().max(50).optional(),
    odometerKm: z.number().int().min(0),
  }),
  customer: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), customerId: z.string().uuid() }),
    z
      .object({
        mode: z.literal('create_new'),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email(),
        phone: z.string().max(30).optional(),
        taxCode: z.string().max(20).optional(),
        isBusiness: z.boolean().default(false),
        businessName: z.string().max(200).optional(),
        vatNumber: z.string().max(20).optional(),
      })
      .refine((d) => !d.isBusiness || (d.businessName && d.vatNumber), {
        message: 'businessName e vatNumber obbligatori per clienti aziendali',
      }),
  ]),
  locationId: z.string().uuid(),
  sendInvitationEmail: z.boolean().default(true),
  forceNonstandardVin: z.boolean().default(false),
});

export type CreateVehiclePayload = z.infer<typeof CreateVehiclePayloadSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/validators/createVehicle.parity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/validators/createVehicle.ts packages/web/src/lib/validators/createVehicle.parity.test.ts
git commit -m "feat(web): add vehicle-create payload schema with backend parity test"
```

---

## Task 2: Form schema + transformToPayload

**Files:**
- Modify: `packages/web/src/lib/validators/createVehicle.ts`
- Test: `packages/web/src/lib/validators/createVehicle.test.ts`

The form keeps numeric fields as **strings** (RHF `<input>` values) and converts in `transformToPayload`, avoiding `z.coerce.number()` footguns (empty string → 0). `sendInvitationEmail` is hard-coded `false` (invito differito; the UI toggle is disabled). `forceNonstandardVin`/`force` are added later by the page on retry, not here.

- [ ] **Step 1: Write the failing transform test**

Create `packages/web/src/lib/validators/createVehicle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  CreateVehiclePayloadSchema,
  transformToPayload,
  type VehicleFormValues,
} from './createVehicle';

const base: VehicleFormValues = {
  customerMode: 'create_new',
  customerId: '',
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@example.it',
  phone: '',
  taxCode: '',
  isBusiness: false,
  businessName: '',
  vatNumber: '',
  vin: '1hgcm82633a004352',
  plate: 'ab123cd',
  plateCountry: 'it',
  make: 'Fiat',
  model: 'Panda',
  version: '',
  year: '2020',
  registrationDate: '',
  vehicleType: 'car',
  fuelType: 'petrol',
  engineDisplacement: '',
  powerKw: '',
  color: '',
  odometerKm: '45000',
  locationId: '11111111-1111-4111-8111-111111111111',
};

describe('transformToPayload', () => {
  it('produces a payload accepted by CreateVehiclePayloadSchema and uppercases vin/plate/country', () => {
    const payload = transformToPayload(base);
    expect(payload.vehicle.vin).toBe('1HGCM82633A004352');
    expect(payload.vehicle.plate).toBe('AB123CD');
    expect(payload.vehicle.plateCountry).toBe('IT');
    expect(payload.vehicle.year).toBe(2020);
    expect(payload.vehicle.odometerKm).toBe(45000);
    expect(payload.sendInvitationEmail).toBe(false);
    expect(payload.forceNonstandardVin).toBe(false);
    expect(CreateVehiclePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('drops empty optional fields instead of sending empty strings', () => {
    const payload = transformToPayload(base);
    expect('version' in payload.vehicle).toBe(false);
    expect('color' in payload.vehicle).toBe(false);
    expect('engineDisplacement' in payload.vehicle).toBe(false);
    expect('powerKw' in payload.vehicle).toBe(false);
    expect('registrationDate' in payload.vehicle).toBe(false);
  });

  it('converts present optional numbers and keeps provided optionals', () => {
    const payload = transformToPayload({
      ...base,
      version: '1.2 Easy',
      engineDisplacement: '1242',
      powerKw: '51',
      color: 'Rosso',
      registrationDate: '2020-03-15',
    });
    expect(payload.vehicle.engineDisplacement).toBe(1242);
    expect(payload.vehicle.powerKw).toBe(51);
    expect(payload.vehicle.version).toBe('1.2 Easy');
    expect(payload.vehicle.registrationDate).toBe('2020-03-15');
  });

  it('emits an existing-customer discriminator when mode=existing', () => {
    const payload = transformToPayload({
      ...base,
      customerMode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
    expect(payload.customer).toEqual({
      mode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('includes businessName/vatNumber only for business customers', () => {
    const consumer = transformToPayload(base);
    expect('businessName' in consumer.customer).toBe(false);

    const business = transformToPayload({
      ...base,
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: 'IT01234567890',
    });
    expect(business.customer).toMatchObject({
      mode: 'create_new',
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: 'IT01234567890',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/validators/createVehicle.test.ts`
Expected: FAIL — `transformToPayload` / `VehicleFormValues` not exported.

- [ ] **Step 3: Add the form schema + transform**

Append to `packages/web/src/lib/validators/createVehicle.ts`:

```ts
const yearRe = /^\d{4}$/;
const intRe = /^\d+$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// RHF form schema. Numeric inputs are validated as strings here and converted
// in transformToPayload (avoids z.coerce.number() turning "" into 0).
export const VehicleFormSchema = z
  .object({
    customerMode: z.enum(['existing', 'create_new']),
    customerId: z.string().optional(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    email: z.string().max(255).optional(),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    isBusiness: z.boolean(),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
    vin: z.string().trim().length(17, 'Il VIN deve avere 17 caratteri'),
    plate: z.string().trim().min(1, 'Targa obbligatoria').max(10),
    plateCountry: z.string().trim().length(2, 'Codice paese a 2 lettere'),
    make: z.string().trim().min(1, 'Marca obbligatoria').max(50),
    model: z.string().trim().min(1, 'Modello obbligatorio').max(100),
    version: z.string().max(150).optional(),
    year: z.string().regex(yearRe, 'Anno non valido (AAAA)'),
    registrationDate: z.string().optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    engineDisplacement: z.string().optional(),
    powerKw: z.string().optional(),
    color: z.string().max(50).optional(),
    odometerKm: z.string().regex(intRe, 'Km non validi'),
    locationId: z.string().min(1, 'Sede obbligatoria'),
  })
  .superRefine((d, ctx) => {
    if (d.customerMode === 'existing') {
      if (!d.customerId) {
        ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Seleziona un cliente' });
      }
    } else {
      if (!d.firstName?.trim())
        ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Nome obbligatorio' });
      if (!d.lastName?.trim())
        ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Cognome obbligatorio' });
      if (!d.email?.trim())
        ctx.addIssue({ code: 'custom', path: ['email'], message: 'Email obbligatoria' });
      if (d.isBusiness && !d.businessName?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['businessName'],
          message: 'Ragione sociale obbligatoria',
        });
      if (d.isBusiness && !d.vatNumber?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['vatNumber'],
          message: 'P.IVA obbligatoria per aziende',
        });
    }
    if (d.registrationDate && !dateRe.test(d.registrationDate)) {
      ctx.addIssue({ code: 'custom', path: ['registrationDate'], message: 'Data non valida' });
    }
    if (d.engineDisplacement && !intRe.test(d.engineDisplacement)) {
      ctx.addIssue({ code: 'custom', path: ['engineDisplacement'], message: 'Cilindrata non valida' });
    }
    if (d.powerKw && !intRe.test(d.powerKw)) {
      ctx.addIssue({ code: 'custom', path: ['powerKw'], message: 'Potenza non valida' });
    }
  });

export type VehicleFormValues = z.infer<typeof VehicleFormSchema>;

export function transformToPayload(v: VehicleFormValues): CreateVehiclePayload {
  const opt = (s?: string) => {
    const t = s?.trim();
    return t ? t : undefined;
  };
  const optInt = (s?: string) => {
    const t = s?.trim();
    return t ? Number(t) : undefined;
  };

  const ed = optInt(v.engineDisplacement);
  const pk = optInt(v.powerKw);

  const customer: CreateVehiclePayload['customer'] =
    v.customerMode === 'existing'
      ? { mode: 'existing', customerId: v.customerId ?? '' }
      : {
          mode: 'create_new',
          firstName: (v.firstName ?? '').trim(),
          lastName: (v.lastName ?? '').trim(),
          email: (v.email ?? '').trim(),
          isBusiness: v.isBusiness,
          ...(opt(v.phone) ? { phone: opt(v.phone) } : {}),
          ...(opt(v.taxCode) ? { taxCode: opt(v.taxCode) } : {}),
          ...(v.isBusiness && opt(v.businessName) ? { businessName: opt(v.businessName) } : {}),
          ...(v.isBusiness && opt(v.vatNumber) ? { vatNumber: opt(v.vatNumber) } : {}),
        };

  return {
    vehicle: {
      vin: v.vin.trim().toUpperCase(),
      plate: v.plate.trim().toUpperCase(),
      plateCountry: v.plateCountry.trim().toUpperCase(),
      make: v.make.trim(),
      model: v.model.trim(),
      year: Number(v.year),
      vehicleType: v.vehicleType,
      fuelType: v.fuelType,
      odometerKm: Number(v.odometerKm),
      ...(opt(v.version) ? { version: opt(v.version) } : {}),
      ...(opt(v.registrationDate) ? { registrationDate: opt(v.registrationDate) } : {}),
      ...(ed !== undefined ? { engineDisplacement: ed } : {}),
      ...(pk !== undefined ? { powerKw: pk } : {}),
      ...(opt(v.color) ? { color: opt(v.color) } : {}),
    },
    customer,
    locationId: v.locationId,
    sendInvitationEmail: false, // invito app differito (SES sandbox); toggle UI disabilitato
    forceNonstandardVin: false,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/validators/createVehicle.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/validators/createVehicle.ts packages/web/src/lib/validators/createVehicle.test.ts
git commit -m "feat(web): add vehicle-create form schema and payload transform"
```

---

## Task 3: Mutation hook + response type

**Files:**
- Create: `packages/web/src/queries/vehicleCreate.ts`
- Test: `packages/web/src/queries/vehicleCreate.test.tsx`

The hook is intentionally **side-effect-free** (no onSuccess navigation/toast): the page must branch on `garageCode` for the success toast, drive the duplicate/checksum dialogs, and re-submit with `force`/`forceNonstandardVin`. The body type extends the payload with the API-only `force` flag.

- [ ] **Step 1: Write the failing hook test**

Create `packages/web/src/queries/vehicleCreate.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCreateVehicle } from './vehicleCreate';
import type { CreateVehiclePayload } from '@/lib/validators/createVehicle';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => mockApiFetch };
});

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const payload: CreateVehiclePayload = {
  vehicle: {
    vin: '1HGCM82633A004352',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    year: 2020,
    vehicleType: 'car',
    fuelType: 'petrol',
    odometerKm: 45000,
  },
  customer: { mode: 'create_new', firstName: 'Mario', lastName: 'Rossi', email: 'm@e.it', isBusiness: false },
  locationId: '11111111-1111-4111-8111-111111111111',
  sendInvitationEmail: false,
  forceNonstandardVin: false,
};

describe('useCreateVehicle', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('POSTs the payload to /v1/vehicles and returns the response', async () => {
    mockApiFetch.mockResolvedValueOnce({ vehicle: { id: 'v1', garageCode: 'GO-AB12CD' } });
    const { result } = renderHook(() => useCreateVehicle(), { wrapper: wrap });
    const res = await result.current.mutateAsync(payload);
    expect(res.vehicle.garageCode).toBe('GO-AB12CD');
    expect(mockApiFetch).toHaveBeenCalledWith('/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  });

  it('forwards the force flag when present', async () => {
    mockApiFetch.mockResolvedValueOnce({ vehicle: { id: 'v2', garageCode: 'GO-XX99YY' } });
    const { result } = renderHook(() => useCreateVehicle(), { wrapper: wrap });
    await result.current.mutateAsync({ ...payload, force: true });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const sentBody = JSON.parse(mockApiFetch.mock.calls[0][1].body);
    expect(sentBody.force).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/queries/vehicleCreate.test.tsx`
Expected: FAIL — `./vehicleCreate` does not exist.

- [ ] **Step 3: Implement the hook**

Create `packages/web/src/queries/vehicleCreate.ts`:

```ts
import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';
import type { CreateVehiclePayload } from '@/lib/validators/createVehicle';

// API-only override: confirms a BR-002 duplicate-plate warning.
export type CreateVehicleBody = CreateVehiclePayload & { force?: boolean };

export interface CreateVehicleResponse {
  vehicle: {
    id: string;
    garageCode: string;
    vin: string;
    plate: string;
    make: string;
    model: string;
    year: number;
    status: string;
  };
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    appInstalled: boolean;
    status: string;
  };
  ownership: { id: string; vehicleId: string; customerId: string; startedAt: string };
  invitation: { id: string; target_email: string; expires_at: string; sent: boolean } | null;
}

/**
 * POST /v1/vehicles (F-OFF-102/103). Side-effect-free: the page owns the
 * success toast (needs garageCode), the duplicate/checksum confirm dialogs,
 * and force/forceNonstandardVin retries.
 */
export function useCreateVehicle() {
  const apiFetch = useApiFetch();
  return useMutation<CreateVehicleResponse, ApiError, CreateVehicleBody>({
    mutationFn: (body) =>
      apiFetch<CreateVehicleResponse>('/v1/vehicles', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/queries/vehicleCreate.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/vehicleCreate.ts packages/web/src/queries/vehicleCreate.test.tsx
git commit -m "feat(web): add useCreateVehicle mutation hook"
```

---

## Task 4: Error-message strings

**Files:**
- Modify: `packages/web/src/lib/error-messages.ts`
- Test: `packages/web/src/lib/error-messages.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/error-messages.test.ts` (if it already exists, append the `describe` block):

```ts
import { describe, expect, it } from 'vitest';

import { translateError } from './error-messages';

describe('vehicle.creation error strings', () => {
  it('maps duplicate VIN to an Italian message', () => {
    expect(translateError('vehicle.creation.duplicate_vin', 'x')).toMatch(/VIN/i);
  });
  it('maps location_not_in_tenant to an Italian message', () => {
    expect(translateError('vehicle.creation.location_not_in_tenant', 'x')).toMatch(/sede/i);
  });
  it('falls back for unknown codes', () => {
    expect(translateError('vehicle.creation.unknown', 'fallback')).toBe('fallback');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/error-messages.test.ts`
Expected: FAIL — duplicate_vin maps to fallback `'x'`, not a VIN message.

- [ ] **Step 3: Add the messages**

In `packages/web/src/lib/error-messages.ts`, add these keys to the `ERROR_MESSAGES` object (e.g. after the `vehicle.modification.archived` line):

```ts
  'vehicle.creation.duplicate_vin': 'Esiste già un veicolo con questo VIN.',
  'vehicle.creation.duplicate_plate_warning': 'Esiste già un veicolo con questa targa.',
  'vehicle.creation.invalid_vin_checksum':
    'Il VIN non rispetta il checksum standard. Conferma se è un veicolo storico o agricolo.',
  'vehicle.creation.location_not_in_tenant': 'La sede selezionata non è valida.',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/web exec vitest run src/lib/error-messages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/error-messages.ts packages/web/src/lib/error-messages.test.ts
git commit -m "feat(web): add vehicle-creation error messages"
```

---

## Task 5: VehicleCreate page + route

**Files:**
- Create: `packages/web/src/pages/VehicleCreate.tsx`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/pages/VehicleCreate.test.tsx`

The page is split into an outer `VehicleCreate` (resolves profile + role-based location + URL context, gates on loading) and an inner `VehicleCreateForm` (owns `useForm` with concrete defaults). Location resolution:
- **mechanic** (`!isSuperAdmin`): `locationId = profile.locationId`; if `null`, render a blocking Alert (mirror of `intervention.creation.user_no_location`); otherwise no picker, show a read-only note.
- **super_admin**: options = `locations` from `useLocationFilter()`; default = `selectedLocationId ?? (locations.length === 1 ? locations[0].id : '')`; render a Select when `locations.length > 1`.

`vehicleType`/`fuelType` default to `car`/`petrol` so a valid submit needs no Select interaction. The invitation toggle is rendered disabled.

- [ ] **Step 1: Write the failing page test**

Create `packages/web/src/pages/VehicleCreate.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { VehicleCreate } from './VehicleCreate';
import { ApiError } from '@/lib/api-client';

const { mockMutateAsync, mockToastSuccess, mockToastError, mockNavigate, profileRef, filterRef } =
  vi.hoisted(() => ({
    mockMutateAsync: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockNavigate: vi.fn(),
    profileRef: { current: { data: undefined as unknown, isPending: false, isError: false } },
    filterRef: { current: { isSuperAdmin: false, locations: [] as unknown[], selectedLocationId: null as string | null } },
  }));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/queries/vehicleCreate', () => ({
  useCreateVehicle: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
vi.mock('@/queries/profileMe', () => ({ useProfileMe: () => profileRef.current }));
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));
// Stub the autocomplete: expose a button that selects a fixed customer.
vi.mock('@/components/CustomerAutocomplete', () => ({
  CustomerAutocomplete: ({ onSelect }: { onSelect: (c: { id: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: '22222222-2222-4222-8222-222222222222' })}>
      pick-customer
    </button>
  ),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/vehicles/new" element={<VehicleCreate />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: wrap },
  );
}

const MECHANIC = { role: 'mechanic', locationId: '11111111-1111-4111-8111-111111111111' };

async function fillVehicle() {
  await userEvent.type(screen.getByLabelText(/VIN/i), '1HGCM82633A004352');
  await userEvent.type(screen.getByLabelText(/Targa/i), 'AB123CD');
  await userEvent.type(screen.getByLabelText(/Marca/i), 'Fiat');
  await userEvent.type(screen.getByLabelText(/Modello/i), 'Panda');
  await userEvent.type(screen.getByLabelText(/^Anno/i), '2020');
  await userEvent.type(screen.getByLabelText(/Km attuali/i), '45000');
}
async function fillNewCustomer() {
  await userEvent.type(screen.getByLabelText('Nome'), 'Mario');
  await userEvent.type(screen.getByLabelText('Cognome'), 'Rossi');
  await userEvent.type(screen.getByLabelText('Email'), 'mario@example.it');
}

describe('VehicleCreate', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockNavigate.mockReset();
    profileRef.current = { data: MECHANIC, isPending: false, isError: false };
    filterRef.current = { isSuperAdmin: false, locations: [], selectedLocationId: null };
  });

  it('blocks a mechanic with no assigned location', () => {
    profileRef.current = { data: { role: 'mechanic', locationId: null }, isPending: false, isError: false };
    renderAt('/vehicles/new');
    expect(screen.getByText(/non sei associato a una sede/i)).toBeInTheDocument();
  });

  it('shows validation errors and does not submit an empty form', async () => {
    renderAt('/vehicles/new');
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText('Nome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Il VIN deve avere 17 caratteri')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits new customer + vehicle, toasts the GO-code and redirects', async () => {
    mockMutateAsync.mockResolvedValueOnce({ vehicle: { id: 'v1', garageCode: 'GO-AB12CD' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const body = mockMutateAsync.mock.calls[0][0];
    expect(body.vehicle.vin).toBe('1HGCM82633A004352');
    expect(body.customer).toMatchObject({ mode: 'create_new', firstName: 'Mario' });
    expect(body.locationId).toBe(MECHANIC.locationId);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/vehicles/v1'));
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('GO-AB12CD'));
  });

  it('locks to an existing customer when customerId is in the URL', async () => {
    mockMutateAsync.mockResolvedValueOnce({ vehicle: { id: 'v9', garageCode: 'GO-ZZ00ZZ' } });
    renderAt('/vehicles/new?customerId=22222222-2222-4222-8222-222222222222');
    expect(screen.queryByLabelText('Nome')).not.toBeInTheDocument();
    expect(screen.getByText(/cliente selezionato/i)).toBeInTheDocument();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].customer).toEqual({
      mode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('prefills the plate from the URL', () => {
    renderAt('/vehicles/new?plate=AB123CD');
    expect(screen.getByLabelText(/Targa/i)).toHaveValue('AB123CD');
  });

  it('opens the duplicate-plate dialog and re-submits with force on confirm', async () => {
    mockMutateAsync
      .mockRejectedValueOnce(
        new ApiError('vehicle.creation.duplicate_plate_warning', 409, 'targa duplicata'),
      )
      .mockResolvedValueOnce({ vehicle: { id: 'v2', garageCode: 'GO-DUP000' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText(/esiste già un veicolo con questa targa/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /censisci comunque/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockMutateAsync.mock.calls[1][0].force).toBe(true);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/vehicles/v2'));
  });

  it('navigates to search when "Apri veicolo esistente" is chosen', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError('vehicle.creation.duplicate_plate_warning', 409, 'targa duplicata'),
    );
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await userEvent.click(await screen.findByRole('button', { name: /apri veicolo esistente/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/search?q=AB123CD');
  });

  it('opens the VIN-checksum dialog and re-submits with forceNonstandardVin', async () => {
    mockMutateAsync
      .mockRejectedValueOnce(
        new ApiError('vehicle.creation.invalid_vin_checksum', 400, 'checksum'),
      )
      .mockResolvedValueOnce({ vehicle: { id: 'v3', garageCode: 'GO-VIN000' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText(/veicolo storico o agricolo/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /conferma/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockMutateAsync.mock.calls[1][0].forceNonstandardVin).toBe(true);
  });

  it('toasts a hard error on duplicate VIN (no override)', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError('vehicle.creation.duplicate_vin', 409, 'vin dup'),
    );
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Esiste già un veicolo con questo VIN.'),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/web exec vitest run src/pages/VehicleCreate.test.tsx`
Expected: FAIL — `./VehicleCreate` does not exist.

- [ ] **Step 3: Implement the page**

Create `packages/web/src/pages/VehicleCreate.tsx`:

```tsx
// F-OFF-102 vehicle registration. Calls POST /v1/vehicles (atomic vehicle +
// GO-code F-OFF-103 + ownership BR-040 + customer-tenant relation BR-152).
// Customer is inline (existing or new) per resolveCustomer. See
// docs/superpowers/specs/2026-06-09-F-OFF-102-vehicle-create-web-design.md
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import {
  VehicleFormSchema,
  transformToPayload,
  VehicleTypeEnum,
  FuelTypeEnum,
  type VehicleFormValues,
} from '@/lib/validators/createVehicle';
import { useCreateVehicle, type CreateVehicleBody } from '@/queries/vehicleCreate';
import { useProfileMe } from '@/queries/profileMe';
import { useLocationFilter } from '@/location-filter/useLocationFilter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CustomerAutocomplete } from '@/components/CustomerAutocomplete';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  car: 'Auto',
  motorcycle: 'Moto',
  van: 'Furgone',
  truck: 'Camion',
  agricultural: 'Agricolo',
};
const FUEL_TYPE_LABELS: Record<string, string> = {
  petrol: 'Benzina',
  diesel: 'Diesel',
  electric: 'Elettrico',
  hybrid: 'Ibrido',
  lpg: 'GPL',
  methane: 'Metano',
  hydrogen: 'Idrogeno',
  other: 'Altro',
};

interface LocationOption {
  id: string;
  name: string;
}

export function VehicleCreate() {
  const profile = useProfileMe();
  const { isSuperAdmin, locations, selectedLocationId } = useLocationFilter();

  if (profile.isPending) {
    return (
      <div className="p-8 space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>Errore caricamento profilo.</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Resolve location by role.
  let locationOptions: LocationOption[] = [];
  let lockedLocationId: string | null = null;
  let defaultLocationId = '';

  if (isSuperAdmin) {
    locationOptions = (locations as LocationOption[]).map((l) => ({ id: l.id, name: l.name }));
    defaultLocationId =
      selectedLocationId ?? (locationOptions.length === 1 ? locationOptions[0].id : '');
  } else {
    const own = profile.data.locationId;
    if (!own) {
      return (
        <div className="p-8">
          <Alert variant="destructive">
            <AlertDescription>
              Il tuo account non è associato a una sede. Contatta l&apos;amministratore.
            </AlertDescription>
          </Alert>
        </div>
      );
    }
    lockedLocationId = own;
    defaultLocationId = own;
  }

  return (
    <VehicleCreateForm
      isSuperAdmin={isSuperAdmin}
      locationOptions={locationOptions}
      lockedLocationId={lockedLocationId}
      defaultLocationId={defaultLocationId}
    />
  );
}

interface FormProps {
  isSuperAdmin: boolean;
  locationOptions: LocationOption[];
  lockedLocationId: string | null;
  defaultLocationId: string;
}

interface PendingConfirm {
  kind: 'plate' | 'vin';
  body: CreateVehicleBody;
  plate: string;
}

function VehicleCreateForm({
  isSuperAdmin,
  locationOptions,
  lockedLocationId,
  defaultLocationId,
}: FormProps) {
  const navigate = useNavigate();
  const routerLocation = useLocation();
  const [params] = useSearchParams();
  const mutation = useCreateVehicle();

  const lockedCustomerId = params.get('customerId');
  const lockedCustomerLabel =
    (routerLocation.state as { customerLabel?: string } | null)?.customerLabel ?? null;
  const prefillVin = params.get('vin') ?? '';
  const prefillPlate = params.get('plate') ?? '';

  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState<string | null>(
    lockedCustomerId ? (lockedCustomerLabel ?? 'Cliente selezionato') : null,
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<VehicleFormValues>({
    resolver: zodResolver(VehicleFormSchema),
    defaultValues: {
      customerMode: lockedCustomerId ? 'existing' : 'create_new',
      customerId: lockedCustomerId ?? '',
      isBusiness: false,
      vin: prefillVin.toUpperCase(),
      plate: prefillPlate.toUpperCase(),
      plateCountry: 'IT',
      year: String(new Date().getFullYear()),
      vehicleType: 'car',
      fuelType: 'petrol',
      odometerKm: '',
      locationId: defaultLocationId,
    },
  });

  const customerMode = watch('customerMode');
  const isBusiness = watch('isBusiness');
  const vehicleType = watch('vehicleType');
  const fuelType = watch('fuelType');
  const locationId = watch('locationId');

  async function submit(body: CreateVehicleBody) {
    try {
      const res = await mutation.mutateAsync(body);
      toast.success(`Veicolo censito — codice GO ${res.vehicle.garageCode}`);
      navigate(`/vehicles/${res.vehicle.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && e.code === 'vehicle.creation.duplicate_plate_warning') {
          setConfirm({ kind: 'plate', body, plate: body.vehicle.plate });
          return;
        }
        if (e.status === 400 && e.code === 'vehicle.creation.invalid_vin_checksum') {
          setConfirm({ kind: 'vin', body, plate: body.vehicle.plate });
          return;
        }
        toast.error(translateError(e.code, e.message));
        return;
      }
      throw e;
    }
  }

  async function onSubmit(values: VehicleFormValues) {
    await submit(transformToPayload(values));
  }

  async function onForcePlate() {
    if (!confirm) return;
    const body = { ...confirm.body, force: true };
    setConfirm(null);
    await submit(body);
  }
  async function onForceVin() {
    if (!confirm) return;
    const body = { ...confirm.body, forceNonstandardVin: true };
    setConfirm(null);
    await submit(body);
  }
  function onOpenExisting() {
    if (!confirm) return;
    navigate(`/search?q=${encodeURIComponent(confirm.plate)}`);
  }

  function err(name: keyof VehicleFormValues) {
    const e = errors[name];
    return e ? <p className="text-sm text-red-600 mt-1">{String(e.message)}</p> : null;
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={() => navigate(-1)}
        >
          ← Indietro
        </button>
        <h1 className="text-2xl font-bold mt-2">Censimento nuovo veicolo</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
        {/* ── Cliente ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Cliente</h2>

          {lockedCustomerId ? (
            <div className="rounded-md border p-3 text-sm">
              Cliente selezionato: <span className="font-medium">{selectedCustomerLabel}</span>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={customerMode === 'existing' ? 'default' : 'outline'}
                  onClick={() => setValue('customerMode', 'existing', { shouldValidate: false })}
                >
                  Cliente esistente
                </Button>
                <Button
                  type="button"
                  variant={customerMode === 'create_new' ? 'default' : 'outline'}
                  onClick={() => {
                    setValue('customerMode', 'create_new', { shouldValidate: false });
                    setValue('customerId', '');
                    setSelectedCustomerLabel(null);
                  }}
                >
                  Nuovo cliente
                </Button>
              </div>

              {customerMode === 'existing' ? (
                <div className="space-y-2">
                  {selectedCustomerLabel ? (
                    <div className="rounded-md border p-3 text-sm">
                      Cliente selezionato:{' '}
                      <span className="font-medium">{selectedCustomerLabel}</span>{' '}
                      <button
                        type="button"
                        className="ml-2 text-xs text-muted-foreground underline"
                        onClick={() => {
                          setValue('customerId', '');
                          setSelectedCustomerLabel(null);
                        }}
                      >
                        cambia
                      </button>
                    </div>
                  ) : (
                    <CustomerAutocomplete
                      onSelect={(c) => {
                        setValue('customerId', c.id, { shouldValidate: true });
                        const label =
                          c.isBusiness && c.businessName
                            ? c.businessName
                            : `${c.firstName} ${c.lastName}`.trim();
                        setSelectedCustomerLabel(label || c.id);
                      }}
                    />
                  )}
                  {err('customerId')}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="vc-firstName">Nome</Label>
                      <Input id="vc-firstName" {...register('firstName')} />
                      {err('firstName')}
                    </div>
                    <div>
                      <Label htmlFor="vc-lastName">Cognome</Label>
                      <Input id="vc-lastName" {...register('lastName')} />
                      {err('lastName')}
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="vc-email">Email</Label>
                    <Input id="vc-email" type="email" autoComplete="off" {...register('email')} />
                    {err('email')}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="vc-phone">Telefono (opzionale)</Label>
                      <Input id="vc-phone" {...register('phone')} />
                    </div>
                    <div>
                      <Label htmlFor="vc-taxCode">Codice fiscale (opzionale)</Label>
                      <Input id="vc-taxCode" {...register('taxCode')} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="vc-isBusiness"
                      checked={isBusiness}
                      onCheckedChange={(v) => setValue('isBusiness', v, { shouldValidate: true })}
                      aria-label="Cliente aziendale"
                    />
                    <Label htmlFor="vc-isBusiness">Cliente aziendale</Label>
                  </div>
                  {isBusiness && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="vc-businessName">Ragione sociale</Label>
                        <Input id="vc-businessName" {...register('businessName')} />
                        {err('businessName')}
                      </div>
                      <div>
                        <Label htmlFor="vc-vatNumber">P.IVA</Label>
                        <Input id="vc-vatNumber" {...register('vatNumber')} />
                        {err('vatNumber')}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Veicolo ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Veicolo</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="vc-vin">VIN</Label>
              <Input id="vc-vin" {...register('vin')} />
              {err('vin')}
            </div>
            <div>
              <Label htmlFor="vc-plate">Targa</Label>
              <Input id="vc-plate" {...register('plate')} />
              {err('plate')}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="vc-make">Marca</Label>
              <Input id="vc-make" {...register('make')} />
              {err('make')}
            </div>
            <div>
              <Label htmlFor="vc-model">Modello</Label>
              <Input id="vc-model" {...register('model')} />
              {err('model')}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="vc-year">Anno</Label>
              <Input id="vc-year" inputMode="numeric" {...register('year')} />
              {err('year')}
            </div>
            <div>
              <Label htmlFor="vc-odometerKm">Km attuali</Label>
              <Input id="vc-odometerKm" inputMode="numeric" {...register('odometerKm')} />
              {err('odometerKm')}
            </div>
            <div>
              <Label htmlFor="vc-version">Versione (opzionale)</Label>
              <Input id="vc-version" {...register('version')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo veicolo</Label>
              <Select
                value={vehicleType}
                onValueChange={(v) =>
                  setValue('vehicleType', v as VehicleFormValues['vehicleType'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger aria-label="Tipo veicolo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VehicleTypeEnum.options.map((t) => (
                    <SelectItem key={t} value={t}>
                      {VEHICLE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Alimentazione</Label>
              <Select
                value={fuelType}
                onValueChange={(v) =>
                  setValue('fuelType', v as VehicleFormValues['fuelType'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger aria-label="Alimentazione">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FuelTypeEnum.options.map((f) => (
                    <SelectItem key={f} value={f}>
                      {FUEL_TYPE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="vc-registrationDate">Immatricolazione (opzionale)</Label>
              <Input id="vc-registrationDate" type="date" {...register('registrationDate')} />
              {err('registrationDate')}
            </div>
            <div>
              <Label htmlFor="vc-engineDisplacement">Cilindrata cc (opzionale)</Label>
              <Input id="vc-engineDisplacement" inputMode="numeric" {...register('engineDisplacement')} />
              {err('engineDisplacement')}
            </div>
            <div>
              <Label htmlFor="vc-powerKw">Potenza kW (opzionale)</Label>
              <Input id="vc-powerKw" inputMode="numeric" {...register('powerKw')} />
              {err('powerKw')}
            </div>
          </div>
          <div>
            <Label htmlFor="vc-color">Colore (opzionale)</Label>
            <Input id="vc-color" {...register('color')} />
          </div>
        </section>

        {/* ── Sede + invito ───────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Sede</h2>
          {lockedLocationId ? (
            <p className="text-sm text-muted-foreground">
              Il veicolo sarà registrato sulla tua sede assegnata.
            </p>
          ) : locationOptions.length > 1 ? (
            <div>
              <Label>Sede</Label>
              <Select
                value={locationId}
                onValueChange={(v) => setValue('locationId', v, { shouldValidate: true })}
              >
                <SelectTrigger aria-label="Sede">
                  <SelectValue placeholder="Seleziona una sede" />
                </SelectTrigger>
                <SelectContent>
                  {locationOptions.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {err('locationId')}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {locationOptions[0]?.name ?? 'Sede unica'}
            </p>
          )}

          <div className="flex items-center gap-2 opacity-60">
            <Switch id="vc-invite" checked={false} disabled aria-label="Invia invito all'app" />
            <Label htmlFor="vc-invite" title="Disponibile a breve">
              Invia invito all&apos;app al cliente
            </Label>
            <span className="text-xs text-muted-foreground">Disponibile a breve</span>
          </div>
        </section>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => navigate(-1)} disabled={isSubmitting}>
            Annulla
          </Button>
          <Button type="submit" disabled={isSubmitting || mutation.isPending}>
            {isSubmitting || mutation.isPending ? 'Salvataggio…' : 'Censisci veicolo'}
          </Button>
        </div>
      </form>

      {/* Duplicate-plate dialog */}
      <Dialog open={confirm?.kind === 'plate'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Targa già presente</DialogTitle>
            <DialogDescription>
              Esiste già un veicolo con questa targa ({confirm?.plate}). Di solito significa che il
              veicolo è già a sistema.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" onClick={onOpenExisting}>
              Apri veicolo esistente
            </Button>
            <Button type="button" variant="outline" onClick={onForcePlate}>
              Censisci comunque
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIN-checksum dialog */}
      <Dialog open={confirm?.kind === 'vin'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>VIN non standard</DialogTitle>
            <DialogDescription>
              Il VIN non rispetta il checksum standard. Confermi solo se è un veicolo storico o
              agricolo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
              Annulla
            </Button>
            <Button type="button" onClick={onForceVin}>
              Conferma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Register the route in `App.tsx`**

Add the import alongside the other page imports:

```tsx
import { VehicleCreate } from '@/pages/VehicleCreate';
```

Add the route **before** `/vehicles/:id` (inside the `OnboardingGate` block):

```tsx
                    <Route path="/vehicles/new" element={<VehicleCreate />} />
                    <Route path="/vehicles/:id" element={<VehicleDetail />} />
```

- [ ] **Step 5: Run the page test + typecheck**

Run: `pnpm --filter @garageos/web exec vitest run src/pages/VehicleCreate.test.tsx`
Expected: PASS (9 tests).

Run: `pnpm -r typecheck`
Expected: no errors. (If a shadcn `Select`/`Dialog` export name differs, fix the import to match `packages/web/src/components/ui/`.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/VehicleCreate.tsx packages/web/src/pages/VehicleCreate.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): add vehicle-create page and /vehicles/new route"
```

---

## Task 6: Entry points (sidebar, customer card, search empty-state)

**Files:**
- Modify: `packages/web/src/components/layout/Sidebar.tsx`
- Modify: `packages/web/src/pages/CustomerDetail.tsx`
- Modify: `packages/web/src/pages/SearchResults.tsx`
- Test: extend the existing `Sidebar.test.tsx`, `CustomerDetail.test.tsx`, `SearchResults.test.tsx`

- [ ] **Step 1: Write failing tests for the three CTAs**

Append to `packages/web/src/components/layout/Sidebar.test.tsx` (inside the existing `describe`):

```tsx
  it('renders a "Nuovo veicolo" link to /vehicles/new', () => {
    // (uses whatever render helper the existing tests use — render <Sidebar/>
    // inside a MemoryRouter)
    const link = screen.getByRole('link', { name: /nuovo veicolo/i });
    expect(link).toHaveAttribute('href', '/vehicles/new');
  });
```

Append to `packages/web/src/pages/CustomerDetail.test.tsx` (a customer with id `c1` is already rendered by the existing happy-path test — reuse its setup):

```tsx
  it('links "Aggiungi veicolo" to /vehicles/new with the customerId', async () => {
    // render CustomerDetail for customer c1 (reuse existing success setup)
    const link = await screen.findByRole('link', { name: /aggiungi veicolo/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/vehicles/new?customerId=c1'));
  });
```

Append to `packages/web/src/pages/SearchResults.test.tsx` (the empty-state path: a `q` that classifies as a plate and returns no results):

```tsx
  it('offers "Censisci questo veicolo" prefilled with the plate when nothing is found', async () => {
    // render at /search?q=AB123CD with both vehicle + customer queries empty
    const link = await screen.findByRole('link', { name: /censisci questo veicolo/i });
    expect(link).toHaveAttribute('href', '/vehicles/new?plate=AB123CD');
  });
```

> Match each appended test to the existing file's render/mocking helpers — open the file first and reuse its setup (router wrapper, query mocks). Do not invent a new harness.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/web exec vitest run src/components/layout/Sidebar.test.tsx src/pages/CustomerDetail.test.tsx src/pages/SearchResults.test.tsx`
Expected: FAIL — the CTAs do not exist yet.

- [ ] **Step 3a: Sidebar CTA**

In `packages/web/src/components/layout/Sidebar.tsx`, add `Plus` to the lucide import and insert a primary CTA above the `<nav>`:

```tsx
import { Home, Wrench, Users, Settings, LogOut, Calendar, Plus } from 'lucide-react';
```

```tsx
      <Link
        to="/vehicles/new"
        className="flex items-center justify-center gap-2 mb-4 px-3 py-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
      >
        <Plus size={16} />
        Nuovo veicolo
      </Link>
```

Place it immediately after the brand `<div>…GarageOS</div>` and before `<nav …>`.

- [ ] **Step 3b: CustomerDetail card CTA**

In `packages/web/src/pages/CustomerDetail.tsx`, the Veicoli `Card` (around line 412) needs an "Aggiungi veicolo" link that carries the customer label via router state. Compute the label from the already-loaded `dto` and render the link in the card header. Replace the `<CardHeader>` of the Veicoli card with:

```tsx
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Veicoli ({dto.vehicles.length})</CardTitle>
          <Link
            to={`/vehicles/new?customerId=${dto.id}`}
            state={{
              customerLabel:
                dto.isBusiness && dto.businessName
                  ? dto.businessName
                  : `${dto.firstName} ${dto.lastName}`.trim(),
            }}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            + Aggiungi veicolo
          </Link>
        </CardHeader>
```

> Verify the exact field names on `dto` (`id`, `firstName`, `lastName`, `isBusiness`, `businessName`) against the `customerDetail.ts` DTO type; adjust if the customer object is nested. `Link` is already imported in this file.

- [ ] **Step 3c: SearchResults empty-state CTA**

In `packages/web/src/pages/SearchResults.tsx`, the `GlobalSearchResults` component has `parsed = parseSearchInput(q)` and an `allEmpty` block (around lines 118-124). Compute a prefill target and add a CTA link inside that empty-state block:

```tsx
  const prefill =
    parsed.kind === 'valid' && (parsed.type === 'vin' || parsed.type === 'plate')
      ? `?${parsed.type}=${encodeURIComponent(parsed.value)}`
      : '';
```

Inside the `{allEmpty && ( … )}` block, after the "Verifica il dato inserito." line, add:

```tsx
          <Link
            to={`/vehicles/new${prefill}`}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
          >
            + Censisci questo veicolo
          </Link>
```

> `Link` is already imported in `SearchResults.tsx`. Confirm `parseSearchInput`'s result shape exposes `.type` values `'vin' | 'plate' | 'garage_code'` and `.value` (open `lib/search-input.ts`); adjust the field names if they differ.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/web exec vitest run src/components/layout/Sidebar.test.tsx src/pages/CustomerDetail.test.tsx src/pages/SearchResults.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web suite + typecheck**

Run: `pnpm --filter @garageos/web exec vitest run`
Expected: all green (a shared-page change can break a sibling test — see memory "Shared hook new provider dep breaks consumer tests").

Run: `pnpm -r typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/layout/Sidebar.tsx packages/web/src/pages/CustomerDetail.tsx packages/web/src/pages/SearchResults.tsx packages/web/src/components/layout/Sidebar.test.tsx packages/web/src/pages/CustomerDetail.test.tsx packages/web/src/pages/SearchResults.test.tsx
git commit -m "feat(web): wire vehicle-create entry points (sidebar, customer card, search)"
```

---

## Final verification

- [ ] `pnpm --filter @garageos/web exec vitest run` — full web suite green.
- [ ] `pnpm -r typecheck` — clean (also enforced by the pre-push hook).
- [ ] Push the branch and open the PR; let CI run lint/format/commitlint/test matrix.

```bash
git push -u origin feat/f-off-102-vehicle-create-web
```

PR body must follow the CLAUDE.md template (What / Why → F-OFF-102 / Implementation notes / Tests checklist / Checklist). Note in "Implementation notes": location resolution deviates from the spec's `useLocations` mention (role-correct via `useLocationFilter` + `useProfileMe`), and `sendInvitationEmail` is hard-`false` while the UI toggle is disabled (invito differito).

## Manual smoke (post-merge, deferred env)

Not a CI gate, but the recurring lesson (memory: "Smoke mandatory for shell/layout PRs") applies — this PR adds a route + sidebar/header CTAs:

1. Sidebar "+ Nuovo veicolo" → `/vehicles/new` renders, customer toggle defaults to "Nuovo cliente".
2. Create new customer + vehicle → success toast shows GO-code, lands on the new VehicleDetail.
3. From a customer's detail card "+ Aggiungi veicolo" → customer locked, only vehicle fields.
4. Submit a plate that already exists → dialog; "Apri veicolo esistente" → search page; "Censisci comunque" → forces and creates.
5. Search a non-existent plate → empty-state "+ Censisci questo veicolo" prefills the plate.
```

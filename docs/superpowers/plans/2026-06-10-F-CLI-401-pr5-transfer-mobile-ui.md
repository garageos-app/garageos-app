# F-CLI-401 PR5 — Mobile UI full flow passaggio di proprietà — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer-facing mobile UI for the full vehicle ownership transfer flow (seller: initiate/share code/cancel/confirm/reject; recipient: enter code/preview/accept), consuming the `/v1/me/transfers*` API shipped in PR1-PR4.

**Architecture:** Four new expo-router screens — `app/transfers/{index,new,[id]}.tsx` (seller) + `app/accept-transfer.tsx` (recipient), all **top-level standalone** routes (mirror `private-interventions/`, segment-collision lesson #160). One new query module `src/queries/transfers.ts` (TanStack Query, mirror `me.ts`/`notificationPreferences.ts`). Entry points: button/banner in vehicle detail TechTab, nav row in Profilo, `TR-` auto-detect in claim-vehicle. Share via RN `Share.share` (zero new deps). No API/migration/CDK changes.

**Tech Stack:** React Native + Expo (managed), expo-router, TanStack Query v5, Jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-10-F-CLI-401-pr4-pr5-transfer-preview-and-mobile-ui-design.md` §PR5.

---

## Deviations from spec (verified against actual code — the code wins)

1. **Error codes**: the spec's error table (§Errori) is "indicativo" and several codes there don't exist. The REAL codes thrown by `packages/api/src/routes/v1/me-transfers.ts` + `lib/transfer-swap.ts` (verified 2026-06-10) are the 16 mapped in Task 1. Notable: spec's `transfer.creation.not_current_owner` and `transfer.creation.vehicle_not_certified` are real, but the API also throws `transfer.creation.vehicle_not_found` (404), `vehicle.archived` (409), `transfer.confirmation.not_from_customer` (403), `transfer.confirmation.not_pending_seller` (422), `transfer.rejection.not_permitted` (403) — all absent from the spec table and all mapped here.
2. **Vehicles invalidation key**: spec says confirm invalidates `['vehicles']`, but the real list key is `['me','vehicles']` (`src/queries/meVehicles.ts:19`). Using the spec key would be a silent no-op bug. We use `['me','vehicles']`.
3. **Wire shapes**: `POST /v1/me/transfers` returns the **bare** TransferDto (201), NOT `{transfer}`. List returns `{data: [...]}`. Detail/accept/confirm/reject/preview return `{transfer: ...}`. Hooks below match exactly.

## Gotchas the implementer MUST respect (from project memory)

- New expo-router routes → run `rm packages/mobile/.expo/types/router.d.ts` before typecheck (gitignored, regenerated).
- Screen tests import the screen via **relative path** `../../app/...` (jest maps only `@/`→`src`).
- `jest.mock` factory variables must be prefixed `mock` (e.g. `mockRouter`, not `router`).
- Mocks of default-imported modules need `__esModule: true` (none needed below — `Share`/`Alert` are named imports from `react-native`, spied not mocked).
- Commit headers ≤72 chars, Conventional Commits, no emoji.
- User-facing strings in Italian; code comments in English.
- Local gate = `pnpm -r typecheck` only (pre-push hook). Mobile jest suites are safe to run locally per-file: `pnpm --filter @garageos/mobile exec jest <path>`. Do NOT run integration suites.
- **LOC checkpoint**: target ~1300 net LOC, hard PR limit 1500. The controller checks cumulative LOC after each task; if projected total crosses ~1500, halt and ask the user.

## Branch

```bash
git checkout main && git pull origin main
git checkout -b feat/transfer-mobile-ui
```

---

### Task 1: Foundation — types, status labels, code validator, error messages

**Files:**
- Create: `packages/mobile/src/lib/types/transfer.ts`
- Create: `packages/mobile/src/lib/transfer-labels.ts`
- Create: `packages/mobile/src/lib/validators/transfer.ts`
- Modify: `packages/mobile/src/lib/error-messages.ts` (add transfer block before the closing `};` of `MESSAGES`)
- Test: `packages/mobile/tests/lib/validators/transfer.test.ts`
- Test: `packages/mobile/tests/lib/transfer-labels.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/mobile/tests/lib/validators/transfer.test.ts`:

```ts
import { TRANSFER_CODE_RE, validateTransferCode } from '@/lib/validators/transfer';

describe('TRANSFER_CODE_RE', () => {
  it('accepts a well-formed code', () => {
    expect(TRANSFER_CODE_RE.test('TR-ABCD-2345')).toBe(true);
  });
  it('rejects ambiguous glyphs excluded from the alphabet (0 1 I O Q S U)', () => {
    expect(TRANSFER_CODE_RE.test('TR-AB0D-2345')).toBe(false);
    expect(TRANSFER_CODE_RE.test('TR-ABID-2345')).toBe(false);
  });
  it('rejects the GO- garage code shape', () => {
    expect(TRANSFER_CODE_RE.test('GO-234-ABCD')).toBe(false);
  });
});

describe('validateTransferCode', () => {
  it('requires a code', () => {
    expect(validateTransferCode('')).toBe('Codice obbligatorio');
  });
  it('rejects a malformed code with the format hint', () => {
    expect(validateTransferCode('TR-XX')).toBe('Codice non valido. Formato: TR-XXXX-XXXX');
  });
  it('accepts a valid code', () => {
    expect(validateTransferCode('TR-ABCD-2345')).toBeUndefined();
  });
});
```

`packages/mobile/tests/lib/transfer-labels.test.ts`:

```ts
import {
  TRANSFER_STATUS_LABELS,
  isTransferActive,
  transferStatusTone,
  transferShareMessage,
} from '@/lib/transfer-labels';
import type { Transfer } from '@/lib/types/transfer';

describe('transfer labels', () => {
  it('maps every status to the Italian label from the spec', () => {
    expect(TRANSFER_STATUS_LABELS.pending_recipient).toBe('In attesa del nuovo proprietario');
    expect(TRANSFER_STATUS_LABELS.pending_seller_confirmation).toBe(
      'In attesa della tua conferma',
    );
    expect(TRANSFER_STATUS_LABELS.completed).toBe('Completato');
    expect(TRANSFER_STATUS_LABELS.rejected).toBe('Rifiutato');
    expect(TRANSFER_STATUS_LABELS.expired).toBe('Scaduto');
  });

  it('isTransferActive is true only for pending statuses', () => {
    expect(isTransferActive('pending_recipient')).toBe(true);
    expect(isTransferActive('pending_seller_confirmation')).toBe(true);
    expect(isTransferActive('pending_validation')).toBe(true);
    expect(isTransferActive('completed')).toBe(false);
    expect(isTransferActive('rejected')).toBe(false);
    expect(isTransferActive('expired')).toBe(false);
  });

  it('transferStatusTone buckets statuses for badge styling', () => {
    expect(transferStatusTone('pending_recipient')).toBe('pending');
    expect(transferStatusTone('completed')).toBe('done');
    expect(transferStatusTone('rejected')).toBe('closed');
    expect(transferStatusTone('expired')).toBe('closed');
  });

  it('transferShareMessage includes code, vehicle and expiry date', () => {
    const t: Transfer = {
      id: 'x',
      vehicleId: 'v',
      vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      method: 'physical_code',
      status: 'pending_recipient',
      transferCode: 'TR-ABCD-2345',
      expiresAt: '2026-06-17T10:00:00.000Z',
      createdAt: '2026-06-10T10:00:00.000Z',
    };
    const msg = transferShareMessage(t);
    expect(msg).toContain('TR-ABCD-2345');
    expect(msg).toContain('Fiat Panda');
    expect(msg).toContain('AB123CD');
    expect(msg).toContain('17/06/2026');
  });
});
```

Append to `MESSAGES` assertions in `packages/mobile/tests/lib/error-messages.test.ts` (inside the existing `describe`, add one test):

```ts
  it('maps the transfer domain codes (F-CLI-401)', () => {
    expect(mapErrorToUserMessage('transfer.not_found')).toBe(
      'Codice o trasferimento non valido. Controlla e riprova.',
    );
    expect(mapErrorToUserMessage('transfer.acceptance.expired')).toBe(
      'Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.',
    );
    expect(mapErrorToUserMessage('transfer.creation.already_pending')).toBe(
      "C'è già un trasferimento attivo per questo veicolo.",
    );
    expect(mapErrorToUserMessage('transfer.confirmation.ownership_conflict')).toBe(
      'La proprietà del veicolo è cambiata nel frattempo.',
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/mobile exec jest tests/lib/validators/transfer.test.ts tests/lib/transfer-labels.test.ts tests/lib/error-messages.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validators/transfer'` etc.

- [ ] **Step 3: Implement**

`packages/mobile/src/lib/types/transfer.ts`:

```ts
// Mirror of the API TransferDto (api/src/lib/dtos/transfer.ts). api/mobile do
// not share a package, so the shape is mirrored by hand (parity is enforced by
// the API integration tests on the serializer side).

export type TransferStatus =
  | 'pending_recipient'
  | 'pending_seller_confirmation'
  | 'pending_validation'
  | 'completed'
  | 'rejected'
  | 'expired';

export interface TransferVehicle {
  plate: string;
  make: string;
  model: string;
}

export interface Transfer {
  id: string;
  vehicleId: string;
  vehicle: TransferVehicle;
  method: string;
  status: TransferStatus;
  transferCode: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  rejectedReason?: string;
}

export interface TransfersListResponse {
  data: Transfer[];
}

export interface TransferResponse {
  transfer: Transfer;
}
```

`packages/mobile/src/lib/validators/transfer.ts`:

```ts
// Pure validator for the transfer code input. The regex mirrors the backend
// exactly (api/src/lib/transfer-code.ts TRANSFER_CODE_RE): TR-XXXX-XXXX where
// the alphabet excludes ambiguous glyphs (0 1 I O Q S U). The caller
// normalizes to trim().toUpperCase() first; the server stays authoritative.
export const TRANSFER_CODE_RE = /^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/;

export function validateTransferCode(code: string): string | undefined {
  if (!code) return 'Codice obbligatorio';
  if (!TRANSFER_CODE_RE.test(code)) return 'Codice non valido. Formato: TR-XXXX-XXXX';
  return undefined;
}
```

`packages/mobile/src/lib/transfer-labels.ts`:

```ts
import type { Transfer, TransferStatus } from '@/lib/types/transfer';
import { formatDate } from '@/lib/format';

// BR-043 lifecycle states (Italian, user-facing, seller perspective).
export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  pending_recipient: 'In attesa del nuovo proprietario',
  pending_seller_confirmation: 'In attesa della tua conferma',
  pending_validation: 'In verifica',
  completed: 'Completato',
  rejected: 'Rifiutato',
  expired: 'Scaduto',
};

// Mirror of ACTIVE_TRANSFER_STATUSES in api routes/v1/me-transfers.ts (BR-047:
// at most one active transfer per vehicle).
const ACTIVE_STATUSES: readonly TransferStatus[] = [
  'pending_recipient',
  'pending_seller_confirmation',
  'pending_validation',
];

export function isTransferActive(status: TransferStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export type TransferStatusTone = 'pending' | 'done' | 'closed';

// Badge styling bucket: pending → warning colors, done → muted/primary,
// closed (rejected/expired) → danger colors.
export function transferStatusTone(status: TransferStatus): TransferStatusTone {
  if (isTransferActive(status)) return 'pending';
  return status === 'completed' ? 'done' : 'closed';
}

// Message handed to Share.share by the seller (spec §PR5: zero new deps).
export function transferShareMessage(t: Transfer): string {
  const label = `${t.vehicle.make} ${t.vehicle.model} (${t.vehicle.plate})`;
  return (
    `Codice GarageOS per il passaggio di proprietà di ${label}: ${t.transferCode ?? ''}. ` +
    `Apri l'app GarageOS, tocca "Hai ricevuto un codice?" e inseriscilo entro il ${formatDate(t.expiresAt)}.`
  );
}
```

In `packages/mobile/src/lib/error-messages.ts`, add this block inside `MESSAGES` after the dispute block (before the closing `};`):

```ts
  // Transfer domain codes (F-CLI-401→403). Codes verified against
  // api routes/v1/me-transfers.ts + lib/transfer-swap.ts.
  'transfer.not_found': 'Codice o trasferimento non valido. Controlla e riprova.',
  'transfer.creation.vehicle_not_found': 'Veicolo non trovato.',
  'transfer.creation.not_current_owner': 'Non risulti il proprietario attuale del veicolo.',
  'transfer.creation.vehicle_not_certified': 'Questo veicolo non può ancora essere trasferito.',
  'transfer.creation.already_pending': "C'è già un trasferimento attivo per questo veicolo.",
  'vehicle.archived': 'Veicolo archiviato: operazione non disponibile.',
  'transfer.acceptance.self_not_allowed': 'Questo trasferimento è stato avviato da te.',
  'transfer.acceptance.already_completed': 'Trasferimento già completato.',
  'transfer.acceptance.expired':
    'Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.',
  'transfer.acceptance.not_pending_recipient': 'Il trasferimento non è più accettabile.',
  'transfer.confirmation.not_from_customer':
    'Solo chi ha avviato il trasferimento può confermarlo.',
  'transfer.confirmation.expired': 'Trasferimento scaduto: avviane uno nuovo.',
  'transfer.confirmation.not_pending_seller':
    'Il trasferimento non è in attesa della tua conferma.',
  'transfer.confirmation.ownership_conflict': 'La proprietà del veicolo è cambiata nel frattempo.',
  'transfer.rejection.not_permitted': 'Non puoi annullare questo trasferimento.',
  'transfer.rejection.not_pending': 'Il trasferimento non è più annullabile.',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile exec jest tests/lib/validators/transfer.test.ts tests/lib/transfer-labels.test.ts tests/lib/error-messages.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/lib packages/mobile/tests/lib
git commit -m "feat(mobile): transfer types, labels, validator, errors"
```

---

### Task 2: Query hooks — `src/queries/transfers.ts`

**Files:**
- Create: `packages/mobile/src/queries/transfers.ts`
- Test: `packages/mobile/tests/queries/transfers.test.tsx`

- [ ] **Step 1: Write the failing tests**

`packages/mobile/tests/queries/transfers.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useTransfers,
  useTransfer,
  useInitiateTransfer,
  useTransferPreview,
  useAcceptTransfer,
  useConfirmTransfer,
  useRejectTransfer,
} from '@/queries/transfers';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { Transfer } from '@/lib/types/transfer';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const TRANSFER: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useTransfers', () => {
  it('GETs /v1/me/transfers and unwraps data', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ data: [TRANSFER] });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useTransfers(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/transfers');
    expect(result.current.data).toEqual([TRANSFER]);
  });
});

describe('useTransfer', () => {
  it('GETs /v1/me/transfers/:id and unwraps transfer', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ transfer: TRANSFER });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useTransfer(TRANSFER.id), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/transfers/${TRANSFER.id}`);
    expect(result.current.data).toEqual(TRANSFER);
  });

  it('does not fetch with an empty id', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    renderHook(() => useTransfer(''), { wrapper: makeWrapper(qc) });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('useInitiateTransfer', () => {
  it('POSTs the create body (bare DTO response) and invalidates the list', async () => {
    const apiFetch = jest.fn().mockResolvedValue(TRANSFER);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useInitiateTransfer(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ vehicleId: TRANSFER.vehicleId });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/transfers', {
      method: 'POST',
      body: { vehicleId: TRANSFER.vehicleId, method: 'physical_code' },
    });
    expect(result.current.data).toEqual(TRANSFER);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transfers'] });
  });
});

describe('useTransferPreview', () => {
  it('GETs /v1/me/transfers/:code/preview and unwraps transfer', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ transfer: TRANSFER });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useTransferPreview(), { wrapper: makeWrapper(qc) });
    result.current.mutate('TR-ABCD-2345');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/transfers/TR-ABCD-2345/preview');
    expect(result.current.data).toEqual(TRANSFER);
  });

  it('propagates the ApiError', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(new ApiError('transfer.acceptance.expired', 410, 'scaduto'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useTransferPreview(), { wrapper: makeWrapper(qc) });
    result.current.mutate('TR-ABCD-2345');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('transfer.acceptance.expired');
  });
});

describe('useAcceptTransfer', () => {
  it('POSTs /v1/me/transfers/:code/accept with no body', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ transfer: TRANSFER });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useAcceptTransfer(), { wrapper: makeWrapper(qc) });
    result.current.mutate('TR-ABCD-2345');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/transfers/TR-ABCD-2345/accept', {
      method: 'POST',
    });
  });
});

describe('useConfirmTransfer', () => {
  it('POSTs confirm and invalidates transfers + the REAL vehicles key', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ transfer: TRANSFER });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useConfirmTransfer(), { wrapper: makeWrapper(qc) });
    result.current.mutate(TRANSFER.id);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/transfers/${TRANSFER.id}/confirm`, {
      method: 'POST',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transfers'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transfers', TRANSFER.id] });
    // ownership moved (BR-043): the vehicle must leave the seller's list.
    // Real key is ['me','vehicles'] (meVehicles.ts), NOT the spec's ['vehicles'].
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'vehicles'] });
  });
});

describe('useRejectTransfer', () => {
  it('POSTs reject with an empty body and invalidates transfers keys', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ transfer: TRANSFER });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRejectTransfer(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ id: TRANSFER.id });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/transfers/${TRANSFER.id}/reject`, {
      method: 'POST',
      body: {},
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transfers'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['transfers', TRANSFER.id] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/mobile exec jest tests/queries/transfers.test.tsx`
Expected: FAIL — `Cannot find module '@/queries/transfers'`.

- [ ] **Step 3: Implement**

`packages/mobile/src/queries/transfers.ts`:

```ts
// Transfer hooks — F-CLI-401→403 customer ownership transfer (consumes
// /v1/me/transfers* from PR1-PR4). Mirrors me.ts / notificationPreferences.ts.
//
// Wire shapes (me-transfers.ts): POST /me/transfers returns the BARE TransferDto
// (201); list returns {data}; detail/accept/confirm/reject/preview return
// {transfer}. Invalidations per spec §PR5: initiate/reject → ['transfers'](+id);
// confirm → ['transfers'](+id) + ['me','vehicles'] (the REAL meVehicles.ts key —
// ownership moves on confirm, BR-043, so the vehicle leaves the seller's list);
// accept → none (ownership does not move on accept).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type { Transfer, TransferResponse, TransfersListResponse } from '@/lib/types/transfer';

export function useTransfers() {
  const api = useApiClient();
  return useQuery<TransfersListResponse, Error, Transfer[]>({
    queryKey: ['transfers'],
    queryFn: () => api.fetch<TransfersListResponse>('/v1/me/transfers'),
    select: (r) => r.data,
  });
}

export function useTransfer(id: string) {
  const api = useApiClient();
  return useQuery<TransferResponse, Error, Transfer>({
    queryKey: ['transfers', id],
    queryFn: () => api.fetch<TransferResponse>(`/v1/me/transfers/${id}`),
    select: (r) => r.transfer,
    enabled: id.length > 0,
  });
}

export function useInitiateTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, { vehicleId: string }>({
    mutationFn: ({ vehicleId }) =>
      api.fetch<Transfer>('/v1/me/transfers', {
        method: 'POST',
        body: { vehicleId, method: 'physical_code' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
    },
  });
}

// A GET modeled as a mutation: the preview runs on the "Verifica" tap, not on
// mount or while typing (spec §Dati), and its lifecycle (pending/error) drives
// the button state exactly like a write would.
export function useTransferPreview() {
  const api = useApiClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (code) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${code}/preview`);
      return r.transfer;
    },
  });
}

export function useAcceptTransfer() {
  const api = useApiClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (code) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${code}/accept`, {
        method: 'POST',
      });
      return r.transfer;
    },
  });
}

export function useConfirmTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, string>({
    mutationFn: async (id) => {
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${id}/confirm`, {
        method: 'POST',
      });
      return r.transfer;
    },
    onSuccess: (_t, id) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfers', id] });
      void qc.invalidateQueries({ queryKey: ['me', 'vehicles'] });
    },
  });
}

export function useRejectTransfer() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<Transfer, Error, { id: string; reason?: string }>({
    mutationFn: async ({ id, reason }) => {
      // Always send a JSON body: the api-client only sets Content-Type when a
      // body is present, and the route parses `request.body ?? {}`.
      const r = await api.fetch<TransferResponse>(`/v1/me/transfers/${id}/reject`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
      return r.transfer;
    },
    onSuccess: (_t, { id }) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['transfers', id] });
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @garageos/mobile exec jest tests/queries/transfers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/queries/transfers.ts packages/mobile/tests/queries/transfers.test.tsx
git commit -m "feat(mobile): transfer query hooks (F-CLI-401)"
```

---

### Task 3: Lista trasferimenti — `app/transfers/index.tsx`

**Files:**
- Create: `packages/mobile/app/transfers/index.tsx`
- Test: `packages/mobile/tests/screens/transfers-list.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/mobile/tests/screens/transfers-list.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react-native';
import TransfersScreen from '../../app/transfers/index';
import type { Transfer } from '@/lib/types/transfer';

const mockPush = jest.fn();
let mockTransfersState: ReturnType<typeof makeState>;

const TRANSFER: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn().mockResolvedValue({}),
    data: [TRANSFER],
    ...overrides,
  };
}

jest.mock('@/queries/transfers', () => ({
  useTransfers: () => mockTransfersState,
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
}));

describe('Transfers list screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransfersState = makeState();
  });

  it('renders a card per transfer with vehicle, status label and date', () => {
    render(<TransfersScreen />);
    expect(screen.getByText('Fiat Panda')).toBeOnTheScreen();
    expect(screen.getByText('AB123CD')).toBeOnTheScreen();
    expect(screen.getByText('In attesa del nuovo proprietario')).toBeOnTheScreen();
    expect(screen.getByText('Avviato il 10/06/2026')).toBeOnTheScreen();
  });

  it('navigates to the detail on card tap', () => {
    render(<TransfersScreen />);
    fireEvent.press(screen.getByTestId(`transfer-row-${TRANSFER.id}`));
    expect(mockPush).toHaveBeenCalledWith(`/transfers/${TRANSFER.id}`);
  });

  it('shows the empty state when there are no transfers', () => {
    mockTransfersState = makeState({ data: [] });
    render(<TransfersScreen />);
    expect(screen.getByText('Nessun trasferimento')).toBeOnTheScreen();
  });

  it('always offers the "Hai ricevuto un codice?" entry to accept-transfer', () => {
    render(<TransfersScreen />);
    fireEvent.press(screen.getByText('Hai ricevuto un codice?'));
    expect(mockPush).toHaveBeenCalledWith('/accept-transfer');
  });

  it('shows the error state with the fallback message', () => {
    mockTransfersState = makeState({ isError: true, data: undefined });
    render(<TransfersScreen />);
    expect(screen.getByText('Si è verificato un errore. Riprova più tardi.')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfers-list.test.tsx`
Expected: FAIL — cannot find `../../app/transfers/index`.

- [ ] **Step 3: Implement**

`packages/mobile/app/transfers/index.tsx`:

```tsx
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTransfers } from '@/queries/transfers';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { TRANSFER_STATUS_LABELS, transferStatusTone } from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

export default function TransfersScreen() {
  const router = useRouter();
  const transfers = useTransfers();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await transfers.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [transfers]);

  if (transfers.isLoading) return <LoadingState variant="fullscreen" />;
  if (transfers.isError) {
    const code = transfers.error instanceof ApiError ? transfers.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={transfers.refetch} />;
  }

  const items = transfers.data ?? [];

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferimenti' }} />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.body}
        data={items}
        keyExtractor={(t) => t.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <Pressable
            onPress={() => router.push('/accept-transfer')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.receivedBtn, pressed && styles.pressed]}
          >
            <Text style={styles.receivedBtnText}>Hai ricevuto un codice?</Text>
          </Pressable>
        }
        ListEmptyComponent={
          <EmptyState
            title="Nessun trasferimento"
            body="Quando avvierai il passaggio di proprietà di un veicolo lo vedrai qui."
          />
        }
        renderItem={({ item }) => <TransferRow transfer={item} />}
      />
    </>
  );
}

function TransferRow({ transfer }: { transfer: Transfer }) {
  const router = useRouter();
  const tone = transferStatusTone(transfer.status);
  return (
    <Pressable
      testID={`transfer-row-${transfer.id}`}
      onPress={() => router.push(`/transfers/${transfer.id}`)}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>
          {transfer.vehicle.make} {transfer.vehicle.model}
        </Text>
        <View
          style={[
            styles.badge,
            tone === 'pending'
              ? styles.badgePending
              : tone === 'done'
                ? styles.badgeDone
                : styles.badgeClosed,
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              tone === 'pending'
                ? styles.badgeTextPending
                : tone === 'done'
                  ? styles.badgeTextDone
                  : styles.badgeTextClosed,
            ]}
          >
            {TRANSFER_STATUS_LABELS[transfer.status]}
          </Text>
        </View>
      </View>
      <Text style={styles.cardPlate}>{transfer.vehicle.plate}</Text>
      <Text style={styles.cardDate}>Avviato il {formatDate(transfer.createdAt)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  receivedBtn: {
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  receivedBtnText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  card: {
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.fg, flexShrink: 1 },
  cardPlate: { fontSize: 14, color: colors.fg },
  cardDate: { fontSize: 12, color: colors.muted },
  badge: { borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgePending: { backgroundColor: colors.warningBg },
  badgeDone: { backgroundColor: colors.mutedBg, borderWidth: 1, borderColor: colors.primary },
  badgeClosed: { backgroundColor: colors.dangerBg },
  badgeText: { fontSize: 11, fontWeight: '600' },
  badgeTextPending: { color: colors.warningFg },
  badgeTextDone: { color: colors.primary },
  badgeTextClosed: { color: colors.danger },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfers-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/transfers/index.tsx packages/mobile/tests/screens/transfers-list.test.tsx
git commit -m "feat(mobile): transfers list screen (F-CLI-402)"
```

---

### Task 4: Avvio trasferimento — `app/transfers/new.tsx`

**Files:**
- Create: `packages/mobile/app/transfers/new.tsx`
- Test: `packages/mobile/tests/screens/transfer-new.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/mobile/tests/screens/transfer-new.test.tsx`:

```tsx
import { Share } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import NewTransferScreen from '../../app/transfers/new';
import { ApiError } from '@/lib/api-error';
import type { Transfer } from '@/lib/types/transfer';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockMutateAsync = jest.fn();
let mockParams: Record<string, string | undefined>;

const TRANSFER: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

jest.mock('@/queries/transfers', () => ({
  useInitiateTransfer: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mockBack, replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

describe('New transfer screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {
      vehicleId: TRANSFER.vehicleId,
      vehicleLabel: 'Fiat Panda · AB123CD',
    };
  });

  it('renders the summary with vehicle label and 7-day warning', () => {
    render(<NewTransferScreen />);
    expect(screen.getByText('Fiat Panda · AB123CD')).toBeOnTheScreen();
    expect(screen.getByText(/valido 7 giorni/)).toBeOnTheScreen();
    expect(screen.getByText(/resta di tua proprietà/)).toBeOnTheScreen();
  });

  it('shows an error state for an invalid vehicleId param', () => {
    mockParams = { vehicleId: 'not-a-uuid' };
    render(<NewTransferScreen />);
    expect(screen.getByText('Veicolo non valido.')).toBeOnTheScreen();
  });

  it('initiates the transfer and shows the code screen with share', async () => {
    mockMutateAsync.mockResolvedValue(TRANSFER);
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<NewTransferScreen />);
    fireEvent.press(screen.getByText('Avvia trasferimento'));
    await waitFor(() => expect(screen.getByTestId('transfer-code')).toBeOnTheScreen());
    expect(mockMutateAsync).toHaveBeenCalledWith({ vehicleId: TRANSFER.vehicleId });
    expect(screen.getByText('TR-ABCD-2345')).toBeOnTheScreen();

    fireEvent.press(screen.getByText('Condividi'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    expect(shareSpy.mock.calls[0]![0].message).toContain('TR-ABCD-2345');

    fireEvent.press(screen.getByText('Fine'));
    expect(mockReplace).toHaveBeenCalledWith(`/transfers/${TRANSFER.id}`);
  });

  it('maps an already_pending API error to the Italian banner', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError('transfer.creation.already_pending', 409, 'x'),
    );
    render(<NewTransferScreen />);
    fireEvent.press(screen.getByText('Avvia trasferimento'));
    await waitFor(() =>
      expect(
        screen.getByText("C'è già un trasferimento attivo per questo veicolo."),
      ).toBeOnTheScreen(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfer-new.test.tsx`
Expected: FAIL — cannot find `../../app/transfers/new`.

- [ ] **Step 3: Implement**

`packages/mobile/app/transfers/new.tsx`:

```tsx
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useInitiateTransfer } from '@/queries/transfers';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { transferShareMessage } from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Phase = { name: 'summary' } | { name: 'code'; transfer: Transfer };

export default function NewTransferScreen() {
  const params = useLocalSearchParams<{ vehicleId?: string; vehicleLabel?: string }>();
  const vehicleId =
    typeof params.vehicleId === 'string' && UUID_RE.test(params.vehicleId) ? params.vehicleId : '';
  const vehicleLabel =
    typeof params.vehicleLabel === 'string' && params.vehicleLabel
      ? params.vehicleLabel
      : 'Questo veicolo';
  const router = useRouter();
  const initiate = useInitiateTransfer();
  const [phase, setPhase] = useState<Phase>({ name: 'summary' });
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!vehicleId) {
    return <ErrorState message="Veicolo non valido." />;
  }

  async function onStart() {
    if (submitting) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const t = await initiate.mutateAsync({ vehicleId });
      setPhase({ name: 'code', transfer: t });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferisci proprietà' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {banner ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{banner}</Text>
          </View>
        ) : null}

        {phase.name === 'summary' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Veicolo</Text>
              <Text style={styles.value}>{vehicleLabel}</Text>
            </View>
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                Riceverai un codice da comunicare al nuovo proprietario, valido 7 giorni. Il
                veicolo resta di tua proprietà finché non confermerai il passaggio.
              </Text>
            </View>
            <Pressable
              onPress={() => void onStart()}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryFg} />
              ) : (
                <Text style={styles.primaryBtnText}>Avvia trasferimento</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              disabled={submitting}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Annulla</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.codeTitle}>Codice generato</Text>
            <Text style={styles.code} testID="transfer-code">
              {phase.transfer.transferCode}
            </Text>
            <Text style={styles.hint}>
              Comunica questo codice al nuovo proprietario. Scade il{' '}
              {formatDate(phase.transfer.expiresAt)}.
            </Text>
            <Pressable
              onPress={() => void Share.share({ message: transferShareMessage(phase.transfer) })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Condividi</Text>
            </Pressable>
            <Pressable
              onPress={() => router.replace(`/transfers/${phase.transfer.id}`)}
              accessibilityRole="button"
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Fine</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  label: { fontSize: 12, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 16, color: colors.fg },
  warningBox: { backgroundColor: colors.warningBg, padding: spacing.md, borderRadius: 8 },
  warningText: { color: colors.warningFg, fontSize: 13, lineHeight: 18 },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  primaryBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  disabled: { backgroundColor: colors.muted },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
  codeTitle: { fontSize: 16, fontWeight: '600', color: colors.fg, textAlign: 'center' },
  code: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.fg,
    textAlign: 'center',
    letterSpacing: 2,
    paddingVertical: spacing.md,
    backgroundColor: colors.mutedBg,
    borderRadius: 8,
    overflow: 'hidden',
  },
  hint: { fontSize: 13, color: colors.muted, textAlign: 'center' },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfer-new.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/transfers/new.tsx packages/mobile/tests/screens/transfer-new.test.tsx
git commit -m "feat(mobile): initiate transfer screen with share code"
```

---

### Task 5: Dettaglio trasferimento — `app/transfers/[id].tsx`

**Files:**
- Create: `packages/mobile/app/transfers/[id].tsx`
- Test: `packages/mobile/tests/screens/transfer-detail.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/mobile/tests/screens/transfer-detail.test.tsx`:

```tsx
import { Alert, Share } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import TransferDetailScreen from '../../app/transfers/[id]';
import type { Transfer, TransferStatus } from '@/lib/types/transfer';

const mockConfirmMutate = jest.fn();
const mockRejectMutate = jest.fn();
let mockDetailState: ReturnType<typeof makeState>;

const BASE: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

function makeState(transfer: Transfer) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
    data: transfer,
  };
}
function withStatus(status: TransferStatus, extra: Partial<Transfer> = {}): Transfer {
  return { ...BASE, status, ...extra };
}

jest.mock('@/queries/transfers', () => ({
  useTransfer: () => mockDetailState,
  useConfirmTransfer: () => ({ mutate: mockConfirmMutate, isPending: false, error: null }),
  useRejectTransfer: () => ({ mutate: mockRejectMutate, isPending: false, error: null }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
}));

describe('Transfer detail screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetailState = makeState(BASE);
  });

  it('pending_recipient: shows code, share and cancel action', () => {
    render(<TransferDetailScreen />);
    expect(screen.getByTestId('transfer-code')).toBeOnTheScreen();
    expect(screen.getByText('TR-ABCD-2345')).toBeOnTheScreen();
    expect(screen.getByText('Condividi')).toBeOnTheScreen();
    expect(screen.getByText('Annulla trasferimento')).toBeOnTheScreen();
    expect(screen.getByText('In attesa del nuovo proprietario')).toBeOnTheScreen();
  });

  it('cancel asks for confirmation, then rejects', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Annulla trasferimento'));
    expect(alertSpy).toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0]![2]!;
    const confirmBtn = buttons.find((b) => b.style === 'destructive')!;
    confirmBtn.onPress!();
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: BASE.id });
  });

  it('share hands the message to Share.share', () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Condividi'));
    expect(shareSpy).toHaveBeenCalled();
    expect(shareSpy.mock.calls[0]![0].message).toContain('TR-ABCD-2345');
  });

  it('pending_seller_confirmation: confirm dialog warns about definitive transfer', () => {
    mockDetailState = makeState(withStatus('pending_seller_confirmation'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Conferma passaggio'));
    expect(alertSpy.mock.calls[0]![1]).toMatch(/definitivamente/);
    const buttons = alertSpy.mock.calls[0]![2]!;
    buttons.find((b) => b.text === 'Conferma')!.onPress!();
    expect(mockConfirmMutate).toHaveBeenCalledWith(BASE.id);
  });

  it('pending_seller_confirmation: reject asks confirmation then rejects', () => {
    mockDetailState = makeState(withStatus('pending_seller_confirmation'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Rifiuta'));
    const buttons = alertSpy.mock.calls[0]![2]!;
    buttons.find((b) => b.style === 'destructive')!.onPress!();
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: BASE.id });
  });

  it('completed: read-only with completion date, no actions', () => {
    mockDetailState = makeState(
      withStatus('completed', { completedAt: '2026-06-12T10:00:00.000Z', transferCode: null }),
    );
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Completato il 12\/06\/2026/)).toBeOnTheScreen();
    expect(screen.queryByText('Conferma passaggio')).toBeNull();
    expect(screen.queryByText('Annulla trasferimento')).toBeNull();
  });

  it('rejected: shows the reason when present', () => {
    mockDetailState = makeState(withStatus('rejected', { rejectedReason: 'Cambio idea' }));
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Cambio idea/)).toBeOnTheScreen();
  });

  it('expired: read-only with expiry date', () => {
    mockDetailState = makeState(withStatus('expired'));
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Scaduto il 17\/06\/2026/)).toBeOnTheScreen();
    expect(screen.queryByText('Condividi')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfer-detail.test.tsx`
Expected: FAIL — cannot find `../../app/transfers/[id]`.

- [ ] **Step 3: Implement**

`packages/mobile/app/transfers/[id].tsx`:

```tsx
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useConfirmTransfer, useRejectTransfer, useTransfer } from '@/queries/transfers';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import {
  TRANSFER_STATUS_LABELS,
  transferShareMessage,
  transferStatusTone,
} from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TransferDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const detail = useTransfer(id);
  const confirm = useConfirmTransfer();
  const reject = useRejectTransfer();

  if (!id) return <ErrorState message="Trasferimento non trovato." />;
  if (detail.isLoading) return <LoadingState variant="fullscreen" />;
  if (detail.isError || !detail.data) {
    const code = detail.error instanceof ApiError ? detail.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
  }

  const t = detail.data;
  const tone = transferStatusTone(t.status);
  const busy = confirm.isPending || reject.isPending;
  const mutationError = confirm.error ?? reject.error;

  function onCancelTransfer() {
    Alert.alert('Annullare il trasferimento?', 'Il codice non sarà più utilizzabile.', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Annulla trasferimento',
        style: 'destructive',
        onPress: () => reject.mutate({ id }),
      },
    ]);
  }

  function onConfirmTransfer() {
    Alert.alert(
      'Confermare il passaggio?',
      'La proprietà del veicolo passerà definitivamente al nuovo proprietario.',
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Conferma', onPress: () => confirm.mutate(id) },
      ],
    );
  }

  function onRejectTransfer() {
    Alert.alert('Rifiutare il trasferimento?', 'Il veicolo resterà di tua proprietà.', [
      { text: 'No', style: 'cancel' },
      { text: 'Rifiuta', style: 'destructive', onPress: () => reject.mutate({ id }) },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferimento' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {t.vehicle.make} {t.vehicle.model}
          </Text>
          <Text style={styles.cardPlate}>{t.vehicle.plate}</Text>
        </View>

        <View
          style={[
            styles.badge,
            tone === 'pending'
              ? styles.badgePending
              : tone === 'done'
                ? styles.badgeDone
                : styles.badgeClosed,
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              tone === 'pending'
                ? styles.badgeTextPending
                : tone === 'done'
                  ? styles.badgeTextDone
                  : styles.badgeTextClosed,
            ]}
          >
            {TRANSFER_STATUS_LABELS[t.status]}
          </Text>
        </View>
        <Text style={styles.meta}>Avviato il {formatDate(t.createdAt)}</Text>

        {mutationError ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>
              {mapErrorToUserMessage(
                mutationError instanceof ApiError ? mutationError.code : undefined,
              )}
            </Text>
          </View>
        ) : null}

        {t.status === 'pending_recipient' ? (
          <>
            <Text style={styles.code} testID="transfer-code">
              {t.transferCode}
            </Text>
            <Text style={styles.hint}>
              Comunica questo codice al nuovo proprietario. Scade il {formatDate(t.expiresAt)}.
            </Text>
            <Pressable
              onPress={() => void Share.share({ message: transferShareMessage(t) })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Condividi</Text>
            </Pressable>
            <Pressable
              onPress={onCancelTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
            >
              <Text style={styles.dangerBtnText}>Annulla trasferimento</Text>
            </Pressable>
          </>
        ) : null}

        {t.status === 'pending_seller_confirmation' ? (
          <>
            <Text style={styles.hint}>
              Il nuovo proprietario ha accettato. Conferma per completare il passaggio entro il{' '}
              {formatDate(t.expiresAt)}.
            </Text>
            <Pressable
              onPress={onConfirmTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Conferma passaggio</Text>
            </Pressable>
            <Pressable
              onPress={onRejectTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
            >
              <Text style={styles.dangerBtnText}>Rifiuta</Text>
            </Pressable>
          </>
        ) : null}

        {t.status === 'completed' ? (
          <Text style={styles.meta}>Completato il {formatDate(t.completedAt)}.</Text>
        ) : null}

        {t.status === 'rejected' ? (
          <>
            <Text style={styles.meta}>Trasferimento rifiutato.</Text>
            {t.rejectedReason ? <Text style={styles.meta}>Motivo: {t.rejectedReason}</Text> : null}
          </>
        ) : null}

        {t.status === 'expired' ? (
          <Text style={styles.meta}>Scaduto il {formatDate(t.expiresAt)}.</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  cardPlate: { fontSize: 15, color: colors.fg },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgePending: { backgroundColor: colors.warningBg },
  badgeDone: { backgroundColor: colors.mutedBg, borderWidth: 1, borderColor: colors.primary },
  badgeClosed: { backgroundColor: colors.dangerBg },
  badgeText: { fontSize: 13, fontWeight: '600' },
  badgeTextPending: { color: colors.warningFg },
  badgeTextDone: { color: colors.primary },
  badgeTextClosed: { color: colors.danger },
  meta: { fontSize: 14, color: colors.muted },
  code: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.fg,
    textAlign: 'center',
    letterSpacing: 2,
    paddingVertical: spacing.md,
    backgroundColor: colors.mutedBg,
    borderRadius: 8,
    overflow: 'hidden',
  },
  hint: { fontSize: 13, color: colors.muted },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  dangerBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtnText: { color: colors.danger, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
});
```

Note: after a successful confirm/reject, `useConfirmTransfer`/`useRejectTransfer` invalidate `['transfers', id]`, the detail refetches and the screen re-renders in its new (terminal) state — no navigation needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/transfer-detail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "packages/mobile/app/transfers/[id].tsx" packages/mobile/tests/screens/transfer-detail.test.tsx
git commit -m "feat(mobile): transfer detail with confirm/reject (F-CLI-403)"
```

---

### Task 6: Accettazione cessionario — `app/accept-transfer.tsx`

**Files:**
- Create: `packages/mobile/app/accept-transfer.tsx`
- Test: `packages/mobile/tests/screens/accept-transfer.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/mobile/tests/screens/accept-transfer.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import AcceptTransferScreen from '../../app/accept-transfer';
import { ApiError } from '@/lib/api-error';
import type { Transfer } from '@/lib/types/transfer';

const mockReplace = jest.fn();
const mockPreviewMutateAsync = jest.fn();
const mockAcceptMutateAsync = jest.fn();
let mockParams: Record<string, string | undefined>;

const TRANSFER: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

jest.mock('@/queries/transfers', () => ({
  useTransferPreview: () => ({ mutateAsync: mockPreviewMutateAsync, isPending: false }),
  useAcceptTransfer: () => ({ mutateAsync: mockAcceptMutateAsync, isPending: false }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

describe('Accept transfer screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
  });

  it('rejects a malformed code client-side without calling the API', () => {
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-XX');
    fireEvent.press(screen.getByText('Verifica'));
    expect(screen.getByText('Codice non valido. Formato: TR-XXXX-XXXX')).toBeOnTheScreen();
    expect(mockPreviewMutateAsync).not.toHaveBeenCalled();
  });

  it('verifies the code and shows the vehicle preview card', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'tr-abcd-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Fiat Panda')).toBeOnTheScreen());
    expect(mockPreviewMutateAsync).toHaveBeenCalledWith('TR-ABCD-2345');
    expect(screen.getByText('AB123CD')).toBeOnTheScreen();
    expect(screen.getByText(/Scade il 17\/06\/2026/)).toBeOnTheScreen();
    expect(screen.getByText('Accetta')).toBeOnTheScreen();
  });

  it('accepts from the preview and lands on the waiting-for-seller outcome', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    mockAcceptMutateAsync.mockResolvedValue({
      ...TRANSFER,
      status: 'pending_seller_confirmation',
    });
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Accetta')).toBeOnTheScreen());
    fireEvent.press(screen.getByText('Accetta'));
    await waitFor(() =>
      expect(screen.getByText(/In attesa della conferma del venditore/)).toBeOnTheScreen(),
    );
    expect(mockAcceptMutateAsync).toHaveBeenCalledWith('TR-ABCD-2345');
    fireEvent.press(screen.getByText('Fine'));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('"Indietro" returns from the preview to the input', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Indietro')).toBeOnTheScreen());
    fireEvent.press(screen.getByText('Indietro'));
    expect(screen.getByTestId('transfer-code-input')).toBeOnTheScreen();
  });

  it('maps an expired (410) preview error to the Italian banner', async () => {
    mockPreviewMutateAsync.mockRejectedValue(
      new ApiError('transfer.acceptance.expired', 410, 'x'),
    );
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() =>
      expect(
        screen.getByText('Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.'),
      ).toBeOnTheScreen(),
    );
  });

  it('prefills a well-formed ?code param (claim-vehicle redirect)', () => {
    mockParams = { code: 'TR-ABCD-2345' };
    render(<AcceptTransferScreen />);
    expect(screen.getByTestId('transfer-code-input').props.value).toBe('TR-ABCD-2345');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/accept-transfer.test.tsx`
Expected: FAIL — cannot find `../../app/accept-transfer`.

- [ ] **Step 3: Implement**

`packages/mobile/app/accept-transfer.tsx`:

```tsx
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAcceptTransfer, useTransferPreview } from '@/queries/transfers';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { TRANSFER_CODE_RE, validateTransferCode } from '@/lib/validators/transfer';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

type Phase = { name: 'input' } | { name: 'preview'; transfer: Transfer } | { name: 'accepted' };

export default function AcceptTransferScreen() {
  const router = useRouter();
  // claim-vehicle redirects here with the TR code it detected; pre-fill only a
  // well-formed code (mirror of the GO-code prefill in claim-vehicle.tsx).
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();
  const normalizedParam =
    typeof codeParam === 'string' ? codeParam.trim().toUpperCase() : undefined;
  const initialCode =
    normalizedParam && TRANSFER_CODE_RE.test(normalizedParam) ? normalizedParam : '';

  const [code, setCode] = useState(initialCode);
  const [phase, setPhase] = useState<Phase>({ name: 'input' });
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const preview = useTransferPreview();
  const accept = useAcceptTransfer();

  async function onVerify() {
    if (submitting) return;
    const normalized = code.trim().toUpperCase();
    const err = validateTransferCode(normalized);
    setFieldError(err);
    if (err) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const t = await preview.mutateAsync(normalized);
      setPhase({ name: 'preview', transfer: t });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  async function onAccept(t: Transfer) {
    if (submitting) return;
    setBanner(null);
    setSubmitting(true);
    try {
      await accept.mutateAsync(t.transferCode ?? code.trim().toUpperCase());
      setPhase({ name: 'accepted' });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Accetta trasferimento' }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {banner ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{banner}</Text>
          </View>
        ) : null}

        {phase.name === 'input' ? (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Codice trasferimento</Text>
              <TextInput
                testID="transfer-code-input"
                style={styles.input}
                value={code}
                onChangeText={setCode}
                placeholder="TR-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                editable={!submitting}
              />
              <Text style={styles.hint}>Te lo fornisce chi ti sta cedendo il veicolo.</Text>
              {fieldError ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
            </View>
            <Pressable
              onPress={() => void onVerify()}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryFg} />
              ) : (
                <Text style={styles.primaryBtnText}>Verifica</Text>
              )}
            </Pressable>
          </>
        ) : null}

        {phase.name === 'preview' ? (
          <>
            <Text style={styles.sectionTitle}>Stai per ricevere</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {phase.transfer.vehicle.make} {phase.transfer.vehicle.model}
              </Text>
              <Text style={styles.cardPlate}>{phase.transfer.vehicle.plate}</Text>
            </View>
            <Text style={styles.hint}>Scade il {formatDate(phase.transfer.expiresAt)}.</Text>
            <Pressable
              onPress={() => void onAccept(phase.transfer)}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryFg} />
              ) : (
                <Text style={styles.primaryBtnText}>Accetta</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => setPhase({ name: 'input' })}
              accessibilityRole="button"
              disabled={submitting}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Indietro</Text>
            </Pressable>
          </>
        ) : null}

        {phase.name === 'accepted' ? (
          <>
            <Text style={styles.sectionTitle}>Richiesta inviata</Text>
            <Text style={styles.outcome}>
              In attesa della conferma del venditore. Il veicolo comparirà tra i tuoi veicoli
              quando il venditore confermerà il passaggio.
            </Text>
            <Pressable
              onPress={() => router.replace('/')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Fine</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
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
  hint: { fontSize: 12, color: colors.muted },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  cardPlate: { fontSize: 15, color: colors.fg },
  outcome: { fontSize: 14, color: colors.fg, lineHeight: 20 },
  primaryBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  disabled: { backgroundColor: colors.muted },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/mobile exec jest tests/screens/accept-transfer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/app/accept-transfer.tsx packages/mobile/tests/screens/accept-transfer.test.tsx
git commit -m "feat(mobile): accept transfer screen with preview"
```

---

### Task 7: Entry points — vehicle detail, Profilo, claim-vehicle auto-detect

**Files:**
- Create: `packages/mobile/src/components/VehicleTransferSection.tsx`
- Modify: `packages/mobile/app/(tabs)/vehicles/[id].tsx` (TechTab, after the export section)
- Modify: `packages/mobile/app/(tabs)/profile.tsx` (nav row after "Notifiche")
- Modify: `packages/mobile/src/components/ClaimVehicleForm.tsx` (TR- detect + hint)
- Modify: `packages/mobile/app/claim-vehicle.tsx` (redirect handler)
- Test: `packages/mobile/tests/components/VehicleTransferSection.test.tsx`
- Test: `packages/mobile/tests/components/ClaimVehicleForm.test.tsx` (append)

- [ ] **Step 1: Write the failing tests**

`packages/mobile/tests/components/VehicleTransferSection.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react-native';
import { VehicleTransferSection } from '@/components/VehicleTransferSection';
import type { Transfer } from '@/lib/types/transfer';

const mockPush = jest.fn();
let mockTransfersState: { isLoading: boolean; data: Transfer[] | undefined };

const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: VEHICLE_ID,
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

jest.mock('@/queries/transfers', () => ({
  useTransfers: () => mockTransfersState,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('VehicleTransferSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransfersState = { isLoading: false, data: [] };
  });

  it('shows the transfer button when no active transfer exists', () => {
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    fireEvent.press(screen.getByText('Trasferisci proprietà'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/transfers/new',
      params: { vehicleId: VEHICLE_ID, vehicleLabel: 'Fiat Panda · AB123CD' },
    });
  });

  it('shows the in-progress banner when an active transfer exists for THIS vehicle', () => {
    mockTransfersState = { isLoading: false, data: [ACTIVE] };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    fireEvent.press(screen.getByText('Trasferimento in corso'));
    expect(mockPush).toHaveBeenCalledWith(`/transfers/${ACTIVE.id}`);
    expect(screen.queryByText('Trasferisci proprietà')).toBeNull();
  });

  it('ignores terminal transfers and other vehicles', () => {
    mockTransfersState = {
      isLoading: false,
      data: [
        { ...ACTIVE, status: 'rejected' },
        { ...ACTIVE, id: 'other', vehicleId: 'another-vehicle' },
      ],
    };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    expect(screen.getByText('Trasferisci proprietà')).toBeOnTheScreen();
  });

  it('renders nothing while the transfers list is loading', () => {
    mockTransfersState = { isLoading: true, data: undefined };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    expect(screen.queryByText('Trasferisci proprietà')).toBeNull();
    expect(screen.queryByText('Trasferimento in corso')).toBeNull();
  });
});
```

Append to `packages/mobile/tests/components/ClaimVehicleForm.test.tsx` (inside the existing top-level `describe`; reuse the file's existing mock/render helpers — if it renders with explicit props, pass the new `onTransferCode` only in these tests):

```tsx
  it('detects a TR- code and hands it to onTransferCode without submitting', async () => {
    const onSubmit = jest.fn();
    const onTransferCode = jest.fn();
    render(
      <ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} onTransferCode={onTransferCode} />,
    );
    fireEvent.changeText(screen.getByPlaceholderText('GO-NNN-AAAA'), 'tr-abcd-2345');
    fireEvent.press(screen.getByText('Aggiungi'));
    await waitFor(() => expect(onTransferCode).toHaveBeenCalledWith('TR-ABCD-2345'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('without onTransferCode a TR- input falls through to normal validation', () => {
    const onSubmit = jest.fn();
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('GO-NNN-AAAA'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Aggiungi'));
    expect(onSubmit).not.toHaveBeenCalled(); // fails GO validation, stays client-side
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @garageos/mobile exec jest tests/components/VehicleTransferSection.test.tsx tests/components/ClaimVehicleForm.test.tsx`
Expected: FAIL — `VehicleTransferSection` not found; `onTransferCode` prop unknown / not called.

- [ ] **Step 3: Implement**

`packages/mobile/src/components/VehicleTransferSection.tsx`:

```tsx
// Entry point to the ownership-transfer flow from the vehicle detail TechTab
// (F-CLI-401). Derives "transfer in progress" from the seller's transfers list
// (no dedicated endpoint, spec §Punti d'ingresso): active transfer for this
// vehicle → banner to its detail; otherwise → button to /transfers/new.
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTransfers } from '@/queries/transfers';
import { isTransferActive, TRANSFER_STATUS_LABELS } from '@/lib/transfer-labels';
import { colors, spacing } from '@/theme/colors';

type Props = { vehicleId: string; vehicleLabel: string };

export function VehicleTransferSection({ vehicleId, vehicleLabel }: Props) {
  const router = useRouter();
  const transfers = useTransfers();

  // While loading render nothing (the section pops in); on error fall back to
  // the button — the server re-guards BR-047 with already_pending anyway.
  if (transfers.isLoading) return null;

  const active = (transfers.data ?? []).find(
    (t) => t.vehicleId === vehicleId && isTransferActive(t.status),
  );

  if (active) {
    return (
      <Pressable
        testID="transfer-in-progress-banner"
        onPress={() => router.push(`/transfers/${active.id}`)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      >
        <Text style={styles.bannerTitle}>Trasferimento in corso</Text>
        <Text style={styles.bannerBody}>
          {TRANSFER_STATUS_LABELS[active.status]} — tocca per i dettagli
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      testID="transfer-vehicle-button"
      onPress={() => router.push({ pathname: '/transfers/new', params: { vehicleId, vehicleLabel } })}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>Trasferisci proprietà</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  banner: {
    backgroundColor: colors.warningBg,
    padding: spacing.md,
    borderRadius: 8,
    gap: spacing.xs,
  },
  bannerTitle: { color: colors.warningFg, fontSize: 14, fontWeight: '700' },
  bannerBody: { color: colors.warningFg, fontSize: 12 },
  pressed: { opacity: 0.7 },
});
```

In `packages/mobile/app/(tabs)/vehicles/[id].tsx`:
1. Add import: `import { VehicleTransferSection } from '@/components/VehicleTransferSection';`
2. In `TechTab`, after the `<View style={styles.exportSection}>…</View>` block, add:

```tsx
      <View style={styles.exportSection}>
        <VehicleTransferSection
          vehicleId={vehicle.id}
          vehicleLabel={`${vehicle.make} ${vehicle.model} · ${vehicle.plate}`}
        />
      </View>
```

In `packages/mobile/app/(tabs)/profile.tsx`, after the "Notifiche" nav row `</Pressable>`, add (same styles):

```tsx
      <Pressable
        onPress={() => router.push('/transfers')}
        accessibilityRole="button"
        accessibilityLabel="Trasferimenti"
        style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
      >
        <Text style={styles.navLabel}>Trasferimenti</Text>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Pressable>
```

In `packages/mobile/src/components/ClaimVehicleForm.tsx`:
1. Extend `Props`:

```tsx
type Props = {
  onSubmit: (garageCode: string) => Promise<ClaimVehicleFormResult>;
  onCancel: () => void;
  initialCode?: string;
  // F-CLI-401 auto-detect: a TR- code entered here belongs to the transfer
  // acceptance flow, not the GO claim. The parent redirects to /accept-transfer.
  onTransferCode?: (code: string) => void;
};
```

2. Destructure `onTransferCode` in the component signature.
3. At the top of `handleSubmit`, right after `const normalized = code.trim().toUpperCase();`:

```tsx
    if (onTransferCode && normalized.startsWith('TR-')) {
      onTransferCode(normalized);
      return;
    }
```

4. Update the hint `<Text style={styles.hint}>` to also mention the TR path:

```tsx
        <Text style={styles.hint}>
          {
            "Lo trovi sul tag adesivo del veicolo o nell'email dell'officina. Hai un codice TR- per un passaggio di proprietà? Inseriscilo qui."
          }
        </Text>
```

In `packages/mobile/app/claim-vehicle.tsx`, pass the new prop to `<ClaimVehicleForm>`:

```tsx
        <ClaimVehicleForm
          onSubmit={onSubmit}
          onCancel={() => router.back()}
          initialCode={initialCode}
          onTransferCode={(c) =>
            router.push({ pathname: '/accept-transfer', params: { code: c } })
          }
        />
```

- [ ] **Step 4: Run tests to verify they pass (plus the touched suites)**

Run: `pnpm --filter @garageos/mobile exec jest tests/components/VehicleTransferSection.test.tsx tests/components/ClaimVehicleForm.test.tsx tests/screens/claim-vehicle.test.tsx tests/screens/profile-logout-push.test.tsx`
Expected: PASS — including the pre-existing claim-vehicle and profile suites (cascade check, lesson [[handler-change-breaks-unit-mock]]: if the profile/claim screen tests break on the new row/prop, fix their mocks, do not weaken the screens).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components packages/mobile/app packages/mobile/tests/components
git commit -m "feat(mobile): transfer entry points in vehicle, profile, claim"
```

---

### Task 8: Full suite, typecheck, smoke runbook, PR

**Files:**
- Create: `docs/superpowers/runbooks/F-CLI-401-pr5-smoke.md`

- [ ] **Step 1: Regenerate router types and run the full mobile suite + typecheck**

```bash
rm packages/mobile/.expo/types/router.d.ts
pnpm --filter @garageos/mobile exec jest
pnpm -r typecheck
```

Expected: all mobile suites PASS; typecheck clean on all 5 workspaces. (The `.expo` types file is gitignored and regenerated by tsc — removing it prevents stale-route TS errors.)

- [ ] **Step 2: Write the smoke runbook**

`docs/superpowers/runbooks/F-CLI-401-pr5-smoke.md`:

```markdown
# Smoke runbook — F-CLI-401 PR5 mobile transfer full flow (BLOCKER)

E2e a due account su device reale (Expo Go sideloaded SDK 52, `adb reverse tcp:8081`,
Metro con `npx expo start --offline`), API prod. Account A = venditore (possiede un
veicolo certificato), Account B = cessionario.

## Pre-requisiti
- [ ] Account A con almeno un veicolo certificato di cui è owner attivo.
- [ ] Account B cliente registrato, loggato su un secondo device o in sessione alternata.

## Flusso venditore (A)
- [ ] a. Detail veicolo → tab Dati tecnici → bottone "Trasferisci proprietà" visibile sotto export PDF.
- [ ] b. Tap → schermata riepilogo (label veicolo + avviso 7 giorni) → "Avvia trasferimento" → codice TR-XXXX-XXXX in evidenza.
- [ ] c. "Condividi" apre lo share sheet di sistema col messaggio (codice + veicolo + scadenza).
- [ ] d. "Fine" → dettaglio transfer: badge "In attesa del nuovo proprietario", codice + Condividi + "Annulla trasferimento".
- [ ] e. Tornare alla detail veicolo → al posto del bottone c'è il banner "Trasferimento in corso" → tap → dettaglio.
- [ ] f. Profilo → riga "Trasferimenti" → lista con la card del transfer (veicolo, badge, data).

## Flusso cessionario (B)
- [ ] g. Aggiungi veicolo (claim) → digitare il codice TR- → submit → auto-redirect a "Accetta trasferimento" col codice precompilato.
- [ ] h. "Verifica" → card veicolo (targa/marca/modello) + scadenza. NO PII venditore.
- [ ] i. "Accetta" → esito "In attesa della conferma del venditore".
- [ ] j. Il veicolo NON compare ancora nella lista veicoli di B (proprietà ferma, BR-043).

## Conferma venditore (A)
- [ ] k. Lista trasferimenti → pull-to-refresh → badge "In attesa della tua conferma".
- [ ] l. Dettaglio → "Conferma passaggio" → dialog "passerà definitivamente" → conferma.
- [ ] m. Stato → "Completato"; il veicolo SPARISCE dalla lista veicoli di A (invalidazione ['me','vehicles']).
- [ ] n. Su B: pull-to-refresh lista veicoli → il veicolo COMPARE. Storico officina visibile; interventi privati di A NON visibili (F-CLI-405).

## Rami alternativi
- [ ] o. Nuovo transfer su altro veicolo → "Annulla trasferimento" in pending_recipient → dialog → stato "Rifiutato"; bottone "Trasferisci proprietà" torna disponibile sulla detail veicolo.
- [ ] p. Transfer accettato da B → A "Rifiuta" in pending_seller_confirmation → stato "Rifiutato", proprietà ferma.
- [ ] q. Codice inesistente ben formato (es. TR-AAAA-2222) → "Codice o trasferimento non valido. Controlla e riprova."
- [ ] r. Codice proprio (A inserisce il suo TR) → "Questo trasferimento è stato avviato da te."

## Verifica claim green-path (nota checkpoint 2026-06-10)
- [ ] s. Dopo lo swap (step m): verificare che il claim GO-code green-path (`claimed` nuovo su veicolo certificato senza owner) resti NON testabile — lo swap è atomico, non esiste mai una finestra a zero owner. Annotare qui l'esito: ____
```

- [ ] **Step 3: Commit, push, open the PR**

```bash
git add docs/superpowers/runbooks/F-CLI-401-pr5-smoke.md docs/superpowers/plans/2026-06-10-F-CLI-401-pr5-transfer-mobile-ui.md
git commit -m "docs: add F-CLI-401 PR5 smoke runbook and plan"
git push origin feat/transfer-mobile-ui
```

Open the PR with `gh pr create` — title `feat(mobile): customer transfer full flow UI (F-CLI-401 PR5)`, body per CLAUDE.md template:
- **What**: 4 new screens (transfers list/new/detail + accept-transfer), transfer query hooks, 3 entry points, IT error mapping for the whole `transfer.*` family.
- **Why**: F-CLI-401→403/405 (spec `docs/superpowers/specs/2026-06-10-F-CLI-401-pr4-pr5-transfer-preview-and-mobile-ui-design.md` §PR5).
- **Implementation notes**: top-level standalone routes (#160 lesson); preview as mutation-style GET; confirm invalidates the REAL `['me','vehicles']` key (spec said `['vehicles']` — flagged as spec deviation); real API error codes mapped (spec table was indicative — flagged); `Share.share`, zero new deps.
- **Tests**: unit (validators/labels/errors), query hooks, 4 screen suites + 2 component suites. BR verified: BR-043 (two-step flow + confirm invalidation), BR-047 (banner derivation + already_pending mapping). Smoke device = runbook `F-CLI-401-pr5-smoke.md`, BLOCKER post-merge.
- Watch CI: `gh pr checks --watch`.

---

## Self-review (done at plan time)

1. **Spec coverage**: route table → Tasks 3-6; punti d'ingresso (detail veicolo, Profilo, claim auto-detect, link lista) → Task 7 + Task 3 header link; dati/invalidazioni → Task 2; errori IT → Task 1; stati→label → Task 1; test lean → per-task; smoke runbook + claim green-path note → Task 8. Reject lato venditore only: recipient screens expose no reject (spec §4). ✓
2. **Placeholders**: none — every file has complete code. ✓
3. **Type consistency**: `Transfer`/`TransferResponse`/`TransfersListResponse` (Task 1) used by Tasks 2-7; `transferShareMessage(t: Transfer)` consistent in Tasks 4-5; `useRejectTransfer` takes `{id, reason?}` everywhere; `validateTransferCode`/`TRANSFER_CODE_RE` consistent in Task 6-7. ✓

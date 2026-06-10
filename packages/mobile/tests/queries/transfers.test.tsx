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

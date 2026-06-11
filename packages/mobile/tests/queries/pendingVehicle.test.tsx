import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreatePendingVehicle } from '@/queries/pendingVehicle';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { CreatePendingVehicleRequest } from '@/lib/types/vehicle';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const request: CreatePendingVehicleRequest = {
  vin: 'ZFA31200003456789',
  plate: 'AB123CD',
  make: 'Fiat',
  model: 'Panda',
  year: 2019,
  vehicleType: 'car',
  fuelType: 'petrol',
};

describe('useCreatePendingVehicle', () => {
  it('POSTs the body to /v1/me/vehicles/pending and invalidates the vehicles list on success', async () => {
    // Echo the submitted body back so the assertion threads the dynamic
    // input through the mock instead of hardcoding a fixture.
    const apiFetch = jest
      .fn()
      .mockImplementation((_path: string, opts: { body: CreatePendingVehicleRequest }) =>
        Promise.resolve({
          vehicle: {
            id: 'veh-pending-1',
            garageCode: null,
            ...opts.body,
            plateCountry: 'IT',
            status: 'pending',
          },
          ownership: { id: 'own-1', startedAt: '2026-06-10T00:00:00.000Z' },
        }),
      );
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePendingVehicle(), { wrapper: makeWrapper(qc) });
    result.current.mutate(request);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/vehicles/pending', {
      method: 'POST',
      body: request,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'vehicles'] });
    expect(result.current.data?.vehicle.id).toBe('veh-pending-1');
    expect(result.current.data?.vehicle.garageCode).toBeNull();
    expect(result.current.data?.vehicle.vin).toBe(request.vin);
    expect(result.current.data?.vehicle.status).toBe('pending');
  });

  it('surfaces ApiError preserving the code', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(
        new ApiError('vehicle.pending.duplicate_vin_certified', 409, 'duplicate vin'),
      );
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePendingVehicle(), { wrapper: makeWrapper(qc) });
    result.current.mutate(request);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('vehicle.pending.duplicate_vin_certified');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

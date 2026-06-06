import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useClaimVehicle } from '@/queries/claimVehicle';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useClaimVehicle', () => {
  it('POSTs the garageCode and invalidates the vehicles list on success', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      vehicle: {
        id: 'veh1',
        garageCode: 'GO-234-ABCD',
        make: 'Fiat',
        model: 'Panda',
        year: 2018,
        plate: 'AA000BB',
      },
      ownership: { id: 'own1', startedAt: '2026-06-06T00:00:00.000Z' },
      status: 'claimed',
    });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useClaimVehicle(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ garageCode: 'GO-234-ABCD' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/vehicles/claim', {
      method: 'POST',
      body: { garageCode: 'GO-234-ABCD' },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'vehicles'] });
    expect(result.current.data?.vehicle.id).toBe('veh1');
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(new ApiError('me.vehicle.claim.owned_by_other', 409, 'owned'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useClaimVehicle(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ garageCode: 'GO-234-ABCD' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('me.vehicle.claim.owned_by_other');
  });
});

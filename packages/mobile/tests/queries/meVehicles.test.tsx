import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeVehiclesList, useMeVehicleDetail } from '@/queries/meVehicles';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useMeVehiclesList', () => {
  it('returns vehicle array on success', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      data: [
        {
          id: 'v1',
          garageCode: 'GO-001-AAAA',
          vin: '...',
          plate: 'AA000AA',
          plateCountry: 'IT',
          make: 'Fiat',
          model: 'Panda',
          year: 2020,
          vehicleType: 'car',
          fuelType: 'gasoline',
          status: 'active',
          currentOwnership: { id: 'o1', startedAt: '2024-01-01T00:00:00Z' },
        },
      ],
      meta: { has_more: false },
    });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeVehiclesList(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].plate).toBe('AA000AA');
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/vehicles');
  });
});

describe('useMeVehicleDetail', () => {
  it('surfaces me.vehicle.not_found on 404', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(new ApiError('me.vehicle.not_found', 404, 'not found'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeVehicleDetail('abc'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('me.vehicle.not_found');
  });

  it('does not run when id is empty', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeVehicleDetail(''), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

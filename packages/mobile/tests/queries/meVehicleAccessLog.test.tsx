import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeVehicleAccessLog } from '@/queries/meVehicleAccessLog';
import type { AccessLogPage } from '@/lib/types/accessLog';
import * as apiClientHook from '@/lib/use-api-client';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const page1: AccessLogPage = {
  data: [
    {
      action: 'view',
      tenantName: 'Officina Rossi',
      locationCity: 'Torino',
      occurredAt: '2026-06-05T12:00:00.000Z',
    },
  ],
  meta: { has_more: true, cursor: 'c1' },
};
const page2: AccessLogPage = {
  data: [
    {
      action: 'new_intervention',
      tenantName: 'Officina Verdi',
      locationCity: null,
      occurredAt: '2026-06-01T09:00:00.000Z',
      mechanicName: 'Mario Bianchi',
    },
  ],
  meta: { has_more: false },
};

describe('useMeVehicleAccessLog', () => {
  it('flattens pages and paginates with the cursor', async () => {
    const apiFetch = jest.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });

    const { result } = renderHook(() => useMeVehicleAccessLog('v1', { enabled: true }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.tenantName).toBe('Officina Rossi');
    expect(result.current.hasNextPage).toBe(true);
    expect(apiFetch).toHaveBeenLastCalledWith('/v1/me/vehicles/v1/access-log');

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
    expect(apiFetch).toHaveBeenLastCalledWith('/v1/me/vehicles/v1/access-log?cursor=c1');
  });

  it('does not fetch when disabled', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    renderHook(() => useMeVehicleAccessLog('v1', { enabled: false }), { wrapper: makeWrapper() });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMePrivateInterventionDetail } from '@/queries/mePrivateInterventionDetail';
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

describe('useMePrivateInterventionDetail', () => {
  it('fetches the detail by id', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ id: 'pi1', custom_type: 'Lavaggio' });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMePrivateInterventionDetail('pi1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/private-interventions/pi1');
  });

  it('does not run when id is empty', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMePrivateInterventionDetail(''), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(new ApiError('private_intervention.not_found', 404, 'nope'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMePrivateInterventionDetail('pi1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('private_intervention.not_found');
  });
});

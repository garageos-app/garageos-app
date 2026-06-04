import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useUpdatePrivateIntervention,
  useDeletePrivateIntervention,
} from '@/queries/privateInterventionMutations';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const BODY: CreatePrivateInterventionBody = {
  intervention_date: '2020-05-10',
  odometer_km: null,
  intervention_type_id: null,
  custom_type: 'Lavaggio',
  description: 'Aggiornata',
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useUpdatePrivateIntervention', () => {
  it('PATCHes the body and invalidates timeline + detail', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ id: 'pi1' });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdatePrivateIntervention('pi1', 'v1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(BODY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/private-interventions/pi1', {
      method: 'PATCH',
      body: BODY,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle', 'v1', 'timeline'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'private-intervention', 'pi1'] });
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('x', 422, 'bad'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpdatePrivateIntervention('pi1', 'v1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(BODY);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('x');
  });
});

describe('useDeletePrivateIntervention', () => {
  it('DELETEs and invalidates the timeline', async () => {
    const apiFetch = jest.fn().mockResolvedValue(undefined);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeletePrivateIntervention('pi1', 'v1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/private-interventions/pi1', { method: 'DELETE' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle', 'v1', 'timeline'] });
  });
});

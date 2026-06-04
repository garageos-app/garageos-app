import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreatePrivateIntervention } from '@/queries/createPrivateIntervention';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const BODY: CreatePrivateInterventionBody = {
  intervention_date: '2020-05-10',
  odometer_km: 120000,
  intervention_type_id: null,
  custom_type: 'Lavaggio',
  description: 'Lavaggio completo',
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useCreatePrivateIntervention', () => {
  it('POSTs the body to the vehicle endpoint and invalidates the timeline on success', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ id: 'pi1' });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePrivateIntervention('v1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(BODY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/vehicles/v1/private-interventions', {
      method: 'POST',
      body: BODY,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle', 'v1', 'timeline'] });
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest
      .fn()
      .mockRejectedValue(new ApiError('private_intervention.rate_limit', 429, 'too many'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useCreatePrivateIntervention('v1'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(BODY);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('private_intervention.rate_limit');
  });
});

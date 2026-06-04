import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeDeadlines } from '@/queries/meDeadlines';
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

describe('useMeDeadlines', () => {
  it('projects the deadlines array and calls the endpoint', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      deadlines: [
        {
          id: 'd1',
          vehicleId: 'v1',
          interventionTypeId: 't1',
          sourceInterventionId: null,
          dueDate: '2026-07-01',
          dueOdometerKm: null,
          description: 'Revisione biennale',
          isRecurring: false,
          recurringMonths: null,
          recurringKm: null,
          status: 'open',
          completedByInterventionId: null,
          completedAt: null,
          createdAt: '2026-06-01T00:00:00Z',
          updatedAt: '2026-06-01T00:00:00Z',
          vehicle: { id: 'v1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
          interventionType: { id: 't1', code: 'REVISIONE', nameIt: 'Revisione' },
        },
      ],
      nextCursor: null,
    });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeDeadlines(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.interventionType.nameIt).toBe('Revisione');
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/deadlines');
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('me.error', 500, 'boom'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeDeadlines(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('me.error');
  });
});

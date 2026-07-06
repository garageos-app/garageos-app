import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';
import * as apiClientHook from '@/lib/use-api-client';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useMeInterventionTypes', () => {
  it('fetches the catalog and projects to the data array', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      data: [{ id: 't1', code: 'GOMME', name_it: 'Cambio Gomme', icon: null, checklist_items: [] }],
    });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const { result } = renderHook(() => useMeInterventionTypes(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/intervention-types');
    expect(result.current.data).toEqual([
      { id: 't1', code: 'GOMME', name_it: 'Cambio Gomme', icon: null, checklist_items: [] },
    ]);
  });
});

import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMe, useUpdateMeProfile } from '@/queries/me';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { UpdateMeProfileBody } from '@/lib/types/profile';

jest.mock('@/lib/use-api-client');

const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const PROFILE = {
  id: 'c1',
  email: 'mario@example.com',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+393331112233',
  status: 'active',
  createdAt: '2026-01-10T00:00:00Z',
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useMe', () => {
  it('fetches /v1/me', async () => {
    const apiFetch = jest.fn().mockResolvedValue(PROFILE);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMe(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.firstName).toBe('Mario');
    expect(apiFetch).toHaveBeenCalledWith('/v1/me');
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('boom', 500, 'x'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMe(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('boom');
  });
});

describe('useUpdateMeProfile', () => {
  const BODY: UpdateMeProfileBody = { firstName: 'Marco', lastName: 'Rossi', phone: null };

  it('PATCHes /v1/me/profile and invalidates the profile query', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ ...PROFILE, firstName: 'Marco', phone: null });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateMeProfile(), { wrapper: makeWrapper(qc) });
    result.current.mutate(BODY);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/profile', { method: 'PATCH', body: BODY });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'profile'] });
  });

  it('surfaces ApiError', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('bad', 422, 'x'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpdateMeProfile(), { wrapper: makeWrapper(qc) });
    result.current.mutate(BODY);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('bad');
  });
});

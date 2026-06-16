import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  usePersonalDeadlines,
  usePersonalDeadline,
  useCreatePersonalDeadline,
  useUpdatePersonalDeadline,
  useCompletePersonalDeadline,
  useDeletePersonalDeadline,
} from '@/queries/personalDeadlines';
import * as apiClientHook from '@/lib/use-api-client';
import type { PersonalDeadlineDto } from '@/lib/types/personalDeadline';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const DTO: PersonalDeadlineDto = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  category: 'insurance',
  dueDate: '2026-12-31',
  reminderLeadDays: [7, 30],
  notifyPush: true,
  notifyEmail: false,
  status: 'open',
  createdAt: '2026-06-10T10:00:00.000Z',
  updatedAt: '2026-06-10T10:00:00.000Z',
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('usePersonalDeadlines', () => {
  it('GETs /v1/me/personal-deadlines and unwraps data array', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ data: [DTO] });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => usePersonalDeadlines(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/personal-deadlines');
    expect(result.current.data).toEqual([DTO]);
  });

  it('appends status filter to the path when provided', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ data: [] });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => usePersonalDeadlines({ status: 'open' }), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/personal-deadlines?status=open');
  });

  it('appends vehicleId filter to the path when provided', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ data: [] });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => usePersonalDeadlines({ vehicleId: DTO.vehicleId }), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/personal-deadlines?vehicleId=${DTO.vehicleId}`);
  });

  it('appends both filters when provided', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ data: [] });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(
      () => usePersonalDeadlines({ status: 'open', vehicleId: DTO.vehicleId }),
      { wrapper: makeWrapper(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(
      `/v1/me/personal-deadlines?status=open&vehicleId=${DTO.vehicleId}`,
    );
  });
});

describe('usePersonalDeadline', () => {
  it('GETs /v1/me/personal-deadlines/:id and unwraps personalDeadline', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ personalDeadline: DTO });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => usePersonalDeadline(DTO.id), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/personal-deadlines/${DTO.id}`);
    expect(result.current.data).toEqual(DTO);
  });

  it('does not fetch when id is empty', () => {
    const apiFetch = jest.fn();
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    renderHook(() => usePersonalDeadline(''), { wrapper: makeWrapper(qc) });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('useCreatePersonalDeadline', () => {
  it('POSTs the body and resolves the bare DTO; invalidates the list', async () => {
    const apiFetch = jest.fn().mockResolvedValue(DTO);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreatePersonalDeadline(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({
      vehicleId: DTO.vehicleId,
      category: 'insurance',
      dueDate: '2026-12-31',
      reminderLeadDays: [7, 30],
      notifyPush: true,
      notifyEmail: false,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/personal-deadlines', {
      method: 'POST',
      body: {
        vehicleId: DTO.vehicleId,
        category: 'insurance',
        dueDate: '2026-12-31',
        reminderLeadDays: [7, 30],
        notifyPush: true,
        notifyEmail: false,
      },
    });
    expect(result.current.data).toEqual(DTO);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines'] });
  });
});

describe('useUpdatePersonalDeadline', () => {
  it('PATCHes /v1/me/personal-deadlines/:id and invalidates list + detail', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ personalDeadline: DTO });
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdatePersonalDeadline(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ id: DTO.id, body: { dueDate: '2027-01-01' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/personal-deadlines/${DTO.id}`, {
      method: 'PATCH',
      body: { dueDate: '2027-01-01' },
    });
    expect(result.current.data).toEqual(DTO);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines', DTO.id] });
  });
});

describe('useCompletePersonalDeadline', () => {
  it('POSTs /v1/me/personal-deadlines/:id/complete with empty body and returns whole response', async () => {
    const renewalSuggestion = {
      suggestedDueDate: '2027-12-31',
      category: 'insurance' as const,
      recurrenceMonths: 12,
      reminderLeadDays: [7, 30],
      notifyPush: true,
      notifyEmail: false,
    };
    const apiResponse = { personalDeadline: DTO, renewalSuggestion };
    const apiFetch = jest.fn().mockResolvedValue(apiResponse);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCompletePersonalDeadline(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(DTO.id);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/personal-deadlines/${DTO.id}/complete`, {
      method: 'POST',
      body: {},
    });
    // Returns the WHOLE response (screen needs renewalSuggestion)
    expect(result.current.data).toEqual(apiResponse);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines', DTO.id] });
  });

  it('resolves without renewalSuggestion for non-recurring deadlines', async () => {
    const apiResponse = { personalDeadline: DTO };
    const apiFetch = jest.fn().mockResolvedValue(apiResponse);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useCompletePersonalDeadline(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(DTO.id);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(apiResponse);
    expect(result.current.data?.renewalSuggestion).toBeUndefined();
  });
});

describe('useDeletePersonalDeadline', () => {
  it('DELETEs /v1/me/personal-deadlines/:id, invalidates list, removes detail cache', async () => {
    const apiFetch = jest.fn().mockResolvedValue(undefined); // 204 → undefined
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const removeQueriesSpy = jest.spyOn(qc, 'removeQueries');
    const { result } = renderHook(() => useDeletePersonalDeadline(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(DTO.id);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(`/v1/me/personal-deadlines/${DTO.id}`, {
      method: 'DELETE',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines'] });
    expect(removeQueriesSpy).toHaveBeenCalledWith({ queryKey: ['personalDeadlines', DTO.id] });
  });
});

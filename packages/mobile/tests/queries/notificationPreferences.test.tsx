import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/queries/notificationPreferences';
import * as apiClientHook from '@/lib/use-api-client';
import { ApiError } from '@/lib/api-error';
import type { NotificationPreferences } from '@/lib/types/notification-preferences';

jest.mock('@/lib/use-api-client');
const mockedHook = apiClientHook as jest.Mocked<typeof apiClientHook>;

const QUERY_KEY = ['me', 'notification-preferences'];

const PREFS: NotificationPreferences = {
  email: {
    intervention_updates: true,
    deadline_reminder: true,
    ownership_transfer: true,
    marketing: false,
  },
  push: {
    intervention_updates: true,
    deadline_reminder: true,
    ownership_transfer: true,
  },
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useNotificationPreferences', () => {
  it('fetches /v1/me/notification-preferences', async () => {
    const apiFetch = jest.fn().mockResolvedValue(PREFS);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.email.intervention_updates).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences');
  });
});

describe('useUpdateNotificationPreference', () => {
  it('PATCHes a single-key email body and invalidates the query', async () => {
    const apiFetch = jest.fn().mockResolvedValue(PREFS);
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ channel: 'email', key: 'marketing', value: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences', {
      method: 'PATCH',
      body: { email: { marketing: true } },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: QUERY_KEY });
  });

  it('optimistically updates the cache before the request resolves', async () => {
    let resolve!: (v: NotificationPreferences) => void;
    const apiFetch = jest
      .fn()
      .mockReturnValue(new Promise<NotificationPreferences>((r) => (resolve = r)));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    qc.setQueryData(QUERY_KEY, PREFS);
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    act(() => {
      result.current.mutate({ channel: 'email', key: 'marketing', value: true });
    });
    await waitFor(() =>
      expect(qc.getQueryData<NotificationPreferences>(QUERY_KEY)?.email.marketing).toBe(true),
    );
    // settle the in-flight request so no act() warning leaks
    act(() => resolve(PREFS));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('reverts the cache when the request fails', async () => {
    const apiFetch = jest.fn().mockRejectedValue(new ApiError('boom', 500, 'x'));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    qc.setQueryData(QUERY_KEY, PREFS);
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate({ channel: 'email', key: 'marketing', value: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<NotificationPreferences>(QUERY_KEY)?.email.marketing).toBe(false);
  });

  it('PATCHes a push body and the optimistic write preserves the email channel', async () => {
    let resolve!: (v: NotificationPreferences) => void;
    const apiFetch = jest
      .fn()
      .mockReturnValue(new Promise<NotificationPreferences>((r) => (resolve = r)));
    mockedHook.useApiClient.mockReturnValue({ fetch: apiFetch });
    const qc = newClient();
    qc.setQueryData(QUERY_KEY, PREFS);
    const { result } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: makeWrapper(qc),
    });
    act(() => {
      result.current.mutate({ channel: 'push', key: 'deadline_reminder', value: false });
    });
    await waitFor(() => {
      const data = qc.getQueryData<NotificationPreferences>(QUERY_KEY);
      expect(data?.push.deadline_reminder).toBe(false);
      // email channel must be untouched by a push write
      expect(data?.email.intervention_updates).toBe(true);
    });
    expect(apiFetch).toHaveBeenCalledWith('/v1/me/notification-preferences', {
      method: 'PATCH',
      body: { push: { deadline_reminder: false } },
    });
    act(() => resolve(PREFS));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

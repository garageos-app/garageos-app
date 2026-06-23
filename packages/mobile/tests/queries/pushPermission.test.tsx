import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState } from 'react-native';
import type { ReactNode } from 'react';

import { usePushPermissionStatus, useInvalidatePushPermission } from '@/queries/pushPermission';

// Mock the push lib so tests don't touch native notification modules.
const mockGetPushPermissionStatus = jest.fn();
jest.mock('@/lib/push', () => ({
  __esModule: true,
  getPushPermissionStatus: (...args: unknown[]) => mockGetPushPermissionStatus(...args),
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Capture the handler passed to AppState.addEventListener so tests can fire 'active'.
let capturedAppStateHandler: ((state: string) => void) | null = null;
let addEventListenerSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  capturedAppStateHandler = null;
  addEventListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event: string, handler: (state: string) => void) => {
      capturedAppStateHandler = handler;
      return { remove: jest.fn() };
    });
});

afterEach(() => {
  addEventListenerSpy.mockRestore();
});

describe('usePushPermissionStatus', () => {
  it('exposes data === "denied" when the lib returns "denied"', async () => {
    mockGetPushPermissionStatus.mockResolvedValue('denied');
    const qc = newClient();
    const { result } = renderHook(() => usePushPermissionStatus(), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe('denied');
    expect(mockGetPushPermissionStatus).toHaveBeenCalledTimes(1);
  });

  it('registers an AppState listener on mount and removes it on unmount', async () => {
    mockGetPushPermissionStatus.mockResolvedValue('granted');
    const qc = newClient();
    const { unmount } = renderHook(() => usePushPermissionStatus(), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() =>
      expect(addEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function)),
    );
    // Capture the remove mock from the subscription returned by addEventListener.
    const removeMock = addEventListenerSpy.mock.results[0]?.value?.remove as jest.Mock;
    unmount();
    expect(removeMock).toHaveBeenCalled();
  });

  it('triggers a refetch when the captured AppState handler fires "active"', async () => {
    mockGetPushPermissionStatus.mockResolvedValue('granted');
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderHook(() => usePushPermissionStatus(), { wrapper: makeWrapper(qc) });

    // Wait for the initial query + the AppState listener to be registered.
    await waitFor(() => expect(addEventListenerSpy).toHaveBeenCalled());

    // Simulate the app returning to the foreground.
    act(() => {
      capturedAppStateHandler?.('active');
    });

    // invalidateQueries is the observable side effect; the refetch follows.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['push', 'permission'] }),
    );
    // The query function must have been called at least twice (initial + refetch).
    await waitFor(() => expect(mockGetPushPermissionStatus).toHaveBeenCalledTimes(2));
  });

  it('does not invalidate when the AppState handler fires a non-active state', async () => {
    mockGetPushPermissionStatus.mockResolvedValue('granted');
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderHook(() => usePushPermissionStatus(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(addEventListenerSpy).toHaveBeenCalled());

    act(() => {
      capturedAppStateHandler?.('background');
    });

    // Give the hook a tick — no invalidate should happen.
    await new Promise((r) => setTimeout(r, 50));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useInvalidatePushPermission', () => {
  it('returns a function that invalidates the push permission query key', async () => {
    mockGetPushPermissionStatus.mockResolvedValue('blocked');
    const qc = newClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useInvalidatePushPermission(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['push', 'permission'] });
  });
});

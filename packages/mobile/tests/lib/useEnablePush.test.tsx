import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// --- mocks declared before the import under test ---

const mockEnsurePushPermission = jest.fn();
const mockGetDevicePushToken = jest.fn();
const mockBuildRegistrationPayload = jest.fn((token: string) => ({
  expoPushToken: token,
  platform: 'android' as const,
}));

jest.mock('@/lib/push', () => ({
  ensurePushPermission: (...args: unknown[]) => mockEnsurePushPermission(...args),
  getDevicePushToken: (...args: unknown[]) => mockGetDevicePushToken(...args),
  buildRegistrationPayload: (token: string) => mockBuildRegistrationPayload(token),
}));

const mockMutateAsync = jest.fn();

jest.mock('@/queries/pushTokens', () => ({
  useRegisterPushToken: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));

const mockInvalidate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/queries/pushPermission', () => ({
  useInvalidatePushPermission: () => mockInvalidate,
}));

import { useEnablePush } from '@/lib/useEnablePush';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useEnablePush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvalidate.mockResolvedValue(undefined);
  });

  it('granted: calls register with the built payload, calls invalidate, and returns "granted"', async () => {
    mockEnsurePushPermission.mockResolvedValue('granted');
    mockGetDevicePushToken.mockResolvedValue('ExpoPushToken[abc]');
    mockMutateAsync.mockResolvedValue({ id: 'tok-1' });

    const { result } = renderHook(() => useEnablePush(), { wrapper: makeWrapper() });

    let perm!: string;
    await act(async () => {
      perm = await result.current.enable();
    });

    expect(perm).toBe('granted');
    expect(mockMutateAsync).toHaveBeenCalledWith({
      expoPushToken: 'ExpoPushToken[abc]',
      platform: 'android',
    });
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('denied: does not call register, calls invalidate, and returns "denied"', async () => {
    mockEnsurePushPermission.mockResolvedValue('denied');

    const { result } = renderHook(() => useEnablePush(), { wrapper: makeWrapper() });

    let perm!: string;
    await act(async () => {
      perm = await result.current.enable();
    });

    expect(perm).toBe('denied');
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('blocked: does not call register, calls invalidate, and returns "blocked"', async () => {
    mockEnsurePushPermission.mockResolvedValue('blocked');

    const { result } = renderHook(() => useEnablePush(), { wrapper: makeWrapper() });

    let perm!: string;
    await act(async () => {
      perm = await result.current.enable();
    });

    expect(perm).toBe('blocked');
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('registration rejects: enable() still resolves "granted" (best-effort, does not throw)', async () => {
    mockEnsurePushPermission.mockResolvedValue('granted');
    mockGetDevicePushToken.mockResolvedValue('ExpoPushToken[abc]');
    mockMutateAsync.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useEnablePush(), { wrapper: makeWrapper() });

    let perm!: string;
    await act(async () => {
      perm = await result.current.enable();
    });

    expect(perm).toBe('granted');
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });
});

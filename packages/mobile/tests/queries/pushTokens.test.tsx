import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useRegisterPushToken, useDeletePushToken } from '@/queries/pushTokens';
import * as storage from '@/lib/push-token-storage';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('push token mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('register POSTs the payload and stores the returned id', async () => {
    mockFetch.mockResolvedValueOnce({ id: 'srv-id-1' });
    const writeSpy = jest.spyOn(storage, 'writePushTokenId').mockResolvedValue();
    const { result } = renderHook(() => useRegisterPushToken(), { wrapper });
    await result.current.mutateAsync({ expoPushToken: 'ExpoPushToken[a]', platform: 'android' });
    expect(mockFetch).toHaveBeenCalledWith('/v1/me/push-tokens', {
      method: 'POST',
      body: { expoPushToken: 'ExpoPushToken[a]', platform: 'android' },
    });
    expect(writeSpy).toHaveBeenCalledWith('srv-id-1');
  });

  it('delete DELETEs :id and clears the stored id', async () => {
    mockFetch.mockResolvedValueOnce(undefined);
    const clearSpy = jest.spyOn(storage, 'clearPushTokenId').mockResolvedValue();
    const { result } = renderHook(() => useDeletePushToken(), { wrapper });
    await result.current.mutateAsync('srv-id-1');
    expect(mockFetch).toHaveBeenCalledWith('/v1/me/push-tokens/srv-id-1', { method: 'DELETE' });
    expect(clearSpy).toHaveBeenCalled();
  });
});

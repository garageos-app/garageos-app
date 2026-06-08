// Register (POST) / delete (DELETE) the device's push token. The server row id
// is persisted in SecureStore so we can deregister on toggle-off / logout.
import { useMutation } from '@tanstack/react-query';

import { useApiClient } from '@/lib/use-api-client';
import { clearPushTokenId, writePushTokenId } from '@/lib/push-token-storage';
import type { PushRegistrationPayload } from '@/lib/types/push';

export function useRegisterPushToken() {
  const api = useApiClient();
  return useMutation<{ id: string }, Error, PushRegistrationPayload>({
    mutationFn: (payload) =>
      api.fetch<{ id: string }>('/v1/me/push-tokens', { method: 'POST', body: payload }),
    onSuccess: async ({ id }) => {
      await writePushTokenId(id);
    },
  });
}

export function useDeletePushToken() {
  const api = useApiClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.fetch<void>(`/v1/me/push-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await clearPushTokenId();
    },
  });
}

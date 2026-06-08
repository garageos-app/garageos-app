// useNotificationPreferences — GET /v1/me/notification-preferences (customer
// notification settings, F-CLI-005). useUpdateNotificationPreference — PATCH a
// single email key with an optimistic cache update + revert on failure, so the
// toggle responds instantly despite Lambda cold start. Mirrors me.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  EditableEmailKey,
  NotificationPreferences,
} from '@/lib/types/notification-preferences';

const QUERY_KEY = ['me', 'notification-preferences'] as const;

export function useNotificationPreferences() {
  const api = useApiClient();
  return useQuery<NotificationPreferences, Error>({
    queryKey: QUERY_KEY,
    queryFn: () => api.fetch<NotificationPreferences>('/v1/me/notification-preferences'),
  });
}

interface UpdateVars {
  key: EditableEmailKey;
  value: boolean;
}

interface MutationContext {
  previous?: NotificationPreferences;
}

export function useUpdateNotificationPreference() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<NotificationPreferences, Error, UpdateVars, MutationContext>({
    mutationFn: ({ key, value }) =>
      api.fetch<NotificationPreferences>('/v1/me/notification-preferences', {
        method: 'PATCH',
        body: { email: { [key]: value } },
      }),
    onMutate: async ({ key, value }) => {
      // Cancel in-flight refetches so they don't clobber the optimistic write.
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const previous = qc.getQueryData<NotificationPreferences>(QUERY_KEY);
      if (previous) {
        qc.setQueryData<NotificationPreferences>(QUERY_KEY, {
          email: { ...previous.email, [key]: value },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(QUERY_KEY, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

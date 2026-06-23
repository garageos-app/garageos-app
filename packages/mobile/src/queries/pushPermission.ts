// Single reactive source of truth for the OS notification permission.
// AppState-active invalidation covers the user granting via system Settings
// while the app was backgrounded.
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getPushPermissionStatus } from '@/lib/push';
import type { PushPermission } from '@/lib/types/push';

export const PUSH_PERMISSION_KEY = ['push', 'permission'] as const;

export function usePushPermissionStatus() {
  const qc = useQueryClient();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void qc.invalidateQueries({ queryKey: PUSH_PERMISSION_KEY });
    });
    return () => sub.remove();
  }, [qc]);

  return useQuery<PushPermission>({
    queryKey: PUSH_PERMISSION_KEY,
    queryFn: getPushPermissionStatus,
    staleTime: 0,
  });
}

export function useInvalidatePushPermission() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: PUSH_PERMISSION_KEY });
}

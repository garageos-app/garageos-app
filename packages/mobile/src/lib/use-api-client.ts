// useApiClient — React hook that connects AuthContext callbacks to createApiClient.
// Returns a memoized ApiClient whose closures reference the latest AuthContext
// callbacks. The 3 callbacks (getIdToken, refresh, signOut) are wrapped in
// useCallback with empty deps in AuthContext, so identity is stable across
// renders and useMemo recomputes only on auth provider remount.
// See plan 2026-05-14-mobile-b2c-scaffold §Task 8.1.

import { useMemo } from 'react';
import { useAuth } from '@/auth/useAuth';
import { createApiClient, type ApiClient } from './api-client';

export function useApiClient(): ApiClient {
  const { getIdToken, refresh, signOut } = useAuth();
  return useMemo(
    () =>
      createApiClient({
        getIdToken,
        refreshTokens: refresh,
        onAuthLost: () => {
          void signOut();
        },
      }),
    [getIdToken, refresh, signOut],
  );
}

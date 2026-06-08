import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';

// F-OFF-002 — marks the guided onboarding complete. 204 → apiFetch resolves
// to {} (it tolerates an empty body). Invalidates tenants-me so the
// OnboardingGate stops redirecting.
export function useCompleteOnboarding() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () => apiFetch<void>('/v1/tenants/me/onboarding/complete', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants-me'] });
    },
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';

// F-OFF-002 — marks the guided onboarding complete. 204 → apiFetch resolves
// to {} (it tolerates an empty body). Invalidates tenants-me so the
// OnboardingGate stops redirecting.
//
// body: '{}' — apiFetch hardcodes `Content-Type: application/json` on every
// request and Fastify's body parser rejects empty bodies under that header
// with 400 "Body cannot be empty when content-type is set to
// 'application/json'". The endpoint takes no body; the empty object
// satisfies both ends. Same pattern as queries/attachmentUpload.ts.
export function useCompleteOnboarding() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () =>
      apiFetch<void>('/v1/tenants/me/onboarding/complete', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants-me'] });
    },
  });
}

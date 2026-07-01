import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiBlob } from '@/lib/api-client';

// F-OFF-309 — intervention PDF is now streamed as application/pdf bytes
// (no S3 presigned URL). Fetch with auth, wrap in an object URL, open it.

/**
 * Mutation that fetches the intervention PDF as an authenticated Blob and
 * opens it in a new browser tab via a short-lived object URL.
 *
 * Usage:
 *   const { mutate, isPending } = useInterventionPdfDownload();
 *   mutate(interventionId);
 */
export function useInterventionPdfDownload() {
  const apiBlob = useApiBlob();

  return useMutation<void, ApiError, string>({
    mutationFn: async (interventionId: string) => {
      const blob = await apiBlob(`/v1/interventions/${interventionId}/pdf`, { method: 'GET' });
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank');
      // Revoke after a delay so the new tab has time to load the object URL.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    },
  });
}

import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiBlob } from '@/lib/api-client';

// F-OFF-309 — intervention PDF is streamed as application/pdf bytes (no S3
// presigned URL). Fetch with auth, wrap in an object URL, open it. The PDF is
// the bulk vehicle-history document scoped to this one intervention; `showNames`
// controls whether the officina name is printed (grouped vs anonymous).

export interface InterventionPdfParams {
  interventionId: string;
  /** true = print the officina name on the PDF; false = anonymous. */
  showNames: boolean;
}

/**
 * Mutation that fetches the intervention PDF as an authenticated Blob and
 * opens it in a new browser tab via a short-lived object URL.
 *
 * Usage:
 *   const { mutate, isPending } = useInterventionPdfDownload();
 *   mutate({ interventionId, showNames: true });
 */
export function useInterventionPdfDownload() {
  const apiBlob = useApiBlob();

  return useMutation<void, ApiError, InterventionPdfParams>({
    mutationFn: async ({ interventionId, showNames }) => {
      const qs = new URLSearchParams({ show_names: String(showNames) });
      const blob = await apiBlob(`/v1/interventions/${interventionId}/pdf?${qs.toString()}`, {
        method: 'GET',
      });
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank');
      // Revoke after a delay so the new tab has time to load the object URL.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    },
  });
}

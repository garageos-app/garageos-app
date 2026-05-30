import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';

// F-OFF-309 — intervention PDF (single-intervention export) presigned download.
// GET /v1/interventions/:id/pdf returns a short-lived S3 presigned URL for the
// generated PDF. The hook opens it in a new tab on success — mirrors
// useVehicleTagDownload (F-OFF-104).

export interface InterventionPdfResponse {
  pdf_download_url: string;
  expires_at: string;
}

/**
 * Mutation that fetches the presigned intervention-PDF URL and opens it in a
 * new browser tab.
 *
 * Usage:
 *   const { mutate, isPending } = useInterventionPdfDownload();
 *   mutate(interventionId);
 */
export function useInterventionPdfDownload() {
  const apiFetch = useApiFetch();

  return useMutation<InterventionPdfResponse, ApiError, string>({
    mutationFn: (interventionId: string) =>
      apiFetch<InterventionPdfResponse>(`/v1/interventions/${interventionId}/pdf`, {
        method: 'GET',
      }),
    onSuccess: (data) => {
      window.open(data.pdf_download_url, '_blank');
    },
  });
}

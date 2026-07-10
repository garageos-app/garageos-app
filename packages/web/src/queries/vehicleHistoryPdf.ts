import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiBlob } from '@/lib/api-client';
import { openBlobInNewTab } from '@/lib/openBlob';

// Officina full vehicle-history PDF (GET /v1/vehicles/:id/export.pdf). Always
// scoped to the caller's own tenant by the API (the old cross-tenant `scope`
// param is gone). Streamed as application/pdf bytes (no S3 presigned URL):
// fetch with auth, wrap in an object URL, open it in a new tab. Mirrors
// useInterventionPdfDownload.

export interface VehicleHistoryPdfParams {
  /** true = show the officina name on the PDF; false = anonymous. */
  showNames: boolean;
}

/**
 * Mutation that fetches the vehicle-history PDF as an authenticated Blob and
 * opens it in a new browser tab via a short-lived object URL.
 *
 * Usage:
 *   const { mutate, isPending } = useVehicleHistoryPdfDownload(vehicleId);
 *   mutate({ showNames: true });
 */
export function useVehicleHistoryPdfDownload(vehicleId: string) {
  const apiBlob = useApiBlob();

  return useMutation<void, ApiError, VehicleHistoryPdfParams>({
    mutationFn: async ({ showNames }) => {
      const qs = new URLSearchParams({ show_names: String(showNames) });
      const blob = await apiBlob(`/v1/vehicles/${vehicleId}/export.pdf?${qs.toString()}`, {
        method: 'GET',
      });
      openBlobInNewTab(blob);
    },
  });
}

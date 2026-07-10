import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiBlob } from '@/lib/api-client';
import { openBlobInNewTab } from '@/lib/openBlob';

// F-OFF-104 — vehicle tag (QR-code PDF) is now streamed as application/pdf
// bytes (no S3 presigned URL). GET /v1/vehicles/:id/tag returns the
// printable PDF tag; the hook fetches it as an authenticated Blob, wraps it
// in an object URL, and opens it in a new tab.

/**
 * Mutation that fetches the tag PDF for a vehicle as an authenticated Blob
 * and opens it in a new browser tab via a short-lived object URL.
 *
 * Usage:
 *   const { mutate, isPending } = useVehicleTagDownload();
 *   mutate(vehicleId);
 */
export function useVehicleTagDownload() {
  const apiBlob = useApiBlob();

  return useMutation<void, ApiError, string>({
    mutationFn: async (vehicleId: string) => {
      const blob = await apiBlob(`/v1/vehicles/${vehicleId}/tag`, { method: 'GET' });
      // throwOnBlock:false — this route inserts a VehicleTagPrint audit row on
      // every successful call, so a blocked popup must NOT become a retryable
      // error (a retry would duplicate the audit row).
      openBlobInNewTab(blob, { throwOnBlock: false });
    },
  });
}

// F-OFF-109 — vehicle tag reprint (operator-initiated, requires document
// verification). POST /v1/vehicles/:id/tag-reprint generates a new QR-code
// PDF tag, streamed as application/pdf bytes. The hook opens it the same
// way as useVehicleTagDownload.

export interface VehicleTagReprintBody {
  reason: 'lost' | 'damaged' | 'other';
  reasonNote?: string;
  documentVerified: true;
}

/**
 * Mutation that posts a tag-reprint request for a vehicle, fetches the
 * resulting PDF as an authenticated Blob, and opens it in a new browser tab.
 *
 * Usage:
 *   const { mutate, isPending } = useVehicleTagReprint(vehicleId);
 *   mutate({ reason: 'lost', documentVerified: true });
 */
export function useVehicleTagReprint(vehicleId: string) {
  const apiBlob = useApiBlob();

  return useMutation<void, ApiError, VehicleTagReprintBody>({
    mutationFn: async (body: VehicleTagReprintBody) => {
      const blob = await apiBlob(`/v1/vehicles/${vehicleId}/tag-reprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // throwOnBlock:false — this route inserts a VehicleTagPrint audit row on
      // every successful call, so a blocked popup must NOT become a retryable
      // error (a retry would duplicate the audit row).
      openBlobInNewTab(blob, { throwOnBlock: false });
    },
  });
}

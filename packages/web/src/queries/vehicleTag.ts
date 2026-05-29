import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';

// F-OFF-104 — vehicle tag (QR-code PDF) presigned download URL.
// GET /v1/vehicles/:id/tag returns a short-lived S3 presigned URL for the
// printable PDF tag. The hook opens it in a new tab on success.

export interface VehicleTagResponse {
  tag_download_url: string;
  expires_at: string;
}

/**
 * Mutation that fetches the presigned tag PDF URL for a vehicle and opens it
 * in a new browser tab.
 *
 * Usage:
 *   const { mutate, isPending } = useVehicleTagDownload();
 *   mutate(vehicleId);
 */
export function useVehicleTagDownload() {
  const apiFetch = useApiFetch();

  return useMutation<VehicleTagResponse, ApiError, string>({
    mutationFn: (vehicleId: string) =>
      apiFetch<VehicleTagResponse>(`/v1/vehicles/${vehicleId}/tag`, { method: 'GET' }),
    onSuccess: (data) => {
      window.open(data.tag_download_url, '_blank');
    },
  });
}

// F-OFF-109 — vehicle tag reprint (operator-initiated, requires document verification).
// POST /v1/vehicles/:id/tag-reprint generates a new QR-code PDF tag and returns
// a short-lived S3 presigned URL. The hook opens it in a new tab on success.

export interface VehicleTagReprintBody {
  reason: 'lost' | 'damaged' | 'other';
  reasonNote?: string;
  documentVerified: true;
}

/**
 * Mutation that posts a tag-reprint request for a vehicle and opens the
 * resulting presigned PDF URL in a new browser tab.
 *
 * Usage:
 *   const { mutate, isPending } = useVehicleTagReprint(vehicleId);
 *   mutate({ reason: 'lost', documentVerified: true });
 */
export function useVehicleTagReprint(vehicleId: string) {
  const apiFetch = useApiFetch();
  return useMutation<VehicleTagResponse, ApiError, VehicleTagReprintBody>({
    mutationFn: async (body: VehicleTagReprintBody): Promise<VehicleTagResponse> => {
      return apiFetch<VehicleTagResponse>(`/v1/vehicles/${vehicleId}/tag-reprint`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      window.open(data.tag_download_url, '_blank');
    },
  });
}

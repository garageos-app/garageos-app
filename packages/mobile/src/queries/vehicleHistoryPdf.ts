// useVehicleHistoryPdfExport — F-CLI-501 PR2. Calls
// GET /v1/me/vehicles/:id/export.pdf, which renders the vehicle's full shop
// history to a PDF on S3 and returns a 1h presigned URL, then hands that URL to
// the OS so the user can view/save/share it.
//
// Dependency note (CLAUDE.md §7): expo-file-system / expo-sharing are NOT
// installed, so we use the no-new-dep fallback Linking.openURL(pdf_download_url)
// from react-native — the presigned https URL opens in the system browser/PDF
// viewer, from which the user can save or share. See design §5.1.
import { Linking } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface VehicleHistoryPdfResponse {
  pdf_download_url: string;
  expires_at: string;
}

export function useVehicleHistoryPdfExport() {
  const api = useApiClient();
  // Read-side export: no cache to invalidate. The whole flow (server render +
  // S3 + open) lives in mutationFn so the button's pending state covers it and
  // any failure (API error or openURL reject) surfaces as the mutation error.
  return useMutation<VehicleHistoryPdfResponse, Error, string>({
    mutationFn: async (vehicleId) => {
      const res = await api.fetch<VehicleHistoryPdfResponse>(
        `/v1/me/vehicles/${vehicleId}/export.pdf`,
      );
      await Linking.openURL(res.pdf_download_url);
      return res;
    },
  });
}

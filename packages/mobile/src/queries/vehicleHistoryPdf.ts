// useVehicleHistoryPdfExport — F-CLI-501 PR2. Calls
// GET /v1/me/vehicles/:id/export.pdf, which now streams application/pdf bytes
// directly (no more S3 presigned URL) and requires the Bearer header. We
// download the bytes natively to the cache dir with expo-file-system, then
// hand the file to the OS share sheet via expo-sharing so the user can
// view/save/share it.
//
// Dependency note (CLAUDE.md §7): expo-file-system / expo-sharing are added
// here (via `expo install`, SDK-pinned) because Linking.openURL cannot carry
// an Authorization header, and the endpoint no longer returns an openable
// URL — a native authenticated download is required.
//
// getIdToken is the synchronous accessor from AuthContext; the api-client's
// refresh-on-401 does not cover FileSystem.downloadAsync, so a 401 surfaces
// as a plain error and the user retries after re-login.
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/auth/useAuth';

export function useVehicleHistoryPdfExport() {
  const { getIdToken } = useAuth();
  // Read-side export: no cache to invalidate. The whole flow (download +
  // share) lives in mutationFn so the button's pending state covers it and
  // any failure (missing token, non-200 download) surfaces as the mutation
  // error.
  return useMutation<void, Error, string>({
    mutationFn: async (vehicleId) => {
      const token = getIdToken();
      if (!token) {
        throw new Error('Sessione scaduta. Effettua di nuovo l’accesso.');
      }
      const baseUrl = process.env.EXPO_PUBLIC_API_URL;
      const fileUri = `${FileSystem.cacheDirectory}storico-${vehicleId}.pdf`;
      const result = await FileSystem.downloadAsync(
        `${baseUrl}/v1/me/vehicles/${vehicleId}/export.pdf`,
        fileUri,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (result.status !== 200) {
        throw new Error('Download del PDF non riuscito.');
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
        });
      }
    },
  });
}

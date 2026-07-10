import { ApiError } from '@/lib/api-client';

/**
 * Open a Blob (e.g. a streamed PDF) in a new browser tab via a short-lived
 * object URL. Shared by the PDF / tag download hooks.
 *
 * `window.open` returns `null` when the browser blocked the popup — which is
 * common for a programmatic open fired after an `await` (outside the direct
 * click gesture). Left unchecked, that reads as a silent success: the mutation
 * resolves, the dialog closes, but no tab ever opens. We surface it as an
 * ApiError instead so callers show an error and the user knows what happened.
 */
export function openBlobInNewTab(blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, '_blank');
  // Revoke after a delay so the new tab has time to load the object URL.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  if (!win) {
    throw new ApiError(
      'client.popup_blocked',
      0,
      'Popup bloccato dal browser: consenti i popup per aprire il PDF.',
    );
  }
}

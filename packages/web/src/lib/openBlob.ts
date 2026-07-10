import { ApiError } from '@/lib/api-client';

export interface OpenBlobOptions {
  /**
   * When the browser blocks the popup (window.open returns null): `true`
   * (default) throws ApiError('client.popup_blocked') so the caller can surface
   * a "consenti i popup" message and let the user retry. Set to `false` for
   * NON-idempotent operations (e.g. the tag routes insert an audit row on every
   * successful call) where the server work already succeeded and a retry would
   * duplicate it — there, a blocked popup is swallowed rather than turned into a
   * retryable error.
   */
  throwOnBlock?: boolean;
}

/**
 * Open a Blob (e.g. a streamed PDF) in a new browser tab via a short-lived
 * object URL. Shared by the PDF / tag download hooks.
 *
 * `window.open` returns `null` when the browser blocked the popup — which is
 * common for a programmatic open fired after an `await` (outside the direct
 * click gesture). Left unchecked, that reads as a silent success: the mutation
 * resolves, the dialog closes, but no tab ever opens. The display copy for the
 * thrown error lives in the callers' error maps (mirroring the other PDF/tag
 * error codes), not here.
 */
export function openBlobInNewTab(blob: Blob, { throwOnBlock = true }: OpenBlobOptions = {}): void {
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, '_blank');
  if (!win) {
    // Popup blocked: the URL was never opened, so revoke it now instead of
    // leaking it for the usual grace period.
    URL.revokeObjectURL(objectUrl);
    if (throwOnBlock) {
      throw new ApiError('client.popup_blocked', 0, 'popup blocked');
    }
    return;
  }
  // Revoke after a delay so the new tab has time to load the object URL.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

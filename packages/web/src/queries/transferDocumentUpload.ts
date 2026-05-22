import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiFetch, ApiError } from '@/lib/api-client';

// F-OFF-110 PR-2 — libretto document upload (presign → S3 PUT).
// No confirm step: the libretto is not an Attachment row; the key is
// passed into the transfer body and stored on VehicleTransfer.documentUrl.

export const LIBRETTO_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'image/heic',
] as const;
export type LibrettoMimeType = (typeof LIBRETTO_ALLOWED_MIME_TYPES)[number];
export const LIBRETTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export type LibrettoValidationError =
  | { code: 'mime_not_supported'; received: string }
  | { code: 'size_exceeded'; received: number; max: number };

export function validateLibrettoFile(file: File): LibrettoValidationError | null {
  if (!(LIBRETTO_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { code: 'mime_not_supported', received: file.type };
  }
  if (file.size > LIBRETTO_MAX_SIZE_BYTES) {
    return { code: 'size_exceeded', received: file.size, max: LIBRETTO_MAX_SIZE_BYTES };
  }
  return null;
}

interface DocumentUploadUrlResponse {
  uploadUrl: string;
  uploadMethod: 'PUT';
  uploadHeaders: Record<string, string>;
  s3Key: string;
  expiresAt: string;
}

export type TransferUploadState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'success'; s3Key: string; fileName: string }
  | { phase: 'error'; code: string; message: string };

export type TransferUploadResult =
  | { ok: true; s3Key: string }
  | { ok: false; code: string; message: string };

export interface UseTransferDocumentUploadResult {
  upload: (file: File) => Promise<TransferUploadResult>;
  state: TransferUploadState;
  reset: () => void;
}

export function useTransferDocumentUpload(vehicleId: string): UseTransferDocumentUploadResult {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<TransferUploadState>({ phase: 'idle' });
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    return () => {
      // Abort any in-flight XHR on unmount.
      xhrRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  const upload = useCallback(
    async (file: File): Promise<TransferUploadResult> => {
      // Step 1 — presign
      setState({ phase: 'requesting' });
      let presign: DocumentUploadUrlResponse;
      try {
        presign = await apiFetch<DocumentUploadUrlResponse>(
          `/v1/vehicles/${vehicleId}/ownership-transfer/document-upload-url`,
          {
            method: 'POST',
            body: JSON.stringify({
              fileName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
            }),
          },
        );
      } catch (e) {
        const err = toErrorResult(e);
        setState({ phase: 'error', code: err.code, message: err.message });
        return err;
      }

      // Step 2 — direct S3 PUT via XHR (fetch cannot surface upload progress).
      // Unlike useAttachmentUpload there is no Step 3 confirm: the libretto is
      // not an Attachment row; the s3Key is returned to the caller and embedded
      // in the VehicleTransfer body.
      setState({ phase: 'uploading', progress: 0 });
      try {
        await putToS3(
          presign,
          file,
          (progress) => setState({ phase: 'uploading', progress }),
          xhrRef,
        );
      } catch (e) {
        const err = toErrorResult(e);
        setState({ phase: 'error', code: err.code, message: err.message });
        return err;
      }

      setState({ phase: 'success', s3Key: presign.s3Key, fileName: file.name });
      return { ok: true, s3Key: presign.s3Key };
    },
    [apiFetch, vehicleId],
  );

  return { upload, state, reset };
}

// Direct S3 PUT via XHR (fetch cannot surface upload progress). The
// sibling useAttachmentUpload has an equivalent helper; kept local
// here to keep PR-2 self-contained (no cross-feature refactor).
function putToS3(
  presign: DocumentUploadUrlResponse,
  file: File,
  onProgress: (progress: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open(presign.uploadMethod, presign.uploadUrl);
    for (const [k, v] of Object.entries(presign.uploadHeaders)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new XhrHttpError(xhr.status));
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      reject(new XhrNetworkError());
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      reject(new XhrAbortError());
    };
    xhr.send(file);
  });
}

class XhrHttpError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`S3 PUT returned HTTP ${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}
class XhrNetworkError extends Error {
  constructor() {
    super('S3 PUT network error');
  }
}
class XhrAbortError extends Error {
  constructor() {
    super('S3 PUT aborted');
  }
}

function toErrorResult(e: unknown): { ok: false; code: string; message: string } {
  if (e instanceof ApiError) {
    return { ok: false, code: e.code, message: e.message };
  }
  if (e instanceof XhrHttpError) {
    return { ok: false, code: 'xhr.http_error', message: `Upload fallito (HTTP ${e.httpStatus}).` };
  }
  if (e instanceof XhrNetworkError) {
    return { ok: false, code: 'xhr.network_error', message: "Errore di rete durante l'upload." };
  }
  if (e instanceof XhrAbortError) {
    return { ok: false, code: 'xhr.aborted', message: 'Upload interrotto.' };
  }
  return {
    ok: false,
    code: 'unknown',
    message: e instanceof Error ? e.message : 'Errore sconosciuto',
  };
}

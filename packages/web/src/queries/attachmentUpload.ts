import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type {
  AttachmentUploadUrlRequest,
  AttachmentUploadUrlResponse,
  AttachmentConfirmResponse,
} from './types';

// State machine for the 3-step S3 upload protocol.
// idle → requesting → uploading(progress) → confirming → success | error
export type UploadState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'confirming' }
  | { phase: 'success'; attachmentId: string }
  | { phase: 'error'; code: string; message: string };

export interface UseAttachmentUploadResult {
  upload: (file: File) => Promise<void>;
  state: UploadState;
  reset: () => void;
}

/**
 * Orchestrates the 3-step S3 upload protocol for intervention attachments
 * (F-OFF-305). Step 2 uses XMLHttpRequest (not fetch) because the browser
 * fetch API does not surface upload progress events. The XHR instance
 * is held in a ref so unmount mid-flight can abort it.
 *
 * On success the React Query `['intervention-detail', interventionId]`
 * cache is invalidated, refetching the detail page and surfacing the new
 * attachment row.
 */
export function useAttachmentUpload(interventionId: string): UseAttachmentUploadResult {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    return () => {
      // Abort any in-flight XHR on unmount. fetch calls cannot be
      // aborted cleanly here without AbortController plumbing; the
      // hook's `state` is local so dangling fetches are harmless.
      xhrRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    setState({ phase: 'idle' });
  }, []);

  const upload = useCallback(
    async (file: File) => {
      // Step 1 — presign
      setState({ phase: 'requesting' });
      let presign: AttachmentUploadUrlResponse;
      try {
        const body: AttachmentUploadUrlRequest = {
          owner_type: 'intervention',
          owner_id: interventionId,
          file_name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
        };
        presign = await apiFetch<AttachmentUploadUrlResponse>('/v1/attachments/upload-url', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return;
      }

      // Step 2 — direct S3 PUT via XHR (progress events)
      setState({ phase: 'uploading', progress: 0 });
      try {
        await putToS3(
          presign,
          file,
          (progress) => {
            setState({ phase: 'uploading', progress });
          },
          xhrRef,
        );
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return;
      }

      // Step 3 — confirm (idempotent)
      setState({ phase: 'confirming' });
      try {
        const result = await apiFetch<AttachmentConfirmResponse>(
          `/v1/attachments/${presign.attachment_id}/confirm`,
          { method: 'POST' },
        );
        setState({ phase: 'success', attachmentId: result.id });
        await queryClient.invalidateQueries({
          queryKey: ['intervention-detail', interventionId],
        });
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return;
      }
    },
    [apiFetch, interventionId, queryClient],
  );

  return { upload, state, reset };
}

function putToS3(
  presign: AttachmentUploadUrlResponse,
  file: File,
  onProgress: (progress: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open(presign.upload_method, presign.upload_url);
    for (const [k, v] of Object.entries(presign.upload_headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new XhrHttpError(xhr.status));
      }
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

function toErrorState(e: unknown): { phase: 'error'; code: string; message: string } {
  if (e instanceof ApiError) {
    return { phase: 'error', code: e.code, message: e.message };
  }
  if (e instanceof XhrHttpError) {
    return {
      phase: 'error',
      code: 'xhr.http_error',
      message: `Upload fallito (HTTP ${e.httpStatus}).`,
    };
  }
  if (e instanceof XhrNetworkError) {
    return {
      phase: 'error',
      code: 'xhr.network_error',
      message: "Errore di rete durante l'upload.",
    };
  }
  if (e instanceof XhrAbortError) {
    return {
      phase: 'error',
      code: 'xhr.aborted',
      message: 'Upload interrotto.',
    };
  }
  const message = e instanceof Error ? e.message : 'Errore sconosciuto';
  return { phase: 'error', code: 'unknown', message };
}

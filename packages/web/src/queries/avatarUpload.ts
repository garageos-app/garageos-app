import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { ProfileMeDto } from './profileMe';

// State machine for the 2-phase avatar upload.
// idle → requesting → uploading(progress) → confirming → success | error
export type AvatarUploadState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'confirming' }
  | { phase: 'success'; profile: ProfileMeDto }
  | { phase: 'error'; code: string; message: string };

interface UploadUrlResponse {
  upload_url: string;
  upload_method: 'PUT';
  upload_headers: Record<string, string>;
  expires_at: string;
}

export type AvatarUploadResult = { ok: true } | { ok: false; code: string; message: string };

export interface UseAvatarUploadResult {
  upload: (blob: Blob) => Promise<AvatarUploadResult>;
  remove: () => Promise<AvatarUploadResult>;
  state: AvatarUploadState;
  reset: () => void;
}

/**
 * Orchestrates the 2-phase S3 avatar upload protocol (slice L1).
 * Step 1: POST /v1/users/me/avatar/upload-url → presigned PUT URL.
 * Step 2: PUT blob directly to S3 via XMLHttpRequest (fetch cannot surface
 *         upload progress events). The XHR instance is held in a ref so an
 *         unmount mid-flight aborts cleanly.
 * Step 3: POST /v1/users/me/avatar/confirm → ProfileMeDto with fresh avatarUrl.
 *
 * Invalidates `['users-me']` on success so ProfileForm + TopBar
 * re-render with the fresh presigned URL.
 */
export function useAvatarUpload(): UseAvatarUploadResult {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AvatarUploadState>({ phase: 'idle' });
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
    async (blob: Blob): Promise<AvatarUploadResult> => {
      // Step 1 — presign
      setState({ phase: 'requesting' });
      let presign: UploadUrlResponse;
      try {
        presign = await apiFetch<UploadUrlResponse>('/v1/users/me/avatar/upload-url', {
          method: 'POST',
          body: '{}',
        });
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return { ok: false, code: err.code, message: err.message };
      }

      // Step 2 — direct S3 PUT via XHR (progress events)
      setState({ phase: 'uploading', progress: 0 });
      try {
        await putToS3(
          presign,
          blob,
          (progress) => {
            setState({ phase: 'uploading', progress });
          },
          xhrRef,
        );
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return { ok: false, code: err.code, message: err.message };
      }

      // Step 3 — confirm (idempotent); body '{}' required because useApiFetch
      // hard-codes Content-Type: application/json and Fastify rejects empty bodies.
      setState({ phase: 'confirming' });
      try {
        const profile = await apiFetch<ProfileMeDto>('/v1/users/me/avatar/confirm', {
          method: 'POST',
          body: '{}',
        });
        setState({ phase: 'success', profile });
        await queryClient.invalidateQueries({ queryKey: ['users-me'] });
        return { ok: true };
      } catch (e) {
        const err = toErrorState(e);
        setState(err);
        return { ok: false, code: err.code, message: err.message };
      }
    },
    [apiFetch, queryClient],
  );

  const remove = useCallback(async (): Promise<AvatarUploadResult> => {
    setState({ phase: 'requesting' });
    try {
      // Empty `{}` body required: useApiFetch hard-codes
      // `Content-Type: application/json`, and Fastify rejects empty bodies
      // under that header with 400 "Body cannot be empty...". Same pattern
      // as attachment confirm. The endpoint ignores the body server-side.
      await apiFetch<void>('/v1/users/me/avatar', { method: 'DELETE', body: '{}' });
      await queryClient.invalidateQueries({ queryKey: ['users-me'] });
      setState({ phase: 'idle' });
      return { ok: true };
    } catch (e) {
      const err = toErrorState(e);
      setState(err);
      return { ok: false, code: err.code, message: err.message };
    }
  }, [apiFetch, queryClient]);

  return { upload, remove, state, reset };
}

function putToS3(
  presign: UploadUrlResponse,
  blob: Blob,
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
    xhr.send(blob);
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

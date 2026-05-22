import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

// ---------------------------------------------------------------------------
// XHR mock — capture instance for assertions
// ---------------------------------------------------------------------------

class MockXHR {
  static instances: MockXHR[] = [];
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  readyState = 0;
  openArgs: { method: string; url: string } | null = null;
  setHeaders: Record<string, string> = {};
  sentBody: BodyInit | null = null;
  aborted = false;

  constructor() {
    MockXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.openArgs = { method, url };
  }
  setRequestHeader(k: string, v: string) {
    this.setHeaders[k] = v;
  }
  send(body: BodyInit | null) {
    this.sentBody = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  // Test helpers
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent);
  }
  resolveSuccess(status = 200) {
    this.status = status;
    this.readyState = 4;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

beforeEach(() => {
  apiFetchMock.mockReset();
  MockXHR.instances.length = 0;
  vi.stubGlobal('XMLHttpRequest', MockXHR);
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  useTransferDocumentUpload,
  validateLibrettoFile,
  LIBRETTO_MAX_SIZE_BYTES,
} from './transferDocumentUpload';
import { ApiError } from '@/lib/api-client';

function makeFile(name = 'libretto.pdf', type = 'application/pdf', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const VEHICLE_ID = '11111111-1111-1111-1111-111111111111';
const S3_KEY = 'vehicle-transfers/veh-1/libretto.pdf';

const PRESIGN_OK = {
  uploadUrl: 'https://s3.example.com/upload?sig',
  uploadMethod: 'PUT' as const,
  uploadHeaders: { 'Content-Type': 'application/pdf' },
  s3Key: S3_KEY,
  expiresAt: '2026-05-22T13:00:00Z',
};

// ---------------------------------------------------------------------------
// validateLibrettoFile — pure function tests
// ---------------------------------------------------------------------------

describe('validateLibrettoFile', () => {
  it('accepts a valid PDF under 10 MB', () => {
    const file = new File(['x'], 'libretto.pdf', { type: 'application/pdf' });
    expect(validateLibrettoFile(file)).toBeNull();
  });

  it('accepts image/jpeg', () => {
    const file = new File(['x'], 'libretto.jpg', { type: 'image/jpeg' });
    expect(validateLibrettoFile(file)).toBeNull();
  });

  it('accepts image/png', () => {
    const file = new File(['x'], 'libretto.png', { type: 'image/png' });
    expect(validateLibrettoFile(file)).toBeNull();
  });

  it('accepts image/heic', () => {
    const file = new File(['x'], 'libretto.heic', { type: 'image/heic' });
    expect(validateLibrettoFile(file)).toBeNull();
  });

  it('rejects an unsupported mime type', () => {
    const file = new File(['x'], 'libretto.webp', { type: 'image/webp' });
    expect(validateLibrettoFile(file)).toEqual({
      code: 'mime_not_supported',
      received: 'image/webp',
    });
  });

  it('rejects a file over 10 MB', () => {
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: LIBRETTO_MAX_SIZE_BYTES + 1 });
    expect(validateLibrettoFile(file)).toMatchObject({ code: 'size_exceeded' });
  });

  it('accepts a file exactly at 10 MB boundary', () => {
    const file = new File(['x'], 'boundary.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: LIBRETTO_MAX_SIZE_BYTES });
    expect(validateLibrettoFile(file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useTransferDocumentUpload — hook tests
// ---------------------------------------------------------------------------

describe('useTransferDocumentUpload', () => {
  it('happy path: presign → S3 PUT → resolves {ok:true, s3Key} + success state', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    const file = makeFile();
    let uploadPromise!: Promise<{ ok: boolean; s3Key?: string }>;
    act(() => {
      uploadPromise = result.current.upload(file);
    });

    // Wait for presign call
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      1,
      `/v1/vehicles/${VEHICLE_ID}/ownership-transfer/document-upload-url`,
      {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      },
    );

    // Wait for XHR open
    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    expect(xhr.openArgs).toEqual({ method: 'PUT', url: PRESIGN_OK.uploadUrl });
    expect(xhr.setHeaders['Content-Type']).toBe('application/pdf');
    expect(xhr.sentBody).toBe(file);

    // Emit progress + resolve
    await act(async () => {
      xhr.emitProgress(512, 1024);
      xhr.resolveSuccess(200);
    });

    const uploadResult = await uploadPromise;

    expect(uploadResult).toEqual({ ok: true, s3Key: S3_KEY });
    expect(result.current.state).toEqual({ phase: 'success', s3Key: S3_KEY, fileName: file.name });
    // No confirm step — apiFetch called exactly once (presign only)
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('progress events update state.progress during uploading phase', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    act(() => {
      void result.current.upload(makeFile());
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];

    act(() => xhr.emitProgress(256, 1024));
    await waitFor(() =>
      expect(result.current.state).toEqual({ phase: 'uploading', progress: 0.25 }),
    );

    act(() => xhr.emitProgress(1024, 1024));
    await waitFor(() => expect(result.current.state).toEqual({ phase: 'uploading', progress: 1 }));
  });

  it('presign failure → resolves {ok:false, code, message} + error state', async () => {
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('vehicle.transfer.upload_url_unavailable', 502, 'S3 down'),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    let uploadResult!: { ok: boolean; code?: string };
    await act(async () => {
      uploadResult = await result.current.upload(makeFile());
    });

    expect(uploadResult).toEqual({
      ok: false,
      code: 'vehicle.transfer.upload_url_unavailable',
      message: 'S3 down',
    });
    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'vehicle.transfer.upload_url_unavailable',
    });
    // No XHR should be created when presign fails
    expect(MockXHR.instances).toHaveLength(0);
  });

  it('S3 PUT 403 → resolves {ok:false, code: xhr.http_error} + error state', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    act(() => {
      void result.current.upload(makeFile());
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    await act(async () => {
      xhr.resolveSuccess(403);
    });

    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'xhr.http_error',
    });
  });

  it('S3 PUT network error → resolves {ok:false, code: xhr.network_error} + error state', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    act(() => {
      void result.current.upload(makeFile());
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    await act(async () => xhr.fail());

    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'xhr.network_error',
    });
  });

  it('reset() clears error state back to idle', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('whatever', 500, 'x'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.upload(makeFile());
    });
    expect(result.current.state.phase).toBe('error');

    act(() => result.current.reset());
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('unmount mid-upload aborts the XHR', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => useTransferDocumentUpload(VEHICLE_ID), {
      wrapper: Wrapper,
    });

    act(() => {
      void result.current.upload(makeFile());
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];

    unmount();

    expect(xhr.aborted).toBe(true);
  });
});

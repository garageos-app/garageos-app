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

import { useAvatarUpload, type AvatarUploadResult } from './avatarUpload';
import { ApiError } from '@/lib/api-client';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc, invalidateSpy };
}

const PRESIGN_OK = {
  upload_url: 'https://s3.example.com/upload?sig',
  upload_method: 'PUT' as const,
  upload_headers: { 'Content-Type': 'image/jpeg' },
  expires_at: '2026-05-15T13:00:00Z',
};

const PROFILE_OK = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'test@example.com',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic' as const,
  tenantId: '22222222-2222-2222-2222-222222222222',
  locationId: null,
  avatarUrl: 'https://s3.example.com/avatars/signed-url',
  phone: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('useAvatarUpload', () => {
  it('happy path: presign → S3 PUT → confirm → invalidateQueries + success state', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK).mockResolvedValueOnce(PROFILE_OK);

    const { Wrapper, invalidateSpy } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    expect(result.current.state.phase).toBe('idle');

    const blob = new Blob(['x'], { type: 'image/jpeg' });
    let uploadPromise!: Promise<AvatarUploadResult>;
    act(() => {
      uploadPromise = result.current.upload(blob);
    });

    // Wait for presign call
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/v1/users/me/avatar/upload-url', {
      method: 'POST',
      body: '{}',
    });

    // Wait for XHR open
    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    expect(xhr.openArgs).toEqual({ method: 'PUT', url: PRESIGN_OK.upload_url });
    expect(xhr.setHeaders['Content-Type']).toBe('image/jpeg');
    expect(xhr.sentBody).toBe(blob);

    // Emit progress + resolve
    act(() => {
      xhr.emitProgress(512, 1024);
      xhr.resolveSuccess(200);
    });

    // Wait for confirm call
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/v1/users/me/avatar/confirm', {
      method: 'POST',
      body: '{}',
    });

    const uploadResult = await uploadPromise;

    expect(result.current.state).toEqual({ phase: 'success', profile: PROFILE_OK });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users-me'] });
    // Verify return value (guards against stale-closure callers relying on state)
    expect(uploadResult).toEqual({ ok: true });
  });

  it('progress events update state.progress during uploading phase', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    act(() => {
      void result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
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

  it('presign 502 → error state with ApiError code preserved', async () => {
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('users.me.avatar.s3_unavailable', 502, 'S3 down'),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    let uploadResult: AvatarUploadResult | undefined;
    await act(async () => {
      uploadResult = await result.current.upload(new Blob());
    });

    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'users.me.avatar.s3_unavailable',
    });
    // Verify return value carries the error — callers must not rely on stale state
    expect(uploadResult).toMatchObject({ ok: false, code: 'users.me.avatar.s3_unavailable' });
  });

  it('S3 PUT 403 → error state with xhr.http_error code', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    act(() => {
      void result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
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

  it('S3 PUT network error → error state with xhr.network_error code', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    act(() => {
      void result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    await act(async () => xhr.fail());

    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'xhr.network_error',
    });
  });

  it('confirm failure → error state, no invalidation', async () => {
    apiFetchMock
      .mockResolvedValueOnce(PRESIGN_OK)
      .mockRejectedValueOnce(new ApiError('users.me.avatar.confirm_failed', 422, 'bad confirm'));

    const { Wrapper, invalidateSpy } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    act(() => {
      void result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];
    await act(async () => xhr.resolveSuccess(200));

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: 'error',
        code: 'users.me.avatar.confirm_failed',
      }),
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('remove: DELETE success → idle + invalidateQueries', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);

    const { Wrapper, invalidateSpy } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.remove();
    });

    expect(result.current.state.phase).toBe('idle');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users-me'] });
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users/me/avatar', {
      method: 'DELETE',
      body: '{}',
    });
  });

  it('remove: DELETE failure → error state', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('users.me.avatar.not_found', 404, 'No avatar'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.remove();
    });

    expect(result.current.state).toMatchObject({
      phase: 'error',
      code: 'users.me.avatar.not_found',
    });
  });

  it('reset() clears error state back to idle', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError('whatever', 500, 'x'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.upload(new Blob());
    });
    expect(result.current.state.phase).toBe('error');

    act(() => result.current.reset());
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('unmount mid-upload aborts the XHR', async () => {
    apiFetchMock.mockResolvedValueOnce(PRESIGN_OK);

    const { Wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => useAvatarUpload(), { wrapper: Wrapper });

    act(() => {
      void result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    const xhr = MockXHR.instances[0];

    unmount();

    expect(xhr.aborted).toBe(true);
  });
});

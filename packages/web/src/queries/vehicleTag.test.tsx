import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockApiBlob } = vi.hoisted(() => ({
  mockApiBlob: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiBlob: () => mockApiBlob,
  };
});

let openSpy: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockApiBlob.mockReset();
  openSpy = vi.fn(() => ({}) as Window);
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('open', openSpy);
  // @ts-expect-error jsdom URL lacks createObjectURL
  URL.createObjectURL = createObjectURL;
  // @ts-expect-error jsdom URL lacks revokeObjectURL
  URL.revokeObjectURL = revokeObjectURL;
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { useVehicleTagDownload, useVehicleTagReprint } from './vehicleTag';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VEHICLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

describe('useVehicleTagDownload', () => {
  it('calls GET /v1/vehicles/:id/tag on mutate', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());

    const { result } = renderHook(() => useVehicleTagDownload(), { wrapper: wrap });

    await act(async () => {
      await result.current.mutateAsync(VEHICLE_ID);
    });

    expect(mockApiBlob).toHaveBeenCalledOnce();
    expect(mockApiBlob).toHaveBeenCalledWith(`/v1/vehicles/${VEHICLE_ID}/tag`, {
      method: 'GET',
    });
  });

  it('opens the tag PDF blob in a new tab', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());

    const { result } = renderHook(() => useVehicleTagDownload(), { wrapper: wrap });

    await act(async () => {
      await result.current.mutateAsync(VEHICLE_ID);
    });

    expect(createObjectURL).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
  });
});

describe('useVehicleTagReprint', () => {
  it('calls POST /v1/vehicles/:id/tag-reprint with body', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const { result } = renderHook(() => useVehicleTagReprint('vehicle-uuid'), { wrapper: wrap });
    await act(async () => {
      await result.current.mutateAsync({
        reason: 'lost',
        documentVerified: true,
      });
    });
    expect(mockApiBlob).toHaveBeenCalledWith('/v1/vehicles/vehicle-uuid/tag-reprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'lost', documentVerified: true }),
    });
  });

  it('opens the reprinted tag PDF blob in a new tab', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const { result } = renderHook(() => useVehicleTagReprint('vehicle-uuid'), { wrapper: wrap });
    await act(async () => {
      await result.current.mutateAsync({ reason: 'lost', documentVerified: true });
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
  });
});

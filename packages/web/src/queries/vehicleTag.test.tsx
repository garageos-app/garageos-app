import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

beforeEach(() => {
  mockApiFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { useVehicleTagDownload, type VehicleTagResponse } from './vehicleTag';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VEHICLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const TAG_RESPONSE: VehicleTagResponse = {
  tag_download_url: 'https://example.com/tags/signed-url',
  expires_at: '2026-05-30T12:00:00Z',
};

describe('useVehicleTagDownload', () => {
  it('calls GET /v1/vehicles/:id/tag on mutate', async () => {
    mockApiFetch.mockResolvedValueOnce(TAG_RESPONSE);
    // Mock window.open to suppress jsdom "not implemented" noise — this test
    // focuses on the fetch call, not the side effect.
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { result } = renderHook(() => useVehicleTagDownload(), { wrapper: wrap });

    await result.current.mutateAsync(VEHICLE_ID);

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(mockApiFetch).toHaveBeenCalledWith(`/v1/vehicles/${VEHICLE_ID}/tag`, {
      method: 'GET',
    });

    openSpy.mockRestore();
  });

  it('opens window with returned URL on success', async () => {
    mockApiFetch.mockResolvedValueOnce(TAG_RESPONSE);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { result } = renderHook(() => useVehicleTagDownload(), { wrapper: wrap });

    await result.current.mutateAsync(VEHICLE_ID);

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(TAG_RESPONSE.tag_download_url, '_blank'),
    );

    openSpy.mockRestore();
  });
});

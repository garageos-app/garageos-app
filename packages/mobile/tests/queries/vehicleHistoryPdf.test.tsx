import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Linking } from 'react-native';
import React from 'react';

import { useVehicleHistoryPdfExport } from '@/queries/vehicleHistoryPdf';
import { ApiError } from '@/lib/api-error';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useVehicleHistoryPdfExport', () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    mockFetch.mockReset();
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  it('GETs the export endpoint and opens the presigned URL', async () => {
    mockFetch.mockResolvedValue({
      pdf_download_url:
        'https://bucket.s3.eu-south-1.amazonaws.com/vehicle-history-pdfs/v-1.pdf?sig',
      expires_at: '2026-06-09T19:00:00Z',
    });
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await result.current.mutateAsync('veh-1');

    expect(mockFetch).toHaveBeenCalledWith('/v1/me/vehicles/veh-1/export.pdf');
    expect(openURL).toHaveBeenCalledWith(
      'https://bucket.s3.eu-south-1.amazonaws.com/vehicle-history-pdfs/v-1.pdf?sig',
    );
  });

  it('does not open a URL when the API call fails', async () => {
    mockFetch.mockRejectedValue(
      new ApiError('me.vehicle.not_found', 404, 'Veicolo non trovato o non più di tua proprietà.'),
    );
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await expect(result.current.mutateAsync('veh-1')).rejects.toBeInstanceOf(ApiError);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(openURL).not.toHaveBeenCalled();
  });
});

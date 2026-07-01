import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useVehicleHistoryPdfExport } from '@/queries/vehicleHistoryPdf';

const mockDownloadAsync = jest.fn();
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  downloadAsync: (...args: unknown[]) => mockDownloadAsync(...args),
}));

const mockIsAvailableAsync = jest.fn();
const mockShareAsync = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: (...args: unknown[]) => mockIsAvailableAsync(...args),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));

const mockGetIdToken = jest.fn();
jest.mock('@/auth/useAuth', () => ({
  useAuth: () => ({ getIdToken: mockGetIdToken }),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// babel-preset-expo inlines process.env.EXPO_PUBLIC_* at transform time, so the
// hook cannot be overridden via runtime assignment — the base URL is the value
// baked in by jest.setup.ts. Reference it the same way so the expectation
// tracks whatever that setup uses.
const API_BASE = process.env.EXPO_PUBLIC_API_URL;

describe('useVehicleHistoryPdfExport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIdToken.mockReturnValue('tok');
    mockDownloadAsync.mockResolvedValue({ status: 200, uri: 'file:///cache/storico-veh-1.pdf' });
    mockIsAvailableAsync.mockResolvedValue(true);
    mockShareAsync.mockResolvedValue(undefined);
  });

  it('downloads with the auth header and opens the share sheet', async () => {
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await result.current.mutateAsync('veh-1');

    expect(mockDownloadAsync).toHaveBeenCalledWith(
      `${API_BASE}/v1/me/vehicles/veh-1/export.pdf`,
      'file:///cache/storico-veh-1.pdf',
      { headers: { Authorization: 'Bearer tok' } },
    );
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/storico-veh-1.pdf',
      expect.objectContaining({ mimeType: 'application/pdf' }),
    );
  });

  it('does not share when the OS share sheet is unavailable', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await result.current.mutateAsync('veh-1');

    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('throws without downloading when there is no session token', async () => {
    mockGetIdToken.mockReturnValue(null);
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await expect(result.current.mutateAsync('veh-1')).rejects.toThrow();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it('throws when the download does not return a 200 status', async () => {
    mockDownloadAsync.mockResolvedValue({ status: 404, uri: 'file:///cache/storico-veh-1.pdf' });
    const { result } = renderHook(() => useVehicleHistoryPdfExport(), { wrapper: makeWrapper() });

    await expect(result.current.mutateAsync('veh-1')).rejects.toThrow();

    expect(mockShareAsync).not.toHaveBeenCalled();
  });
});

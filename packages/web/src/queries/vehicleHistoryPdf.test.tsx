// packages/web/src/queries/vehicleHistoryPdf.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockApiBlob } = vi.hoisted(() => ({ mockApiBlob: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiBlob: () => mockApiBlob };
});

let openSpy: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockApiBlob.mockReset();
  openSpy = vi.fn();
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('open', openSpy);
  // @ts-expect-error jsdom URL lacks createObjectURL
  URL.createObjectURL = createObjectURL;
  // @ts-expect-error jsdom URL lacks revokeObjectURL
  URL.revokeObjectURL = revokeObjectURL;
});

import { useVehicleHistoryPdfDownload } from './vehicleHistoryPdf';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

describe('useVehicleHistoryPdfDownload', () => {
  it('calls GET /v1/vehicles/:id/export.pdf with show_names on mutate (no scope param)', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const { result } = renderHook(() => useVehicleHistoryPdfDownload(VEHICLE_ID), {
      wrapper: wrap,
    });
    await act(async () => {
      await result.current.mutateAsync({ showNames: false });
    });
    expect(mockApiBlob).toHaveBeenCalledWith(
      `/v1/vehicles/${VEHICLE_ID}/export.pdf?show_names=false`,
      { method: 'GET' },
    );
  });

  it('opens the PDF blob in a new tab on success', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const { result } = renderHook(() => useVehicleHistoryPdfDownload(VEHICLE_ID), {
      wrapper: wrap,
    });
    await act(async () => {
      await result.current.mutateAsync({ showNames: true });
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
  });
});

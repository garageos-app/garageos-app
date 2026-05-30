// packages/web/src/queries/interventionPdf.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => mockApiFetch };
});

beforeEach(() => {
  mockApiFetch.mockReset();
});

import { useInterventionPdfDownload, type InterventionPdfResponse } from './interventionPdf';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const INTERVENTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PDF_RESPONSE: InterventionPdfResponse = {
  pdf_download_url: 'https://example.com/intervention-pdfs/signed-url',
  expires_at: '2026-05-31T12:00:00Z',
};

describe('useInterventionPdfDownload', () => {
  it('calls GET /v1/interventions/:id/pdf on mutate', async () => {
    mockApiFetch.mockResolvedValueOnce(PDF_RESPONSE);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { result } = renderHook(() => useInterventionPdfDownload(), { wrapper: wrap });
    await result.current.mutateAsync(INTERVENTION_ID);

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(mockApiFetch).toHaveBeenCalledWith(`/v1/interventions/${INTERVENTION_ID}/pdf`, {
      method: 'GET',
    });
    openSpy.mockRestore();
  });

  it('opens the returned URL in a new tab on success', async () => {
    mockApiFetch.mockResolvedValueOnce(PDF_RESPONSE);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { result } = renderHook(() => useInterventionPdfDownload(), { wrapper: wrap });
    await result.current.mutateAsync(INTERVENTION_ID);

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(PDF_RESPONSE.pdf_download_url, '_blank'),
    );
    openSpy.mockRestore();
  });
});

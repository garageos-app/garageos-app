// packages/web/src/queries/interventionPdf.test.tsx
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
  openSpy = vi.fn(() => ({}) as Window);
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('open', openSpy);
  // @ts-expect-error jsdom URL lacks createObjectURL
  URL.createObjectURL = createObjectURL;
  // @ts-expect-error jsdom URL lacks revokeObjectURL
  URL.revokeObjectURL = revokeObjectURL;
});

import { useInterventionPdfDownload } from './interventionPdf';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const INTERVENTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

describe('useInterventionPdfDownload', () => {
  it('calls GET /v1/interventions/:id/pdf with show_names on mutate', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());

    const { result } = renderHook(() => useInterventionPdfDownload(), { wrapper: wrap });
    await act(async () => {
      await result.current.mutateAsync({ interventionId: INTERVENTION_ID, showNames: true });
    });

    expect(mockApiBlob).toHaveBeenCalledOnce();
    expect(mockApiBlob).toHaveBeenCalledWith(
      `/v1/interventions/${INTERVENTION_ID}/pdf?show_names=true`,
      { method: 'GET' },
    );
  });

  it('passes show_names=false when the officina name is hidden', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());

    const { result } = renderHook(() => useInterventionPdfDownload(), { wrapper: wrap });
    await act(async () => {
      await result.current.mutateAsync({ interventionId: INTERVENTION_ID, showNames: false });
    });

    expect(mockApiBlob).toHaveBeenCalledWith(
      `/v1/interventions/${INTERVENTION_ID}/pdf?show_names=false`,
      { method: 'GET' },
    );
  });

  it('opens the PDF blob in a new tab on success', async () => {
    mockApiBlob.mockResolvedValueOnce(pdfBlob());

    const { result } = renderHook(() => useInterventionPdfDownload(), { wrapper: wrap });
    await act(async () => {
      await result.current.mutateAsync({ interventionId: INTERVENTION_ID, showNames: true });
    });

    expect(createObjectURL).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
  });
});

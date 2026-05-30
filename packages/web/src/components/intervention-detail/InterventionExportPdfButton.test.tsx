// packages/web/src/components/intervention-detail/InterventionExportPdfButton.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { InterventionExportPdfButton } from './InterventionExportPdfButton';
import { ApiError } from '@/lib/api-client';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => mockApiFetch };
});

const INTERVENTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PDF_RESPONSE = {
  pdf_download_url: 'https://example.com/intervention-pdfs/signed-url',
  expires_at: '2026-05-31T12:00:00Z',
};

function renderButton() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <InterventionExportPdfButton interventionId={INTERVENTION_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('InterventionExportPdfButton', () => {
  it('renders idle button with "Esporta PDF" label', () => {
    renderButton();
    const button = screen.getByRole('button', { name: /Esporta PDF/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('calls the mutation and opens the PDF in a new tab on success', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce(PDF_RESPONSE);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(PDF_RESPONSE.pdf_download_url, '_blank'),
    );
    expect(mockApiFetch).toHaveBeenCalledWith(`/v1/interventions/${INTERVENTION_ID}/pdf`, {
      method: 'GET',
    });
    openSpy.mockRestore();
  });

  it('shows "Generazione PDF..." and disables the button while pending', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementationOnce(() => new Promise(() => {})); // never resolves

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Generazione PDF/i });
      expect(button).toBeDisabled();
    });
  });

  it('maps intervention.not_found to an Italian error message', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(new ApiError('intervention.not_found', 404, 'not found'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Intervento non trovato/i),
    );
  });

  it('shows a generic error message on a non-ApiError failure', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(new Error('network down'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Impossibile generare il PDF/i),
    );
  });
});

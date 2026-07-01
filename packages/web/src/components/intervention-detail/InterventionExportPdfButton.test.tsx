// packages/web/src/components/intervention-detail/InterventionExportPdfButton.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { InterventionExportPdfButton } from './InterventionExportPdfButton';
import { ApiError } from '@/lib/api-client';

const { mockApiBlob } = vi.hoisted(() => ({ mockApiBlob: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiBlob: () => mockApiBlob };
});

const INTERVENTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

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
  mockApiBlob.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
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
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank'));
    expect(mockApiBlob).toHaveBeenCalledWith(`/v1/interventions/${INTERVENTION_ID}/pdf`, {
      method: 'GET',
    });
    openSpy.mockRestore();
  });

  it('shows "Generazione PDF..." and disables the button while pending', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockImplementationOnce(() => new Promise(() => {})); // never resolves

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Generazione PDF/i });
      expect(button).toBeDisabled();
    });
  });

  it('maps intervention.not_found to an Italian error message', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new ApiError('intervention.not_found', 404, 'not found'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Intervento non trovato/i),
    );
  });

  it('shows a generic error message on a non-ApiError failure', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new Error('network down'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Impossibile generare il PDF/i),
    );
  });
});

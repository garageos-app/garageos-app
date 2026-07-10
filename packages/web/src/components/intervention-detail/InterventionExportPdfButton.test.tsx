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
  it('generates with the default (show_names=true) and opens the PDF in a new tab', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/interventions/${INTERVENTION_ID}/pdf?show_names=true`,
        { method: 'GET' },
      ),
    );
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
    openSpy.mockRestore();
  });

  it('reflects the toggle in the request when "Mostra nome officina" is turned off', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));
    await user.click(screen.getByLabelText(/Mostra nome officina/i));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/interventions/${INTERVENTION_ID}/pdf?show_names=false`,
        { method: 'GET' },
      ),
    );
  });

  it('resets the officina-name switch to the default when the dialog is reopened', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));
    const toggle = screen.getByLabelText(/Mostra nome officina/i);
    expect(toggle).toBeChecked();
    await user.click(toggle); // turn off
    expect(toggle).not.toBeChecked();

    // Close without generating, then reopen — the switch must be back on so a
    // prior anonymous choice does not silently persist.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));
    expect(screen.getByLabelText(/Mostra nome officina/i)).toBeChecked();
  });

  it('maps intervention.not_found to an Italian error message', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new ApiError('intervention.not_found', 404, 'not found'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Intervento non trovato/i),
    );
  });
});

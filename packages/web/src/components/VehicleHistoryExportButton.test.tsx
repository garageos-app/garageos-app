// packages/web/src/components/VehicleHistoryExportButton.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { VehicleHistoryExportButton } from './VehicleHistoryExportButton';
import { ApiError } from '@/lib/api-client';

const { mockApiBlob } = vi.hoisted(() => ({ mockApiBlob: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiBlob: () => mockApiBlob };
});

const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

function renderButton() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VehicleHistoryExportButton vehicleId={VEHICLE_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiBlob.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

describe('VehicleHistoryExportButton', () => {
  it('generates with the default (show_names=true) and opens the PDF', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/export.pdf?show_names=true`,
        { method: 'GET' },
      ),
    );
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
    openSpy.mockRestore();
  });

  it('reflects the toggle in the request when "Mostra nome officina" is turned off', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    vi.spyOn(window, 'open').mockReturnValue({} as Window);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    await user.click(screen.getByLabelText(/Mostra nome officina/i));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/export.pdf?show_names=false`,
        { method: 'GET' },
      ),
    );
  });

  it('shows an Italian error message when generation fails', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new ApiError('vehicle.not_found', 404, 'not found'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Veicolo non trovato/i),
    );
  });

  it('clears the stale error banner when the dialog is closed and reopened', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new ApiError('vehicle.not_found', 404, 'not found'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Veicolo non trovato/i),
    );

    // Close the dialog manually (Escape) without retrying.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Reopen — the stale error banner must be gone.
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

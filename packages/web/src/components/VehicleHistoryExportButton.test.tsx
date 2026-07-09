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
  it('generates with defaults (scope=all, show_names=true) and opens the PDF', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/export.pdf?scope=all&show_names=true`,
        { method: 'GET' },
      ),
    );
    expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank');
    openSpy.mockRestore();
  });

  it('reflects the toggles in the request (own scope, names hidden)', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Esporta storico PDF/i }));
    // Turn OFF "include other officine" (→ scope=own) and "show names" (→ show_names=false).
    await user.click(screen.getByLabelText(/Includi anche le altre officine/i));
    await user.click(screen.getByLabelText(/Mostra nomi officine/i));
    await user.click(screen.getByRole('button', { name: /Genera PDF/i }));

    await waitFor(() =>
      expect(mockApiBlob).toHaveBeenCalledWith(
        `/v1/vehicles/${VEHICLE_ID}/export.pdf?scope=own&show_names=false`,
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
});

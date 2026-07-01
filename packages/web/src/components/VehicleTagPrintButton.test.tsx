import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { VehicleTagPrintButton } from './VehicleTagPrintButton';
import type { Props as VehicleTagPrintButtonProps } from './VehicleTagPrintButton';
import { ApiError } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockApiBlob } = vi.hoisted(() => ({
  mockApiBlob: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiBlob: () => mockApiBlob,
  };
});

vi.mock('./VehicleTagReprintDialog', () => ({
  VehicleTagReprintDialog: vi.fn(({ open }: { open: boolean }) =>
    open ? <div role="dialog">mock-reprint-dialog</div> : null,
  ),
}));

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function pdfBlob(): Blob {
  return new Blob(['%PDF-1.4'], { type: 'application/pdf' });
}

function renderButton(props: Partial<VehicleTagPrintButtonProps> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VehicleTagPrintButton
        vehicleId={VEHICLE_ID}
        tagFirstPrintedAt={null}
        status="certified"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiBlob.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

describe('VehicleTagPrintButton', () => {
  // 1. Renders idle button "Stampa tag"
  it('renders idle button with "Stampa tag" label', () => {
    renderButton();
    const button = screen.getByRole('button', { name: /Stampa tag/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  // 2. Click triggers mutation and opens window on success
  it('calls mutation and opens window on success', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockResolvedValueOnce(pdfBlob());
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderButton();
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank'));

    openSpy.mockRestore();
  });

  // 3. Shows loading state during fetch
  it('shows "Generazione PDF..." and disables button while pending', async () => {
    const user = userEvent.setup();
    // Never resolves, keeping the mutation in isPending state
    mockApiBlob.mockImplementationOnce(() => new Promise(() => {}));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Generazione PDF/i });
      expect(button).toBeDisabled();
    });
  });

  // 4. Shows error message on failure — vehicle.archived
  it('shows "archiviati" error message when mutation fails with vehicle.archived', async () => {
    const user = userEvent.setup();
    mockApiBlob.mockRejectedValueOnce(new ApiError('vehicle.archived', 409, 'Vehicle is archived'));

    renderButton();
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/archiviati/i));
  });
});

describe('gating via tagFirstPrintedAt prop', () => {
  it('renders "Stampa tag" label when tagFirstPrintedAt is null', () => {
    renderButton({ vehicleId: VEHICLE_ID, tagFirstPrintedAt: null });
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /ristampa tag/i })).not.toBeInTheDocument();
  });

  it('renders "Ristampa tag" label when tagFirstPrintedAt is set', () => {
    renderButton({ vehicleId: VEHICLE_ID, tagFirstPrintedAt: '2026-04-10T12:34:56.789Z' });
    expect(screen.getByRole('button', { name: /ristampa tag/i })).toBeVisible();
  });

  it('clicking "Ristampa tag" opens the dialog', async () => {
    renderButton({ vehicleId: VEHICLE_ID, tagFirstPrintedAt: '2026-04-10T12:34:56.789Z' });
    await userEvent.click(screen.getByRole('button', { name: /ristampa tag/i }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });
});

describe('status gate (#6)', () => {
  it('disables the button and shows reason for pending vehicles', () => {
    renderButton({ status: 'pending' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeDisabled();
    expect(screen.getByText('Disponibile dopo la certificazione')).toBeVisible();
  });

  it('disables the button and shows reason for archived vehicles', () => {
    renderButton({ status: 'archived' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).toBeDisabled();
    expect(screen.getByText('Non disponibile per veicoli archiviati')).toBeVisible();
  });

  it('enables the button for certified vehicles', () => {
    renderButton({ status: 'certified' });
    expect(screen.getByRole('button', { name: /stampa tag/i })).not.toBeDisabled();
  });

  it('does not fire the mutation or open the dialog when clicked while disabled', async () => {
    const user = userEvent.setup();
    // Prior print would normally make this a reprint; archived keeps it disabled.
    renderButton({ status: 'archived', tagFirstPrintedAt: '2026-04-10T12:34:56.789Z' });
    const button = screen.getByRole('button', { name: /ristampa tag/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(mockApiBlob).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

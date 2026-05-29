import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { VehicleTagPrintButton } from './VehicleTagPrintButton';
import { ApiError } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

// ---------------------------------------------------------------------------
// Provider wrapper
// ---------------------------------------------------------------------------

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TAG_RESPONSE = {
  tag_download_url: 'https://example.com/tags/signed-url',
  expires_at: '2026-05-30T12:00:00Z',
};

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('VehicleTagPrintButton', () => {
  // 1. Renders idle button "Stampa tag"
  it('renders idle button with "Stampa tag" label', () => {
    render(<VehicleTagPrintButton vehicleId={VEHICLE_ID} />, { wrapper: wrap });
    const button = screen.getByRole('button', { name: /Stampa tag/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  // 2. Click triggers mutation and opens window on success
  it('calls mutation and opens window on success', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce(TAG_RESPONSE);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<VehicleTagPrintButton vehicleId={VEHICLE_ID} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(TAG_RESPONSE.tag_download_url, '_blank'),
    );

    openSpy.mockRestore();
  });

  // 3. Shows loading state during fetch
  it('shows "Generazione PDF..." and disables button while pending', async () => {
    const user = userEvent.setup();
    // Never resolves, keeping the mutation in isPending state
    mockApiFetch.mockImplementationOnce(() => new Promise(() => {}));

    render(<VehicleTagPrintButton vehicleId={VEHICLE_ID} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Generazione PDF/i });
      expect(button).toBeDisabled();
    });
  });

  // 4. Shows error message on failure — vehicle.archived
  it('shows "archiviati" error message when mutation fails with vehicle.archived', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('vehicle.archived', 409, 'Vehicle is archived'),
    );

    render(<VehicleTagPrintButton vehicleId={VEHICLE_ID} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: /Stampa tag/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/archiviati/i));
  });
});

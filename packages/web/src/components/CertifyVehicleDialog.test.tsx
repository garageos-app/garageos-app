import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CertifyVehicleDialog } from './CertifyVehicleDialog';
import { ApiError } from '@/lib/api-client';
import type { VehicleDetail } from '@/queries/types';

const { apiFetchMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';

// The wire carries backend Prisma enum values; queries/types.ts still
// declares legacy literals, hence the cast (same boundary as the dialog).
const PENDING_VEHICLE = {
  id: VEHICLE_ID,
  garageCode: null as unknown as string,
  vin: '1M8GDM9AXKP042788',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  version: null,
  year: 2021,
  registrationDate: null,
  vehicleType: 'car' as unknown as VehicleDetail['vehicleType'],
  fuelType: 'petrol' as unknown as VehicleDetail['fuelType'],
  engineDisplacement: null,
  powerKw: null,
  color: null,
  status: 'pending' as const,
  certifiedAt: null,
  certifiedByTenantId: null,
  createdAt: '2026-06-10T00:00:00Z',
  tag_first_printed_at: null,
} satisfies VehicleDetail;

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CertifyVehicleDialog open onOpenChange={onOpenChange} vehicle={PENDING_VEHICLE} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('CertifyVehicleDialog', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
  });

  it('submits librettoVisioned + only dirty fields as corrections, then toasts the GO-code', async () => {
    apiFetchMock.mockResolvedValue({
      vehicle: { id: VEHICLE_ID, garageCode: 'GO-456-BCDE', status: 'certified' },
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    // Correct one field against the libretto (year 2021 → 2019).
    const yearInput = screen.getByLabelText('Anno');
    await user.clear(yearInput);
    await user.type(yearInput, '2019');

    await user.click(screen.getByRole('switch', { name: /ho visionato il libretto/i }));
    await user.click(screen.getByRole('button', { name: /certifica veicolo/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiFetchMock.mock.calls[0] as [string, { body: string }];
    expect(path).toBe(`/v1/vehicles/${VEHICLE_ID}/certify`);
    // Dirty diff: untouched fields must NOT travel as corrections.
    expect(JSON.parse(init.body)).toEqual({
      librettoVisioned: true,
      corrections: { year: 2019 },
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('GO-456-BCDE'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the submit disabled until the libretto declaration is checked (BR-004)', async () => {
    const user = userEvent.setup();
    renderDialog();

    const submit = screen.getByRole('button', { name: /certifica veicolo/i });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: /ho visionato il libretto/i }));
    expect(submit).not.toBeDisabled();
  });

  it('maps API errors to the Italian message', async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError('vehicle.certification.not_pending', 422, 'not pending'),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('switch', { name: /ho visionato il libretto/i }));
    await user.click(screen.getByRole('button', { name: /certifica veicolo/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Il veicolo è già stato certificato.'),
    );
  });
});

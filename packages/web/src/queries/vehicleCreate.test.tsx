import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCreateVehicle } from './vehicleCreate';
import type { CreateVehiclePayload } from '@/lib/validators/createVehicle';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => mockApiFetch };
});

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const payload: CreateVehiclePayload = {
  vehicle: {
    vin: '1HGCM82633A004352',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    year: 2020,
    vehicleType: 'car',
    fuelType: 'petrol',
    odometerKm: 45000,
  },
  customer: {
    mode: 'create_new',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'm@e.it',
    isBusiness: false,
  },
  locationId: '11111111-1111-4111-8111-111111111111',
  sendInvitationEmail: false,
  forceNonstandardVin: false,
};

describe('useCreateVehicle', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('POSTs the payload to /v1/vehicles and returns the response', async () => {
    mockApiFetch.mockResolvedValueOnce({ vehicle: { id: 'v1', garageCode: 'GO-AB12CD' } });
    const { result } = renderHook(() => useCreateVehicle(), { wrapper: wrap });
    const res = await result.current.mutateAsync(payload);
    expect(res.vehicle.garageCode).toBe('GO-AB12CD');
    expect(mockApiFetch).toHaveBeenCalledWith('/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  });

  it('forwards the force flag when present', async () => {
    mockApiFetch.mockResolvedValueOnce({ vehicle: { id: 'v2', garageCode: 'GO-XX99YY' } });
    const { result } = renderHook(() => useCreateVehicle(), { wrapper: wrap });
    await result.current.mutateAsync({ ...payload, force: true });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const sentBody = JSON.parse(mockApiFetch.mock.calls[0][1].body);
    expect(sentBody.force).toBe(true);
  });
});

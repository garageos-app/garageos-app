import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SearchResults } from './SearchResults';
import type { VehicleSearchResponse } from '@/queries/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ initialPath, children }: { initialPath: string; children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const VEHICLE_FIXTURE = {
  id: 'veh-1',
  garageCode: 'GO-234-ABCD',
  vin: 'ZFA31200000123456',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'auto' as const,
  fuelType: 'gasoline' as const,
  status: 'certified' as const,
  currentOwnership: null,
};

describe('SearchResults — t=customer branch', () => {
  it('renders the vehicles list when ?customer=<uuid>&t=customer', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce({
      data: [VEHICLE_FIXTURE],
      meta: { has_more: false },
    } satisfies VehicleSearchResponse);

    const path = '/search?customer=11111111-1111-4111-8111-111111111111&t=customer';
    render(
      wrap({
        initialPath: path,
        children: <SearchResults />,
      }),
    );

    await waitFor(() => expect(screen.getByText(/Fiat Panda/i)).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/vehicles/search?customer=11111111-1111-4111-8111-111111111111'),
    );
    expect(screen.getByText(/Veicoli del/i)).toBeInTheDocument();
  });

  it('shows the invalid-params alert when customer is not a UUID', () => {
    apiFetchMock.mockClear();
    render(
      wrap({
        initialPath: '/search?customer=not-a-uuid&t=customer',
        children: <SearchResults />,
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/parametri.*invalidi/i);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('shows the invalid-params alert when customer is missing', () => {
    apiFetchMock.mockClear();
    render(
      wrap({
        initialPath: '/search?t=customer',
        children: <SearchResults />,
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/parametri.*invalidi/i);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('SearchResults — q+t branch (regression)', () => {
  it('still works for plate search', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce({
      data: [VEHICLE_FIXTURE],
      meta: { has_more: false },
    } satisfies VehicleSearchResponse);

    render(
      wrap({
        initialPath: '/search?q=AB123CD&t=plate',
        children: <SearchResults />,
      }),
    );

    await waitFor(() => expect(screen.getByText(/Fiat Panda/i)).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('plate=AB123CD'));
    expect(screen.getByText(/Ricerca per/i)).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { VehicleCreate } from './VehicleCreate';
import { ApiError } from '@/lib/api-client';

const { mockMutateAsync, mockToastSuccess, mockToastError, mockNavigate, profileRef, filterRef } =
  vi.hoisted(() => ({
    mockMutateAsync: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockNavigate: vi.fn(),
    profileRef: { current: { data: undefined as unknown, isPending: false, isError: false } },
    filterRef: {
      current: {
        isSuperAdmin: false,
        locations: [] as unknown[],
        selectedLocationId: null as string | null,
      },
    },
  }));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/queries/vehicleCreate', () => ({
  useCreateVehicle: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
vi.mock('@/queries/profileMe', () => ({ useProfileMe: () => profileRef.current }));
vi.mock('@/location-filter/useLocationFilter', () => ({
  useLocationFilter: () => filterRef.current,
}));
// Stub the autocomplete: expose a button that selects a fixed customer.
vi.mock('@/components/CustomerAutocomplete', () => ({
  CustomerAutocomplete: ({ onSelect }: { onSelect: (c: { id: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: '22222222-2222-4222-8222-222222222222' })}>
      pick-customer
    </button>
  ),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/vehicles/new" element={<VehicleCreate />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: wrap },
  );
}

const MECHANIC = { role: 'mechanic', locationId: '11111111-1111-4111-8111-111111111111' };

async function fillVehicle() {
  await userEvent.type(screen.getByLabelText(/VIN/i), '1HGCM82633A004352');
  await userEvent.type(screen.getByLabelText(/Targa/i), 'AB123CD');
  await userEvent.type(screen.getByLabelText(/Marca/i), 'Fiat');
  await userEvent.type(screen.getByLabelText(/Modello/i), 'Panda');
  await userEvent.type(screen.getByLabelText(/^Anno/i), '2020');
  await userEvent.type(screen.getByLabelText(/Km attuali/i), '45000');
}
async function fillNewCustomer() {
  await userEvent.type(screen.getByLabelText('Nome'), 'Mario');
  await userEvent.type(screen.getByLabelText('Cognome'), 'Rossi');
  await userEvent.type(screen.getByLabelText('Email'), 'mario@example.it');
}

describe('VehicleCreate', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockNavigate.mockReset();
    profileRef.current = { data: MECHANIC, isPending: false, isError: false };
    filterRef.current = { isSuperAdmin: false, locations: [], selectedLocationId: null };
  });

  it('shows validation errors and does not submit an empty form', async () => {
    renderAt('/vehicles/new');
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText('Nome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Il VIN deve avere 17 caratteri')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits new customer + vehicle, toasts the GO-code and redirects', async () => {
    mockMutateAsync.mockResolvedValueOnce({ vehicle: { id: 'v1', garageCode: 'GO-AB12CD' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const body = mockMutateAsync.mock.calls[0][0];
    expect(body.vehicle.vin).toBe('1HGCM82633A004352');
    expect(body.customer).toMatchObject({ mode: 'create_new', firstName: 'Mario' });
    expect(body).not.toHaveProperty('locationId');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/vehicles/v1'));
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('GO-AB12CD'));
  });

  it('locks to an existing customer when customerId is in the URL', async () => {
    mockMutateAsync.mockResolvedValueOnce({ vehicle: { id: 'v9', garageCode: 'GO-ZZ00ZZ' } });
    renderAt('/vehicles/new?customerId=22222222-2222-4222-8222-222222222222');
    expect(screen.queryByLabelText('Nome')).not.toBeInTheDocument();
    expect(screen.getByText(/cliente selezionato/i)).toBeInTheDocument();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync.mock.calls[0][0].customer).toEqual({
      mode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('prefills the plate from the URL', () => {
    renderAt('/vehicles/new?plate=AB123CD');
    expect(screen.getByLabelText(/Targa/i)).toHaveValue('AB123CD');
  });

  it('opens the duplicate-plate dialog and re-submits with force on confirm', async () => {
    mockMutateAsync
      .mockRejectedValueOnce(
        new ApiError('vehicle.creation.duplicate_plate_warning', 409, 'targa duplicata'),
      )
      .mockResolvedValueOnce({ vehicle: { id: 'v2', garageCode: 'GO-DUP000' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText(/esiste già un veicolo con questa targa/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /censisci comunque/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockMutateAsync.mock.calls[1][0].force).toBe(true);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/vehicles/v2'));
  });

  it('navigates to search when "Apri veicolo esistente" is chosen', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError('vehicle.creation.duplicate_plate_warning', 409, 'targa duplicata'),
    );
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await userEvent.click(await screen.findByRole('button', { name: /apri veicolo esistente/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/search?q=AB123CD');
  });

  it('opens the VIN-checksum dialog and re-submits with forceNonstandardVin', async () => {
    mockMutateAsync
      .mockRejectedValueOnce(new ApiError('vehicle.creation.invalid_vin_checksum', 400, 'checksum'))
      .mockResolvedValueOnce({ vehicle: { id: 'v3', garageCode: 'GO-VIN000' } });
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    expect(await screen.findByText(/veicolo storico o agricolo/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /conferma/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockMutateAsync.mock.calls[1][0].forceNonstandardVin).toBe(true);
  });

  it('toasts a hard error on duplicate VIN (no override)', async () => {
    mockMutateAsync.mockRejectedValueOnce(
      new ApiError('vehicle.creation.duplicate_vin', 409, 'vin dup'),
    );
    renderAt('/vehicles/new');
    await fillNewCustomer();
    await fillVehicle();
    await userEvent.click(screen.getByRole('button', { name: /censisci veicolo/i }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Esiste già un veicolo con questo VIN.'),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

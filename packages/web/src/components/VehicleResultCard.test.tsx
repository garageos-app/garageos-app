import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { VehicleResultCard } from './VehicleResultCard';
import type { VehicleSearchItem } from '@/queries/types';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const mockVehicle: VehicleSearchItem = {
  id: 'uuid-vehicle-1',
  garageCode: 'GO-482-KXRT',
  vin: 'ZFA31200000123456',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2018,
  vehicleType: 'auto',
  fuelType: 'diesel',
  status: 'certified',
  currentOwnership: {
    id: 'ownership-1',
    startedAt: '2020-01-01T00:00:00Z',
    customer: {
      id: 'cust-1',
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'm@example.com',
      phone: null,
    },
  },
};

describe('VehicleResultCard', () => {
  it('click naviga a /vehicles/:id', async () => {
    navigateMock.mockClear();
    render(
      <MemoryRouter>
        <VehicleResultCard vehicle={mockVehicle} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(navigateMock).toHaveBeenCalledWith('/vehicles/uuid-vehicle-1');
  });

  it('customer mascherato → mostra "—" invece di nome', () => {
    const masked: VehicleSearchItem = {
      ...mockVehicle,
      currentOwnership: { ...mockVehicle.currentOwnership!, customer: null },
    };
    render(
      <MemoryRouter>
        <VehicleResultCard vehicle={masked} />
      </MemoryRouter>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

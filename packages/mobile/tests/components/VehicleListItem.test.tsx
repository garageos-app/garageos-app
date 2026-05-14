import { fireEvent, render, screen } from '@testing-library/react-native';
import { VehicleListItem } from '@/components/VehicleListItem';
import type { MeVehicleSummary } from '@/lib/types/vehicle';

const vehicle: MeVehicleSummary = {
  id: 'v1',
  garageCode: 'GO-001-AAAA',
  vin: 'WVWZZZ1JZXW000001',
  plate: 'AB123CD',
  plateCountry: 'IT',
  make: 'Fiat',
  model: 'Panda',
  year: 2020,
  vehicleType: 'car',
  fuelType: 'gasoline',
  status: 'active',
  currentOwnership: { id: 'o1', startedAt: '2024-01-01T00:00:00Z' },
};

describe('VehicleListItem', () => {
  it('renders make+model and plate', () => {
    render(<VehicleListItem vehicle={vehicle} onPress={() => {}} />);
    expect(screen.getByText('Fiat Panda')).toBeOnTheScreen();
    expect(screen.getByText('AB123CD')).toBeOnTheScreen();
  });

  it('calls onPress on tap', () => {
    const onPress = jest.fn();
    render(<VehicleListItem vehicle={vehicle} onPress={onPress} />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

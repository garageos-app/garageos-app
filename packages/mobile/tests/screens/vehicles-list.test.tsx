import { fireEvent, render, screen } from '@testing-library/react-native';
import VehicleListScreen from '../../app/(tabs)/index';
import * as meVehicles from '@/queries/meVehicles';
import { useRouter } from 'expo-router';

jest.mock('@/queries/meVehicles');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const mockedQuery = meVehicles as jest.Mocked<typeof meVehicles>;
const mockedRouter = useRouter as jest.Mock;

describe('VehicleListScreen — empty state CTA', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('navigates to the claim screen when "Aggiungi veicolo" is tapped', () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ push });
    mockedQuery.useMeVehiclesList.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    } as unknown as ReturnType<typeof meVehicles.useMeVehiclesList>);

    render(<VehicleListScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi veicolo' }));
    expect(push).toHaveBeenCalledWith('/claim-vehicle');
  });
});

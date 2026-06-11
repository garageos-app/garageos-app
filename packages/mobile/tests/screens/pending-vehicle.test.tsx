import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PendingVehicleScreen from '../../app/pending-vehicle';
import { ApiError } from '@/lib/api-error';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockMutateAsync = jest.fn();

jest.mock('@/queries/pendingVehicle', () => ({
  useCreatePendingVehicle: () => ({ mutateAsync: mockMutateAsync }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mockReplace, back: mockBack }),
}));

// Fills every form field with valid values (same fixture as the form test).
function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Es. ZFA16900001234567'), 'ZFA16900001234567');
  fireEvent.changeText(screen.getByPlaceholderText('Es. AB123CD'), 'AB123CD');
  fireEvent.changeText(screen.getByPlaceholderText('Es. Fiat'), 'Fiat');
  fireEvent.changeText(screen.getByPlaceholderText('Es. Panda'), 'Panda');
  fireEvent.changeText(screen.getByPlaceholderText('Es. 2018'), '2018');
  fireEvent.press(screen.getByTestId('chip-vehicleType-car'));
  fireEvent.press(screen.getByTestId('chip-fuelType-petrol'));
}

describe('PendingVehicle screen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the pre-registration form', () => {
    render(<PendingVehicleScreen />);
    expect(screen.getByText('Telaio (VIN)')).toBeOnTheScreen();
    expect(screen.getByText('Targa')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pre-registra' })).toBeOnTheScreen();
  });

  it('submits the body and navigates to the new vehicle detail via replace', async () => {
    mockMutateAsync.mockResolvedValue({ vehicle: { id: 'new-vehicle-id' } });
    render(<PendingVehicleScreen />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/vehicles/new-vehicle-id'),
    );
    expect(mockMutateAsync).toHaveBeenCalledWith({
      vin: 'ZFA16900001234567',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      year: 2018,
      vehicleType: 'car',
      fuelType: 'petrol',
    });
  });

  it('maps an ApiError from the mutation to the Italian banner (no navigation)', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError('vehicle.pending.duplicate_vin_certified', 409, 'x'),
    );
    render(<PendingVehicleScreen />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Esiste già un veicolo registrato con questo telaio/),
      ).toBeOnTheScreen(),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('shows the generic banner for a non-ApiError failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));
    render(<PendingVehicleScreen />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() => expect(screen.getByText(/Si è verificato un errore/)).toBeOnTheScreen());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('"Annulla" calls router.back', () => {
    render(<PendingVehicleScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PendingVehicleForm } from '@/components/PendingVehicleForm';

// Fills every text field with valid values and selects one chip per group.
// VIN is typed lowercase on purpose: the form must normalize to uppercase.
function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Es. ZFA16900001234567'), ' zfa16900001234567 ');
  fireEvent.changeText(screen.getByPlaceholderText('Es. AB123CD'), ' ab123cd ');
  fireEvent.changeText(screen.getByPlaceholderText('Es. Fiat'), '  Fiat ');
  fireEvent.changeText(screen.getByPlaceholderText('Es. Panda'), ' Panda ');
  fireEvent.changeText(screen.getByPlaceholderText('Es. 2018'), ' 2018 ');
  fireEvent.press(screen.getByTestId('chip-vehicleType-car'));
  fireEvent.press(screen.getByTestId('chip-fuelType-petrol'));
}

describe('PendingVehicleForm', () => {
  it('renders hint, the 5 text fields, both chip groups and the submit button', () => {
    render(<PendingVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(/in attesa di certificazione/)).toBeOnTheScreen();
    expect(screen.getByText('Telaio (VIN)')).toBeOnTheScreen();
    expect(screen.getByText('Targa')).toBeOnTheScreen();
    expect(screen.getByText('Marca')).toBeOnTheScreen();
    expect(screen.getByText('Modello')).toBeOnTheScreen();
    expect(screen.getByText('Anno')).toBeOnTheScreen();
    expect(screen.getByText('Tipo veicolo')).toBeOnTheScreen();
    expect(screen.getByText('Alimentazione')).toBeOnTheScreen();
    // One chip per enum value, spot-check both groups
    expect(screen.getByTestId('chip-vehicleType-car')).toBeOnTheScreen();
    expect(screen.getByTestId('chip-vehicleType-agricultural')).toBeOnTheScreen();
    expect(screen.getByTestId('chip-fuelType-petrol')).toBeOnTheScreen();
    expect(screen.getByTestId('chip-fuelType-hydrogen')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pre-registra' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeOnTheScreen();
  });

  it('marks a chip as selected when pressed', () => {
    render(<PendingVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    const chip = screen.getByTestId('chip-fuelType-diesel');
    expect(chip.props.accessibilityState?.selected).toBe(false);
    fireEvent.press(chip);
    expect(screen.getByTestId('chip-fuelType-diesel').props.accessibilityState?.selected).toBe(
      true,
    );
  });

  it('blocks submit and shows required errors for every empty field', async () => {
    const onSubmit = jest.fn();
    render(<PendingVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() => {
      // 5 text fields + 2 chip groups, all required
      expect(screen.getAllByText('Campo obbligatorio')).toHaveLength(7);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the VIN format error for a 16-char VIN', async () => {
    const onSubmit = jest.fn();
    render(<PendingVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('Es. ZFA16900001234567'), 'ZFA1690000123456');
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() =>
      expect(
        screen.getByText('Il telaio (VIN) deve essere di 17 caratteri (senza I, O, Q)'),
      ).toBeOnTheScreen(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with the normalized CreatePendingVehicleRequest body', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<PendingVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      vin: 'ZFA16900001234567',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      year: 2018,
      vehicleType: 'car',
      fuelType: 'petrol',
    });
  });

  it('shows the mapped banner when onSubmit returns a server error code', async () => {
    const onSubmit = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'vehicle.pending.duplicate_vin_certified' });
    render(<PendingVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Pre-registra' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Esiste già un veicolo registrato con questo telaio/),
      ).toBeOnTheScreen(),
    );
  });

  it('guards against double submit while the promise is pending', async () => {
    const onSubmit = jest.fn(
      () =>
        new Promise(() => {
          // pending forever
        }) as Promise<{ ok: true }>,
    );
    render(<PendingVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fillValid();
    const button = screen.getByRole('button', { name: 'Pre-registra' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('pending-vehicle-submit').props.accessibilityState?.disabled).toBe(
        true,
      ),
    );
  });

  it('calls onCancel when Annulla tapped', () => {
    const onCancel = jest.fn();
    render(<PendingVehicleForm onSubmit={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

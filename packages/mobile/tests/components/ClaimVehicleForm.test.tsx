import { Modal } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ClaimVehicleForm } from '@/components/ClaimVehicleForm';

// Mock the camera component: a stub button that, when pressed, emits a valid code
// as if a QR had been scanned. Keeps the form test free of expo-camera.
jest.mock('@/components/QrScanner', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    QrScanner: ({ onScanned }: { onScanned: (code: string) => void }) =>
      React.createElement(
        Pressable,
        { testID: 'scanner-stub', onPress: () => onScanned('GO-234-ABCD') },
        React.createElement(Text, null, 'scanner'),
      ),
  };
});

describe('ClaimVehicleForm', () => {
  it('renders the code field, hint and submit button', () => {
    render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByPlaceholderText('GO-NNN-AAAA')).toBeOnTheScreen();
    expect(screen.getByText(/tag adesivo/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Aggiungi' })).toBeOnTheScreen();
  });

  it('blocks submit and shows a field error when the code is empty', async () => {
    const onSubmit = jest.fn();
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() => expect(screen.getByText('Codice obbligatorio')).toBeOnTheScreen());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a field error and does not submit a malformed code', async () => {
    const onSubmit = jest.fn();
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('GO-NNN-AAAA'), 'nonsense');
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() =>
      expect(screen.getByText('Codice non valido. Formato: GO-NNN-AAAA')).toBeOnTheScreen(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with a normalized (trimmed, uppercased) code', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('GO-NNN-AAAA'), '  go-234-abcd ');
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('GO-234-ABCD');
  });

  it('shows a banner mapped from the server error code', async () => {
    const onSubmit = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'me.vehicle.claim.owned_by_other' });
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText('GO-NNN-AAAA'), 'GO-234-ABCD');
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() => expect(screen.getByText(/altro account/)).toBeOnTheScreen());
  });

  it('calls onCancel when Annulla tapped', () => {
    const onCancel = jest.fn();
    render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('opens the scanner when "Scansiona QR" is tapped', () => {
    render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Scansiona QR' }));
    expect(screen.getByTestId('scanner-stub')).toBeOnTheScreen();
  });

  it('presents the scanner in a full-screen Modal (not inline in the scroll content)', () => {
    // Regression: the form lives inside a ScrollView; rendering the
    // absoluteFill QrScanner as an in-flow child collapses it to 0 height
    // (blank/white screen). A Modal escapes the scroll layout.
    render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.UNSAFE_getByType(Modal).props.visible).toBe(false);
    fireEvent.press(screen.getByRole('button', { name: 'Scansiona QR' }));
    expect(screen.UNSAFE_getByType(Modal).props.visible).toBe(true);
    expect(screen.getByTestId('scanner-stub')).toBeOnTheScreen();
  });

  it('pre-fills the code field from a scanned QR', async () => {
    render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Scansiona QR' }));
    fireEvent.press(screen.getByTestId('scanner-stub'));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('GO-NNN-AAAA').props.value).toBe('GO-234-ABCD'),
    );
  });

  it('pre-fills the code field from initialCode', () => {
    render(
      <ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} initialCode="GO-482-KXRT" />,
    );
    expect(screen.getByDisplayValue('GO-482-KXRT')).toBeOnTheScreen();
  });

  it('submits the pre-filled initialCode when "Aggiungi" is tapped', async () => {
    const onSubmit = jest.fn().mockResolvedValue({ ok: true });
    render(<ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} initialCode="GO-482-KXRT" />);
    fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('GO-482-KXRT'));
  });
});

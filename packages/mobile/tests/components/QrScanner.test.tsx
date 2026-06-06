import { fireEvent, render, screen } from '@testing-library/react-native';
import { QrScanner } from '@/components/QrScanner';

// Controllable mocks for expo-camera. `mockPermission` / `mockRequest` drive the
// permission state; `mockScanData` is the payload the mocked CameraView emits on
// press (so a test press simulates a barcode read).
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
let mockRequest = jest.fn();
let mockScanData = '';

jest.mock('expo-camera', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    useCameraPermissions: () => [mockPermission, mockRequest],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (e: { data: string }) => void }) =>
      React.createElement(
        Pressable,
        { testID: 'mock-camera', onPress: () => onBarcodeScanned?.({ data: mockScanData }) },
        React.createElement(Text, null, 'camera'),
      ),
  };
});

beforeEach(() => {
  mockPermission = null;
  mockRequest = jest.fn();
  mockScanData = '';
});

describe('QrScanner', () => {
  it('asks for permission when undetermined', () => {
    mockPermission = { granted: false, canAskAgain: true };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Consenti accesso camera' }));
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('shows the manual fallback when permission is denied for good', () => {
    mockPermission = { granted: false, canAskAgain: false };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(/Permesso camera negato/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Apri impostazioni' })).toBeOnTheScreen();
  });

  it('renders the camera when granted', () => {
    mockPermission = { granted: true, canAskAgain: false };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId('mock-camera')).toBeOnTheScreen();
  });

  it('calls onScanned with the extracted code on a valid QR', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://app.garageos.it/v/GO-234-ABCD';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(onScanned).toHaveBeenCalledWith('GO-234-ABCD');
  });

  it('shows "QR non riconosciuto" and does not call onScanned on an invalid QR', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://example.com';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(screen.getByText('QR non riconosciuto')).toBeOnTheScreen();
    expect(onScanned).not.toHaveBeenCalled();
  });

  it('ignores a second valid scan (one-shot guard)', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://app.garageos.it/v/GO-234-ABCD';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(onScanned).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from the camera overlay', () => {
    mockPermission = { granted: true, canAskAgain: false };
    const onCancel = jest.fn();
    render(<QrScanner onScanned={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

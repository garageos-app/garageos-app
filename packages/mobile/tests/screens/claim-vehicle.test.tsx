import { fireEvent, render, screen } from '@testing-library/react-native';
import ClaimVehicleScreen from '../../app/claim-vehicle';
import { useLocalSearchParams } from 'expo-router';

const mockPush = jest.fn();

jest.mock('@/queries/claimVehicle', () => ({
  useClaimVehicle: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ replace: jest.fn(), back: jest.fn(), push: mockPush })),
  useLocalSearchParams: jest.fn(),
  Stack: { Screen: () => null },
}));
// Stub the form: render the received initialCode so the test can assert it.
jest.mock('@/components/ClaimVehicleForm', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    ClaimVehicleForm: ({ initialCode }: { initialCode?: string }) =>
      React.createElement(Text, null, `INITIAL:${initialCode ?? 'none'}`),
  };
});

const mockedParams = useLocalSearchParams as jest.Mock;

describe('ClaimVehicle screen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a valid ?code to the form as initialCode', () => {
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:GO-482-KXRT')).toBeOnTheScreen();
  });

  it('ignores a malformed ?code (form gets no initialCode)', () => {
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:none')).toBeOnTheScreen();
  });

  it('handles an absent ?code (form gets no initialCode)', () => {
    mockedParams.mockReturnValue({});
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:none')).toBeOnTheScreen();
  });

  it('shows the pre-registration link and navigates to /pending-vehicle on press', () => {
    mockedParams.mockReturnValue({});
    render(<ClaimVehicleScreen />);
    fireEvent.press(
      screen.getByRole('button', { name: 'Non hai il codice? Pre-registra il veicolo' }),
    );
    expect(mockPush).toHaveBeenCalledWith('/pending-vehicle');
  });
});

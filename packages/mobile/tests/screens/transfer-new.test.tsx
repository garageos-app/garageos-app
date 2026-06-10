import { Share } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import NewTransferScreen from '../../app/transfers/new';
import { ApiError } from '@/lib/api-error';
import type { Transfer } from '@/lib/types/transfer';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockMutateAsync = jest.fn();
let mockParams: Record<string, string | undefined>;

const TRANSFER: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

jest.mock('@/queries/transfers', () => ({
  useInitiateTransfer: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mockBack, replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

describe('New transfer screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {
      vehicleId: TRANSFER.vehicleId,
      vehicleLabel: 'Fiat Panda · AB123CD',
    };
  });

  it('renders the summary with vehicle label and 7-day warning', () => {
    render(<NewTransferScreen />);
    expect(screen.getByText('Fiat Panda · AB123CD')).toBeOnTheScreen();
    expect(screen.getByText(/valido 7 giorni/)).toBeOnTheScreen();
    expect(screen.getByText(/resta di tua proprietà/)).toBeOnTheScreen();
  });

  it('shows an error state for an invalid vehicleId param', () => {
    mockParams = { vehicleId: 'not-a-uuid' };
    render(<NewTransferScreen />);
    expect(screen.getByText('Veicolo non valido.')).toBeOnTheScreen();
  });

  it('initiates the transfer and shows the code screen with share', async () => {
    mockMutateAsync.mockResolvedValue(TRANSFER);
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<NewTransferScreen />);
    fireEvent.press(screen.getByText('Avvia trasferimento'));
    await waitFor(() => expect(screen.getByTestId('transfer-code')).toBeOnTheScreen());
    expect(mockMutateAsync).toHaveBeenCalledWith({ vehicleId: TRANSFER.vehicleId });
    expect(screen.getByText('TR-ABCD-2345')).toBeOnTheScreen();

    fireEvent.press(screen.getByText('Condividi'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    expect(shareSpy.mock.calls[0]![0].message).toContain('TR-ABCD-2345');

    fireEvent.press(screen.getByText('Fine'));
    expect(mockReplace).toHaveBeenCalledWith(`/transfers/${TRANSFER.id}`);
  });

  it('maps an already_pending API error to the Italian banner', async () => {
    mockMutateAsync.mockRejectedValue(new ApiError('transfer.creation.already_pending', 409, 'x'));
    render(<NewTransferScreen />);
    fireEvent.press(screen.getByText('Avvia trasferimento'));
    await waitFor(() =>
      expect(
        screen.getByText("C'è già un trasferimento attivo per questo veicolo."),
      ).toBeOnTheScreen(),
    );
  });
});

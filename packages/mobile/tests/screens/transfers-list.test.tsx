import { render, screen, fireEvent } from '@testing-library/react-native';
import TransfersScreen from '../../app/transfers/index';
import type { Transfer } from '@/lib/types/transfer';

const mockPush = jest.fn();
let mockTransfersState: ReturnType<typeof makeState>;

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

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn().mockResolvedValue({}),
    data: [TRANSFER],
    ...overrides,
  };
}

jest.mock('@/queries/transfers', () => ({
  useTransfers: () => mockTransfersState,
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
}));

describe('Transfers list screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransfersState = makeState();
  });

  it('renders a card per transfer with vehicle, status label and date', () => {
    render(<TransfersScreen />);
    expect(screen.getByText('Fiat Panda')).toBeOnTheScreen();
    expect(screen.getByText('AB123CD')).toBeOnTheScreen();
    expect(screen.getByText('In attesa del nuovo proprietario')).toBeOnTheScreen();
    expect(screen.getByText('Avviato il 10/06/2026')).toBeOnTheScreen();
  });

  it('navigates to the detail on card tap', () => {
    render(<TransfersScreen />);
    fireEvent.press(screen.getByTestId(`transfer-row-${TRANSFER.id}`));
    expect(mockPush).toHaveBeenCalledWith(`/transfers/${TRANSFER.id}`);
  });

  it('shows the empty state when there are no transfers', () => {
    mockTransfersState = makeState({ data: [] });
    render(<TransfersScreen />);
    expect(screen.getByText('Nessun trasferimento')).toBeOnTheScreen();
    // The accept-transfer entry must survive the empty state (ListHeaderComponent).
    expect(screen.getByText('Hai ricevuto un codice?')).toBeOnTheScreen();
  });

  it('always offers the "Hai ricevuto un codice?" entry to accept-transfer', () => {
    render(<TransfersScreen />);
    fireEvent.press(screen.getByText('Hai ricevuto un codice?'));
    expect(mockPush).toHaveBeenCalledWith('/accept-transfer');
  });

  it('shows the error state with the fallback message', () => {
    mockTransfersState = makeState({ isError: true, data: undefined });
    render(<TransfersScreen />);
    expect(screen.getByText('Si è verificato un errore. Riprova più tardi.')).toBeOnTheScreen();
  });
});

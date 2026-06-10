import { Alert, Share } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import TransferDetailScreen from '../../app/transfers/[id]';
import type { Transfer, TransferStatus } from '@/lib/types/transfer';

const mockConfirmMutate = jest.fn();
const mockRejectMutate = jest.fn();
let mockDetailState: ReturnType<typeof makeState>;

const BASE: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

function makeState(transfer: Transfer) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
    data: transfer,
  };
}
function withStatus(status: TransferStatus, extra: Partial<Transfer> = {}): Transfer {
  return { ...BASE, status, ...extra };
}

jest.mock('@/queries/transfers', () => ({
  useTransfer: () => mockDetailState,
  useConfirmTransfer: () => ({ mutate: mockConfirmMutate, isPending: false, error: null }),
  useRejectTransfer: () => ({ mutate: mockRejectMutate, isPending: false, error: null }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
}));

describe('Transfer detail screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetailState = makeState(BASE);
  });

  it('pending_recipient: shows code, share and cancel action', () => {
    render(<TransferDetailScreen />);
    expect(screen.getByTestId('transfer-code')).toBeOnTheScreen();
    expect(screen.getByText('TR-ABCD-2345')).toBeOnTheScreen();
    expect(screen.getByText('Condividi')).toBeOnTheScreen();
    expect(screen.getByText('Annulla trasferimento')).toBeOnTheScreen();
    expect(screen.getByText('In attesa del nuovo proprietario')).toBeOnTheScreen();
  });

  it('cancel asks for confirmation, then rejects', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Annulla trasferimento'));
    expect(alertSpy).toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0]![2]!;
    const confirmBtn = buttons.find((b) => b.style === 'destructive')!;
    confirmBtn.onPress!();
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: BASE.id });
  });

  it('share hands the message to Share.share', () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Condividi'));
    expect(shareSpy).toHaveBeenCalled();
    expect(shareSpy.mock.calls[0]![0].message).toContain('TR-ABCD-2345');
  });

  it('pending_seller_confirmation: confirm dialog warns about definitive transfer', () => {
    mockDetailState = makeState(withStatus('pending_seller_confirmation'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Conferma passaggio'));
    expect(alertSpy.mock.calls[0]![1]).toMatch(/definitivamente/);
    const buttons = alertSpy.mock.calls[0]![2]!;
    buttons.find((b) => b.text === 'Conferma')!.onPress!();
    expect(mockConfirmMutate).toHaveBeenCalledWith(BASE.id);
  });

  it('pending_seller_confirmation: reject asks confirmation then rejects', () => {
    mockDetailState = makeState(withStatus('pending_seller_confirmation'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<TransferDetailScreen />);
    fireEvent.press(screen.getByText('Rifiuta'));
    const buttons = alertSpy.mock.calls[0]![2]!;
    buttons.find((b) => b.style === 'destructive')!.onPress!();
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: BASE.id });
  });

  it('completed: read-only with completion date, no actions', () => {
    mockDetailState = makeState(
      withStatus('completed', { completedAt: '2026-06-12T10:00:00.000Z', transferCode: null }),
    );
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Completato il 12\/06\/2026/)).toBeOnTheScreen();
    expect(screen.queryByText('Conferma passaggio')).toBeNull();
    expect(screen.queryByText('Annulla trasferimento')).toBeNull();
  });

  it('rejected: shows the reason when present', () => {
    mockDetailState = makeState(withStatus('rejected', { rejectedReason: 'Cambio idea' }));
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Cambio idea/)).toBeOnTheScreen();
  });

  it('expired: read-only with expiry date', () => {
    mockDetailState = makeState(withStatus('expired'));
    render(<TransferDetailScreen />);
    expect(screen.getByText(/Scaduto il 17\/06\/2026/)).toBeOnTheScreen();
    expect(screen.queryByText('Condividi')).toBeNull();
  });
});

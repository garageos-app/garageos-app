import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import AcceptTransferScreen from '../../app/accept-transfer';
import { ApiError } from '@/lib/api-error';
import type { Transfer } from '@/lib/types/transfer';

const mockReplace = jest.fn();
const mockPreviewMutateAsync = jest.fn();
const mockAcceptMutateAsync = jest.fn();
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
  useTransferPreview: () => ({ mutateAsync: mockPreviewMutateAsync, isPending: false }),
  useAcceptTransfer: () => ({ mutateAsync: mockAcceptMutateAsync, isPending: false }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

describe('Accept transfer screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
  });

  it('rejects a malformed code client-side without calling the API', () => {
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-XX');
    fireEvent.press(screen.getByText('Verifica'));
    expect(screen.getByText('Codice non valido. Formato: TR-XXXX-XXXX')).toBeOnTheScreen();
    expect(mockPreviewMutateAsync).not.toHaveBeenCalled();
  });

  it('verifies the code and shows the vehicle preview card', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'tr-abcd-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Fiat Panda')).toBeOnTheScreen());
    expect(mockPreviewMutateAsync).toHaveBeenCalledWith('TR-ABCD-2345');
    expect(screen.getByText('AB123CD')).toBeOnTheScreen();
    expect(screen.getByText(/Scade il 17\/06\/2026/)).toBeOnTheScreen();
    expect(screen.getByText('Accetta')).toBeOnTheScreen();
  });

  it('accepts from the preview and lands on the waiting-for-seller outcome', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    mockAcceptMutateAsync.mockResolvedValue({
      ...TRANSFER,
      status: 'pending_seller_confirmation',
    });
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Accetta')).toBeOnTheScreen());
    fireEvent.press(screen.getByText('Accetta'));
    await waitFor(() =>
      expect(screen.getByText(/In attesa della conferma del venditore/)).toBeOnTheScreen(),
    );
    expect(mockAcceptMutateAsync).toHaveBeenCalledWith('TR-ABCD-2345');
    fireEvent.press(screen.getByText('Fine'));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('"Indietro" returns from the preview to the input', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Indietro')).toBeOnTheScreen());
    fireEvent.press(screen.getByText('Indietro'));
    expect(screen.getByTestId('transfer-code-input')).toBeOnTheScreen();
  });

  it('maps an expired (410) preview error to the Italian banner', async () => {
    mockPreviewMutateAsync.mockRejectedValue(new ApiError('transfer.acceptance.expired', 410, 'x'));
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() =>
      expect(
        screen.getByText('Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.'),
      ).toBeOnTheScreen(),
    );
  });

  it('shows the banner on the preview when the accept itself fails (raced 410)', async () => {
    mockPreviewMutateAsync.mockResolvedValue(TRANSFER);
    mockAcceptMutateAsync.mockRejectedValue(new ApiError('transfer.acceptance.expired', 410, 'x'));
    render(<AcceptTransferScreen />);
    fireEvent.changeText(screen.getByTestId('transfer-code-input'), 'TR-ABCD-2345');
    fireEvent.press(screen.getByText('Verifica'));
    await waitFor(() => expect(screen.getByText('Accetta')).toBeOnTheScreen());
    fireEvent.press(screen.getByText('Accetta'));
    await waitFor(() =>
      expect(
        screen.getByText('Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.'),
      ).toBeOnTheScreen(),
    );
    // still on the preview phase, accept was attempted with the verified code
    expect(screen.getByText('Accetta')).toBeOnTheScreen();
    expect(mockAcceptMutateAsync).toHaveBeenCalledWith('TR-ABCD-2345');
  });

  it('prefills a well-formed ?code param (claim-vehicle redirect)', () => {
    mockParams = { code: 'TR-ABCD-2345' };
    render(<AcceptTransferScreen />);
    expect(screen.getByTestId('transfer-code-input').props.value).toBe('TR-ABCD-2345');
  });

  it('does not prefill a malformed ?code param', () => {
    mockParams = { code: 'TR-INVALID' };
    render(<AcceptTransferScreen />);
    expect(screen.getByTestId('transfer-code-input').props.value).toBe('');
  });
});

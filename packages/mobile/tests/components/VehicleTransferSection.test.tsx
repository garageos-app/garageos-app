import { render, screen, fireEvent } from '@testing-library/react-native';
import { VehicleTransferSection } from '@/components/VehicleTransferSection';
import type { Transfer } from '@/lib/types/transfer';

const mockPush = jest.fn();
let mockTransfersState: { isLoading: boolean; data: Transfer[] | undefined };

const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE: Transfer = {
  id: '11111111-1111-4111-8111-111111111111',
  vehicleId: VEHICLE_ID,
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
  method: 'physical_code',
  status: 'pending_recipient',
  transferCode: 'TR-ABCD-2345',
  expiresAt: '2026-06-17T10:00:00.000Z',
  createdAt: '2026-06-10T10:00:00.000Z',
};

jest.mock('@/queries/transfers', () => ({
  useTransfers: () => mockTransfersState,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('VehicleTransferSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransfersState = { isLoading: false, data: [] };
  });

  it('shows the transfer button when no active transfer exists', () => {
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    fireEvent.press(screen.getByText('Trasferisci proprietà'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/transfers/new',
      params: { vehicleId: VEHICLE_ID, vehicleLabel: 'Fiat Panda · AB123CD' },
    });
  });

  it('shows the in-progress banner when an active transfer exists for THIS vehicle', () => {
    mockTransfersState = { isLoading: false, data: [ACTIVE] };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    fireEvent.press(screen.getByText('Trasferimento in corso'));
    expect(mockPush).toHaveBeenCalledWith(`/transfers/${ACTIVE.id}`);
    expect(screen.queryByText('Trasferisci proprietà')).toBeNull();
  });

  it('ignores terminal transfers and other vehicles', () => {
    mockTransfersState = {
      isLoading: false,
      data: [
        { ...ACTIVE, status: 'rejected' },
        { ...ACTIVE, id: 'other', vehicleId: 'another-vehicle' },
      ],
    };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    expect(screen.getByText('Trasferisci proprietà')).toBeOnTheScreen();
  });

  it('falls back to the button when the transfers query errors', () => {
    // isError shape: not loading, data undefined. Server re-guards BR-047
    // with already_pending, so offering the button is safe.
    mockTransfersState = { isLoading: false, data: undefined };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    expect(screen.getByText('Trasferisci proprietà')).toBeOnTheScreen();
  });

  it('renders nothing while the transfers list is loading', () => {
    mockTransfersState = { isLoading: true, data: undefined };
    render(<VehicleTransferSection vehicleId={VEHICLE_ID} vehicleLabel="Fiat Panda · AB123CD" />);
    expect(screen.queryByText('Trasferisci proprietà')).toBeNull();
    expect(screen.queryByText('Trasferimento in corso')).toBeNull();
  });
});

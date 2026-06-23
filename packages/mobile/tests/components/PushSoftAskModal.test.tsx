// Visibility and behavior tests for PushSoftAskModal (Tier 2).
// Covers: dual-async gate (seen + status both resolved), show/hide conditions,
// and button interactions. No pure-render assertions.
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// --- Mocks (declared before any import that might pull the real modules) ---

const mockUsePushPermissionStatus = jest.fn();
jest.mock('@/queries/pushPermission', () => ({
  usePushPermissionStatus: () => mockUsePushPermissionStatus(),
}));

const mockEnable = jest.fn();
jest.mock('@/lib/useEnablePush', () => ({
  useEnablePush: () => ({ enable: mockEnable }),
}));

const mockReadSoftAskSeen = jest.fn<Promise<boolean>, []>();
const mockMarkSoftAskSeen = jest.fn<Promise<void>, []>();
jest.mock('@/lib/push-prompt-storage', () => ({
  readSoftAskSeen: () => mockReadSoftAskSeen(),
  markSoftAskSeen: () => mockMarkSoftAskSeen(),
}));

// Import AFTER mocks so the module-level bindings are already replaced.
import { PushSoftAskModal } from '@/components/PushSoftAskModal';

describe('PushSoftAskModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkSoftAskSeen.mockResolvedValue(undefined);
    mockEnable.mockResolvedValue('granted');
  });

  // -------------------------------------------------------------------------
  // Visibility gate: show the modal
  // -------------------------------------------------------------------------

  it('shows the modal when status is denied and soft-ask has not been seen', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    mockReadSoftAskSeen.mockResolvedValue(false);

    render(<PushSoftAskModal />);

    // Use findByText because seen is resolved asynchronously.
    await screen.findByText('Attiva le notifiche');
  });

  // -------------------------------------------------------------------------
  // Visibility gate: never show the modal
  // -------------------------------------------------------------------------

  it('renders null when status is granted and soft-ask has not been seen', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'granted' });
    mockReadSoftAskSeen.mockResolvedValue(false);

    render(<PushSoftAskModal />);

    await waitFor(() => {
      expect(screen.queryByText('Attiva le notifiche')).toBeNull();
    });
  });

  it('renders null when status is blocked and soft-ask has not been seen', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'blocked' });
    mockReadSoftAskSeen.mockResolvedValue(false);

    render(<PushSoftAskModal />);

    await waitFor(() => {
      expect(screen.queryByText('Attiva le notifiche')).toBeNull();
    });
  });

  it('renders null when status is denied but soft-ask has already been seen', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    mockReadSoftAskSeen.mockResolvedValue(true);

    render(<PushSoftAskModal />);

    await waitFor(() => {
      expect(screen.queryByText('Attiva le notifiche')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Button interactions
  // -------------------------------------------------------------------------

  it('calls enable AND markSoftAskSeen when the enable button is pressed', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    mockReadSoftAskSeen.mockResolvedValue(false);

    render(<PushSoftAskModal />);
    await screen.findByText('Attiva le notifiche');

    fireEvent.press(screen.getByTestId('softask-enable'));

    await waitFor(() => {
      expect(mockEnable).toHaveBeenCalledTimes(1);
      expect(mockMarkSoftAskSeen).toHaveBeenCalledTimes(1);
    });
  });

  it('calls markSoftAskSeen and does NOT call enable when dismiss button is pressed', async () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    mockReadSoftAskSeen.mockResolvedValue(false);

    render(<PushSoftAskModal />);
    await screen.findByText('Attiva le notifiche');

    fireEvent.press(screen.getByTestId('softask-dismiss'));

    await waitFor(() => {
      expect(mockMarkSoftAskSeen).toHaveBeenCalledTimes(1);
      expect(mockEnable).not.toHaveBeenCalled();
    });
  });
});

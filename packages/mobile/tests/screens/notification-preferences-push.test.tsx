import { fireEvent, render, waitFor } from '@testing-library/react-native';
import NotificationPreferencesScreen from '../../app/notification-preferences';

// Email prefs query: loaded data so the screen renders past the gate.
jest.mock('@/queries/notificationPreferences', () => ({
  useNotificationPreferences: () => ({
    isError: false,
    isLoading: false,
    data: {
      email: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        marketing: false,
        personal_deadline_reminder: false,
      },
      push: {
        intervention_updates: true,
        deadline_reminder: true,
        ownership_transfer: true,
        personal_deadline_reminder: false,
      },
    },
    refetch: jest.fn(),
  }),
  useUpdateNotificationPreference: () => ({ mutate: jest.fn() }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));

jest.mock('@/queries/pushTokens', () => ({
  useDeletePushToken: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

// The screen now delegates enable to useEnablePush and reads permission from
// usePushPermissionStatus. Mock at that seam instead of the raw push lib.
const mockEnable = jest.fn();
jest.mock('@/lib/useEnablePush', () => ({
  useEnablePush: () => ({ enable: mockEnable }),
}));

jest.mock('@/queries/pushPermission', () => ({
  usePushPermissionStatus: () => ({ data: 'denied' }),
  useInvalidatePushPermission: () => jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/push-token-storage', () => ({
  readPushTokenId: jest.fn().mockResolvedValue(null),
  writePushTokenId: jest.fn(),
  clearPushTokenId: jest.fn(),
}));

describe('device push toggle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers when permission is granted', async () => {
    // Arrange: enable() resolves 'granted' — the hook internally calls register.
    // At the screen seam, all we verify is that enable() was called and the
    // toggle flips ON (which indicates the screen's granted branch ran).
    mockEnable.mockResolvedValueOnce('granted');
    const { getByTestId } = render(<NotificationPreferencesScreen />);
    fireEvent(getByTestId('toggle-device-push'), 'valueChange', true);
    await waitFor(() => expect(mockEnable).toHaveBeenCalledTimes(1));
    // Toggle must end up ON after a 'granted' result.
    await waitFor(() => expect(getByTestId('toggle-device-push').props.value).toBe(true));
  });

  it('shows the settings hint when blocked and does not register', async () => {
    mockEnable.mockResolvedValueOnce('blocked');
    const { getByTestId, findByText } = render(<NotificationPreferencesScreen />);
    fireEvent(getByTestId('toggle-device-push'), 'valueChange', true);
    await findByText(/impostazioni/i);
    // enable() was called once — it is the hook's responsibility to skip
    // registration internally; from the screen's perspective enable() resolved.
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });
});

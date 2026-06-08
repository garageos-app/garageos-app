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
      },
    },
    refetch: jest.fn(),
  }),
  useUpdateNotificationPreference: () => ({ mutate: jest.fn() }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));

const mockRegister = jest.fn().mockResolvedValue({ id: 'x' });
const mockDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('@/queries/pushTokens', () => ({
  useRegisterPushToken: () => ({ mutateAsync: mockRegister, isPending: false }),
  useDeletePushToken: () => ({ mutateAsync: mockDelete, isPending: false }),
}));

const mockEnsure = jest.fn();
jest.mock('@/lib/push', () => ({
  ensurePushPermission: (...a: unknown[]) => mockEnsure(...a),
  getPushPermissionStatus: jest.fn().mockResolvedValue('denied'),
  getDevicePushToken: jest.fn().mockResolvedValue('ExpoPushToken[scr]'),
  buildRegistrationPayload: (t: string) => ({ expoPushToken: t, platform: 'android' }),
}));
jest.mock('@/lib/push-token-storage', () => ({
  readPushTokenId: jest.fn().mockResolvedValue(null),
  writePushTokenId: jest.fn(),
  clearPushTokenId: jest.fn(),
}));

describe('device push toggle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers when permission is granted', async () => {
    mockEnsure.mockResolvedValueOnce('granted');
    const { getByTestId } = render(<NotificationPreferencesScreen />);
    fireEvent(getByTestId('toggle-device-push'), 'valueChange', true);
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith({
        expoPushToken: 'ExpoPushToken[scr]',
        platform: 'android',
      }),
    );
  });

  it('shows the settings hint when blocked and does not register', async () => {
    mockEnsure.mockResolvedValueOnce('blocked');
    const { getByTestId, findByText } = render(<NotificationPreferencesScreen />);
    fireEvent(getByTestId('toggle-device-push'), 'valueChange', true);
    await findByText(/impostazioni/i);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

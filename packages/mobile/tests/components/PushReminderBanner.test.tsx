// Behavior/visibility tests for PushReminderBanner (Tier 2 — no pure-render assertions).
// Tests cover: visibility gates (granted, denied, blocked) and the dismiss action.
import { render, screen, fireEvent } from '@testing-library/react-native';
import { Linking, Pressable } from 'react-native';

const mockUsePushPermissionStatus = jest.fn();
jest.mock('@/queries/pushPermission', () => ({
  usePushPermissionStatus: () => mockUsePushPermissionStatus(),
}));

const mockEnable = jest.fn();
jest.mock('@/lib/useEnablePush', () => ({
  useEnablePush: () => ({ enable: mockEnable }),
}));

// Import AFTER mocks so the module-level bindings are already replaced.
import { PushReminderBanner } from '@/components/PushReminderBanner';

describe('PushReminderBanner', () => {
  let openSettings: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
  });

  afterEach(() => {
    openSettings.mockRestore();
  });

  it('renders null when status is granted', () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'granted' });
    render(<PushReminderBanner />);
    expect(screen.queryByTestId('push-reminder-banner')).toBeNull();
  });

  it('calls enable when status is denied and body is pressed', () => {
    mockEnable.mockResolvedValue('granted');
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    const { UNSAFE_getAllByType } = render(<PushReminderBanner />);
    expect(screen.getByTestId('push-reminder-banner')).toBeTruthy();
    // The body Pressable is the first child; dismiss is the second.
    const pressables = UNSAFE_getAllByType(Pressable);
    fireEvent.press(pressables[0]);
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });

  it('calls Linking.openSettings when status is blocked and body is pressed', () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'blocked' });
    const { UNSAFE_getAllByType } = render(<PushReminderBanner />);
    const pressables = UNSAFE_getAllByType(Pressable);
    fireEvent.press(pressables[0]);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('hides the banner after the dismiss button is pressed', () => {
    mockUsePushPermissionStatus.mockReturnValue({ data: 'denied' });
    const { UNSAFE_getAllByType } = render(<PushReminderBanner />);
    expect(screen.getByTestId('push-reminder-banner')).toBeTruthy();
    const pressables = UNSAFE_getAllByType(Pressable);
    // Dismiss is the second Pressable.
    fireEvent.press(pressables[1]);
    expect(screen.queryByTestId('push-reminder-banner')).toBeNull();
  });
});

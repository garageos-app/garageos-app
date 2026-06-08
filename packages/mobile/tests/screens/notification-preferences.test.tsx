import { render, screen, fireEvent } from '@testing-library/react-native';
import NotificationPreferencesScreen from '../../app/notification-preferences';

const mockMutate = jest.fn();
let mockPrefsState: ReturnType<typeof makeState>;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
    data: {
      email: {
        intervention_updates: true,
        deadline_reminder: false,
        ownership_transfer: true,
        marketing: false,
      },
    },
    ...overrides,
  };
}

jest.mock('@/queries/notificationPreferences', () => ({
  useNotificationPreferences: () => mockPrefsState,
  useUpdateNotificationPreference: () => ({ mutate: mockMutate }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));

describe('NotificationPreferences screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrefsState = makeState();
  });

  it('renders the 4 toggles reflecting current values', () => {
    render(<NotificationPreferencesScreen />);
    expect(screen.getByTestId('toggle-intervention_updates').props.value).toBe(true);
    expect(screen.getByTestId('toggle-deadline_reminder').props.value).toBe(false);
    expect(screen.getByTestId('toggle-ownership_transfer').props.value).toBe(true);
    expect(screen.getByTestId('toggle-marketing').props.value).toBe(false);
  });

  it('flipping a toggle calls mutate with key and new value', () => {
    render(<NotificationPreferencesScreen />);
    fireEvent(screen.getByTestId('toggle-marketing'), 'valueChange', true);
    expect(mockMutate).toHaveBeenCalledWith({ key: 'marketing', value: true });
  });

  it('shows the loading state (no toggles)', () => {
    mockPrefsState = makeState({ isLoading: true, data: undefined });
    render(<NotificationPreferencesScreen />);
    expect(screen.queryByTestId('toggle-marketing')).toBeNull();
  });

  it('shows the error state with the fallback message', () => {
    mockPrefsState = makeState({ isError: true, data: undefined });
    render(<NotificationPreferencesScreen />);
    expect(screen.getByText('Si è verificato un errore. Riprova più tardi.')).toBeOnTheScreen();
  });
});

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import ProfileScreen from '../../app/(tabs)/profile';

const mockSignOut = jest.fn().mockResolvedValue(undefined);
jest.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    customerId: 'c1',
    email: 'a@b.it',
    status: 'authenticated',
  }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
// Profile reads the customer profile; stub the query to a loaded state.
jest.mock('@/queries/me', () => ({
  useMe: () => ({
    isLoading: false,
    isError: false,
    data: { firstName: 'A', lastName: 'B', email: 'a@b.it', phone: null },
  }),
  useUpdateMeProfile: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
const mockDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('@/queries/pushTokens', () => ({
  useDeletePushToken: () => ({ mutateAsync: mockDelete }),
}));
const mockReadId = jest.fn();
jest.mock('@/lib/push-token-storage', () => ({ readPushTokenId: () => mockReadId() }));

describe('logout deregisters push token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs the stored token before signing out', async () => {
    mockReadId.mockResolvedValueOnce('srv-id-9');
    const { getByText } = render(<ProfileScreen />);
    fireEvent.press(getByText('Esci'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('srv-id-9'));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  });

  it('still signs out when there is no stored token', async () => {
    mockReadId.mockResolvedValueOnce(null);
    const { getByText } = render(<ProfileScreen />);
    fireEvent.press(getByText('Esci'));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

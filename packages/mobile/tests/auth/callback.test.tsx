import { render, screen } from '@testing-library/react-native';
import { Redirect } from 'expo-router';
import AuthCallback from '../../app/auth/callback';

// Control the auth status the callback route reads.
const mockUseAuth = jest.fn();
jest.mock('@/auth/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

// Stub <Redirect> as a no-op spy so we can assert the redirect target without
// pulling in the real expo-router navigation tree (which needs a router context).
jest.mock('expo-router', () => ({
  Redirect: jest.fn(() => null),
}));

const mockRedirect = Redirect as unknown as jest.Mock;

describe('AuthCallback (OAuth redirect landing route)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects into the app once authenticated', () => {
    mockUseAuth.mockReturnValue({ status: 'authenticated' });
    render(<AuthCallback />);
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ href: '/(tabs)' }),
      expect.anything(),
    );
  });

  it('renders a neutral loading state (NOT an unmatched route / redirect) while the exchange is pending', () => {
    mockUseAuth.mockReturnValue({ status: 'loading' });
    render(<AuthCallback />);
    // Loading branch: the fullscreen LoadingState exposes this a11y label, and
    // crucially no Redirect is rendered (the token exchange is still in flight).
    expect(screen.getByLabelText('Caricamento')).toBeOnTheScreen();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect while unauthenticated (failure path navigates from the originating screen)', () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });
    render(<AuthCallback />);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

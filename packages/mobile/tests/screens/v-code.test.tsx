import { render, screen } from '@testing-library/react-native';
import VCodeScreen from '../../app/v/[code]';
import { useAuth } from '@/auth/useAuth';
import { useLocalSearchParams } from 'expo-router';

jest.mock('@/auth/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('expo-router', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    useLocalSearchParams: jest.fn(),
    Redirect: ({ href }: { href: string }) => React.createElement(Text, null, `REDIRECT:${href}`),
  };
});

const mockedAuth = useAuth as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

describe('Deep-link /v/[code] redirector', () => {
  beforeEach(() => jest.clearAllMocks());

  it('authenticated + valid code → redirects to claim with the code', () => {
    mockedAuth.mockReturnValue({ status: 'authenticated' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/claim-vehicle?code=GO-482-KXRT')).toBeOnTheScreen();
  });

  it('unauthenticated + valid code → redirects to login carrying the code', () => {
    mockedAuth.mockReturnValue({ status: 'unauthenticated' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/login?claimCode=GO-482-KXRT')).toBeOnTheScreen();
  });

  it('authenticated + malformed code → redirects to claim without a code', () => {
    mockedAuth.mockReturnValue({ status: 'authenticated' });
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/claim-vehicle')).toBeOnTheScreen();
  });

  it('unauthenticated + malformed code → redirects to plain login', () => {
    mockedAuth.mockReturnValue({ status: 'unauthenticated' });
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/login')).toBeOnTheScreen();
  });

  it('auth loading → shows a fullscreen loader, no redirect', () => {
    mockedAuth.mockReturnValue({ status: 'loading' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByLabelText('Caricamento')).toBeOnTheScreen();
    expect(screen.queryByText(/^REDIRECT:/)).toBeNull();
  });
});

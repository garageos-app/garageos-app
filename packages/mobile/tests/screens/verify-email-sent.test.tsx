import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import VerifyEmailSent from '../../app/verify-email-sent';
import { AuthProvider } from '@/auth/AuthContext';
import * as signupQuery from '@/queries/signup';
import * as storage from '@/lib/secure-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';

jest.mock('@/queries/signup');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useLocalSearchParams: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedSignup = signupQuery as jest.Mocked<typeof signupQuery>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

function renderScreen() {
  return render(
    <AuthProvider>
      <VerifyEmailSent />
    </AuthProvider>,
  );
}

describe('VerifyEmailSent screen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedStorage.clearTokens.mockResolvedValue();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn() });
    mockedParams.mockReturnValue({ email: 'mario.rossi@example.com' });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('displays the email from search params', () => {
    renderScreen();
    expect(screen.getByText(/mario.rossi@example.com/)).toBeOnTheScreen();
  });

  it('calls resendVerification and starts 60s cooldown on tap', async () => {
    mockedSignup.resendVerification.mockResolvedValue({ ok: true });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo/ }));
    await waitFor(() =>
      expect(mockedSignup.resendVerification).toHaveBeenCalledWith('mario.rossi@example.com'),
    );
    await waitFor(() => {
      expect(screen.getByText(/Invia di nuovo \(60s\)/)).toBeOnTheScreen();
    });
  });

  it('decrements the cooldown countdown each second', async () => {
    mockedSignup.resendVerification.mockResolvedValue({ ok: true });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo/ }));
    await waitFor(() => {
      expect(screen.getByText(/Invia di nuovo \(60s\)/)).toBeOnTheScreen();
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/Invia di nuovo \(57s\)/)).toBeOnTheScreen();
  });

  it('"Continua" replaces to /(tabs)', () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Continua' }));
    expect(replace).toHaveBeenCalledWith('/(tabs)');
  });

  it('"Torna al login" signs out and replaces to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    renderScreen();
    fireEvent.press(screen.getByText(/Torna al login/));
    await waitFor(() => expect(mockedStorage.clearTokens).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

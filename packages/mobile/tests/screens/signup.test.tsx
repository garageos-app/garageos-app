import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Signup from '../../app/signup';
import { renderWithAuth } from '../helpers/renderWithAuth';
import * as signupQuery from '@/queries/signup';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useRouter } from 'expo-router';

jest.mock('@/queries/signup');
jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedSignup = signupQuery as jest.Mocked<typeof signupQuery>;
const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;

// Shared fake token result for Google sign-in (mirrors AuthContext.signInWithGoogle shape)
const GOOGLE_TOKEN_RESULT: cognito.SignInResult = {
  idToken: 'google-id',
  accessToken: 'google-access',
  refreshToken: 'google-refresh',
  customerId: 'cust-google',
  email: 'google@example.com',
};

function fillForm() {
  fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
  fireEvent.changeText(screen.getByPlaceholderText('Password'), 'miapassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'miapassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Nome'), 'Mario');
  fireEvent.changeText(screen.getByPlaceholderText('Cognome'), 'Rossi');
}

async function renderSignup() {
  return renderWithAuth(<Signup />);
}

describe('Signup screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedStorage.writeTokens.mockResolvedValue();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
  });

  it('renders the SignupForm', async () => {
    await renderSignup();
    expect(screen.getByRole('button', { name: 'Registrati' })).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('on success: calls signupCustomer + signIn + replaces to /verify-email-sent', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: true,
      customer: {
        id: 'cust-1',
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        status: 'active',
        createdAt: '2026-05-15T12:00:00Z',
      },
    });
    mockedCognito.signInSrp.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust-1',
      email: 'mario.rossi@example.com',
    });
    await renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith({
        pathname: '/verify-email-sent',
        params: { email: 'mario.rossi@example.com' },
      }),
    );
    expect(mockedSignup.signupCustomer).toHaveBeenCalledWith({
      email: 'mario.rossi@example.com',
      password: 'miapassword1',
      firstName: 'Mario',
      lastName: 'Rossi',
    });
    expect(mockedCognito.signInSrp).toHaveBeenCalledWith('mario.rossi@example.com', 'miapassword1');
  });

  it('on signupCustomer failure: banner shown, no signIn call', async () => {
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: false,
      code: 'auth.signup.email_already_active',
      message: 'Un account con questa email è già registrato.',
    });
    await renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => {
      expect(screen.getByText(/Un account con questa email è già registrato/)).toBeOnTheScreen();
    });
    expect(mockedCognito.signInSrp).not.toHaveBeenCalled();
  });

  it('on signIn failure post-signup: redirects to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedSignup.signupCustomer.mockResolvedValue({
      ok: true,
      customer: {
        id: 'cust-1',
        email: 'mario.rossi@example.com',
        firstName: 'Mario',
        lastName: 'Rossi',
        status: 'active',
        createdAt: '2026-05-15T12:00:00Z',
      },
    });
    mockedCognito.signInSrp.mockRejectedValue(new Error('SRP transient'));
    await renderSignup();
    fillForm();
    fireEvent.press(screen.getByRole('button', { name: 'Registrati' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });

  describe('Google sign-up button', () => {
    it('renders "Registrati con Google" button', async () => {
      await renderSignup();
      expect(screen.getByRole('button', { name: 'Registrati con Google' })).toBeOnTheScreen();
    });

    it('on success: calls signInWithGoogle + navigates to /(tabs) (no verify-email screen)', async () => {
      const replace = jest.fn();
      mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
      // signInWithGoogle in AuthContext calls cognito.signInWithGoogle then writeTokens
      mockedCognito.signInWithGoogle.mockResolvedValue(GOOGLE_TOKEN_RESULT);
      mockedStorage.writeTokens.mockResolvedValue();
      await renderSignup();
      fireEvent.press(screen.getByRole('button', { name: 'Registrati con Google' }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/(tabs)'));
      expect(mockedCognito.signInWithGoogle).toHaveBeenCalledTimes(1);
      // Must NOT route to verify-email-sent (Google = already verified)
      expect(replace).not.toHaveBeenCalledWith(
        expect.objectContaining({ pathname: '/verify-email-sent' }),
      );
    });

    it('on auth.google.exchange_failed: shows Italian error banner', async () => {
      mockedCognito.signInWithGoogle.mockRejectedValue(
        Object.assign(new Error('exchange failed'), { code: 'auth.google.exchange_failed' }),
      );
      await renderSignup();
      fireEvent.press(screen.getByRole('button', { name: 'Registrati con Google' }));
      await waitFor(() => {
        expect(screen.getByText('Accesso con Google non riuscito. Riprova.')).toBeOnTheScreen();
      });
    });

    it('on auth.google.cancelled: no banner shown', async () => {
      mockedCognito.signInWithGoogle.mockRejectedValue(
        Object.assign(new Error('cancelled'), { code: 'auth.google.cancelled' }),
      );
      await renderSignup();
      fireEvent.press(screen.getByRole('button', { name: 'Registrati con Google' }));
      // Wait a tick for async handler to settle
      await waitFor(() => expect(mockedCognito.signInWithGoogle).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Accesso con Google non riuscito. Riprova.')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

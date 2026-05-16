import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ResetPasswordScreen from '../../app/reset-password';
import { renderWithAuth } from '../helpers/renderWithAuth';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';

jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  useLocalSearchParams: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

async function renderScreen() {
  return renderWithAuth(<ResetPasswordScreen />);
}

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('Codice'), '123456');
  fireEvent.changeText(screen.getByPlaceholderText('Nuova password'), 'newpassword1');
  fireEvent.changeText(screen.getByPlaceholderText('Conferma password'), 'newpassword1');
}

describe('/reset-password screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
    mockedParams.mockReturnValue({ email: 'mario.rossi@example.com' });
  });

  it('renders ResetPasswordForm with email hidden when query param present', async () => {
    await renderScreen();
    expect(screen.queryByPlaceholderText('Email')).toBeNull();
    expect(screen.getByPlaceholderText('Codice')).toBeOnTheScreen();
  });

  it('shows email input when no query param (direct deep-link)', async () => {
    mockedParams.mockReturnValue({});
    await renderScreen();
    expect(screen.getByPlaceholderText('Email')).toBeOnTheScreen();
  });

  it('calls confirmForgotPassword and redirects /login on success', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedCognito.confirmForgotPassword.mockResolvedValue({ ok: true });
    await renderScreen();
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(mockedCognito.confirmForgotPassword).toHaveBeenCalledWith(
        'mario.rossi@example.com',
        '123456',
        'newpassword1',
      );
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith({
        pathname: '/login',
        params: { reset: '1' },
      });
    });
  });

  it('does NOT redirect when confirmForgotPassword fails', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    mockedCognito.confirmForgotPassword.mockResolvedValue({
      ok: false,
      code: 'CodeMismatchException',
    });
    await renderScreen();
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(screen.getByText(/Codice non valido/)).toBeOnTheScreen();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('"Invia di nuovo il codice" calls forgotPasswordRequest with the email', async () => {
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
    await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: /Invia di nuovo il codice/ }));
    await waitFor(() => {
      expect(mockedCognito.forgotPasswordRequest).toHaveBeenCalledWith('mario.rossi@example.com');
    });
  });

  it('"Torna al login" replaces to /login', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn(), back: jest.fn() });
    await renderScreen();
    fireEvent.press(screen.getByText('Torna al login'));
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

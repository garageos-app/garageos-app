import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Login from '../../app/login';
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

async function renderLogin() {
  return renderWithAuth(<Login />);
}

describe('Login screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn() });
    mockedParams.mockReturnValue({});
  });

  it('shows validation when email empty', async () => {
    await renderLogin();
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => {
      expect(screen.getByText(/Email obbligatoria/)).toBeOnTheScreen();
    });
    expect(mockedCognito.signInSrp).not.toHaveBeenCalled();
  });

  it('shows validation on malformed email', async () => {
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'not-an-email');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => {
      expect(screen.getByText(/Email non valida/)).toBeOnTheScreen();
    });
    expect(mockedCognito.signInSrp).not.toHaveBeenCalled();
  });

  it('calls signIn and redirects on success', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    mockedCognito.signInSrp.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust',
      email: 'u@example.com',
    });
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/(tabs)'));
  });

  it('redirects to the pre-filled claim when ?claimCode is present on success', async () => {
    const replace = jest.fn();
    mockedRouter.mockReturnValue({ replace, push: jest.fn() });
    mockedParams.mockReturnValue({ claimCode: 'GO-482-KXRT' });
    mockedCognito.signInSrp.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust',
      email: 'u@example.com',
    });
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/claim-vehicle?code=GO-482-KXRT'));
  });

  it('shows IT banner for NotAuthorizedException', async () => {
    mockedCognito.signInSrp.mockRejectedValue(
      Object.assign(new Error('not auth'), { code: 'NotAuthorizedException' }),
    );
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'wrong');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => {
      expect(screen.getByText('Email o password non corretti.')).toBeOnTheScreen();
    });
  });

  it('shows IT banner for UserNotConfirmedException', async () => {
    mockedCognito.signInSrp.mockRejectedValue(
      Object.assign(new Error('not confirmed'), { code: 'UserNotConfirmedException' }),
    );
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => {
      expect(screen.getByText(/Account non confermato/)).toBeOnTheScreen();
    });
  });

  it('guards against double submit', async () => {
    // Intentionally never resolved: we want signIn to stay in-flight to
    // verify the submitting-guard blocks the second press.
    mockedCognito.signInSrp.mockReturnValue(
      new Promise(() => {
        // pending forever
      }) as ReturnType<typeof mockedCognito.signInSrp>,
    );
    await renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    const button = screen.getByRole('button', { name: 'Accedi' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(mockedCognito.signInSrp).toHaveBeenCalledTimes(1);
  });

  it('navigates to /signup when "Registrati" link tapped', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push });
    await renderLogin();
    fireEvent.press(screen.getByText(/Non hai un account/));
    expect(push).toHaveBeenCalledWith('/signup');
  });

  it('tapping "Hai dimenticato la password?" pushes /forgot-password', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push });
    await renderLogin();
    fireEvent.press(screen.getByText('Hai dimenticato la password?'));
    expect(push).toHaveBeenCalledWith('/forgot-password');
  });

  it('renders success banner when ?reset=1 param is present', async () => {
    mockedParams.mockReturnValue({ reset: '1' });
    await renderLogin();
    expect(screen.getByText(/Password aggiornata/)).toBeOnTheScreen();
  });

  it('does NOT render success banner when ?reset is absent', async () => {
    mockedParams.mockReturnValue({});
    await renderLogin();
    expect(screen.queryByText(/Password aggiornata/)).toBeNull();
  });
});

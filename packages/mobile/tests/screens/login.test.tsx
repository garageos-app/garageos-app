import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Login from '../../app/login';
import { AuthProvider } from '@/auth/AuthContext';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';
import { useRouter } from 'expo-router';

jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;
const mockedRouter = useRouter as jest.Mock;

function renderLogin() {
  return render(
    <AuthProvider>
      <Login />
    </AuthProvider>,
  );
}

describe('Login screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn() });
  });

  it('shows validation when email empty', async () => {
    renderLogin();
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => {
      expect(screen.getByText(/Email obbligatoria/)).toBeOnTheScreen();
    });
    expect(mockedCognito.signInSrp).not.toHaveBeenCalled();
  });

  it('shows validation on malformed email', async () => {
    renderLogin();
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
    renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/(tabs)'));
  });

  it('shows IT banner for NotAuthorizedException', async () => {
    mockedCognito.signInSrp.mockRejectedValue(
      Object.assign(new Error('not auth'), { code: 'NotAuthorizedException' }),
    );
    renderLogin();
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
    renderLogin();
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
    renderLogin();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
    fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
    const button = screen.getByRole('button', { name: 'Accedi' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(mockedCognito.signInSrp).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ForgotPasswordScreen from '../../app/forgot-password';
import { renderWithAuth } from '../helpers/renderWithAuth';
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

async function renderScreen() {
  return renderWithAuth(<ForgotPasswordScreen />);
}

describe('/forgot-password screen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
  });

  it('renders the ForgotPasswordForm', async () => {
    await renderScreen();
    expect(screen.getByRole('button', { name: 'Invia codice' })).toBeOnTheScreen();
  });

  it('calls forgotPasswordRequest and pushes /reset-password on ok', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push, back: jest.fn() });
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
    await renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(mockedCognito.forgotPasswordRequest).toHaveBeenCalledWith('mario.rossi@example.com');
    });
    expect(push).toHaveBeenCalledWith({
      pathname: '/reset-password',
      params: { email: 'mario.rossi@example.com' },
    });
  });

  it('does NOT navigate when forgotPasswordRequest fails', async () => {
    const push = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push, back: jest.fn() });
    mockedCognito.forgotPasswordRequest.mockResolvedValue({
      ok: false,
      code: 'LimitExceededException',
    });
    await renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText('Email'), 'mario.rossi@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Invia codice' }));
    await waitFor(() => {
      expect(screen.getByText(/Troppi tentativi/)).toBeOnTheScreen();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('"Torna al login" goes back via router', async () => {
    const back = jest.fn();
    mockedRouter.mockReturnValue({ replace: jest.fn(), push: jest.fn(), back });
    await renderScreen();
    fireEvent.press(screen.getByText('Torna al login'));
    expect(back).toHaveBeenCalled();
  });
});

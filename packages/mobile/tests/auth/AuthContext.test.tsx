import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '@/auth/AuthContext';
import { useAuth } from '@/auth/useAuth';
import * as cognito from '@/lib/cognito';
import * as storage from '@/lib/secure-storage';

jest.mock('@/lib/cognito');
jest.mock('@/lib/secure-storage');

const mockedCognito = cognito as jest.Mocked<typeof cognito>;
const mockedStorage = storage as jest.Mocked<typeof storage>;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

describe('AuthContext', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('bootstraps to unauthenticated when storage empty', async () => {
    mockedStorage.readTokens.mockResolvedValue(null);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
  });

  it('bootstraps to authenticated when storage has valid tokens', async () => {
    mockedStorage.readTokens.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust-1',
      email: 'u@example.com',
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.customerId).toBe('cust-1');
    expect(result.current.email).toBe('u@example.com');
  });

  it('signIn success persists tokens and transitions to authenticated', async () => {
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedCognito.signInSrp.mockResolvedValue({
      idToken: 'newid',
      accessToken: 'newaccess',
      refreshToken: 'newrefresh',
      customerId: 'cust-2',
      email: 'u@example.com',
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    await act(async () => {
      await result.current.signIn('u@example.com', 'pwd');
    });
    expect(result.current.status).toBe('authenticated');
    expect(mockedStorage.writeTokens).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cust-2' }),
    );
  });

  it('signIn failure leaves state unauthenticated and propagates error', async () => {
    mockedStorage.readTokens.mockResolvedValue(null);
    const err = Object.assign(new Error('not auth'), { code: 'NotAuthorizedException' });
    mockedCognito.signInSrp.mockRejectedValue(err);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    await expect(
      act(async () => {
        await result.current.signIn('u@example.com', 'wrong');
      }),
    ).rejects.toThrow();
    expect(result.current.status).toBe('unauthenticated');
  });

  it('signOut clears storage and transitions to unauthenticated', async () => {
    mockedStorage.readTokens.mockResolvedValue({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
      customerId: 'cust-1',
      email: 'u@example.com',
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.status).toBe('unauthenticated');
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
  });

  it('treats null storage result as unauthenticated (corrupt-payload path is in secure-storage)', async () => {
    // secure-storage.readTokens already returns null for malformed payloads,
    // so AuthContext just needs to handle that null path (covered structurally
    // here; corrupt-payload filtering itself is unit-tested in secure-storage).
    mockedStorage.readTokens.mockResolvedValue(null);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
  });

  it('signInWithGoogle success persists tokens and transitions to authenticated', async () => {
    mockedStorage.readTokens.mockResolvedValue(null);
    mockedCognito.signInWithGoogle.mockResolvedValue({
      idToken: 'google-id',
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      customerId: 'cust-google',
      email: 'google@example.com',
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    await act(async () => {
      await result.current.signInWithGoogle();
    });
    expect(result.current.status).toBe('authenticated');
    expect(mockedStorage.writeTokens).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cust-google' }),
    );
  });

  it('signInWithGoogle failure leaves state unauthenticated and propagates error', async () => {
    mockedStorage.readTokens.mockResolvedValue(null);
    const err = Object.assign(new Error('Google sign-in cancelled by user'), {
      code: 'auth.google.cancelled',
    });
    mockedCognito.signInWithGoogle.mockRejectedValue(err);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    await expect(
      act(async () => {
        await result.current.signInWithGoogle();
      }),
    ).rejects.toThrow();
    expect(result.current.status).toBe('unauthenticated');
  });
});

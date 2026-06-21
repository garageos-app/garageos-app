// Mocks amazon-cognito-identity-js at the module level so cognito.ts can be
// imported without triggering the real SDK (which requires a live Cognito pool
// and secure-crypto that isn't available in Node/jest). Mirror the same pattern
// used in cognito-forgot-password.test.ts.
//
// Note: variables referenced inside jest.mock() factories must be prefixed
// with 'mock' (case-insensitive) to satisfy babel-jest hoisting rules.

const mockForgotPassword = jest.fn();
const mockConfirmPassword = jest.fn();

jest.mock('amazon-cognito-identity-js', () => ({
  __esModule: true,
  CognitoUserPool: jest.fn().mockImplementation(() => ({})),
  CognitoUser: jest.fn().mockImplementation(() => ({
    forgotPassword: mockForgotPassword,
    confirmPassword: mockConfirmPassword,
  })),
  // Stubs not exercised by these tests but required so cognito.ts imports
  // type-check against the mocked module.
  AuthenticationDetails: jest.fn(),
}));

import { AuthRequest, exchangeCodeAsync } from 'expo-auth-session';
import { decodeJwtPayload, signInWithGoogle } from '@/lib/cognito';

// ---------------------------------------------------------------------------
// decodeJwtPayload — pure logic (Node has global atob / Buffer)
// ---------------------------------------------------------------------------

describe('decodeJwtPayload', () => {
  it('extracts claims from a JWT middle segment', () => {
    const payload = { 'custom:customer_id': 'cust-123', email: 'u@example.com' };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const jwt = `header.${b64}.sig`;
    expect(decodeJwtPayload(jwt)).toMatchObject(payload);
  });

  it('throws on malformed jwt', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// signInWithGoogle — OAuth Authorization Code + PKCE flow
// ---------------------------------------------------------------------------

describe('signInWithGoogle', () => {
  beforeEach(() => {
    (exchangeCodeAsync as jest.Mock).mockReset();
    (AuthRequest as jest.Mock).mockReset();
  });

  it('returns a SignInResult on successful code exchange', async () => {
    const idTokenPayload = { 'custom:customer_id': 'cust-9', email: 'g@example.com' };
    const idToken = `h.${Buffer.from(JSON.stringify(idTokenPayload)).toString('base64url')}.s`;
    (AuthRequest as jest.Mock).mockImplementation(() => ({
      codeVerifier: 'v',
      promptAsync: jest.fn().mockResolvedValue({ type: 'success', params: { code: 'abc' } }),
    }));
    (exchangeCodeAsync as jest.Mock).mockResolvedValue({
      idToken,
      accessToken: 'acc',
      refreshToken: 'ref',
    });
    await expect(signInWithGoogle()).resolves.toEqual({
      idToken,
      accessToken: 'acc',
      refreshToken: 'ref',
      customerId: 'cust-9',
      email: 'g@example.com',
    });
  });

  it('throws auth.google.cancelled when the user dismisses the browser', async () => {
    (AuthRequest as jest.Mock).mockImplementation(() => ({
      codeVerifier: 'v',
      promptAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
    }));
    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth.google.cancelled' });
    expect(exchangeCodeAsync).not.toHaveBeenCalled();
  });

  it('throws auth.google.exchange_failed when token exchange rejects', async () => {
    (AuthRequest as jest.Mock).mockImplementation(() => ({
      codeVerifier: 'v',
      promptAsync: jest.fn().mockResolvedValue({ type: 'success', params: { code: 'abc' } }),
    }));
    (exchangeCodeAsync as jest.Mock).mockRejectedValue(new Error('network'));
    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth.google.exchange_failed' });
  });
});

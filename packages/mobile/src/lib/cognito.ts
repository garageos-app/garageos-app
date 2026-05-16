// RN polyfills must load BEFORE amazon-cognito-identity-js so SRP can use
// secure crypto.getRandomValues (otherwise SDK falls back to an insecure RNG
// and Cognito rejects the challenge with an opaque error).
import './crypto-polyfill';
import 'react-native-url-polyfill/auto';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
  type CognitoRefreshToken,
} from 'amazon-cognito-identity-js';

const poolId = process.env.EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID;
const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID;

if (!poolId) throw new Error('EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID not set');
if (!clientId) throw new Error('EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID not set');

export const clientiUserPool = new CognitoUserPool({
  UserPoolId: poolId,
  ClientId: clientId,
});

export type SignInResult = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  customerId: string;
  email: string;
};

function extractFromSession(session: CognitoUserSession, fallbackEmail: string): SignInResult {
  const idToken = session.getIdToken();
  const payload = idToken.payload as Record<string, unknown>;
  const customerId =
    typeof payload['custom:customer_id'] === 'string' ? payload['custom:customer_id'] : '';
  const email = typeof payload.email === 'string' ? payload.email : fallbackEmail;
  return {
    idToken: idToken.getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
    customerId,
    email,
  };
}

export function signInSrp(email: string, password: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    const auth = new AuthenticationDetails({
      Username: email,
      Password: password,
    });
    user.authenticateUser(auth, {
      onSuccess: (session) => resolve(extractFromSession(session, email)),
      onFailure: (err) => reject(err),
      newPasswordRequired: () =>
        reject(
          Object.assign(new Error('NEW_PASSWORD_REQUIRED'), {
            code: 'NEW_PASSWORD_REQUIRED',
          }),
        ),
    });
  });
}

export function refreshSession(email: string, refreshToken: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    // CognitoRefreshToken is a class; the SDK only reads `.getToken()` on it
    // during refreshSession, so a minimal object satisfying that contract is
    // sufficient. Documented typed shim — keeps strict mode happy without `any`.
    user.refreshSession(
      { getToken: () => refreshToken } as unknown as CognitoRefreshToken,
      (err, session: CognitoUserSession) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(extractFromSession(session, email));
      },
    );
  });
}

export type ForgotPasswordResult =
  | { ok: true; deliveryMedium: 'EMAIL' | 'SMS' | 'UNKNOWN' }
  | { ok: false; code: string };

// Anti-enumeration: UserNotFoundException and InvalidParameterException are
// both treated as success so the UI flow is identical for non-existent and
// unverified-existent emails. The user typing a wrong/unverified email will
// simply never receive a code and the next-screen confirm will fail with
// CodeMismatchException. See spec §2.2.
function extractDeliveryMedium(data: unknown): 'EMAIL' | 'SMS' | 'UNKNOWN' {
  if (typeof data === 'object' && data !== null) {
    const details = (data as { CodeDeliveryDetails?: { DeliveryMedium?: string } })
      .CodeDeliveryDetails;
    if (details?.DeliveryMedium === 'EMAIL') return 'EMAIL';
    if (details?.DeliveryMedium === 'SMS') return 'SMS';
  }
  return 'UNKNOWN';
}

function extractErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: string; name?: string };
    return e.code ?? e.name ?? 'UnknownError';
  }
  return 'UnknownError';
}

export function forgotPasswordRequest(email: string): Promise<ForgotPasswordResult> {
  return new Promise((resolve) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    user.forgotPassword({
      // inputVerificationCode intentionally omitted — the SDK invokes onSuccess
      // when the optional inputVerificationCode callback is absent.
      onSuccess: (data: unknown) => {
        resolve({ ok: true, deliveryMedium: extractDeliveryMedium(data) });
      },
      onFailure: (err: unknown) => {
        const code = extractErrorCode(err);
        if (code === 'UserNotFoundException' || code === 'InvalidParameterException') {
          resolve({ ok: true, deliveryMedium: 'UNKNOWN' });
          return;
        }
        resolve({ ok: false, code });
      },
    });
  });
}

export type ConfirmForgotPasswordResult = { ok: true } | { ok: false; code: string };

export function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<ConfirmForgotPasswordResult> {
  return new Promise((resolve) => {
    const user = new CognitoUser({ Username: email, Pool: clientiUserPool });
    user.confirmPassword(code, newPassword, {
      onSuccess: () => resolve({ ok: true }),
      onFailure: (err: unknown) => resolve({ ok: false, code: extractErrorCode(err) }),
    });
  });
}

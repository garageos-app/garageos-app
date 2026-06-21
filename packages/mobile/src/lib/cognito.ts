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
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

// Required to close the in-app browser when the redirect lands back in the app
// (expo-web-browser keeps the browser open until this is called on iOS/Android).
WebBrowser.maybeCompleteAuthSession();

const poolId = process.env.EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID;
const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID;
const hostedUi = process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI;

if (!poolId) throw new Error('EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID not set');
if (!clientId) throw new Error('EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID not set');
if (!hostedUi) throw new Error('EXPO_PUBLIC_COGNITO_HOSTED_UI not set');

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

// ---------------------------------------------------------------------------
// Google Sign-In — OAuth Authorization Code + PKCE via Cognito Hosted UI
// ---------------------------------------------------------------------------

/**
 * Decode the payload segment (middle part) of a JWT without re-verifying the
 * signature. Used to extract claims from Cognito-issued tokens on the client
 * after the server has already validated them.
 *
 * Handles base64url encoding (RFC 4648 §5): replaces `-` → `+` and `_` → `/`
 * before decoding. Works on both Hermes (RN 0.76) and Node (jest) which both
 * expose `atob` as a global.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const seg = jwt.split('.')[1];
  if (!seg) throw new Error('malformed jwt: missing payload segment');
  // Normalise base64url → base64 before feeding to atob.
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  // escape/decodeURIComponent round-trip handles multi-byte UTF-8 without
  // requiring Buffer (which is absent in Hermes on device).
  return JSON.parse(decodeURIComponent(escape(atob(b64)))) as Record<string, unknown>;
}

/**
 * Open the Cognito Hosted UI in an in-app browser, perform the OAuth
 * Authorization Code + PKCE exchange, and return a `SignInResult`.
 *
 * Error contract:
 * - User cancels / dismisses / browser is locked → throws Error with
 *   `.code === 'auth.google.cancelled'` (exchange is NOT called).
 * - Any other failure (network, token endpoint error) → throws Error with
 *   `.code === 'auth.google.exchange_failed'`.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'garageos', path: 'auth/callback' });

  const discovery = {
    authorizationEndpoint: `${hostedUi}/oauth2/authorize`,
    tokenEndpoint: `${hostedUi}/oauth2/token`,
  };

  const request = new AuthSession.AuthRequest({
    clientId: clientId!,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: ['openid', 'email', 'profile'],
    usePKCE: true,
    extraParams: { identity_provider: 'Google' },
  });

  const result = await request.promptAsync(discovery);

  if (result.type !== 'success') {
    throw Object.assign(new Error('Google sign-in cancelled by user'), {
      code: 'auth.google.cancelled',
    });
  }

  try {
    // noUncheckedIndexedAccess: params is Record<string,string> but indexed
    // access returns string|undefined. The code param is guaranteed by the
    // OAuth success response — non-null assert is correct here.

    const authCode = result.params.code!;
    const tokenResult = await AuthSession.exchangeCodeAsync(
      {
        clientId: clientId!,
        code: authCode,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? '' },
      },
      discovery,
    );

    const payload = decodeJwtPayload(tokenResult.idToken ?? '');
    const customerId = String(payload['custom:customer_id'] ?? '');
    const email = String(payload.email ?? '');

    return {
      idToken: tokenResult.idToken ?? '',
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken ?? '',
      customerId,
      email,
    };
  } catch (err) {
    throw Object.assign(new Error('Google sign-in token exchange failed'), {
      code: 'auth.google.exchange_failed',
      cause: err,
    });
  }
}

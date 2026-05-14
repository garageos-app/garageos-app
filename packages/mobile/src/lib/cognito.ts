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

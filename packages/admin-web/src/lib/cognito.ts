import { CognitoUserPool } from 'amazon-cognito-identity-js';

if (!import.meta.env.VITE_COGNITO_PLATFORM_ADMINS_POOL_ID) {
  throw new Error('VITE_COGNITO_PLATFORM_ADMINS_POOL_ID is not set at build time');
}
if (!import.meta.env.VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID) {
  throw new Error('VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID is not set at build time');
}

export const platformAdminsUserPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_PLATFORM_ADMINS_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID,
});

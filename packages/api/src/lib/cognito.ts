import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

import { env } from '../config/env.js';

// Lazy singleton — Cognito SDK clients are heavy (HTTP/2 connections,
// credential providers) and we want exactly one per Lambda warm
// container. Tests use `_resetCognitoClientForTests` to ensure
// `aws-sdk-client-mock` overrides the underlying transport on every
// test setup.
let _client: CognitoIdentityProviderClient | null = null;

export function getCognitoClient(): CognitoIdentityProviderClient {
  if (_client) return _client;
  _client = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetCognitoClientForTests(): void {
  _client = null;
}

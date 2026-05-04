import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

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

// Typed errors thrown by this module. The signup route catches by
// `name` and maps each to the appropriate HTTP error code. Using the
// `name` property keeps interop with `error-handler.ts` simple — its
// dot-separated check sees these names plain and surfaces them as-is.
export class CognitoEmailAlreadyExistsError extends Error {
  override name = 'CognitoEmailAlreadyExistsError';
}
export class CognitoInvalidPasswordError extends Error {
  override name = 'CognitoInvalidPasswordError';
}
export class CognitoUnavailableError extends Error {
  override name = 'CognitoUnavailableError';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function createCustomerCognitoUser(args: {
  poolId: string;
  email: string;
  firstName: string;
  lastName: string;
  customerId: string;
}): Promise<{ cognitoSub: string }> {
  const client = getCognitoClient();
  let resp;
  try {
    resp = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: args.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'given_name', Value: args.firstName },
          { Name: 'family_name', Value: args.lastName },
          { Name: 'custom:customer_id', Value: args.customerId },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new CognitoEmailAlreadyExistsError('Cognito user already exists for this email');
    }
    if (err instanceof InvalidPasswordException) {
      // AdminCreateUser does not validate password (no password is set
      // here) — but the policy applies via the pool's signup flow if the
      // SDK ever proxies it. Guard anyway for forward compat.
      throw new CognitoInvalidPasswordError('Cognito password policy violation');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }

  const sub = resp.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) {
    throw new CognitoUnavailableError('AdminCreateUser response missing sub attribute');
  }
  return { cognitoSub: sub };
}

export async function setCustomerCognitoPassword(args: {
  poolId: string;
  email: string;
  password: string;
}): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        Password: args.password,
        Permanent: true,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidPasswordException) {
      throw new CognitoInvalidPasswordError('Cognito password policy violation');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Idempotent — swallows UserNotFoundException so callers can use this in
// rollback paths without checking whether the user was actually created.
export async function deleteCognitoUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminDeleteUserCommand({ UserPoolId: args.poolId, Username: args.email }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

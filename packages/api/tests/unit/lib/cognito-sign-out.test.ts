import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CognitoUnavailableError, _resetCognitoClientForTests } from '../../../src/lib/cognito.js';
import { signOutOfficineUser } from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

afterEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

describe('signOutOfficineUser', () => {
  it('calls AdminUserGlobalSignOutCommand with correct PoolId + Username', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    await signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' });

    const calls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-central-1_TESTPOOL',
      Username: 'user@test.it',
    });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(
      new UserNotFoundException({
        message: 'User does not exist',
        $metadata: {},
      }),
    );

    // Must not throw.
    await expect(
      signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'gone@test.it' }),
    ).resolves.toBeUndefined();
  });

  it('wraps other errors in CognitoUnavailableError', async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error('Network failure'));

    await expect(
      signOutOfficineUser({ poolId: 'eu-central-1_TESTPOOL', email: 'user@test.it' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

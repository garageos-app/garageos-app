import {
  AdminLinkProviderForUserCommand,
  AliasExistsException,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CognitoUnavailableError,
  _resetCognitoClientForTests,
  findNativeClientiUserByEmail,
  linkGoogleIdentityToClientiUser,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  cognitoMock.reset();
  _resetCognitoClientForTests();
});

// ---------------------------------------------------------------------------
// findNativeClientiUserByEmail
// ---------------------------------------------------------------------------
describe('findNativeClientiUserByEmail', () => {
  it('returns {exists:true, username} for the native user when ListUsers yields native + Google_ user', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: 'Google_123456789',
          Attributes: [{ Name: 'email', Value: 'mario@example.it' }],
        },
        {
          Username: 'mario@example.it',
          Attributes: [{ Name: 'email', Value: 'mario@example.it' }],
        },
      ],
    });

    const result = await findNativeClientiUserByEmail({
      poolId: 'eu-central-1_TESTPOOL',
      email: 'mario@example.it',
    });

    expect(result).toEqual({ exists: true, username: 'mario@example.it' });

    // Assert the ListUsers call used the correct email filter
    const calls = cognitoMock.commandCalls(ListUsersCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-central-1_TESTPOOL',
      Filter: 'email = "mario@example.it"',
    });
  });

  it('returns {exists:false} when ListUsers yields only a Google_ user', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: 'Google_999888777',
          Attributes: [{ Name: 'email', Value: 'mario@example.it' }],
        },
      ],
    });

    const result = await findNativeClientiUserByEmail({
      poolId: 'eu-central-1_TESTPOOL',
      email: 'mario@example.it',
    });

    expect(result).toEqual({ exists: false });
  });

  it('returns {exists:false} when ListUsers yields an empty list', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

    const result = await findNativeClientiUserByEmail({
      poolId: 'eu-central-1_TESTPOOL',
      email: 'new@example.it',
    });

    expect(result).toEqual({ exists: false });
  });

  it('throws CognitoUnavailableError when ListUsersCommand rejects', async () => {
    cognitoMock.on(ListUsersCommand).rejects(new Error('Service unavailable'));

    await expect(
      findNativeClientiUserByEmail({ poolId: 'eu-central-1_TESTPOOL', email: 'x@y.it' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// linkGoogleIdentityToClientiUser
// ---------------------------------------------------------------------------
describe('linkGoogleIdentityToClientiUser', () => {
  it('sends AdminLinkProviderForUserCommand with the correct Destination/Source shape', async () => {
    cognitoMock.on(AdminLinkProviderForUserCommand).resolves({});

    await linkGoogleIdentityToClientiUser({
      poolId: 'eu-central-1_TESTPOOL',
      destinationUsername: 'mario@example.it',
      googleSub: '123456789012345678901',
    });

    const calls = cognitoMock.commandCalls(AdminLinkProviderForUserCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      UserPoolId: 'eu-central-1_TESTPOOL',
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: 'mario@example.it',
      },
      SourceUser: {
        ProviderName: 'Google',
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: '123456789012345678901',
      },
    });
  });

  it('resolves (swallows AliasExistsException) for idempotent re-runs', async () => {
    cognitoMock
      .on(AdminLinkProviderForUserCommand)
      .rejects(new AliasExistsException({ message: 'Already linked', $metadata: {} }));

    await expect(
      linkGoogleIdentityToClientiUser({
        poolId: 'eu-central-1_TESTPOOL',
        destinationUsername: 'mario@example.it',
        googleSub: '123456789012345678901',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws CognitoUnavailableError on generic rejections', async () => {
    cognitoMock.on(AdminLinkProviderForUserCommand).rejects(new Error('Network timeout'));

    await expect(
      linkGoogleIdentityToClientiUser({
        poolId: 'eu-central-1_TESTPOOL',
        destinationUsername: 'mario@example.it',
        googleSub: '123456789012345678901',
      }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminEnableUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  CognitoUnavailableError,
  _resetCognitoClientForTests,
  enableOfficineUser,
  getOfficineUserByEmail,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('enableOfficineUser', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('sends AdminEnableUserCommand with poolId+email', async () => {
    cognitoMock.on(AdminEnableUserCommand).resolves({});
    await enableOfficineUser({ poolId: 'pool-1', email: 'a@b.test' });
    const calls = cognitoMock.commandCalls(AdminEnableUserCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'a@b.test',
    });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock
      .on(AdminEnableUserCommand)
      .rejects(new UserNotFoundException({ message: 'user not found', $metadata: {} }));
    await expect(
      enableOfficineUser({ poolId: 'pool-1', email: 'gone@b.test' }),
    ).resolves.toBeUndefined();
  });

  it('wraps generic errors in CognitoUnavailableError', async () => {
    cognitoMock.on(AdminEnableUserCommand).rejects(new Error('boom'));
    await expect(
      enableOfficineUser({ poolId: 'pool-1', email: 'a@b.test' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

describe('getOfficineUserByEmail', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('returns {exists:true, sub, attributes} when AdminGetUser succeeds', async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: 'a@b.test',
      UserAttributes: [
        { Name: 'sub', Value: 'cognito-sub-uuid' },
        { Name: 'email', Value: 'a@b.test' },
        { Name: 'custom:tenant_id', Value: 'tenant-1' },
      ],
    });
    const result = await getOfficineUserByEmail({ poolId: 'pool-1', email: 'a@b.test' });
    expect(result.exists).toBe(true);
    if (result.exists) {
      expect(result.sub).toBe('cognito-sub-uuid');
      expect(result.attributes).toEqual({
        sub: 'cognito-sub-uuid',
        email: 'a@b.test',
        'custom:tenant_id': 'tenant-1',
      });
    }
  });

  it('returns {exists:false} on UserNotFoundException', async () => {
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: 'not found', $metadata: {} }));
    const result = await getOfficineUserByEmail({ poolId: 'pool-1', email: 'gone@b.test' });
    expect(result.exists).toBe(false);
    if (!result.exists) {
      // discriminated union — no `sub` on this branch
      expect((result as { sub?: string }).sub).toBeUndefined();
    }
  });

  it('throws CognitoUnavailableError on generic errors', async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('boom'));
    await expect(
      getOfficineUserByEmail({ poolId: 'pool-1', email: 'a@b.test' }),
    ).rejects.toBeInstanceOf(CognitoUnavailableError);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  createOfficineCognitoUser,
  setOfficineCognitoPassword,
  updateOfficineUserRoleAndLocation,
  _resetCognitoClientForTests,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('Cognito officine user lifecycle helpers', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('createOfficineCognitoUser issues AdminCreateUser with SUPPRESS + correct attrs (no location)', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'sub-12345' }] },
    });
    const result = await createOfficineCognitoUser({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      tenantId: 'tenant-1',
      role: 'mechanic',
    });
    expect(result.cognitoSub).toBe('sub-12345');
    const sentCommand = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0];
    expect(sentCommand?.input.MessageAction).toBe('SUPPRESS');
    expect(sentCommand?.input.UserAttributes).toEqual(
      expect.arrayContaining([
        { Name: 'email', Value: 'mario@example.com' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: 'Mario' },
        { Name: 'family_name', Value: 'Rossi' },
        { Name: 'custom:tenant_id', Value: 'tenant-1' },
        { Name: 'custom:role', Value: 'mechanic' },
      ]),
    );
    // sede-unica: custom:location_id is never written
    const attrs = sentCommand?.input.UserAttributes ?? [];
    expect(attrs.find((a) => a.Name === 'custom:location_id')).toBeUndefined();
  });

  it('setOfficineCognitoPassword uses AdminSetUserPassword with Permanent=true', async () => {
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
    await setOfficineCognitoPassword({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      password: 'Secret123!',
    });
    const sentCommand = cognitoMock.commandCalls(AdminSetUserPasswordCommand)[0]?.args[0];
    expect(sentCommand?.input.Permanent).toBe(true);
    expect(sentCommand?.input.Password).toBe('Secret123!');
  });

  it('updateOfficineUserRoleAndLocation issues AdminUpdateUserAttributes with role when given', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    await updateOfficineUserRoleAndLocation({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      role: 'super_admin',
    });
    const sentCommand = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)[0]?.args[0];
    const attrs = sentCommand?.input.UserAttributes ?? [];
    expect(attrs).toEqual(expect.arrayContaining([{ Name: 'custom:role', Value: 'super_admin' }]));
    // sede-unica: custom:location_id is never written
    expect(attrs.find((a) => a.Name === 'custom:location_id')).toBeUndefined();
  });

  it('updateOfficineUserRoleAndLocation makes no API call when role is undefined', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    await updateOfficineUserRoleAndLocation({
      poolId: 'pool-officine',
      email: 'mario@example.com',
    });
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand).length).toBe(0);
  });
});
